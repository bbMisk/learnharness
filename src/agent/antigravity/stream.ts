/**
 * One Antigravity turn as a pi stream function (the shape of
 * claude-code/stream.ts): an agent session on the shared process (fresh, or
 * the chat's parked one), approval mode pinned to "default" (fail closed),
 * the requested model, the replayed transcript as text, and streamed text
 * back. The agent gets no tool of its own: any attempt to use one stops the
 * reply. A lesson's declared LearnHarness tools reach it through the
 * loopback MCP bridge (tool-bridge.ts); a call it makes ends the pi stream
 * with "toolUse" while the agent's prompt stays open, waiting for the result.
 */
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type ThinkingLevel,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";

import { AcpTransportError, isRecord, stripUrls } from "./acp-client.ts";
import { AntigravityMessage, breachMessage, toolBreachMessage } from "./constants.ts";
import { antigravityHost, type AntigravityHost } from "./host.ts";
import { findConfigOption, levelsFrom, modelsFrom } from "./models.ts";
import { antigravityRuntime, antigravityTimeouts, describeAgentError, isValueRefusal, rejectOnce, type AgentConnection, type AntigravityRuntime, type SessionListener } from "./runtime.ts";
import { antigravityReuseOn, antigravityToolsOn } from "../../core/fork-config.ts";
import { AGENT_TOOL_PREFIX, ToolBridge, type EndpointHooks, type HeldCall, type SessionEndpoint } from "./tool-bridge.ts";
import { declaredTools, fingerprintHash, replayAssistant, reuseTailParts, toAntigravityInput, toPromptBlocks, type AntigravityInput, type Part, type PromptBlock, type SeenFingerprint } from "./transcript.ts";

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

class AntigravityTurn {
	readonly output: AssistantMessage;
	finished = false;
	private started = false;
	private open: { kind: "text" | "thinking"; index: number } | null = null;
	private readonly ended: (() => void)[] = [];

	constructor(private readonly stream: AssistantMessageEventStream, model: Model<Api>) {
		this.output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	delta(kind: "text" | "thinking", delta: string): void {
		if (this.finished || !delta) return;
		this.start();
		if (this.open?.kind !== kind) {
			this.closeBlock();
			const index = this.output.content.length;
			this.output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			this.open = { kind, index };
			this.stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: this.output });
		}
		const block = this.output.content[this.open.index]!;
		if (block.type === "text") block.text += delta;
		else if (block.type === "thinking") block.thinking += delta;
		this.stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: this.open.index, delta, partial: this.output });
	}

	/** Per-turn counts. The agent's inputTokens leaves out cached reads; outputTokens includes thought tokens. */
	setUsage(usage: unknown): void {
		if (!isRecord(usage)) return;
		const target = this.output.usage;
		target.input = count(usage.inputTokens);
		target.output = count(usage.outputTokens);
		target.cacheRead = count(usage.cachedReadTokens);
		target.cacheWrite = count(usage.cachedWriteTokens);
		target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
	}

	/**
	 * After tool rounds: the prompt's output and cache reads, with input making the message's total the
	 * context size the agent last reported (never negative). LearnHarness reads the last message's
	 * buckets as the context size, so a sum over the prompt's model rounds must never land on one message.
	 */
	setContextUsage(usage: unknown, used: number): void {
		const target = this.output.usage;
		const record = isRecord(usage) ? usage : {};
		target.output = count(record.outputTokens);
		target.cacheRead = count(record.cachedReadTokens);
		target.cacheWrite = 0;
		target.input = Math.max(0, used - target.output - target.cacheRead);
		target.totalTokens = target.input + target.output + target.cacheRead;
	}

	finish(reason: "stop" | "length"): void {
		if (this.finished) return;
		this.start();
		this.closeBlock();
		this.finished = true;
		this.output.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.output });
		this.end();
	}

	/** End this stream with one tool call for pi to run. */
	toolUse(call: ToolCall): void {
		if (this.finished) return;
		this.start();
		this.closeBlock();
		const contentIndex = this.output.content.length;
		this.output.content.push(call);
		this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
		this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		this.finished = true;
		this.output.stopReason = "toolUse";
		this.stream.push({ type: "done", reason: "toolUse", message: this.output });
		this.end();
	}

	/** Run `fn` once the stream has ended (at once if it has). */
	onEnd(fn: () => void): void {
		if (this.finished) fn();
		else this.ended.push(fn);
	}

	/** Text already streamed stays in the partial message. */
	fail(message: string, reason: "aborted" | "error" = "error"): void {
		if (this.finished) return;
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.end();
	}

	private end(): void {
		this.stream.end();
		for (const fn of this.ended.splice(0)) fn();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeBlock(): void {
		if (!this.open) return;
		const { kind, index } = this.open;
		const block = this.output.content[index]!;
		this.open = null;
		if (kind === "text" && block.type === "text") this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
		if (kind === "thinking" && block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
	}
}

class StopTurn extends Error {}

/** Test seam: the most text + thinking one reply may stream. */
export const antigravityLimits = { replyBytes: 4 * 1024 * 1024 };

let saveFailureLogged = false;

/** A tool's title or kind for the breach message: no links, no control characters, capped. */
function safeLabel(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = stripUrls(value).replace(/\[link removed\]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	return text.slice(0, 120).trim();
}

/** At most this many parked sessions per agent process; the least recently used is closed first. */
export const MAX_PARKED_SESSIONS = 8;

/**
 * One agent session: its config view (kept while parked, so a later turn starts from the freshest
 * state) and its routing. The connection routes the session to `target`: the turn using it, or
 * the parked handler between turns. A session is used by one turn at a time.
 */
class AgentSession {
	/** The session's config options as the agent last stated them (session/new, every set answer, every update). */
	private options: unknown[] = [];
	/** The frame `options` came from: an answer read before a later update never overwrites it. */
	private optionsFrame = -1;
	/** A current_mode_update, kept apart with its own frame: it changes the view only while it is newer than `options`. */
	private modeOverride: { value: string; frame: number } | undefined;
	target: SessionListener | undefined;
	/** What the agent has seen, set when the session is parked. */
	seen: SeenFingerprint | undefined;
	/** The thinking level the agent picks for this session's model by itself (read before any level was set). */
	defaultLevel: string | undefined;
	/** The level the last turn set and confirmed, or undefined when it left the agent's default. */
	appliedLevel: string | undefined;
	poisoned = false;
	closed = false;
	/** The session's MCP endpoint and the plain names of the tools it was given, if any (fixed for its life). */
	tools: { endpoint: SessionEndpoint; names: ReadonlySet<string> } | undefined;
	/** Where the endpoint's calls go: the turn using the session, or the park. */
	calls: EndpointHooks | undefined;
	private stopWatching: (() => void) | undefined;

	constructor(readonly connection: AgentConnection, readonly sessionId: string) {}

	/** Whether `name` (as the agent reports it) is one of the tools this session was given. */
	isOurs(name: unknown): boolean {
		return typeof name === "string" && name.startsWith(AGENT_TOOL_PREFIX) && !!this.tools?.names.has(name.slice(AGENT_TOOL_PREFIX.length));
	}

	/** Start routing (throws for an id another turn already watches; then nothing was taken). Early updates replay into `target`. */
	watch(target: SessionListener): void {
		this.target = target;
		this.stopWatching = this.connection.watch(this.sessionId, {
			onUpdate: (update, frame) => this.target?.onUpdate(update, frame),
			onPermissionRequest: (params) => (this.target ? this.target.onPermissionRequest(params) : rejectOnce(params)),
			onClosed: (error) => this.target?.onClosed(error),
		});
	}

	/** The options as the agent last stated them, with a newer mode update applied on top. */
	view(): unknown[] {
		const override = this.modeOverride;
		if (!override || override.frame < this.optionsFrame) return this.options;
		return this.options.map((option) => (isRecord(option) && (option.id === "mode" || option.category === "mode") ? { ...option, currentValue: override.value } : option));
	}

	/** Returns whether the options were taken (false: not options, or older than the current view). */
	observe(configOptions: unknown, frame: number): boolean {
		if (!Array.isArray(configOptions) || frame < this.optionsFrame) return false;
		this.options = configOptions;
		this.optionsFrame = frame;
		return true;
	}

	observeMode(modeId: unknown, frame: number): void {
		if (typeof modeId === "string" && frame >= (this.modeOverride?.frame ?? -1)) this.modeOverride = { value: modeId, frame };
	}

	/** Stop routing and close it on the agent (when the agent supports that). Never parked again. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.target = undefined;
		this.calls = undefined;
		this.stopWatching?.();
		const endpoint = this.tools?.endpoint;
		endpoint?.failHeld("The session ended.");
		let closing: Promise<unknown> = Promise.resolve();
		if (this.connection.handshake.sessionClose && this.connection.alive) {
			closing = this.connection.request("session/close", { sessionId: this.sessionId }, antigravityTimeouts.startupMs).catch(() => { /* dropped either way */ });
		}
		// After session/close, so the agent's own disconnect (DELETE) still finds its endpoint.
		if (endpoint) void closing.then(() => endpoint.close());
	}
}

/** The parked sessions of one agent process, by pi session id (the chat), least recently used first. */
class SessionPark {
	private readonly parked = new Map<string, AgentSession>();

	/** Take the session parked under `key` if `fits` says it can continue; any other parked one is closed. */
	take(key: string, fits: (session: AgentSession) => Part[] | null): { session: AgentSession; tail: Part[] } | undefined {
		const session = this.parked.get(key);
		if (!session) return undefined;
		this.parked.delete(key);
		const tail = !session.poisoned && !session.closed && session.connection.alive ? fits(session) : null;
		if (tail === null) { session.close(); return undefined; }
		return { session, tail };
	}

	/** Park after a clean turn. The last clean finisher for a key wins; the one it replaces is closed. */
	put(key: string, session: AgentSession): void {
		const previous = this.parked.get(key);
		if (previous && previous !== session) previous.close();
		this.parked.delete(key);
		this.parked.set(key, session);
		session.target = {
			onUpdate: (update, frame) => this.whileParked(key, session, update, frame),
			// The reject answer is written when this returns; the close follows after it (poison defers it).
			onPermissionRequest: (params) => { this.poison(key, session); return rejectOnce(params); },
			onClosed: () => this.drop(key, session),
		};
		// A parked session has no open prompt: any MCP call is the agent acting on its own.
		session.calls = {
			onCall: () => { this.poison(key, session); return false; },
			onAbort: () => {},
			onInvalid: () => this.poison(key, session),
		};
		while (this.parked.size > MAX_PARKED_SESSIONS) {
			const [oldestKey, oldest] = this.parked.entries().next().value!;
			this.parked.delete(oldestKey);
			oldest.close();
		}
	}

	get size(): number { return this.parked.size; }

	private whileParked(key: string, session: AgentSession, update: Record<string, unknown>, frame: number): void {
		switch (update.sessionUpdate) {
			case "tool_call":
			case "tool_call_update":
				this.poison(key, session);
				return;
			case "config_option_update":
				// An update LearnHarness can't read leaves the session's state unknown.
				if (!Array.isArray(update.configOptions)) this.poison(key, session);
				else session.observe(update.configOptions, frame);
				return;
			case "current_mode_update":
				if (typeof update.currentModeId !== "string") this.poison(key, session);
				else session.observeMode(update.currentModeId, frame);
				return;
			case "agent_message_chunk":
			case "agent_thought_chunk":
				// Anything the agent says outside a prompt is something no transcript holds.
				if (saysSomething(update)) this.poison(key, session);
				return;
			default:
				return; // usage and the like: ignored while parked
		}
	}

	/**
	 * The agent acted while nobody was asking: never use this session again. It leaves the park at
	 * once; the close waits until the current stdout chunk is handled, so a permission answer (and
	 * anything else in that chunk for this session) is still routed here and written first.
	 */
	private poison(key: string, session: AgentSession): void {
		session.poisoned = true;
		this.drop(key, session);
		setImmediate(() => session.close());
	}

	private drop(key: string, session: AgentSession): void {
		if (this.parked.get(key) === session) this.parked.delete(key);
	}
}

/** A message or thought chunk with anything in it: non-empty text, or content that isn't text. */
function saysSomething(update: Record<string, unknown>): boolean {
	const content = isRecord(update.content) ? update.content : undefined;
	return !(content?.type === "text" && content.text === "");
}

const parks = new WeakMap<AgentConnection, SessionPark>();
function parkFor(connection: AgentConnection): SessionPark {
	let park = parks.get(connection);
	if (!park) { park = new SessionPark(); parks.set(connection, park); }
	return park;
}

/** Parked sessions on this connection (tests). */
export function parkedSessionCount(connection: AgentConnection): number {
	return parks.get(connection)?.size ?? 0;
}

/** One tool bridge per agent process, started for its first tool-carrying session, closed with it. */
const bridges = new WeakMap<AgentConnection, Promise<ToolBridge>>();
const startedBridges = new WeakMap<AgentConnection, ToolBridge>();
function bridgeFor(connection: AgentConnection): Promise<ToolBridge> {
	let bridge = bridges.get(connection);
	if (!bridge) {
		bridge = ToolBridge.start();
		bridges.set(connection, bridge);
		bridge.then((started) => {
			startedBridges.set(connection, started);
			void connection.closed.then(() => started.close());
		}, () => bridges.delete(connection));
	}
	return bridge;
}

/** The tool bridge of this connection, if one was started (tests). */
export function toolBridgeOf(connection: AgentConnection): ToolBridge | undefined {
	return startedBridges.get(connection);
}

/** Prompts waiting for a held tool call's result, by chat key, per agent process. */
const waitingTurns = new WeakMap<AgentConnection, Map<string, TurnSession>>();
function waitingOn(connection: AgentConnection): Map<string, TurnSession> {
	let waiting = waitingTurns.get(connection);
	if (!waiting) { waiting = new Map(); waitingTurns.set(connection, waiting); }
	return waiting;
}

/** Prompts waiting for a tool result on this connection (tests). */
export function waitingTurnCount(connection: AgentConnection): number {
	return waitingTurns.get(connection)?.size ?? 0;
}

type AgentMessages = Parameters<typeof toAntigravityInput>[0];

/**
 * The session part of one PROMPT: setup, the prompt, routing and every way it can stop. A prompt
 * streams into one pi stream at a time: when the agent calls a LearnHarness tool, that stream ends
 * with "toolUse" and the prompt WAITS (open, no stream attached, holding the process) until the
 * next stream call for the chat brings exactly that call's result and attaches (resume), or it
 * expires.
 */
class TurnSession {
	private sessionId: string | undefined;
	private prompt: Promise<unknown> | undefined;
	private cancelling = false;
	/** run() has returned: nothing more may be sent for this session. */
	private done = false;
	private replyBytes = 0;
	private inactivity: NodeJS.Timeout | undefined;
	/** The agent session this turn uses (fresh or reused). */
	private agent: AgentSession | undefined;
	/** This turn is on a reused session and has not sent its prompt yet. */
	private reusing = false;
	/** The reused session spoke before this turn's prompt: abandon it for a fresh one. */
	private abandonReuse = false;
	/** The agent produced something this turn did not capture: the session is not parked. */
	private unseenOutput = false;
	/** The request the attached stream answers (replaced on resume). */
	private model!: Model<Api>;
	private input!: AntigravityInput;
	private key: string | undefined;
	/** The tools this prompt's session is given (none: text-only, exactly as without tools support). */
	private tools: readonly Tool[] = [];
	/** A permission LearnHarness granted, for the one MCP call it allows. */
	private allowance: { name: string; toolCallId: unknown } | undefined;
	/** The MCP call the agent is blocked on, from its arrival until its result is handed over. */
	private held: { call: HeldCall; toolCallId: unknown } | undefined;
	/** Set while waiting: what the agent has seen, and the expiry timer. */
	private waiting: { seen: SeenFingerprint; timer: NodeJS.Timeout } | undefined;
	private expired = false;
	/** Tool rounds this prompt has had (each ended a pi stream with "toolUse"). */
	private toolRounds = 0;
	/** The context size (usage_update.used) the agent last reported: in the attached stream, and in the whole prompt. */
	private streamUsed: number | undefined;
	private promptUsed: number | undefined;

	constructor(
		private readonly connection: AgentConnection,
		/** The pi stream the prompt streams into now. */
		private turn: AntigravityTurn,
		private readonly host: AntigravityHost,
	) {}

	/** The learner pressed Stop on `turn`'s request. A stream this prompt has moved past is ignored. */
	abortFrom(turn: AntigravityTurn): void {
		if (turn !== this.turn) return;
		if (this.waiting) { this.expire(); return; }
		this.turn.fail(AntigravityMessage.Aborted, "aborted");
		if (this.prompt) this.cancel();
	}

	async run(model: Model<Api>, messages: AgentMessages, reasoning?: ThinkingLevel, rawKey?: string): Promise<void> {
		const { connection } = this;
		// Reuse only with a session key (the chat) and the switch on; otherwise exactly one fresh session per turn.
		const key = rawKey ? rawKey : undefined;
		this.key = key;
		this.model = model;
		// Tools only with a chat key (a held call resumes under it) and the tools switch on.
		this.tools = key !== undefined && antigravityToolsOn() ? declaredTools(messages) : [];
		this.input = toAntigravityInput(messages, this.tools);
		const input = this.input;
		const park = key !== undefined && antigravityReuseOn() ? parkFor(connection) : undefined;
		try {
			let prompt = await this.setUp(model, input, reasoning, park ? { park, key: key! } : undefined);
			if (prompt === null) {
				// The reused session spoke before this turn's prompt: close it and run this turn fresh, once.
				this.agent?.close();
				this.agent = undefined;
				this.sessionId = undefined;
				this.reusing = false;
				this.abandonReuse = false;
				prompt = (await this.setUp(model, input, reasoning, undefined))!;
			}
			const sessionId = this.sessionId!;
			// A reused session gets no session/new to discover a dead connection: check right before its prompt.
			if (this.reusing && !connection.alive) throw connection.failure ?? new AcpTransportError("closed", AntigravityMessage.Exited);
			this.reusing = false;
			this.prompt = connection.request("session/prompt", { sessionId, prompt });
			this.touch();
			const result = await this.prompt;
			this.settle(result);
		} catch (error) {
			if (error instanceof StopTurn) { if (error.message) this.turn.fail(error.message); }
			else this.turn.fail(describeAgentError(error));
		} finally {
			this.done = true;
			clearTimeout(this.inactivity);
			this.leaveWaiting();
			const session = this.agent;
			if (session) {
				// Parked only after a clean "stop" with nothing unseen or held, on a live, unpoisoned session;
				// anything else is closed. The last attached stream's request is what the session has seen.
				if (park && this.turn.output.stopReason === "stop" && !this.unseenOutput && !this.held && !session.poisoned && !session.closed && connection.alive) {
					const seen = [...this.input.messages, replayAssistant(this.turn.output.content)];
					session.seen = { systemText: this.input.systemText, modelId: this.model.id, messages: seen.length, hash: fingerprintHash(seen), toolsHash: this.input.toolsHash };
					park.put(key!, session);
				} else session.close();
			}
		}
	}

	/**
	 * Get a session ready for the prompt: the parked one when it may continue (`reuse`), else a fresh
	 * one; then the fail-closed checks every prompt passes. Returns the prompt blocks, or null when a
	 * reused session spoke during setup and must be abandoned.
	 */
	private async setUp(model: Model<Api>, input: AntigravityInput, reasoning: ThinkingLevel | undefined, reuse: { park: SessionPark; key: string } | undefined): Promise<PromptBlock[] | null> {
		const { connection } = this;
		const append = connection.handshake.systemPromptAppend;
		// Learner images go out as image blocks only with the tools switch on and an agent that takes them.
		const images = antigravityToolsOn() && connection.handshake.promptImages;
		this.checkpoint();
		const reused = reuse?.park.take(reuse.key, (session) => this.fits(session, input, model.id, reasoning));
		let prompt: PromptBlock[];
		if (reused) {
			// The agent already has the system text and everything but the tail.
			this.agent = reused.session;
			this.reusing = true;
			reused.session.target = this.listener;
			reused.session.calls = this.callRoute;
			this.sessionId = reused.session.sessionId;
			prompt = toPromptBlocks(reused.tail, images);
		} else {
			const session = await this.openSession(input, append);
			this.sessionId = session.sessionId;
			const transcript = toPromptBlocks(input.transcriptParts, images);
			prompt = append ? transcript : [{ type: "text", text: input.systemText }, ...transcript];
		}
		const sessionId = this.sessionId!;
		const session = this.agent!;
		this.checkpoint();

		// Every prompt, reused session or not, passes the same fail-closed checks from the freshest view.
		await this.pinDefaultMode(sessionId);
		this.checkpoint();
		await this.selectModel(sessionId, model.id);
		this.checkpoint();
		// A fresh session's own level for this model, before LearnHarness sets one.
		if (!reused) session.defaultLevel = findConfigOption(this.view(), "thought_level")?.currentValue;
		const level = await this.pinThinkingLevel(sessionId, reasoning);
		this.checkpoint();
		session.appliedLevel = level;
		// The freshest view decides: a change made while setting another option is caught here.
		if (findConfigOption(this.view(), "mode")?.currentValue !== "default") throw new StopTurn(AntigravityMessage.ModeNotSet);
		if (findConfigOption(this.view(), "model")?.currentValue !== model.id) throw new StopTurn(AntigravityMessage.ModelUnavailable);
		if (level !== undefined && findConfigOption(this.view(), "thought_level")?.currentValue !== level) throw new StopTurn(AntigravityMessage.LevelNotSet);
		if (this.abandonReuse) return null;
		// This turn may refresh the levels of the model it selected (only that one), from what it already received.
		this.refreshModels(this.view(), model.id);
		return prompt;
	}

	/** session/new, with this prompt's tools on a new bridge endpoint when it has any; the session becomes this turn's. */
	private async openSession(input: AntigravityInput, append: boolean): Promise<AgentSession> {
		const { connection } = this;
		let endpoint: SessionEndpoint | undefined;
		// The endpoint routes through the session once there is one; nothing is accepted before.
		let owner: AgentSession | undefined;
		if (this.tools.length) {
			endpoint = await (await bridgeFor(connection)).open(this.tools, {
				onCall: (call) => owner?.calls?.onCall(call) ?? false,
				onAbort: (call) => owner?.calls?.onAbort(call),
				onInvalid: (reason) => owner?.calls?.onInvalid(reason),
			});
		}
		try {
			this.checkpoint();
			const { result: created, frame } = await connection.setupRequestStamped("session/new", {
				cwd: connection.workspace,
				mcpServers: endpoint ? [endpoint.mcpServer] : [],
				...(append ? { _meta: { antigravity: { systemPrompt: { append: input.systemText } } } } : {}),
			});
			// A malformed answer breaks the protocol for the whole connection, not just this turn.
			if (!isRecord(created) || typeof created.sessionId !== "string" || !created.sessionId) throw connection.failProtocol();
			// Killed while the answer was in flight: nothing from it is saved.
			if (!connection.alive) throw connection.failure ?? new AcpTransportError("closed", AntigravityMessage.Exited);
			const session = new AgentSession(connection, created.sessionId);
			session.observe(created.configOptions, frame);
			this.refreshModels(created.configOptions);
			if (endpoint) session.tools = { endpoint, names: new Set(this.tools.map((tool) => tool.name)) };
			session.calls = this.callRoute;
			// Replays what arrived before this point (a breach, newer options), so an early tool_call still
			// stops the turn. Throws for an id another turn already watches: this turn then owns nothing.
			this.agent = session;
			try { session.watch(this.listener); }
			catch (error) { this.agent = undefined; throw error; }
			owner = session;
			return session;
		} catch (error) {
			void endpoint?.close();
			throw error;
		}
	}

	/**
	 * The tail to send when `session` may continue this conversation, else null. Besides the transcript
	 * rule (reuseTail), the thinking level in force must be what a fresh session would run at: the
	 * requested level when the session offers it (it is then set and confirmed), otherwise the
	 * agent's own default for the model.
	 */
	private fits(session: AgentSession, input: AntigravityInput, modelId: string, reasoning: ThinkingLevel | undefined): Part[] | null {
		if (!session.seen) return null;
		const tail = reuseTailParts(session.seen, input, modelId);
		if (tail === null) return null;
		const option = findConfigOption(session.view(), "thought_level");
		const offered = reasoning !== undefined && !!option?.values.some((value) => value.id === reasoning);
		if (!offered) {
			if (session.appliedLevel !== undefined && session.appliedLevel !== session.defaultLevel) return null;
			if (option?.currentValue !== session.defaultLevel) return null;
		}
		return tail;
	}

	/** Between setup steps: stop quietly if the turn already ended (abort, crash, breach). */
	private checkpoint(): void {
		if (this.turn.finished) throw new StopTurn("");
	}

	private view(): unknown[] {
		return this.agent?.view() ?? [];
	}

	private observe(configOptions: unknown, frame: number): boolean {
		return this.agent?.observe(configOptions, frame) ?? false;
	}

	/** This turn's routing for its agent session. */
	private readonly listener: SessionListener = {
		onUpdate: (update, frame) => this.onUpdate(update, frame),
		onPermissionRequest: (params) => this.onPermission(params),
		onClosed: (error) => this.turn.fail(error.message),
	};

	/** This turn's routing for its session's MCP endpoint. */
	private readonly callRoute: EndpointHooks = {
		onCall: (call) => this.onToolCall(call),
		onAbort: (call) => {
			// The agent gave up on the held call (its own limit, or a cancel): the round can't complete.
			if (this.held?.call.id !== call.id) return;
			this.held = undefined;
			if (this.waiting) this.expire();
		},
		onInvalid: () => this.refuseCall(),
	};

	/** One session/set_config_option as a setup request; its answer updates the view. A refusal of the
	 *  value fails the turn with `refused`; sign-in and account problems keep their own message. */
	private async setOption(sessionId: string, configId: string, value: string, refused: string): Promise<void> {
		try {
			const { result: updated, frame } = await this.connection.setupRequestStamped("session/set_config_option", { sessionId, configId, value });
			// Killed while the answer was in flight (the sign-in line, a bad line): report that, use nothing from it.
			if (!this.connection.alive) throw this.connection.failure ?? new AcpTransportError("closed", AntigravityMessage.Exited);
			this.observe(isRecord(updated) ? updated.configOptions : undefined, frame);
		} catch (error) {
			if (isValueRefusal(error)) throw new StopTurn(refused);
			throw error;
		}
	}

	/** Mode "default" from a mode config option, or the turn fails closed. */
	private async pinDefaultMode(sessionId: string): Promise<void> {
		const mode = findConfigOption(this.view(), "mode");
		if (!mode || !mode.values.some((value) => value.id === "default")) throw new StopTurn(AntigravityMessage.ModeNotSet);
		if (mode.currentValue !== "default") await this.setOption(sessionId, mode.configId, "default", AntigravityMessage.ModeNotSet);
	}

	/** The requested model from a model config option, or the turn fails closed. */
	private async selectModel(sessionId: string, modelId: string): Promise<void> {
		const option = findConfigOption(this.view(), "model");
		if (!option || !option.values.some((value) => value.id === modelId)) throw new StopTurn(AntigravityMessage.ModelUnavailable);
		if (option.currentValue !== modelId) await this.setOption(sessionId, option.configId, modelId, AntigravityMessage.ModelUnavailable);
	}

	/**
	 * The thinking level pi asked for, by its own name, when the current view offers it for the
	 * selected model. Not offered: nothing is sent and the agent's default stays. Returns the
	 * value that must be confirmed before the prompt, if any.
	 */
	private async pinThinkingLevel(sessionId: string, requested: ThinkingLevel | undefined): Promise<string | undefined> {
		if (!requested) return undefined;
		const option = findConfigOption(this.view(), "thought_level");
		if (!option || !option.values.some((value) => value.id === requested)) return undefined;
		if (option.currentValue !== requested) await this.setOption(sessionId, option.configId, requested, AntigravityMessage.LevelNotSet);
		return requested;
	}

	/** Save the models these options list; with `selected`, also that model's levels as the options show them now. */
	private refreshModels(configOptions: unknown, selected?: string): void {
		const listed = modelsFrom({ configOptions });
		if (!listed?.length) return;
		const models = selected === undefined ? listed : listed.map((model) => (model.id === selected ? { ...model, ...levelsFrom(configOptions) } : model));
		try { this.host.saveModels(models); }
		catch {
			// A full disk must not fail the turn; the list is refreshed again on the next session.
			if (!saveFailureLogged) { saveFailureLogged = true; console.error("Antigravity: could not save the model list."); }
		}
	}

	private onUpdate(update: Record<string, unknown>, frame: number): void {
		if (this.waiting) { this.whileWaiting(update, frame); return; }
		if (this.turn.finished) return;
		const content = isRecord(update.content) ? update.content : undefined;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk": {
				const text = content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
				// Nothing is shown before this turn's own prompt. Said there, it disqualifies the session:
				// a reused one is abandoned for a fresh one, a fresh one is not parked afterwards.
				if (!this.prompt) {
					if (text !== "") { if (this.reusing) this.abandonReuse = true; else this.unseenOutput = true; }
					return;
				}
				// Non-text content: the turn may finish, but the session saw something its transcript won't hold.
				if (text === undefined) { this.unseenOutput = true; return; }
				// Only non-empty text is progress.
				if (text === "") return;
				this.touch();
				this.replyBytes += Buffer.byteLength(text);
				if (this.replyBytes > antigravityLimits.replyBytes) { this.stopReply(AntigravityMessage.TooLong); return; }
				this.turn.delta(update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", text);
				return;
			}
			case "tool_call":
			case "tool_call_update":
				// One of this session's LearnHarness tools, during the prompt: the agent announcing its call.
				if (this.prompt && this.agent?.isOurs(update.name)) {
					// The allowed call ended without reaching the bridge: the allowance goes with it.
					if (this.allowance && update.toolCallId === this.allowance.toolCallId && (update.status === "completed" || update.status === "failed")) this.allowance = undefined;
					this.touch();
					return;
				}
				this.breach(update);
				return;
			case "current_mode_update":
				this.agent?.observeMode(update.currentModeId, frame);
				if (this.prompt && update.currentModeId !== "default") this.stopReply(AntigravityMessage.ModeChanged);
				return;
			case "config_option_update": {
				// Only an update that was taken may be saved: a stale one would put an old list back.
				if (this.observe(update.configOptions, frame)) this.refreshModels(update.configOptions);
				if (this.prompt && findConfigOption(this.view(), "mode")?.currentValue !== "default") this.stopReply(AntigravityMessage.ModeChanged);
				return;
			}
			case "usage_update":
				this.noteUsed(update.used);
				return; // no progress, no reset
			default:
				return; // available_commands_update, anything unknown: no progress, no reset
		}
	}

	/**
	 * While waiting the agent is blocked on the held call and should say nothing. Anything it does
	 * besides usage reports means the round can't be trusted to resume: expire. Updates for the held
	 * call itself may still arrive (stdout and the MCP request are separate channels).
	 */
	private whileWaiting(update: Record<string, unknown>, frame: number): void {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk":
				if (saysSomething(update)) this.expire();
				return;
			case "tool_call":
			case "tool_call_update": {
				const own = this.held !== undefined && update.toolCallId === this.held.toolCallId && this.agent?.isOurs(update.name) && (update.status === "pending" || update.status === "in_progress");
				if (!own) this.expire();
				return;
			}
			case "current_mode_update":
				this.agent?.observeMode(update.currentModeId, frame);
				this.expire();
				return;
			case "config_option_update":
				if (!Array.isArray(update.configOptions)) { this.expire(); return; }
				this.observe(update.configOptions, frame);
				if (findConfigOption(this.view(), "mode")?.currentValue !== "default") this.expire();
				return;
			case "usage_update":
				this.noteUsed(update.used);
				return;
			default:
				return; // other harmless kinds
		}
	}

	/**
	 * Fail closed: allowed only for one of this session's tools, by its exact agent name, while this
	 * prompt is open and streaming with no call allowed or held, by selecting the allow_once option
	 * (never an "always" one). Everything else is rejected and stops the reply.
	 */
	private onPermission(params: Record<string, unknown>): unknown {
		const call = isRecord(params.toolCall) ? params.toolCall : {};
		if (this.waiting) { this.expire(); return rejectOnce(params); }
		if (this.prompt && !this.turn.finished && !this.held && !this.allowance && this.agent?.isOurs(call.name)) {
			const options = Array.isArray(params.options) ? params.options : [];
			const allow = options.find((option) => isRecord(option) && option.kind === "allow_once" && typeof option.optionId === "string") as { optionId: string } | undefined;
			if (allow) {
				this.allowance = { name: (call.name as string).slice(AGENT_TOOL_PREFIX.length), toolCallId: call.toolCallId };
				this.touch();
				return { outcome: { outcome: "selected", optionId: allow.optionId } };
			}
		}
		this.breach(call);
		return rejectOnce(params);
	}

	/** Any tool use LearnHarness did not grant stops the reply. */
	private breach(call: Record<string, unknown>): void {
		const what = [call.title, call.kind].map(safeLabel).find((value) => value !== "");
		this.stopReply(this.agent?.tools ? toolBreachMessage(what ?? "a tool") : breachMessage(what ?? "a tool"));
	}

	/**
	 * An MCP call for one of this session's tools. Valid only as the call the last permission allowed,
	 * while a stream is attached and nothing is held: it becomes pi's tool call, the stream ends with
	 * "toolUse", and the prompt waits. Anything else is refused and ends the turn.
	 */
	private onToolCall(call: HeldCall): boolean {
		const allowance = this.allowance;
		this.allowance = undefined;
		if (this.waiting || this.held || !this.prompt || this.turn.finished || this.done || allowance?.name !== call.name) {
			this.refuseCall();
			return false;
		}
		this.held = { call, toolCallId: allowance.toolCallId };
		clearTimeout(this.inactivity);
		this.toolRounds++;
		// This stream's message carries only the context size it saw: never a sum over model rounds.
		const usage = this.turn.output.usage;
		usage.input = this.streamUsed ?? 0;
		usage.totalTokens = usage.input;
		this.turn.toolUse({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
		const seen = [...this.input.messages, replayAssistant(this.turn.output.content)];
		const timer = setTimeout(() => this.expire(), antigravityTimeouts.toolWaitMs);
		timer.unref();
		this.waiting = { seen: { systemText: this.input.systemText, modelId: this.model.id, messages: seen.length, hash: fingerprintHash(seen), toolsHash: this.input.toolsHash }, timer };
		const registry = waitingOn(this.connection);
		const other = registry.get(this.key!);
		if (other && other !== this) other.expire();
		registry.set(this.key!, this);
		return true;
	}

	/** A call LearnHarness won't run: the waiting prompt expires, a streaming one stops. */
	private refuseCall(): void {
		if (this.waiting) this.expire();
		else if (!this.turn.finished) this.stopReply(AntigravityMessage.UnexpectedToolCall);
	}

	/**
	 * Continue the waiting prompt into `turn` when this request is exactly the held call's result:
	 * same model, system text and tools; the conversation the agent has seen, then the assistant
	 * message with that one call, then only its result. Otherwise the prompt expires (the caller then
	 * runs the ordinary path, a fresh session with the full replay). Returns whether it attached.
	 * The thinking level is not compared: the open prompt keeps the level it was confirmed at, and
	 * LearnHarness's answer run can ask for another one (measured: "off" on the question turn,
	 * "medium" on the answer run of the same lesson).
	 */
	resume(turn: AntigravityTurn, model: Model<Api>, messages: AgentMessages): boolean {
		const waiting = this.waiting;
		const held = this.held;
		if (!waiting || !held || this.done || !this.connection.alive) { this.expire(); return false; }
		const tools = antigravityToolsOn() ? declaredTools(messages) : [];
		const input = toAntigravityInput(messages, tools);
		const conversation = messages.filter((message) => message.role !== "system");
		const last = conversation.length - 1;
		const assistant = conversation[last - 1];
		const result = conversation[last];
		const ids = assistant?.role === "assistant" ? assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : [];
		const matches = model.id === this.model.id
			&& input.systemText === waiting.seen.systemText && input.toolsHash === waiting.seen.toolsHash
			&& conversation.length === waiting.seen.messages + 1
			&& ids.length === 1 && ids[0] === held.call.id
			&& result?.role === "toolResult" && result.toolCallId === held.call.id
			&& fingerprintHash(input.messages.slice(0, waiting.seen.messages)) === waiting.seen.hash;
		if (!matches || result?.role !== "toolResult") { this.expire(); return false; }
		this.leaveWaiting();
		this.held = undefined;
		// Attach first, then answer: the agent's next updates must find the new stream.
		this.turn = turn;
		this.model = model;
		this.input = input;
		this.streamUsed = undefined;
		this.touch();
		if (!this.agent?.tools?.endpoint.resolve(held.call.id, result)) this.refuseCall();
		return true;
	}

	private noteUsed(used: unknown): void {
		if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return;
		this.promptUsed = used;
		if (!this.waiting) this.streamUsed = used;
	}

	/** No longer waiting (resumed, expired or done). */
	private leaveWaiting(): void {
		if (!this.waiting) return;
		clearTimeout(this.waiting.timer);
		this.waiting = undefined;
		const registry = waitingTurns.get(this.connection);
		if (this.key !== undefined && registry?.get(this.key) === this) registry.delete(this.key);
	}

	/**
	 * The waiting prompt can't resume: cancel it (the agent aborts the held request itself), fail what
	 * is still held, and let run() close the session and release the process. A later request with
	 * the result finds no waiting prompt and gets a fresh session with the full replay.
	 */
	expire(): void {
		if (this.expired || this.done) return;
		this.expired = true;
		this.leaveWaiting();
		this.allowance = undefined;
		this.held = undefined;
		this.cancel();
		this.agent?.tools?.endpoint.failHeld("The tool call expired.");
	}

	/**
	 * Fail the turn now. With a prompt open, session/cancel follows once the
	 * current stdout chunk is processed, so every permission answer in it is
	 * written first. With none open there is nothing to cancel: the process
	 * may already be acting, so it is killed.
	 */
	private stopReply(message: string): void {
		this.turn.fail(message);
		if (!this.prompt) { this.connection.kill(); return; }
		setImmediate(() => { if (!this.done) this.cancel(); });
	}

	/** session/cancel once, then kill the process if the prompt hasn't resolved within the grace period. */
	private cancel(): void {
		if (this.cancelling || !this.sessionId || this.done) return;
		this.cancelling = true;
		clearTimeout(this.inactivity);
		const prompt = this.prompt;
		if (!prompt) return;
		this.connection.notify("session/cancel", { sessionId: this.sessionId });
		let timer: NodeJS.Timeout | undefined;
		const graceOver = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), antigravityTimeouts.cancelGraceMs);
			timer.unref();
		});
		void Promise.race([prompt.then(() => true, () => true), graceOver]).then((settled) => {
			clearTimeout(timer);
			if (!settled) this.connection.kill();
		});
	}

	/** Only text and thinking count as progress. */
	private touch(): void {
		if (!this.prompt || this.cancelling) return;
		clearTimeout(this.inactivity);
		this.inactivity = setTimeout(() => {
			this.turn.fail(AntigravityMessage.StoppedResponding);
			this.cancel();
		}, antigravityTimeouts.inactivityMs);
		this.inactivity.unref();
	}

	private settle(result: unknown): void {
		if (this.turn.finished) return;
		if (!isRecord(result)) { this.turn.fail(AntigravityMessage.NoStopReason); return; }
		if (this.toolRounds > 0) this.turn.setContextUsage(result.usage, this.promptUsed ?? 0);
		else this.turn.setUsage(result.usage);
		const reason = result.stopReason;
		switch (reason) {
			case "end_turn": this.turn.finish("stop"); return;
			case "max_tokens": this.turn.finish("length"); return;
			case "cancelled": this.turn.fail(AntigravityMessage.Aborted, "aborted"); return;
			case "refusal": this.turn.fail(AntigravityMessage.Refusal); return;
			default:
				this.turn.fail(typeof reason === "string" && /^[a-z_]{1,40}$/.test(reason) ? `Antigravity stopped early (${reason}).` : AntigravityMessage.NoStopReason);
		}
	}
}

export interface StreamDeps {
	runtime?: () => AntigravityRuntime;
	host?: () => AntigravityHost;
}

export function createAntigravityStreamFunction({ runtime = antigravityRuntime, host = antigravityHost }: StreamDeps = {}): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AntigravityTurn(stream, model);
		const signal = options?.signal;
		let session: TurnSession | undefined;
		// Abort fails the turn at once, whatever stage it is in.
		const onAbort = () => { if (session) session.abortFrom(turn); else turn.fail(AntigravityMessage.Aborted, "aborted"); };
		void (async () => {
			const currentHost = host();
			// The last door: nothing starts unless the server says this provider is available now.
			if (!currentHost.available()) { turn.fail(AntigravityMessage.Off); return; }
			const key = options?.sessionId ? options.sessionId : undefined;
			const live = key !== undefined ? runtime().connection : undefined;
			const waiting = live ? waitingTurns.get(live)?.get(key!) : undefined;
			if (signal?.aborted) { waiting?.expire(); turn.fail(AntigravityMessage.Aborted, "aborted"); return; }
			// A prompt of this chat is waiting for a tool result: this request continues it, or it expires.
			if (waiting?.resume(turn, model, context.messages)) {
				session = waiting;
				signal?.addEventListener("abort", onAbort, { once: true });
				turn.onEnd(() => signal?.removeEventListener("abort", onAbort));
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				let acquired: { connection: AgentConnection; release: () => void };
				// In use from the moment the turn asks, so an opt-out during a cold start waits for it.
				try { acquired = await runtime().acquire(); }
				catch (error) { turn.fail(describeAgentError(error)); return; }
				const { connection, release } = acquired;
				try {
					if (turn.finished) return;
					session = new TurnSession(connection, turn, currentHost);
					await session.run(model, context.messages, options?.reasoning, options?.sessionId);
				} finally { release(); }
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		})().catch((error: unknown) => {
			console.error("Antigravity turn failed:", error instanceof Error ? error.name : "unknown error");
			turn.fail(describeAgentError(error));
		});
		return stream;
	};
}

export const streamAntigravity = createAntigravityStreamFunction();
