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
} from "@earendil-works/pi-ai";

import { AcpRpcError, AcpTransportError } from "./acp-client.ts";
import { AntigravityMessage, breachMessage } from "./constants.ts";
import { antigravityHost, type AntigravityHost } from "./host.ts";
import { findConfigOption, legacyModels, legacyModes, modelsFrom } from "./models.ts";
import { antigravityRuntime, antigravityTimeouts, describeAgentError, type AgentConnection, type AntigravityRuntime } from "./runtime.ts";
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

/** The session part of one turn: setup, prompt, routing and every way it can stop. */
class TurnSession {
	private sessionId: string | undefined;
	private prompt: Promise<unknown> | undefined;
	private cancelling = false;
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

	async run(model: Model<Api>, messages: Parameters<typeof toAntigravityInput>[0]): Promise<void> {
		const { connection } = this;
		const setup = antigravityTimeouts.startupMs;
		const input = toAntigravityInput(messages);
		const append = connection.handshake.systemPromptAppend;
		try {
			this.checkpoint();
			const created = await connection.request("session/new", {
				cwd: connection.workspace,
				mcpServers: [],
				...(append ? { _meta: { antigravity: { systemPrompt: { append: input.systemText } } } } : {}),
			}, setup);
			if (!isRecord(created) || typeof created.sessionId !== "string") throw new AcpTransportError("protocol", AntigravityMessage.ProtocolError);
			const sessionId = created.sessionId;
			this.sessionId = sessionId;
			this.stopWatching = connection.watch(sessionId, {
				onUpdate: (update) => this.onUpdate(update),
				onPermissionRequest: (params) => this.onPermission(params),
				onClosed: (error) => this.turn.fail(error.message),
			});
			this.refreshModels(created);
			this.checkpoint();

			if (!await this.pinDefaultMode(sessionId, created)) throw new StopTurn(AntigravityMessage.ModeNotSet);
			this.checkpoint();
			await this.selectModel(sessionId, created, model.id);
			this.checkpoint();

			const prompt = [...(append ? [] : [{ type: "text", text: input.systemText }]), { type: "text", text: input.transcript }];
			this.prompt = connection.request("session/prompt", { sessionId, prompt });
			this.touch();
			const result = await this.prompt;
			this.settle(result);
		} catch (error) {
			if (error instanceof StopTurn) { if (error.message) this.turn.fail(error.message); }
			else this.turn.fail(describeAgentError(error));
		} finally {
			clearTimeout(this.inactivity);
			this.stopWatching?.();
			if (this.sessionId && connection.handshake.sessionClose && connection.alive) {
				connection.request("session/close", { sessionId: this.sessionId }, setup).catch(() => { /* dropped either way */ });
			}
		}
	}

	/** Between setup steps: stop quietly if the turn already ended (abort, crash). */
	private checkpoint(): void {
		if (this.turn.finished) throw new StopTurn("");
	}

	private async pinDefaultMode(sessionId: string, created: Record<string, unknown>): Promise<boolean> {
		const setup = antigravityTimeouts.startupMs;
		const mode = findConfigOption(created.configOptions, "mode");
		try {
			if (mode) {
				if (!mode.values.some((value) => value.id === "default")) return false;
				if (mode.currentValue === "default") return true;
				const updated = await this.connection.request("session/set_config_option", { sessionId, configId: mode.configId, value: "default" }, setup);
				return isRecord(updated) && findConfigOption(updated.configOptions, "mode")?.currentValue === "default";
			}
			const legacy = legacyModes(created);
			if (!legacy?.ids.includes("default")) return false;
			if (legacy.currentModeId !== "default") await this.connection.request("session/set_mode", { sessionId, modeId: "default" }, setup);
			return true;
		} catch (error) {
			if (error instanceof AcpRpcError) return false;
			throw error;
		}
	}

	private async selectModel(sessionId: string, created: Record<string, unknown>, modelId: string): Promise<void> {
		const setup = antigravityTimeouts.startupMs;
		const option = findConfigOption(created.configOptions, "model");
		if (option) {
			if (!option.values.some((value) => value.id === modelId)) throw new StopTurn(AntigravityMessage.ModelUnavailable);
			if (option.currentValue !== modelId) await this.connection.request("session/set_config_option", { sessionId, configId: option.configId, value: modelId }, setup);
			return;
		}
		const legacy = legacyModels(created);
		if (!legacy?.values.some((value) => value.id === modelId)) throw new StopTurn(AntigravityMessage.ModelUnavailable);
		if (legacy.currentModelId !== modelId) await this.connection.request("session/set_model", { sessionId, modelId }, setup);
	}

	private refreshModels(source: unknown): void {
		const models = modelsFrom(source);
		if (models?.length) this.host.saveModels(models);
	}

	private onUpdate(update: Record<string, unknown>): void {
		if (this.turn.finished) return;
		this.touch();
		const content = isRecord(update.content) ? update.content : undefined;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (content?.type === "text" && typeof content.text === "string") this.turn.delta("text", content.text);
				return;
			case "agent_thought_chunk":
				if (content?.type === "text" && typeof content.text === "string") this.turn.delta("thinking", content.text);
				return;
			case "tool_call":
			case "tool_call_update":
				this.breach(update);
				return;
			case "config_option_update":
				this.refreshModels(update);
				return;
			default:
				return; // usage_update, available_commands_update, current_mode_update, anything unknown
		}
	}

	private onPermission(params: Record<string, unknown>): unknown {
		const options = Array.isArray(params.options) ? params.options : [];
		const reject = options.find((option) => isRecord(option) && option.kind === "reject_once" && typeof option.optionId === "string") as { optionId: string } | undefined;
		// The turn fails now; session/cancel goes out after the answer below is written.
		this.breach(isRecord(params.toolCall) ? params.toolCall : {}, true);
		return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
	}

	/** LearnHarness granted no tools: any tool use stops the reply. */
	private breach(call: Record<string, unknown>, afterAnswer = false): void {
		const what = [call.title, call.kind].find((value): value is string => typeof value === "string" && value.trim() !== "");
		this.turn.fail(breachMessage(what ? what.trim().slice(0, 120) : "a tool"));
		if (afterAnswer) setImmediate(() => this.cancel());
		else this.cancel();
	}

	/** session/cancel once, then kill the process if the prompt hasn't resolved within the grace period. */
	private cancel(): void {
		if (this.cancelling || !this.sessionId) return;
		this.cancelling = true;
		clearTimeout(this.inactivity);
		const prompt = this.prompt;
		if (!prompt) return;
		this.connection.notify("session/cancel", { sessionId: this.sessionId });
		let timer: NodeJS.Timeout | undefined;
		const graceOver = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), antigravityTimeouts.cancelGraceMs); });
		void Promise.race([prompt.then(() => true, () => true), graceOver]).then((settled) => {
			clearTimeout(timer);
			if (!settled) this.connection.kill();
		});
	}

	private touch(): void {
		if (!this.prompt || this.cancelling) return;
		clearTimeout(this.inactivity);
		this.inactivity = setTimeout(() => {
			this.turn.fail(AntigravityMessage.StoppedResponding);
			this.cancel();
		}, antigravityTimeouts.inactivityMs);
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
				try { await session.run(model, context.messages); }
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
