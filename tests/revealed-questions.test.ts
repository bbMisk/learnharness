import assert from "node:assert/strict";
import { it } from "node:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
	window: { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } },
});
store.set("lh:revealed-questions", JSON.stringify(["q-from-before-reload"]));
const { rememberRevealed, wasRevealed } = await import("../components/revealed-questions.ts");

it("an opened check stays opened across chat switches and reloads", () => {
	assert.equal(wasRevealed("q-from-before-reload"), true, "read back after a reload");
	assert.equal(wasRevealed("q1"), false);
	rememberRevealed("q1");
	assert.equal(wasRevealed("q1"), true);
	assert.deepEqual(JSON.parse(store.get("lh:revealed-questions")!), ["q-from-before-reload", "q1"]);
	assert.equal(wasRevealed(null), false);
	for (let i = 0; i < 250; i++) rememberRevealed(`k${i}`);
	assert.equal(JSON.parse(store.get("lh:revealed-questions")!).length, 200, "bounded");
	assert.equal(wasRevealed("k249"), true);
});
