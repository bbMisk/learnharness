import { piModels as baseModels, piEngineForSpec as baseEngine } from "../agent/models.ts";
import { createChatGPTProvider } from "../agent/chatgpt.ts";
import { activeChatGPTAccount, chatGPTConnected } from "../store/chatgpt.ts";
import { chatGPTAccessToken } from "./chatgpt.ts";

export function piModels() {
	const models = baseModels();
	if (!models.getProvider("chatgpt")) models.setProvider(createChatGPTProvider({ models: () => chatGPTConnected() ? activeChatGPTAccount()?.models ?? [] : [], accessToken: chatGPTAccessToken }));
	return models;
}
export const piEngineForSpec: typeof baseEngine = (spec) => {
	piModels();
	if (spec.provider !== "chatgpt") return baseEngine(spec);
	const engine = baseEngine(spec);
	const provider = piModels().getProvider("chatgpt")!;
	// The custom provider owns OAuth; do not ask the library's API-key resolver.
	return { ...engine, streamFn: (model, context, options) => provider.streamSimple(model, context, { ...options, reasoning: engine.level === "off" ? undefined : engine.level }) };
};
