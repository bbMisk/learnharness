#!/usr/bin/env node
/**
 * Stand-in for Google's `agy acp` in tests. Launched exactly like the real
 * binary (`<path> acp --sandbox`) and speaks the ACP v1 wire shapes over
 * stdio. Its DEFAULT answers mirror a real session captured from agy acp
 * 1.5.15 on 2026-11-23 (tests/fixtures/antigravity/real-agy-1.5.15.json):
 * initialize, session/new (legacy `models`/`modes` blocks beside
 * `configOptions`, mode already "default"), session_info_update, the
 * prompt's usage field names, session/close. Shapes the capture does not
 * contain (tool calls, permission requests, cancel, sign-in) are still
 * reconstructed from T3 Code's source; the file:line above each says where.
 * Scenario `realCapture: <path>` answers with the capture's exact frames.
 *
 * MOCK_AGY_SCENARIO  JSON object scripting the behaviour (fields below).
 * MOCK_AGY_LOG       file that receives one JSON line per event:
 *                    {kind:"start", argv, cwd, envNames, pid}, then
 *                    {kind:"recv", line} for every raw stdin line.
 *
 * Scenario fields (all optional):
 *   stdoutAtStart, stderrAtStart  raw lines written at startup
 *   protocolVersion (1), shape ("v1" | "v2"), systemPromptAppend (true), sessionClose (true)
 *   initializeError {code,message}, initializeHang
 *   sessionNewError {code,message}
 *   mode ("default"; "auto" like older builds; null = no mode option), modeOptions, rejectModeChange
 *   legacyModes {currentModeId, availableModes: [ids]}  (sent as `modes`)
 *   models {style: "flat" | "grouped" | "legacy", current, list: [{value,name}]}
 *   prompt: steps run per session/prompt, in order:
 *     {text} {thought} {echo:true} {toolCall:{...}} {toolCallUpdate:{...}}
 *     {permission:{...toolCall}} {fsRead:true} {sleepMs} {waitForCancel:true}
 *     {hold:true} {exit:code} {stdout:raw} {stderr:raw} {error:{code,message}}
 *     {usageUpdate:true}
 *     {modeUpdate:id} (current_mode_update) {configModeUpdate:value} (config_option_update)
 *     {usageRepeat:{count,everyMs}} {permissionAndToolCall:"permission-first"|"tool-first"}
 *     {toolCallWithResult:true} (a tool_call and the prompt's answer in one write)
 *   stopReason ("end_turn"), usage (result usage object; null = none)
 *   ignoreCancel, ignoreTerm
 * Edge cases (not real-agent shapes, only ways to break the client):
 *   stdoutRawAtStart (written with no newline), garbageAfterInitialize,
 *   toolCallAfterNew {...tool_call} / permissionAfterNew (sent in the same write as the session/new answer),
 *   setConfigError {configId?, code, message}, setModelError {code, message}, hangMethods [method],
 *   modelChangeResetsMode, modeChangeResetsModel, rejectModelChange, modelSetNoOptions,
 *   revertModelAfterSet (a config_option_update undoing the model, in the same write as the answer),
 *   garbageAfterNew (a non-JSON line in the same write as the session/new answer),
 *   fixedSessionId (every session/new answers this id), chunkAfterNew (text sent right after session/new),
 *   steps {emptyRepeat:{count,everyMs}} (empty text chunks)
 */
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

if (process.argv[2] !== "acp") {
	process.stderr.write("mock-agy: refusing to run without the acp subcommand\n");
	process.exit(2);
}

const scenario = process.env.MOCK_AGY_SCENARIO ? JSON.parse(process.env.MOCK_AGY_SCENARIO) : {};
// The real capture, when a test asks for its exact frames.
const real = scenario.realCapture ? JSON.parse(readFileSync(scenario.realCapture, "utf8")) : undefined;
const logFile = process.env.MOCK_AGY_LOG;
const log = (entry) => { if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`); };
log({ kind: "start", argv: process.argv.slice(2), cwd: process.cwd(), envNames: Object.keys(process.env).sort(), pid: process.pid });

if (scenario.ignoreTerm) process.on("SIGTERM", () => log({ kind: "ignored-term" }));
// Keep the process alive while it waits on stdin or held prompts.
const keepAlive = setInterval(() => {}, 60_000);

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const line of scenario.stdoutAtStart ?? []) process.stdout.write(`${line}\n`);
if (scenario.stdoutRawAtStart) process.stdout.write(scenario.stdoutRawAtStart);
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

// initialize result, from the real capture (tests/fixtures/antigravity/real-agy-1.5.15.json, `initialize`):
// protocolVersion 1, the v1 agentInfo/agentCapabilities shapes, snake_case duplicates, append and close
// advertised. Older builds answered protocolVersion 2 with the same v1 shapes (scenario protocolVersion: 2;
// packages/effect-acp/src/client.ts:719-723,1108-1113 in T3 Code).
function initializeResult() {
	if (real) return real.initialize;
	const sessionCapabilities = { resume: {}, ...(scenario.sessionClose === false ? {} : { close: {} }), load: {}, list: {}, additionalDirectories: {} };
	const capabilities = {
		loadSession: true,
		load_session: true,
		promptCapabilities: { image: true, audio: false, embeddedContext: true },
		sessionCapabilities,
		session_capabilities: sessionCapabilities,
		auth: { logout: {} },
		_meta: { antigravity: { tier: true, ...(scenario.systemPromptAppend === false ? {} : { systemPrompt: { append: true } }) } },
	};
	const info = { name: "Antigravity ACP Server", version: "1.5.15" };
	const authMethods = [
		{ id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
		{ id: "oauth-business", name: "Log in with Gemini Enterprise", description: "Log in with your Gemini Enterprise account" },
		{ id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API" },
		{ id: "agent-platform", name: "Gemini Enterprise Agent Platform", description: "Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials" },
	];
	const protocolVersion = scenario.protocolVersion ?? 1;
	if (scenario.shape === "v2") return { protocolVersion, capabilities, authMethods, info };
	return { protocolVersion, agentCapabilities: capabilities, authMethods, agentInfo: info };
}

// session/new result, from the real capture (`sessionNew`): the legacy `models` block (different ids,
// e.g. "gemini-4-neon-high") and `modes` block beside `configOptions`, mode already "default". It is
// followed by an available_commands_update notification.
function newSession() {
	const sessionId = scenario.fixedSessionId ?? randomUUID();
	const session = {
		id: sessionId,
		mode: scenario.mode === undefined ? "default" : scenario.mode,
		modeOptions: scenario.modeOptions ?? ["default", "accept-edits", "auto", "plan"],
		legacy: scenario.legacyModes ? { ...scenario.legacyModes } : undefined,
		cancelled: false,
		cancelWaiters: [],
	};
	sessions.set(sessionId, session);
	if (real) {
		sessions.set(sessionId, { ...session, mode: "default" });
		setTimeout(() => update(sessionId, real.notifications.available_commands_update.params.update), 0);
		return { ...real.sessionNew, sessionId };
	}
	const result = { sessionId, configOptions: configOptions(session) };
	const legacyModes = session.legacy ?? { currentModeId: session.mode ?? "default", availableModes: session.modeOptions };
	result.modes = { currentModeId: legacyModes.currentModeId, availableModes: legacyModes.availableModes.map((id) => ({ id, name: id })) };
	// The real agent's legacy list names other ids than its config option; "legacy" style has only this list.
	const legacyId = (value) => (models.style === "legacy" ? value : `${value}-high`);
	result.models = { currentModelId: legacyId(models.current), availableModels: models.list.map((m) => ({ modelId: legacyId(m.value), name: m.name })) };
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
	// The capture's answer to a model change (`setConfigOption`).
	if (real) return real.setConfigOption;
	const failure = scenario.setConfigError;
	if (failure && (!failure.configId || failure.configId === configId)) throw new RpcError(failure.code, failure.message);
	if (configId === "model" && scenario.modelSetNoOptions) {
		models.current = value;
		return {};
	}
	if (configId === "mode") {
		if (!session.modeOptions.includes(value)) throw new RpcError(-32602, "Invalid mode");
		if (!scenario.rejectModeChange) session.mode = value;
		if (scenario.modeChangeResetsModel) models.current = models.list.find((m) => m.value !== models.current)?.value ?? models.current;
	} else if (configId === "model") {
		if (!models.list.some((m) => m.value === value)) throw new RpcError(-32602, "Invalid model");
		if (!scenario.rejectModelChange) models.current = value;
		if (scenario.modelChangeResetsMode) session.mode = "auto";
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

function permissionParams(sessionId, extra = {}) {
	return {
		sessionId,
		toolCall: { toolCallId: "call-1", title: "Run ls", kind: "execute", status: "pending", rawInput: { command: "ls" }, ...extra },
		options: [
			{ optionId: "remember-this-command", name: "Allow always", kind: "allow_always" },
			{ optionId: "run-this-time", name: "Allow", kind: "allow_once" },
			{ optionId: "stop-this-command", name: "Deny", kind: "reject_once" },
		],
	};
}

/** Two messages in ONE stdout write, so the client sees them in one chunk. */
function writeTogether(...messages) {
	process.stdout.write(messages.map((message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`).join(""));
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
	const myId = requestId;
	const session = sessions.get(sessionId);
	if (!session) throw new RpcError(-32602, "Unknown session");
	const steps = real
		? ["usage_update", "config_option_update", "session_info_update", "agent_message_chunk", "usage_update"].map((kind) => ({ realUpdate: kind }))
		: scenario.prompt ?? [{ text: "Hello" }, { text: " world" }, { usageUpdate: true }];
	// Every real reply carries a session_info_update (a generated title; capture `notifications`).
	if (!real && !scenario.noSessionInfo) update(sessionId, { sessionUpdate: "session_info_update", title: "<generated title>" });
	const lastText = [...(blocks ?? [])].reverse().find((block) => block.type === "text")?.text ?? "";
	for (const step of steps) {
		if (session.cancelled && !scenario.ignoreCancel) break;
		if (step.realUpdate) update(sessionId, real.notifications[step.realUpdate].params.update);
		else if (step.text !== undefined) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } });
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
		else if (step.toolCallWithResult) {
			// The tool_call and the prompt's own answer in one write.
			const tool = { method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "call-3", title: "Late tool", kind: "read" } } };
			return { [RAW]: [tool, { id: myId, result: { stopReason: "end_turn" } }].map((m) => `${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`).join("") };
		}
		else if (step.modeUpdate) update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: step.modeUpdate });
		else if (step.configModeUpdate) { session.mode = step.configModeUpdate; update(sessionId, { sessionUpdate: "config_option_update", configOptions: configOptions(session) }); }
		else if (step.emptyRepeat) {
			for (let i = 0; i < step.emptyRepeat.count; i++) { update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }); await sleep(step.emptyRepeat.everyMs); }
		} else if (step.usageRepeat) {
			for (let i = 0; i < step.usageRepeat.count; i++) { update(sessionId, { sessionUpdate: "usage_update", used: i, size: 1_000_000 }); await sleep(step.usageRepeat.everyMs); }
		} else if (step.permissionAndToolCall) {
			const id = `mock-${nextOwnId++}`;
			const answer = new Promise((resolve) => pendingToAgent.set(id, resolve));
			const permission = { id, method: "session/request_permission", params: permissionParams(sessionId) };
			const tool = { method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "call-2", title: "Read notes", kind: "read", status: "pending" } } };
			if (step.permissionAndToolCall === "tool-first") writeTogether(tool, permission);
			else writeTogether(permission, tool);
			log({ kind: "permission-answer", answer: await answer });
		}
	}
	// session/cancel is a notification; the open prompt then resolves { stopReason: "cancelled" }:
	// packages/effect-acp/src/client.ts:1305, AcpSessionRuntime.ts:2608-2661.
	if (session.cancelled && !scenario.ignoreCancel) return { stopReason: "cancelled" };
	if (real) return real.promptResult;
	// The real result's usage field names (capture `promptResult`).
	const usage = scenario.usage === undefined
		? { inputTokens: 9684, outputTokens: 60, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 59, totalTokens: 9744 }
		: scenario.usage;
	return { stopReason: scenario.stopReason ?? "end_turn", ...(usage ? { usage } : {}) };
}

const RAW = Symbol("raw stdout");
let requestId;

async function handleRequest(method, params) {
	if ((scenario.hangMethods ?? []).includes(method)) return new Promise(() => {});
	switch (method) {
		case "initialize":
			if (scenario.initializeHang) return new Promise(() => {});
			if (scenario.garbageAfterInitialize) return { [RAW]: `${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: initializeResult() })}\nnot json at all\n` };
			// Not signed in: -32000 "Authentication required":
			// apps/server/src/provider/antigravityAuthSupport.ts:27-28,167-177.
			if (scenario.initializeError) throw new RpcError(scenario.initializeError.code, scenario.initializeError.message);
			return initializeResult();
		case "session/new": {
			if (scenario.sessionNewError) throw new RpcError(scenario.sessionNewError.code, scenario.sessionNewError.message);
			const result = newSession();
			const early = scenario.toolCallAfterNew
				? { method: "session/update", params: { sessionId: result.sessionId, update: { sessionUpdate: "tool_call", ...scenario.toolCallAfterNew } } }
				: scenario.chunkAfterNew !== undefined
				? { method: "session/update", params: { sessionId: result.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: scenario.chunkAfterNew } } } }
				: scenario.permissionAfterNew ? { id: `mock-${nextOwnId++}`, method: "session/request_permission", params: permissionParams(result.sessionId) } : undefined;
			if (scenario.garbageAfterNew) return { [RAW]: `${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\nnot json after session/new\n` };
			if (early) {
				if (early.id) pendingToAgent.set(early.id, (answer) => log({ kind: "permission-answer", answer }));
				return { [RAW]: [{ id: requestId, result }, early].map((message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`).join("") };
			}
			return result;
		}
		case "session/set_config_option": {
			const answer = setConfigOption(params);
			if (scenario.revertModelAfterSet && params.configId === "model") {
				// The answer, then (same write) an update putting the old model back.
				const session = sessions.get(params.sessionId);
				const previous = models.current;
				models.current = models.list.find((m) => m.value !== previous)?.value ?? previous;
				const revert = { method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) } } };
				return { [RAW]: [{ id: requestId, result: answer }, revert].map((m) => `${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`).join("") };
			}
			return answer;
		}
		case "session/set_mode": {
			const session = sessions.get(params.sessionId);
			if (!session?.legacy || !session.legacy.availableModes.includes(params.modeId)) throw new RpcError(-32602, "Invalid mode");
			if (!scenario.rejectModeChange) session.legacy.currentModeId = params.modeId;
			return {};
		}
		case "session/set_model":
			if (scenario.setModelError) throw new RpcError(scenario.setModelError.code, scenario.setModelError.message);
			if (!models.list.some((m) => m.value === params.modelId)) throw new RpcError(-32602, "Invalid model");
			models.current = params.modelId;
			return {};
		case "session/prompt":
			return prompt(params);
		case "session/close":
			// The real agent answers {} (checked live, 1.5.15).
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
			requestId = message.id;
			handleRequest(message.method, message.params).then(
				(result) => (result && result[RAW] ? process.stdout.write(result[RAW]) : send({ id: message.id, result })),
				(error) => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
			);
		}
	}
});
process.stdin.on("end", () => { clearInterval(keepAlive); process.exit(0); });
