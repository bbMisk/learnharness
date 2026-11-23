import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { antigravitySwitchOn } from "../../core/fork-config.ts";
import { AcpTransportError, isAcpRpcError } from "./acp-client.ts";
import { AntigravityMessage, ANTIGRAVITY_PROVIDER } from "./constants.ts";
import { antigravityHost } from "./host.ts";
import { findConfigOption, levelsFrom, modelsFrom, toPiModel, type AgentModel } from "./models.ts";
import { antigravityRuntime, antigravityTimeouts, isSignInError, type AgentConnection, type AntigravityRuntime } from "./runtime.ts";
import { streamAntigravity } from "./stream.ts";

/**
 * The pi provider. Its models are only the ones the agent last reported
 * (persisted by the server), and none at all while the server switch is off
 * or the server says the provider is unavailable.
 */
export function createAntigravityProvider(
	streamSimple: StreamFunction<Api, SimpleStreamOptions> = streamAntigravity,
	models: () => readonly AgentModel[] = () => antigravityHost().models(),
): Provider {
	const provider = createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity",
		// The agent owns its sign-in; LearnHarness holds no credential for it.
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: [],
		api: { stream: streamSimple, streamSimple },
	});
	const list = (): Model<Api>[] => (antigravitySwitchOn() ? models().map(toPiModel) : []);
	return { ...provider, getModels: list, getAllModels: list };
}

export interface ConnectionCheck {
	agentVersion: string | null;
	models: AgentModel[];
}

/** "Check connection": start the process if needed, open one session, read its models. No prompt. */
/**
 * The agent reports thinking levels only for the model a session currently selects, so the check
 * selects each model in turn on its own throwaway session and reads the levels from the answer.
 * A model whose selection fails, or whose answer doesn't confirm it, gets no levels.
 */
async function discoverLevels(connection: AgentConnection, sessionId: string, initial: unknown, listed: AgentModel[]): Promise<AgentModel[]> {
	const modelOption = findConfigOption(initial, "model");
	if (!modelOption) return listed.map((model) => ({ ...model, levels: [] }));
	const found: AgentModel[] = [];
	for (const model of listed) {
		let view: unknown;
		if (model.id === modelOption.currentValue) view = initial;
		else {
			try {
				const answer = await connection.setupRequest("session/set_config_option", { sessionId, configId: modelOption.configId, value: model.id });
				view = typeof answer === "object" && answer !== null ? (answer as { configOptions?: unknown }).configOptions : undefined;
			} catch (error) {
				// A refusal of this one model costs only its levels; anything else fails the check.
				if (!isAcpRpcError(error) || isSignInError(error) || error.message.includes("SUBSCRIPTION_REQUIRED")) throw error;
			}
		}
		if (!connection.alive) throw connection.failure ?? new AcpTransportError("closed", AntigravityMessage.Exited);
		const confirmed = findConfigOption(view, "model")?.currentValue === model.id;
		found.push({ ...model, ...(confirmed ? levelsFrom(view) : { levels: [] }) });
	}
	return found;
}

export async function checkAntigravityAgent(runtime: AntigravityRuntime = antigravityRuntime()): Promise<ConnectionCheck> {
	const connection = await runtime.connect();
	const release = connection.hold();
	let sessionId = "";
	try {
		const created = await connection.setupRequest("session/new", { cwd: connection.workspace, mcpServers: [] });
		const id = typeof created === "object" && created !== null ? (created as { sessionId?: unknown }).sessionId : undefined;
		// A missing or empty id breaks the protocol for the whole connection.
		if (typeof id !== "string" || !id) throw connection.failProtocol();
		// Killed while the answer was in flight (a bad line, the sign-in line): not a success.
		if (!connection.alive) throw connection.failure ?? new AcpTransportError("closed", AntigravityMessage.Exited);
		sessionId = id;
		// Never touch a session a turn is watching (a duplicate id must not change or end someone else's reply):
		// then the levels stay as they were.
		const shared = connection.watching(sessionId);
		const listed = modelsFrom(created) ?? [];
		const models = shared ? listed : await discoverLevels(connection, sessionId, (created as { configOptions?: unknown }).configOptions, listed);
		return { agentVersion: connection.handshake.agentVersion, models };
	} finally {
		// The throwaway session is closed however the check ended, unless a turn owns that id.
		if (sessionId && connection.handshake.sessionClose && connection.alive && !connection.watching(sessionId)) {
			connection.request("session/close", { sessionId }, antigravityTimeouts.startupMs).catch(() => { /* dropped either way */ });
		}
		release();
	}
}
