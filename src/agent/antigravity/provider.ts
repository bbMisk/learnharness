import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { antigravitySwitchOn } from "../../core/fork-config.ts";
import { AcpTransportError } from "./acp-client.ts";
import { AntigravityMessage, ANTIGRAVITY_PROVIDER } from "./constants.ts";
import { antigravityHost } from "./host.ts";
import { modelsFrom, toPiModel, type AgentModel } from "./models.ts";
import { antigravityRuntime, antigravityTimeouts, type AntigravityRuntime } from "./runtime.ts";
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
export async function checkAntigravityAgent(runtime: AntigravityRuntime = antigravityRuntime()): Promise<ConnectionCheck> {
	const connection = await runtime.connect();
	const release = connection.hold();
	try {
		const created = await connection.setupRequest("session/new", { cwd: connection.workspace, mcpServers: [] });
		if (typeof created !== "object" || created === null || typeof (created as { sessionId?: unknown }).sessionId !== "string") {
			throw new AcpTransportError("protocol", AntigravityMessage.ProtocolError);
		}
		// Killed while the answer was in flight (a bad line, the sign-in line): not a success.
		if (!connection.alive) throw connection.failure ?? new AcpTransportError("closed", AntigravityMessage.Exited);
		const sessionId = (created as { sessionId: string }).sessionId;
		// Never close a session a turn is watching (a duplicate id must not end someone else's reply).
		if (connection.handshake.sessionClose && !connection.watching(sessionId)) {
			connection.request("session/close", { sessionId }, antigravityTimeouts.startupMs).catch(() => { /* dropped either way */ });
		}
		return { agentVersion: connection.handshake.agentVersion, models: modelsFrom(created) ?? [] };
	} finally {
		release();
	}
}
