/**
 * One Antigravity turn as a pi stream function (the shape of
 * claude-code/stream.ts): a fresh agent session on the shared process,
 * approval mode pinned to "default" (fail closed), the requested model,
 * the replayed transcript as text, and streamed text back. The agent is
 * granted no tools; any attempt to use one stops the reply.
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
} from "@earendil-works/pi-ai";

import { AcpTransportError, isAcpRpcError, stripUrls } from "./acp-client.ts";
import { AntigravityMessage, breachMessage } from "./constants.ts";
import { antigravityHost, type AntigravityHost } from "./host.ts";
import { findConfigOption, levelsFrom, modelsFrom } from "./models.ts";
import { antigravityRuntime, antigravityTimeouts, describeAgentError, isSignInError, rejectOnce, type AgentConnection, type AntigravityRuntime } from "./runtime.ts";
import { toAntigravityInput } from "./transcript.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

class AntigravityTurn {
	readonly output: AssistantMessage;
	finished = false;
	private started = false;
	private open: { kind: "text" | "thinking"; index: number } | null = null;

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

	finish(reason: "stop" | "length"): void {
		if (this.finished) return;
		this.start();
		this.closeBlock();
		this.finished = true;
		this.output.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.output });
		this.stream.end();
	}

	/** Text already streamed stays in the partial message. */
	fail(message: string, reason: "aborted" | "error" = "error"): void {
		if (this.finished) return;
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
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

/** The session part of one turn: setup, prompt, routing and every way it can stop. */
class TurnSession {
	private sessionId: string | undefined;
	private prompt: Promise<unknown> | undefined;
	private cancelling = false;
	/** run() has returned: nothing more may be sent for this session. */
	private done = false;
	private replyBytes = 0;
	/** The session's config options as the agent last stated them (session/new, every set answer, every update). */
	private options: unknown[] = [];
	/** The frame `options` came from: an answer read before a later update never overwrites it. */
	private optionsFrame = -1;
	/** A current_mode_update, kept apart with its own frame: it changes the view only while it is newer than `options`. */
	private modeOverride: { value: string; frame: number } | undefined;
	private inactivity: NodeJS.Timeout | undefined;
	private stopWatching: (() => void) | undefined;

	constructor(
		private readonly connection: AgentConnection,
		private readonly turn: AntigravityTurn,
		private readonly host: AntigravityHost,
	) {}

	/** Abort: fail at once; cancel only once a prompt is open. */
	readonly abort = () => {
		this.turn.fail(AntigravityMessage.Aborted, "aborted");
		if (this.prompt) this.cancel();
	};

	async run(model: Model<Api>, messages: Parameters<typeof toAntigravityInput>[0], reasoning?: ThinkingLevel): Promise<void> {
		const { connection } = this;
		const input = toAntigravityInput(messages);
		const append = connection.handshake.systemPromptAppend;
		try {
			this.checkpoint();
			const { result: created, frame } = await connection.setupRequestStamped("session/new", {
				cwd: connection.workspace,
				mcpServers: [],
				...(append ? { _meta: { antigravity: { systemPrompt: { append: input.systemText } } } } : {}),
			});
			// A malformed answer breaks the protocol for the whole connection, not just this turn.
			if (!isRecord(created) || typeof created.sessionId !== "string" || !created.sessionId) throw connection.failProtocol();
			// Killed while the answer was in flight: nothing from it is saved.
			if (!connection.alive) throw connection.failure ?? new AcpTransportError("closed", AntigravityMessage.Exited);
			const sessionId = created.sessionId;
			this.observe(created.configOptions, frame);
			this.refreshModels(created);
			// Replays what arrived before this point (a breach, newer options), so an early tool_call still
			// stops the turn. Throws for an id another turn already watches: this turn then owns nothing.
			this.stopWatching = connection.watch(sessionId, {
				onUpdate: (update, updateFrame) => this.onUpdate(update, updateFrame),
				onPermissionRequest: (params) => this.onPermission(params),
				onClosed: (error) => this.turn.fail(error.message),
			});
			this.sessionId = sessionId;
			this.checkpoint();

			await this.pinDefaultMode(sessionId);
			this.checkpoint();
			await this.selectModel(sessionId, model.id);
			this.checkpoint();
			const level = await this.pinThinkingLevel(sessionId, reasoning);
			this.checkpoint();
			// The freshest view decides: a change made while setting another option is caught here.
			if (findConfigOption(this.view(), "mode")?.currentValue !== "default") throw new StopTurn(AntigravityMessage.ModeNotSet);
			if (findConfigOption(this.view(), "model")?.currentValue !== model.id) throw new StopTurn(AntigravityMessage.ModelUnavailable);
			if (level !== undefined && findConfigOption(this.view(), "thought_level")?.currentValue !== level) throw new StopTurn(AntigravityMessage.LevelNotSet);
			// This turn may refresh the levels of the model it selected (only that one), from what it already received.
			this.refreshModels(this.view(), model.id);

			const prompt = [...(append ? [] : [{ type: "text", text: input.systemText }]), { type: "text", text: input.transcript }];
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
			this.stopWatching?.();
			if (this.sessionId && connection.handshake.sessionClose && connection.alive) {
				connection.request("session/close", { sessionId: this.sessionId }, antigravityTimeouts.startupMs).catch(() => { /* dropped either way */ });
			}
		}
	}

	/** Between setup steps: stop quietly if the turn already ended (abort, crash, breach). */
	private checkpoint(): void {
		if (this.turn.finished) throw new StopTurn("");
	}

	/** Replace the current view with the agent's statement of the options, unless a later frame already did. */
	/** The options as the agent last stated them, with a newer mode update applied on top. */
	private view(): unknown[] {
		const override = this.modeOverride;
		if (!override || override.frame < this.optionsFrame) return this.options;
		return this.options.map((option) => (isRecord(option) && (option.id === "mode" || option.category === "mode") ? { ...option, currentValue: override.value } : option));
	}

	private observe(configOptions: unknown, frame: number): void {
		if (!Array.isArray(configOptions) || frame < this.optionsFrame) return;
		this.options = configOptions;
		this.optionsFrame = frame;
	}

	/** A refusal of the value is "could not set"; sign-in and account problems say so. */
	private refusal(error: unknown, message: string): never {
		if (isAcpRpcError(error) && !isSignInError(error) && !error.message.includes("SUBSCRIPTION_REQUIRED")) throw new StopTurn(message);
		throw error;
	}

	/** Mode "default" from a mode config option, or the turn fails closed. */
	private async pinDefaultMode(sessionId: string): Promise<void> {
		const mode = findConfigOption(this.view(), "mode");
		if (!mode || !mode.values.some((value) => value.id === "default")) throw new StopTurn(AntigravityMessage.ModeNotSet);
		if (mode.currentValue === "default") return;
		try {
			const { result: updated, frame } = await this.connection.setupRequestStamped("session/set_config_option", { sessionId, configId: mode.configId, value: "default" });
			this.observe(isRecord(updated) ? updated.configOptions : undefined, frame);
		} catch (error) { this.refusal(error, AntigravityMessage.ModeNotSet); }
	}

	/** The requested model from a model config option, or the turn fails closed. */
	private async selectModel(sessionId: string, modelId: string): Promise<void> {
		const option = findConfigOption(this.view(), "model");
		if (!option || !option.values.some((value) => value.id === modelId)) throw new StopTurn(AntigravityMessage.ModelUnavailable);
		if (option.currentValue === modelId) return;
		try {
			const { result: updated, frame } = await this.connection.setupRequestStamped("session/set_config_option", { sessionId, configId: option.configId, value: modelId });
			this.observe(isRecord(updated) ? updated.configOptions : undefined, frame);
		} catch (error) { this.refusal(error, AntigravityMessage.ModelUnavailable); }
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
		if (option.currentValue === requested) return requested;
		try {
			const { result: updated, frame } = await this.connection.setupRequestStamped("session/set_config_option", { sessionId, configId: option.configId, value: requested });
			this.observe(isRecord(updated) ? updated.configOptions : undefined, frame);
		} catch (error) { this.refusal(error, AntigravityMessage.LevelNotSet); }
		return requested;
	}

	/** Save the listed models; with `selected`, also that model's levels as `configOptions` show them now. */
	private refreshModels(source: unknown, selected?: string): void {
		const listed = Array.isArray(source) ? modelsFrom({ configOptions: source }) : modelsFrom(source);
		if (!listed?.length) return;
		const options = Array.isArray(source) ? source : isRecord(source) ? source.configOptions : undefined;
		const models = selected === undefined ? listed : listed.map((model) => (model.id === selected ? { ...model, ...levelsFrom(options) } : model));
		try { this.host.saveModels(models); }
		catch {
			// A full disk must not fail the turn; the list is refreshed again on the next session.
			if (!saveFailureLogged) { saveFailureLogged = true; console.error("Antigravity: could not save the model list."); }
		}
	}

	private onUpdate(update: Record<string, unknown>, frame: number): void {
		if (this.turn.finished) return;
		const content = isRecord(update.content) ? update.content : undefined;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk": {
				// Nothing is shown before this turn's own prompt, and only non-empty text is progress.
				if (!this.prompt || content?.type !== "text" || typeof content.text !== "string" || content.text === "") return;
				this.touch();
				this.replyBytes += Buffer.byteLength(content.text);
				if (this.replyBytes > antigravityLimits.replyBytes) { this.stopReply(AntigravityMessage.TooLong); return; }
				this.turn.delta(update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", content.text);
				return;
			}
			case "tool_call":
			case "tool_call_update":
				this.breach(update);
				return;
			case "current_mode_update":
				if (typeof update.currentModeId === "string" && frame >= (this.modeOverride?.frame ?? -1)) {
					this.modeOverride = { value: update.currentModeId, frame };
				}
				if (this.prompt && update.currentModeId !== "default") this.stopReply(AntigravityMessage.ModeChanged);
				return;
			case "config_option_update": {
				this.observe(update.configOptions, frame);
				this.refreshModels(update);
				if (this.prompt && findConfigOption(this.view(), "mode")?.currentValue !== "default") this.stopReply(AntigravityMessage.ModeChanged);
				return;
			}
			default:
				return; // usage_update, available_commands_update, anything unknown: no progress, no reset
		}
	}

	private onPermission(params: Record<string, unknown>): unknown {
		this.breach(isRecord(params.toolCall) ? params.toolCall : {});
		return rejectOnce(params);
	}

	/** LearnHarness granted no tools: any tool use stops the reply. */
	private breach(call: Record<string, unknown>): void {
		const what = [call.title, call.kind].map(safeLabel).find((value) => value !== "");
		this.stopReply(breachMessage(what ?? "a tool"));
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
		this.turn.setUsage(result.usage);
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
		const onAbort = () => { if (session) session.abort(); else turn.fail(AntigravityMessage.Aborted, "aborted"); };
		void (async () => {
			const currentHost = host();
			// The last door: nothing starts unless the server says this provider is available now.
			if (!currentHost.available()) { turn.fail(AntigravityMessage.Off); return; }
			if (signal?.aborted) { turn.fail(AntigravityMessage.Aborted, "aborted"); return; }
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				let connection: AgentConnection;
				try { connection = await runtime().connect(); }
				catch (error) { turn.fail(describeAgentError(error)); return; }
				if (turn.finished) return;
				const release = connection.hold();
				session = new TurnSession(connection, turn, currentHost);
				try { await session.run(model, context.messages, options?.reasoning); }
				finally { release(); }
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
