#!/usr/bin/env node
/**
 * Stand-in for Google's `agy acp` in tests. Launched exactly like the real
 * binary (`<path> acp --sandbox`) and speaks the ACP v1 wire shapes over
 * stdio. NONE of these shapes comes from a captured real session: each is
 * reconstructed from reading T3 Code's source, and the file:line above each
 * one says where. The first authorised live test must capture a real
 * session and diff it against this file.
 *
 * MOCK_AGY_SCENARIO  JSON object scripting the behaviour (fields below).
 * MOCK_AGY_LOG       file that receives one JSON line per event:
 *                    {kind:"start", argv, cwd, envNames, pid}, then
 *                    {kind:"recv", line} for every raw stdin line.
 *
 * Scenario fields (all optional):
 *   stdoutAtStart, stderrAtStart  raw lines written at startup
 *   protocolVersion (2), shape ("v1" | "v2"), systemPromptAppend, sessionClose
 *   initializeError {code,message}, initializeHang
 *   sessionNewError {code,message}
 *   mode ("auto"; null = no mode option), modeOptions, rejectModeChange
 *   legacyModes {currentModeId, availableModes: [ids]}  (sent as `modes`)
 *   models {style: "flat" | "grouped" | "legacy", current, list: [{value,name}]}
 *   prompt: steps run per session/prompt, in order:
 *     {text} {thought} {echo:true} {toolCall:{...}} {toolCallUpdate:{...}}
 *     {permission:{...toolCall}} {fsRead:true} {sleepMs} {waitForCancel:true}
 *     {hold:true} {exit:code} {stdout:raw} {stderr:raw} {error:{code,message}}
 *     {usageUpdate:true}
 *   stopReason ("end_turn"), usage (result usage object)
 *   ignoreCancel, ignoreTerm
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

if (process.argv[2] !== "acp") {
	process.stderr.write("mock-agy: refusing to run without the acp subcommand\n");
	process.exit(2);
}

const scenario = process.env.MOCK_AGY_SCENARIO ? JSON.parse(process.env.MOCK_AGY_SCENARIO) : {};
const logFile = process.env.MOCK_AGY_LOG;
const log = (entry) => { if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`); };
log({ kind: "start", argv: process.argv.slice(2), cwd: process.cwd(), envNames: Object.keys(process.env).sort(), pid: process.pid });

if (scenario.ignoreTerm) process.on("SIGTERM", () => log({ kind: "ignored-term" }));
// Keep the process alive while it waits on stdin or held prompts.
const keepAlive = setInterval(() => {}, 60_000);

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const line of scenario.stdoutAtStart ?? []) process.stdout.write(`${line}\n`);
for (const line of scenario.stderrAtStart ?? []) process.stderr.write(`${line}\n`);

// ---- config options -------------------------------------------------------

const DEFAULT_MODELS = [
	{ value: "gemini-3-pro", name: "Gemini 3 Pro" },
	{ value: "gemini-3-flash", name: "Gemini 3 Flash" },
];
const models = {
	style: scenario.models?.style ?? "flat",
	list: scenario.models?.list ?? DEFAULT_MODELS,
};
models.current = scenario.models?.current ?? models.list[0]?.value;

const sessions = new Map();

function modelOptionList() {
	if (models.style === "grouped") {
		// Grouped select options: ACP's SessionConfigSelectGroup (groups each holding `options`).
		return [{ group: "recommended", name: "Recommended", options: models.list.slice(0, 1) }, { group: "other", name: "Other", options: models.list.slice(1) }];
	}
	return models.list;
}

// session/new configOptions, reconstructed from apps/server/src/provider/AntigravityProvider.ts:78-123,
// apps/server/src/provider/acp/AntigravityAcpSupport.ts:241 and AntigravityAcpSupport.test.ts:91-101.
function configOptions(session) {
	const options = [];
	if (models.style !== "legacy") {
		options.push({ id: "model", name: "Model", category: "model", type: "select", currentValue: models.current, options: modelOptionList() });
	}
	options.push({
		id: "thinking_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "medium",
		options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
	});
	if (session.mode !== null) {
		options.push({
			id: "mode", name: "Mode", category: "mode", type: "select", currentValue: session.mode,
			options: session.modeOptions.map((value) => ({ value, name: value })),
		});
	}
	return options;
}

// ---- handlers ------------------------------------------------------------------

// initialize result. The 1.5 agent reports protocolVersion 2 with the v1 agentInfo/agentCapabilities
// shapes: packages/effect-acp/src/client.ts:719-723,1108-1113; expectations of a 1.5 build in
// apps/server/src/provider/AntigravityInstallation.ts:788-799 and AntigravityAcpSupport.test.ts:61-85.
// (packages/effect-acp/test/fixtures/antigravity-initialize.json is from an older 1.1.1 build.)
function initializeResult() {
	const capabilities = {
		loadSession: true,
		promptCapabilities: { image: true, audio: true, embeddedContext: true },
		mcpCapabilities: { http: true, sse: true },
		sessionCapabilities: { list: {}, resume: {}, ...(scenario.sessionClose ? { close: {} } : {}) },
		auth: { logout: {} },
		...(scenario.systemPromptAppend ? { _meta: { antigravity: { systemPrompt: { append: true } } } } : {}),
	};
	const info = { name: "Antigravity ACP Server", title: "Google Antigravity", version: "1.5.12" };
	const authMethods = [
		{ id: "oauth-personal", name: "Log in with Google" },
		{ id: "oauth-business", name: "Log in with Google (business)" },
		{ id: "gemini-api-key", name: "Use a Gemini API key" },
		{ id: "agent-platform", name: "Agent Platform" },
	];
	const protocolVersion = scenario.protocolVersion ?? 2;
	if (scenario.shape === "v2") return { protocolVersion, capabilities, authMethods, info };
	return { protocolVersion, agentCapabilities: capabilities, authMethods, agentInfo: info };
}

// session/new result, reconstructed (see configOptions above). It is followed by an
// available_commands_update notification.
function newSession() {
	const sessionId = randomUUID();
	const session = {
		id: sessionId,
		mode: scenario.mode === undefined ? "auto" : scenario.mode,
		modeOptions: scenario.modeOptions ?? ["default", "accept-edits", "auto", "plan"],
		legacy: scenario.legacyModes ? { ...scenario.legacyModes } : undefined,
		cancelled: false,
		cancelWaiters: [],
	};
	sessions.set(sessionId, session);
	const result = { sessionId, configOptions: configOptions(session) };
	if (session.legacy) result.modes = { currentModeId: session.legacy.currentModeId, availableModes: session.legacy.availableModes.map((id) => ({ id, name: id })) };
	if (models.style === "legacy") result.models = { currentModelId: models.current, availableModels: models.list.map((m) => ({ modelId: m.value, name: m.name })) };
	setTimeout(() => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [] }), 0);
	return result;
}

function update(sessionId, body) {
	send({ method: "session/update", params: { sessionId, update: body } });
}

class RpcError extends Error {
	constructor(code, message) { super(message); this.code = code; }
}

// session/set_config_option answers with the full updated list; a rejected value is -32602:
// packages/provider-acp/src/server/AcpSessionRuntime.ts:2995-2999,2271-2293.
function setConfigOption({ sessionId, configId, value }) {
	const session = sessions.get(sessionId);
	if (!session) throw new RpcError(-32602, "Unknown session");
	if (configId === "mode") {
		if (!session.modeOptions.includes(value)) throw new RpcError(-32602, "Invalid mode");
		if (!scenario.rejectModeChange) session.mode = value;
	} else if (configId === "model") {
		if (!models.list.some((m) => m.value === value)) throw new RpcError(-32602, "Invalid model");
		models.current = value;
	} else if (configId !== "thinking_level") throw new RpcError(-32602, "Unknown option");
	return { configOptions: configOptions(session) };
}

const pendingToAgent = new Map();
let nextOwnId = 1;
function requestClient(method, params) {
	const id = `mock-${nextOwnId++}`;
	send({ id, method, params });
	return new Promise((resolve) => pendingToAgent.set(id, resolve));
}

function waitForCancel(session) {
	if (session.cancelled) return Promise.resolve();
	return new Promise((resolve) => session.cancelWaiters.push(resolve));
}

// session/prompt streams session/update notifications (agent_message_chunk, agent_thought_chunk,
// tool_call, tool_call_update, usage_update) and then answers { stopReason }:
// packages/provider-acp/src/server/AcpSessionRuntime.ts:2868-2871; every reply ends with a
// usage_update: packages/provider-acp/src/server/adapter.ts:685-688.
async function prompt({ sessionId, prompt: blocks }) {
	const session = sessions.get(sessionId);
	if (!session) throw new RpcError(-32602, "Unknown session");
	const steps = scenario.prompt ?? [{ text: "Hello" }, { text: " world" }, { usageUpdate: true }];
	const lastText = [...(blocks ?? [])].reverse().find((block) => block.type === "text")?.text ?? "";
	for (const step of steps) {
		if (session.cancelled && !scenario.ignoreCancel) break;
		if (step.text !== undefined) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } });
		else if (step.thought !== undefined) update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.thought } });
		else if (step.echo) {
			for (const piece of [`echo:`, lastText]) { update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } }); await sleep(5); }
		} else if (step.toolCall) update(sessionId, { sessionUpdate: "tool_call", ...step.toolCall });
		else if (step.toolCallUpdate) update(sessionId, { sessionUpdate: "tool_call_update", ...step.toolCallUpdate });
		else if (step.permission) {
			// session/request_permission, from apps/server/src/provider/acp/AntigravityProtocol.test.ts:136-160.
			const answer = await requestClient("session/request_permission", {
				sessionId,
				toolCall: { toolCallId: "call-1", title: "Run ls", kind: "execute", status: "pending", rawInput: { command: "ls" }, ...step.permission },
				options: [
					{ optionId: "remember-this-command", name: "Allow always", kind: "allow_always" },
					{ optionId: "run-this-time", name: "Allow", kind: "allow_once" },
					{ optionId: "stop-this-command", name: "Deny", kind: "reject_once" },
				],
			});
			log({ kind: "permission-answer", answer });
		} else if (step.fsRead) {
			const answer = await requestClient("fs/read_text_file", { sessionId, path: "/etc/hosts" });
			log({ kind: "fs-answer", answer });
		} else if (step.sleepMs) await sleep(step.sleepMs);
		else if (step.waitForCancel) await waitForCancel(session);
		else if (step.hold) await new Promise(() => {});
		else if (step.exit !== undefined) process.exit(step.exit);
		else if (step.stdout !== undefined) process.stdout.write(`${step.stdout}\n`);
		else if (step.stderr !== undefined) process.stderr.write(`${step.stderr}\n`);
		else if (step.error) throw new RpcError(step.error.code, step.error.message);
		else if (step.usageUpdate) update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 1_000_000 });
	}
	// session/cancel is a notification; the open prompt then resolves { stopReason: "cancelled" }:
	// packages/effect-acp/src/client.ts:1305, AcpSessionRuntime.ts:2608-2661.
	if (session.cancelled && !scenario.ignoreCancel) return { stopReason: "cancelled" };
	return { stopReason: scenario.stopReason ?? "end_turn", ...(scenario.usage ? { usage: scenario.usage } : {}) };
}

async function handleRequest(method, params) {
	switch (method) {
		case "initialize":
			if (scenario.initializeHang) return new Promise(() => {});
			// Not signed in: -32000 "Authentication required":
			// apps/server/src/provider/antigravityAuthSupport.ts:27-28,167-177.
			if (scenario.initializeError) throw new RpcError(scenario.initializeError.code, scenario.initializeError.message);
			return initializeResult();
		case "session/new":
			if (scenario.sessionNewError) throw new RpcError(scenario.sessionNewError.code, scenario.sessionNewError.message);
			return newSession();
		case "session/set_config_option":
			return setConfigOption(params);
		case "session/set_mode": {
			const session = sessions.get(params.sessionId);
			if (!session?.legacy || !session.legacy.availableModes.includes(params.modeId)) throw new RpcError(-32602, "Invalid mode");
			if (!scenario.rejectModeChange) session.legacy.currentModeId = params.modeId;
			return {};
		}
		case "session/set_model":
			if (!models.list.some((m) => m.value === params.modelId)) throw new RpcError(-32602, "Invalid model");
			models.current = params.modelId;
			return {};
		case "session/prompt":
			return prompt(params);
		case "session/close":
			sessions.delete(params.sessionId);
			return {};
		default:
			throw new RpcError(-32601, `Method not found: ${method}`);
	}
}

function handleNotification(method, params) {
	if (method !== "session/cancel") return;
	const session = sessions.get(params?.sessionId);
	if (!session || scenario.ignoreCancel) return;
	session.cancelled = true;
	for (const resolve of session.cancelWaiters.splice(0)) resolve();
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		log({ kind: "recv", line });
		if (!line.trim()) continue;
		const message = JSON.parse(line);
		if (message.method === undefined) {
			pendingToAgent.get(message.id)?.(message.result ?? { error: message.error });
			pendingToAgent.delete(message.id);
		} else if (message.id === undefined) handleNotification(message.method, message.params);
		else {
			handleRequest(message.method, message.params).then(
				(result) => send({ id: message.id, result }),
				(error) => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
			);
		}
	}
});
process.stdin.on("end", () => { clearInterval(keepAlive); process.exit(0); });
