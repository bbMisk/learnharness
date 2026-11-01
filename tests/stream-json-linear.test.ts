import assert from "node:assert/strict";
import { it } from "node:test";
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";

// The patched library (patches/@earendil-works+pi-ai+*.patch) re-parses a
// streaming tool call's arguments on every delta only while they are small;
// re-parsing the whole buffer every time is quadratic and froze the server
// on a long tool input (owner, 2026-10-31).

const model = { id: "m", api: "openai-responses", provider: "openai", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function run(args: string, chunk: number, onDelta?: (parsed: unknown) => void) {
	const events: unknown[] = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", call_id: "c", id: "fc", name: "quiz", arguments: "" },
		},
	];
	for (let i = 0; i < args.length; i += chunk)
		events.push({ type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(i, i + chunk) });
	events.push(
		{ type: "response.function_call_arguments.done", output_index: 0, arguments: args },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "function_call", call_id: "c", id: "fc", name: "quiz", arguments: args },
		},
		{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	);
	const output = { role: "assistant", content: [] as Array<{ type: string; arguments?: unknown }>, stopReason: "toolUse", usage: {} };
	const stream = {
		push: (e: { type: string; partial: typeof output }) => {
			if (e.type === "toolcall_delta") onDelta?.(e.partial.content[0]!.arguments);
		},
	};
	async function* source() {
		yield* events;
	}
	await processResponsesStream(source() as never, output as never, stream as never, model as never);
	return output.content[0]!.arguments;
}

it("a long tool input streams in linear time and still ends with the full arguments", async () => {
	const text = "x".repeat(150_000);
	const args = JSON.stringify({ prompt: text });
	const started = performance.now();
	const final = await run(args, 3);
	const ms = performance.now() - started;
	assert.deepEqual(final, { prompt: text });
	assert.ok(ms < 2_000, `150 KB in 3-character deltas took ${Math.round(ms)} ms`);
});

it("a small tool input still updates on every delta", async () => {
	const args = JSON.stringify({ prompt: "Which lens forms an inverted image?", options: ["A", "B"] });
	const seen: string[] = [];
	const final = await run(args, 4, (parsed) => seen.push(JSON.stringify(parsed)));
	assert.equal(seen.length, Math.ceil(args.length / 4));
	assert.ok(new Set(seen).size > seen.length / 2, "the preview advances as the input arrives");
	assert.deepEqual(final, JSON.parse(args));
});
