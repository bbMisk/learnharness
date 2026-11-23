/**
 * One side of an Agent Client Protocol connection: JSON-RPC 2.0, one JSON
 * object per line. The owner (runtime.ts) feeds it the agent's stdout and
 * kills the process on any fatal transport error. No line the agent writes
 * is ever logged or copied into an error: it may carry a sign-in link.
 */
import type { Writable } from "node:stream";

import { AntigravityMessage } from "./constants.ts";

export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** The not-signed-in signal the agent prints instead of JSON. */
export const SIGN_IN_LINE_PREFIX = "Open the following link to authenticate";

/** A JSON-RPC error answer from the agent. */
export class AcpRpcError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

export type TransportFailure = "protocol" | "sign-in" | "closed" | "timeout";

/** The connection itself failed; `message` is always one of ours. */
export class AcpTransportError extends Error {
	constructor(readonly kind: TransportFailure, message: string) {
		super(message);
	}
}

export class LineTooLongError extends Error {}

/** Splits a byte stream on "\n" with a hard cap per line, counted in bytes. */
export class LineSplitter {
	private parts: Buffer[] = [];
	private size = 0;

	constructor(private readonly maxBytes = MAX_LINE_BYTES) {}

	push(chunk: Buffer): string[] {
		const lines: string[] = [];
		let start = 0;
		for (let newline = chunk.indexOf(10, start); newline >= 0; newline = chunk.indexOf(10, start)) {
			const piece = chunk.subarray(start, newline);
			if (this.size + piece.length > this.maxBytes) throw new LineTooLongError("line too long");
			lines.push(Buffer.concat([...this.parts, piece]).toString("utf8"));
			this.parts = [];
			this.size = 0;
			start = newline + 1;
		}
		const rest = chunk.subarray(start);
		if (rest.length > 0) {
			this.size += rest.length;
			if (this.size > this.maxBytes) throw new LineTooLongError("line too long");
			this.parts.push(rest);
		}
		return lines;
	}
}

type JsonRpcId = number | string;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };

export interface AcpPeerHandlers {
	onNotification(method: string, params: unknown): void;
	/** Throw an AcpRpcError to answer with that error. */
	onRequest(method: string, params: unknown): unknown;
	/** The connection is unusable. Called once; the owner kills the process. */
	onFatal(error: AcpTransportError): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
	return typeof value === "number" || typeof value === "string";
}

export class AcpPeer {
	private nextId = 1;
	private readonly pending = new Map<JsonRpcId, Pending>();
	private readonly splitter = new LineSplitter();
	private closedWith: AcpTransportError | undefined;

	constructor(private readonly output: Writable, private readonly handlers: AcpPeerHandlers) {}

	get closed(): boolean { return this.closedWith !== undefined; }

	/** Feed raw stdout bytes. */
	receive(chunk: Buffer): void {
		if (this.closed) return;
		let lines: string[];
		try { lines = this.splitter.push(chunk); }
		catch { this.fatal("protocol", AntigravityMessage.ProtocolError); return; }
		for (const line of lines) {
			if (this.closed) return;
			this.handleLine(line);
		}
	}

	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		if (this.closedWith) return Promise.reject(this.closedWith);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const entry: Pending = { resolve, reject };
			if (timeoutMs !== undefined) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new AcpTransportError("timeout", AntigravityMessage.StartTimeout));
				}, timeoutMs);
				entry.timer.unref();
			}
			this.pending.set(id, entry);
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
	}

	/** Fail every open request with `error` and refuse new ones. */
	close(error: AcpTransportError): void {
		this.closedWith ??= error;
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			this.pending.delete(id);
			entry.reject(this.closedWith);
		}
	}

	private fatal(kind: TransportFailure, message: string): void {
		if (this.closed) return;
		const error = new AcpTransportError(kind, message);
		this.close(error);
		this.handlers.onFatal(error);
	}

	private write(message: unknown): void {
		this.output.write(`${JSON.stringify(message)}\n`);
	}

	private handleLine(raw: string): void {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!line.trim()) return;
		if (line.startsWith(SIGN_IN_LINE_PREFIX)) { this.fatal("sign-in", AntigravityMessage.NotSignedIn); return; }
		let message: unknown;
		try { message = JSON.parse(line); }
		catch { this.fatal("protocol", AntigravityMessage.ProtocolError); return; }
		if (!isRecord(message)) { this.fatal("protocol", AntigravityMessage.ProtocolError); return; }

		if (typeof message.method === "string") {
			if (isId(message.id)) this.answer(message.id, message.method, message.params);
			else this.handlers.onNotification(message.method, message.params);
			return;
		}
		if (!isId(message.id)) { this.fatal("protocol", AntigravityMessage.ProtocolError); return; }
		const entry = this.pending.get(message.id);
		if (!entry) return;
		this.pending.delete(message.id);
		clearTimeout(entry.timer);
		if (isRecord(message.error)) {
			const code = typeof message.error.code === "number" ? message.error.code : -32603;
			entry.reject(new AcpRpcError(code, typeof message.error.message === "string" ? message.error.message : ""));
		} else {
			entry.resolve(message.result);
		}
	}

	private answer(id: JsonRpcId, method: string, params: unknown): void {
		Promise.resolve()
			.then(() => this.handlers.onRequest(method, params))
			.then(
				(result) => { if (!this.closed) this.write({ jsonrpc: "2.0", id, result: result ?? null }); },
				(error: unknown) => {
					if (this.closed) return;
					const rpc = error instanceof AcpRpcError ? error : new AcpRpcError(-32603, "Internal error");
					this.write({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message } });
				},
			);
	}
}

/** Method-not-found, the answer to every agent request LearnHarness doesn't serve. */
export function methodNotFound(method: string): AcpRpcError {
	return new AcpRpcError(-32601, `Method not found: ${method}`);
}
