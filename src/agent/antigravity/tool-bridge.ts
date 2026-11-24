/**
 * The loopback MCP server through which an Antigravity session calls the
 * LearnHarness tools of its lesson (docs/antigravity.md). One HTTP listener
 * per agent process, one endpoint per agent session: an unguessable path and
 * a bearer token (32 random bytes each, compared in constant time), its own
 * MCP server listing exactly the session's declared tools. A valid tools/call
 * is handed to the session as a held call; its HTTP response waits until
 * LearnHarness supplies the result or the call is failed. Nothing the agent
 * sends is logged except tool names.
 *
 * Modelled on claude-code/tool-bridge.ts (not shared: that one is one server
 * per process and keys calls by the CLI's own tool-use id).
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { ImageContent, JsonObject, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

import { promptImageLimit } from "./transcript.ts";

/** The MCP server's own name in its initialize answer (not the per-session name the agent is given). */
export const BRIDGE_SERVER_NAME = "learnharness";
/** Bytes of randomness in a session's server name: "lh" + 10 lowercase hex. */
const SERVER_NAME_BYTES = 5;

/** What the model sees a declared tool as, for a session whose MCP server is called `serverName`. */
export function agentToolName(serverName: string, tool: string): string {
	return `mcp_${serverName}_${tool}`;
}
const LOOPBACK_HOST = "127.0.0.1";
const SECRET_BYTES = 32;
export const MAX_BRIDGE_BODY_BYTES = 8 * 1024 * 1024;

/** A tools/call the agent made, waiting for its result. */
export interface HeldCall {
	/** LearnHarness's own id for the call (the agent's MCP request carries none). */
	readonly id: string;
	readonly name: string;
	readonly arguments: JsonObject;
}

export interface EndpointHooks {
	/** A valid call for a declared tool arrived. Return false to refuse it (it is answered with an error). */
	onCall(call: HeldCall): boolean;
	/** The agent aborted a held call (it gives up after its own limit, or on session/cancel). */
	onAbort(call: HeldCall): void;
	/** A call LearnHarness won't run: an undeclared tool or a malformed request. */
	onInvalid(reason: string): void;
}

/** The ACP `mcpServers` entry for one session. */
export interface McpServerEntry {
	type: "http";
	name: string;
	url: string;
	headers: { name: string; value: string }[];
}

/** Test seams: a tools/call request's response just before the MCP server gets it, and a call as it is held. */
export const toolBridgeTestHooks: {
	beforeDispatch?: (res: http.ServerResponse) => void;
	onHeld?: (call: HeldCall, res: http.ServerResponse) => void;
} = {};

/** In place of a tool-result image beyond the per-result picture budget. */
export const RESULT_IMAGE_OMITTED = "[image omitted: over the 20 MB picture limit for one tool result]";

export interface SessionEndpoint {
	readonly mcpServer: McpServerEntry;
	/**
	 * This session's own MCP server name, never reused in the agent process. The agent names a tool
	 * mcp_<server name>_<tool>, but adds a suffix of its own when a process sees one name with two
	 * urls (measured on agy 1.5.15), so a shared name would break every session after the first.
	 */
	readonly serverName: string;
	/** Whether the held call `id` can still be answered: held, and its response alive. */
	canResolve(id: string): boolean;
	/** Answer the held call `id` with a pi tool result. False (nothing written) unless canResolve(id). */
	resolve(id: string, result: ToolResultMessage): boolean;
	/** Fail every held call (with an error result) and forget them. */
	failHeld(reason: string): void;
	/** Fail held calls, stop serving, forget the token. */
	close(): Promise<void>;
}

/** A pi result's content for MCP: images within the picture budget (as for prompts), beyond it a note. */
function toMcpContent(content: readonly (TextContent | ImageContent)[]): CallToolResult["content"] {
	let bytes = 0;
	return content.map((block) => {
		if (block.type === "text") return { type: "text", text: block.text };
		bytes += Buffer.byteLength(block.data, "base64");
		return bytes > promptImageLimit.bytes ? { type: "text", text: RESULT_IMAGE_OMITTED } : { type: "image", data: block.data, mimeType: block.mimeType };
	});
}

/** One HTTP request to an endpoint, keyed by LearnHarness's own id (never the agent's JSON-RPC id). */
type LiveRequest = { res: http.ServerResponse; aborts: Set<() => void> };

function responseAlive(res: http.ServerResponse): boolean {
	return !res.destroyed && !res.writableEnded && !(res.socket?.destroyed ?? false);
}

function toMcpTool(tool: Tool): McpTool {
	return { name: tool.name, description: tool.description, inputSchema: tool.parameters as McpTool["inputSchema"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameSecret(actual: string | undefined, expected: Buffer): boolean {
	if (actual === undefined) return false;
	const given = Buffer.from(actual);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

type Endpoint = {
	authorization: Buffer;
	transport: StreamableHTTPServerTransport;
	server: Server;
	held: Map<string, (result: CallToolResult) => void>;
	/** Requests in flight by internal id (passed to the handler as authInfo.token), so a dropped one aborts what it holds. */
	requests: Map<string, LiveRequest>;
	/** JSON-RPC ids of the tools/call requests in flight. */
	callIds: Set<string | number>;
	hooks: EndpointHooks;
	/** Requests in flight, so closing never leaves the agent waiting on a response that won't come. */
	open: Set<http.ServerResponse>;
	closed: boolean;
	/** Tell the MCP handler the endpoint is closed. */
	markClosed: () => void;
};

/** Let answered calls' responses go out, then cut whatever is still open. */
async function shutDown(endpoint: Endpoint): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	for (const res of endpoint.open) res.destroy();
	endpoint.open.clear();
	await endpoint.server.close().catch(() => { /* already closed */ });
}

/** One listener per agent process; endpoints come and go with sessions. */
export class ToolBridge {
	private readonly endpoints = new Map<string, Endpoint>();
	/** Every server name this process was given, so none is used twice. */
	private readonly serverNames = new Set<string>();
	private closed = false;

	private constructor(private readonly http: http.Server, readonly port: number) {}

	static async start(): Promise<ToolBridge> {
		let bridge: ToolBridge | undefined;
		const server = http.createServer((req, res) => {
			if (bridge) bridge.handle(req, res);
			else res.writeHead(503).end();
		});
		const address = await new Promise<AddressInfo>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, LOOPBACK_HOST, () => resolve(server.address() as AddressInfo));
		});
		bridge = new ToolBridge(server, address.port);
		return bridge;
	}

	get size(): number { return this.endpoints.size; }

	/** A new endpoint serving exactly `tools`, for one agent session. */
	async open(tools: readonly Tool[], hooks: EndpointHooks): Promise<SessionEndpoint> {
		if (this.closed) throw new Error("tool bridge closed");
		const segment = randomBytes(SECRET_BYTES).toString("hex");
		const token = randomBytes(SECRET_BYTES).toString("hex");
		let serverName: string;
		do serverName = `lh${randomBytes(SERVER_NAME_BYTES).toString("hex")}`;
		while (this.serverNames.has(serverName));
		this.serverNames.add(serverName);
		const declared = new Map(tools.map((tool) => [tool.name, tool]));
		const held = new Map<string, (result: CallToolResult) => void>();
		const responses = new Map<string, http.ServerResponse>();
		const requests = new Map<string, LiveRequest>();
		let closed = false;
		const server = new Server({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
		server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...declared.values()].map(toMcpTool) }));
		server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
			const { name } = request.params;
			const args = request.params.arguments ?? {};
			if (!declared.has(name) || !isRecord(args)) {
				hooks.onInvalid(declared.has(name) ? "malformed tool arguments" : "undeclared tool");
				throw new McpError(ErrorCode.InvalidParams, "That tool is not available.");
			}
			// Hold only a call whose request is still alive, on an endpoint still open: a dead one is never handed over.
			const live = typeof extra.authInfo?.token === "string" ? requests.get(extra.authInfo.token) : undefined;
			if (closed || !live || extra.signal.aborted || !responseAlive(live.res)) {
				return { content: [{ type: "text", text: "The call ended before LearnHarness could take it." }], isError: true };
			}
			const call: HeldCall = { id: randomUUID(), name, arguments: args as JsonObject };
			return new Promise<CallToolResult>((resolve) => {
				const settle = (result: CallToolResult) => {
					live.aborts.delete(aborted);
					responses.delete(call.id);
					if (!held.delete(call.id)) return;
					extra.signal.removeEventListener("abort", aborted);
					resolve(result);
				};
				const aborted = () => {
					if (!held.has(call.id)) return;
					settle({ content: [{ type: "text", text: "The call was cancelled." }], isError: true });
					hooks.onAbort(call);
				};
				held.set(call.id, settle);
				responses.set(call.id, live.res);
				live.aborts.add(aborted);
				extra.signal.addEventListener("abort", aborted, { once: true });
				toolBridgeTestHooks.onHeld?.(call, live.res);
				if (!hooks.onCall(call)) {
					settle({ content: [{ type: "text", text: "LearnHarness did not accept this call." }], isError: true });
				}
			});
		});
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
		await server.connect(transport);
		// The bridge may have closed while the server was connecting: then this endpoint never opens.
		if (this.closed) { await server.close().catch(() => {}); throw new Error("tool bridge closed"); }
		const endpoint: Endpoint = { authorization: Buffer.from(`Bearer ${token}`), transport, server, held, requests, callIds: new Set(), hooks, open: new Set(), closed: false, markClosed: () => { closed = true; } };
		this.endpoints.set(segment, endpoint);
		const failHeld = (reason: string) => {
			for (const settle of [...held.values()]) settle({ content: [{ type: "text", text: reason }], isError: true });
		};
		return {
			serverName,
			mcpServer: { type: "http", name: serverName, url: `http://${LOOPBACK_HOST}:${this.port}/mcp/${segment}`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] },
			canResolve: (id) => {
				const res = responses.get(id);
				return !endpoint.closed && held.has(id) && res !== undefined && responseAlive(res);
			},
			resolve: (id, result) => {
				const settle = held.get(id);
				const res = responses.get(id);
				if (endpoint.closed || !settle || !res || !responseAlive(res)) return false;
				settle({ content: toMcpContent(result.content), isError: result.isError });
				return true;
			},
			failHeld,
			close: async () => {
				if (endpoint.closed) return;
				endpoint.closed = true;
				endpoint.markClosed();
				failHeld("The session ended.");
				this.endpoints.delete(segment);
				await shutDown(endpoint);
			},
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const endpoint of this.endpoints.values()) {
			endpoint.closed = true;
			endpoint.markClosed();
			for (const settle of [...endpoint.held.values()]) settle({ content: [{ type: "text", text: "The session ended." }], isError: true });
			await shutDown(endpoint);
		}
		this.endpoints.clear();
		this.http.closeAllConnections();
		await new Promise<void>((resolve) => this.http.close(() => resolve()));
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const match = /^\/mcp\/([0-9a-f]{64})$/.exec((req.url ?? "").split("?")[0] ?? "");
		const endpoint = match ? this.endpoints.get(match[1]!) : undefined;
		if (!endpoint || endpoint.closed) { res.writeHead(404).end(); return; }
		if (!sameSecret(req.headers.authorization, endpoint.authorization)) { res.writeHead(401).end(); return; }
		endpoint.open.add(res);
		res.once("close", () => endpoint.open.delete(res));
		const declared = Number(req.headers["content-length"] ?? 0);
		if (declared > MAX_BRIDGE_BODY_BYTES) { res.writeHead(413).end(); req.resume(); return; }
		if (req.method !== "POST") {
			endpoint.transport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
			return;
		}
		// Read the body ourselves to enforce the cap, then hand it over parsed.
		const parts: Buffer[] = [];
		let size = 0;
		let refused = false;
		req.on("data", (chunk: Buffer) => {
			if (refused) return;
			size += chunk.length;
			if (size > MAX_BRIDGE_BODY_BYTES) { refused = true; res.writeHead(413).end(); req.destroy(); return; }
			parts.push(chunk);
		});
		req.on("end", () => {
			if (refused) return;
			// Closed while the body was arriving: accept nothing.
			if (endpoint.closed) { res.writeHead(404).end(); return; }
			let body: unknown;
			try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); }
			catch { res.writeHead(400).end(); return; }
			const messages = Array.isArray(body) ? body : [body];
			const calls = messages.filter((message) => isRecord(message) && message.method === "tools/call") as Record<string, unknown>[];
			// Checked here: the SDK's own schema would refuse these before LearnHarness hears of them.
			const malformed = calls.find((message) => !isRecord(message.params) || typeof message.params.name !== "string" || (message.params.arguments !== undefined && !isRecord(message.params.arguments)));
			if (malformed) {
				endpoint.hooks.onInvalid("malformed tool call");
				res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: malformed.id ?? null, error: { code: ErrorCode.InvalidParams, message: "Malformed tool call." } }));
				return;
			}
			// Our own id for this request, handed to the MCP handler as authInfo: the agent gives up on a call by
			// dropping its request, which aborts what THIS request was holding (a reused JSON-RPC id can't reach another).
			const ids = calls.flatMap((message) => (typeof message.id === "string" || typeof message.id === "number" ? [message.id] : []));
			// The MCP transport routes a response by JSON-RPC id: a second call reusing the id of one in flight
			// would take the first one's answer. Refused before it reaches the transport.
			if (ids.some((id) => endpoint.callIds.has(id)) || new Set(ids).size !== ids.length) {
				endpoint.hooks.onInvalid("reused request id");
				res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.InvalidRequest, message: "Request id already in use." } }));
				return;
			}
			const key = randomUUID();
			const live: LiveRequest = { res, aborts: new Set() };
			endpoint.requests.set(key, live);
			for (const id of ids) endpoint.callIds.add(id);
			res.once("close", () => {
				endpoint.requests.delete(key);
				for (const id of ids) endpoint.callIds.delete(id);
				if (!res.writableFinished) for (const abort of [...live.aborts]) abort();
			});
			(req as http.IncomingMessage & { auth?: unknown }).auth = { token: key, clientId: "antigravity", scopes: [] };
			if (calls.length) toolBridgeTestHooks.beforeDispatch?.(res);
			if (endpoint.closed) { if (!res.destroyed) res.writeHead(404).end(); return; }
			endpoint.transport.handleRequest(req, res, body).catch(() => { if (!res.headersSent && !res.destroyed) res.writeHead(500); res.end(); });
		});
		req.on("error", () => { if (!res.headersSent) res.writeHead(400); res.end(); });
	}
}
