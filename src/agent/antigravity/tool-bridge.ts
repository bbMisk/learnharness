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

export const BRIDGE_SERVER_NAME = "learnharness";
/** What the model sees a declared tool as. */
export const AGENT_TOOL_PREFIX = `mcp_${BRIDGE_SERVER_NAME}_`;
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

export interface SessionEndpoint {
	readonly mcpServer: McpServerEntry;
	/** Answer the held call `id` with a pi tool result. False if no such call is held. */
	resolve(id: string, result: ToolResultMessage): boolean;
	/** Fail every held call (with an error result) and forget them. */
	failHeld(reason: string): void;
	/** Fail held calls, stop serving, forget the token. */
	close(): Promise<void>;
}

function toMcpContent(block: TextContent | ImageContent): CallToolResult["content"][number] {
	return block.type === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType };
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
	/** Requests in flight, so closing never leaves the agent waiting on a response that won't come. */
	open: Set<http.ServerResponse>;
	closed: boolean;
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
		const declared = new Map(tools.map((tool) => [tool.name, tool]));
		const held = new Map<string, (result: CallToolResult) => void>();
		const server = new Server({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
		server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...declared.values()].map(toMcpTool) }));
		server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
			const { name } = request.params;
			const args = request.params.arguments ?? {};
			if (!declared.has(name) || !isRecord(args)) {
				hooks.onInvalid(declared.has(name) ? "malformed tool arguments" : "undeclared tool");
				throw new McpError(ErrorCode.InvalidParams, "That tool is not available.");
			}
			const call: HeldCall = { id: randomUUID(), name, arguments: args as JsonObject };
			return new Promise<CallToolResult>((resolve) => {
				const settle = (result: CallToolResult) => {
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
				extra.signal.addEventListener("abort", aborted, { once: true });
				if (!hooks.onCall(call)) {
					settle({ content: [{ type: "text", text: "LearnHarness did not accept this call." }], isError: true });
				}
			});
		});
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
		await server.connect(transport);
		const endpoint: Endpoint = { authorization: Buffer.from(`Bearer ${token}`), transport, server, held, open: new Set(), closed: false };
		this.endpoints.set(segment, endpoint);
		const failHeld = (reason: string) => {
			for (const settle of [...held.values()]) settle({ content: [{ type: "text", text: reason }], isError: true });
		};
		return {
			mcpServer: { type: "http", name: BRIDGE_SERVER_NAME, url: `http://${LOOPBACK_HOST}:${this.port}/mcp/${segment}`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] },
			resolve: (id, result) => {
				const settle = held.get(id);
				if (!settle) return false;
				settle({ content: result.content.map(toMcpContent), isError: result.isError });
				return true;
			},
			failHeld,
			close: async () => {
				if (endpoint.closed) return;
				endpoint.closed = true;
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
			let body: unknown;
			try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); }
			catch { res.writeHead(400).end(); return; }
			endpoint.transport.handleRequest(req, res, body).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
		});
		req.on("error", () => { if (!res.headersSent) res.writeHead(400); res.end(); });
	}
}
