import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";

export interface ChatGPTPorts {
	models(): Model<"openai-responses">[];
	accessToken(): Promise<string>;
}

/** Enforce the subscription contract after caller payload observers too. */
export function subscriptionPayload(payload: unknown): Record<string, unknown> {
	const body = { ...(payload as Record<string, unknown>) };
	for (const key of ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "prompt_cache_options", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id", "service_tier"]) delete body[key];
	body.store = false; body.stream = true;
	if (!Array.isArray(body.input)) throw new Error("ChatGPT requires an input array.");
	body.input = body.input.map((item: Record<string, unknown>) => item.role === "system" ? { ...item, role: "developer" } : item.type === "function_call" ? { ...item, namespace: "learnharness" } : item);
	const tools = body.tools as { type: string; name?: string }[] | undefined;
	if (tools?.length) {
		if (tools.some((tool) => tool.type !== "function")) throw new Error("Only local function tools are supported by this ChatGPT integration.");
		body.tools = [{ type: "namespace", name: "learnharness", description: "LearnHarness teaching and learning tools", tools }];
	}
	return body;
}

export function createChatGPTProvider(ports: ChatGPTPorts): Provider<"openai-responses"> {
	const run = (model: Model<"openai-responses">, context: TranscriptContext, options?: SimpleStreamOptions) => {
		const output = new AssistantMessageEventStream();
		void (async () => {
			try {
				const token = await ports.accessToken();
				if (!ports.models().some((m) => m.id === model.id)) throw new Error("This model is unavailable for the active ChatGPT account. Refresh models in settings.");
				// The existing OpenAI serializer recognizes subscription credentials.
				// Normalize our provider identity on replay, then restore it on output
				// so usage can never be mistaken for pay-as-you-go API usage.
				const wireModel = { ...model, provider: "openai", baseUrl: "https://api.openai.com/v1" };
				const messages = context.messages.map((m) => m.role === "assistant" && m.provider === "chatgpt" ? { ...m, provider: "openai" } : m);
				for await (const event of streamSimple(wireModel, { ...context, messages }, {
					...options, apiKey: token, maxRetries: 0,
					onPayload: async (payload, wire) => subscriptionPayload(await options?.onPayload?.(payload, wire) ?? payload),
					onProviderStreamEvent: async (event, wire) => {
						if ((event as { type?: string }).type === "response.incomplete") throw new Error("ChatGPT response was incomplete; no completed result was received.");
						await options?.onProviderStreamEvent?.(event, wire);
					},
				})) {
					const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
					message.provider = "chatgpt";
					output.push(event);
				}
				output.end();
			} catch (error) {
				output.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: { role: "assistant", api: "openai-responses", provider: "chatgpt", model: model.id, content: [], stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : "ChatGPT request failed.", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
				output.end();
			}
		})();
		return output;
	};
	return { id: "chatgpt", name: "ChatGPT plan", auth: { apiKey: { name: "ChatGPT plan", resolve: async () => undefined } }, getModels: ports.models, stream: (model, context, options) => {
		if (options?.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none") throw new Error("ChatGPT supports automatic or disabled tool choice in LearnHarness.");
		return run(model, context, { ...options, toolChoice: options?.toolChoice as "auto" | "none" | undefined });
	}, streamSimple: run };
}
