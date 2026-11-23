/**
 * One side of an Agent Client Protocol connection: JSON-RPC 2.0, one JSON
 * object per line. The owner (runtime.ts) feeds it the agent's stdout and
 * kills the process on any fatal transport error. No line the agent writes
 * is ever logged or copied into an error: it may carry a sign-in link.
 */
import { StringDecoder } from "node:string_decoder";
import type { Writable } from "node:stream";

import { AntigravityMessage } from "./constants.ts";

export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** The not-signed-in signal the agent prints instead of JSON. */
export const SIGN_IN_LINE_PREFIX = "Open the following link to authenticate";

/** Anything that looks like a link becomes a placeholder: agent text may carry a sign-in URL. */
export function stripUrls(text: string): string {
	return text
		.replace(/\S*accounts\.google\.com\S*/gi, "[link removed]")
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link removed]")
		// Scheme-relative: //host/path, at the start or after a space or opening bracket/quote.
		.replace(/(^|[\s("'<[])\/\/[^\s/]+\S*/g, "$1[link removed]");
}

/**
 * Errors carry a brand: the runtime lives on globalThis and outlives module
 * re-evaluation, so an error built by an older copy of this module fails
 * `instanceof` against the newer class. Classify with the is* helpers.
 */
/** A JSON-RPC error answer from the agent, with any link already removed from its message. */
export class AcpRpcError extends Error {
	readonly brand = "acp-rpc" as const;
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

export type TransportFailure = "protocol" | "sign-in" | "closed" | "timeout";

/** The connection itself failed; `message` is always one of ours. */
export class AcpTransportError extends Error {
	readonly brand = "acp-transport" as const;
	constructor(readonly kind: TransportFailure, message: string) {
		super(message);
	}
}

export function isAcpRpcError(error: unknown): error is AcpRpcError {
	const e = error as Partial<AcpRpcError> | null;
	return !!e && typeof e === "object" && e.brand === "acp-rpc" && typeof e.code === "number" && typeof e.message === "string";
}

export function isAcpTransportError(error: unknown): error is AcpTransportError {
	const e = error as Partial<AcpTransportError> | null;
	return !!e && typeof e === "object" && e.brand === "acp-transport" && typeof e.kind === "string" && typeof e.message === "string";
}

function startsWithSignIn(text: string): boolean {
	return text.trimStart().startsWith(SIGN_IN_LINE_PREFIX);
}

export class LineTooLongError extends Error {}

/**
 * Splits a byte stream on "\n" with a hard cap per line, counted in bytes,
 * and tells whether the unfinished line is the sign-in line. That decision
 * reads only the line's first characters, once, as they arrive (leading
 * whitespace, then the prefix): each further chunk of a long line costs
 * nothing extra.
 */
export class LineSplitter {
	private parts: Buffer[] = [];
	private size = 0;
	// The unfinished line's sign-in decision: undefined until its first non-space characters settle it.
	private decoder = new StringDecoder("utf8");
	private matched = 0;
	private signIn: boolean | undefined;
	private decoding = false;

	constructor(private readonly maxBytes = MAX_LINE_BYTES) {}

	push(chunk: Buffer): string[] {
		const lines: string[] = [];
		let start = 0;
		for (let newline = chunk.indexOf(10, start); newline >= 0; newline = chunk.indexOf(10, start)) {
			const piece = chunk.subarray(start, newline);
			if (this.size + piece.length > this.maxBytes) throw new LineTooLongError("line too long");
			if (this.size === 0) lines.push(piece.toString("utf8"));
			else {
				this.parts.push(piece);
				lines.push(Buffer.concat(this.parts, this.size + piece.length).toString("utf8"));
				this.parts = [];
				this.size = 0;
			}
			this.resetSignIn();
			start = newline + 1;
		}
		const rest = chunk.subarray(start);
		if (rest.length > 0) {
			this.size += rest.length;
			if (this.size > this.maxBytes) throw new LineTooLongError("line too long");
			this.parts.push(rest);
			this.scanSignIn(rest);
		}
		return lines;
	}

	/** The bytes after the last newline, with leading whitespace removed, start with the sign-in prefix. */
	unfinishedIsSignIn(): boolean {
		return this.signIn === true;
	}

	private resetSignIn(): void {
		// A partial character the decoder still holds belongs to the finished line.
		if (this.decoding) this.decoder = new StringDecoder("utf8");
		this.decoding = false;
		this.matched = 0;
		this.signIn = undefined;
	}

	private scanSignIn(bytes: Buffer): void {
		if (this.signIn !== undefined) return;
		this.decoding = true;
		for (const char of this.decoder.write(bytes)) {
			// The same whitespace trimStart() removes.
			if (this.matched === 0 && /^\s$/u.test(char)) continue;
			if (char !== SIGN_IN_LINE_PREFIX[this.matched]) { this.signIn = false; return; }
			if (++this.matched === SIGN_IN_LINE_PREFIX.length) { this.signIn = true; return; }
		}
	}
}

type JsonRpcId = number | string;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout; stamped: boolean };

/** A response and the number of the frame it arrived in, so a caller can order it against updates. */
export type Stamped = { result: unknown; frame: number };

export interface AcpPeerHandlers {
	onNotification(method: string, params: unknown): void;
	/** Throw an AcpRpcError to answer with that error. */
	onRequest(method: string, params: unknown): unknown;
	/** The connection is unusable. Called once; the owner kills the process. */
	onFatal(error: AcpTransportError): void;
}

/** A plain object (not null, not an array): the one copy every Antigravity module uses. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
	return typeof value === "number" || typeof value === "string";
}

export class AcpPeer {
	private nextId = 1;
	/** Incoming frames handled so far; read it inside a notification handler to stamp that update. */
	frame = 0;
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
			this.frame++;
			this.handleLine(line);
		}
		// The sign-in line may come without a newline while the agent waits.
		if (!this.closed && this.splitter.unfinishedIsSignIn()) this.fatal("sign-in", AntigravityMessage.NotSignedIn);
	}

	request(method: string, params: unknown, timeoutMs?: number, timeoutMessage?: string): Promise<unknown> {
		return this.send(method, params, false, timeoutMs, timeoutMessage);
	}

	/** Like request(), resolving with the frame number the answer arrived in. */
	requestStamped(method: string, params: unknown, timeoutMs?: number, timeoutMessage?: string): Promise<Stamped> {
		return this.send(method, params, true, timeoutMs, timeoutMessage) as Promise<Stamped>;
	}

	private send(method: string, params: unknown, stamped: boolean, timeoutMs?: number, timeoutMessage: string = AntigravityMessage.StartTimeout): Promise<unknown> {
		if (this.closedWith) return Promise.reject(this.closedWith);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const entry: Pending = { resolve, reject, stamped };
			if (timeoutMs !== undefined) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new AcpTransportError("timeout", timeoutMessage));
				}, timeoutMs);
				entry.timer.unref();
			}
			this.pending.set(id, entry);
			try { this.write({ jsonrpc: "2.0", id, method, params }); }
			catch (error) {
				// Never leave an entry (or its timer) behind for a request that was not sent.
				this.pending.delete(id);
				clearTimeout(entry.timer);
				throw error;
			}
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
		if (startsWithSignIn(line)) { this.fatal("sign-in", AntigravityMessage.NotSignedIn); return; }
		let message: unknown;
		try { message = JSON.parse(line); }
		catch { this.fatal("protocol", AntigravityMessage.ProtocolError); return; }
		if (!isRecord(message) || message.jsonrpc !== "2.0") { this.fatal("protocol", AntigravityMessage.ProtocolError); return; }

		if (typeof message.method === "string") {
			if (isId(message.id)) this.answer(message.id, message.method, message.params);
			else this.handlers.onNotification(message.method, message.params);
			return;
		}
		const hasError = message.error !== undefined && message.error !== null;
		if (!isId(message.id) || (!hasError && !("result" in message))) { this.fatal("protocol", AntigravityMessage.ProtocolError); return; }
		const entry = this.pending.get(message.id);
		if (!entry) return;
		this.pending.delete(message.id);
		clearTimeout(entry.timer);
		if (hasError) {
			// Any non-null error member is an error, whatever its shape.
			const error = isRecord(message.error) ? message.error : {};
			const code = typeof error.code === "number" ? error.code : -32603;
			entry.reject(new AcpRpcError(code, typeof error.message === "string" ? stripUrls(error.message) : ""));
		} else {
			entry.resolve(entry.stamped ? { result: message.result, frame: this.frame } : message.result);
		}
	}

	/** Answers synchronously when the handler does, so an answer is written
	 *  before anything later lines in the same chunk trigger. */
	private answer(id: JsonRpcId, method: string, params: unknown): void {
		const reply = (result: unknown) => { if (!this.closed) this.write({ jsonrpc: "2.0", id, result: result ?? null }); };
		const refuse = (error: unknown) => {
			if (this.closed) return;
			const rpc = isAcpRpcError(error) ? error : new AcpRpcError(-32603, "Internal error");
			this.write({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message } });
		};
		let result: unknown;
		try { result = this.handlers.onRequest(method, params); }
		catch (error) { refuse(error); return; }
		if (result instanceof Promise) result.then(reply, refuse);
		else reply(result);
	}
}

/** Method-not-found, the answer to every agent request LearnHarness doesn't serve. */
export function methodNotFound(method: string): AcpRpcError {
	return new AcpRpcError(-32601, `Method not found: ${method}`);
}
