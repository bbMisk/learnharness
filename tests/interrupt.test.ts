import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionModel } from "../components/session-core.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => boolean) {
	for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); }
	assert.ok(condition(), "expected asynchronous handoff");
}
function fixture(options: { abortStatus?: number; deferFirstPost?: boolean; delaySettle?: boolean } = {}) {
	const calls: string[] = [], accepted: string[] = [];
	let streamCount = 0, busy = true, releasePost: (() => void) | undefined, rejected = false;
	const messages: unknown[] = [];
	const fetcher = (async (input, init = {}) => {
		const url = String(input);
		if (url === "/api/activity/abort") {
			calls.push("abort");
			if (options.abortStatus) return Response.json({ reason: options.abortStatus === 409 ? "not_running" : "failed" }, { status: options.abortStatus });
			busy = !!options.delaySettle && !accepted.length;
			return Response.json({ ok: true });
		}
		if (url === "/api/chat") {
			const text = JSON.parse(String(init.body)).input.text;
			calls.push(`post:${text}`);
			if (busy && options.delaySettle && !rejected) { rejected = true; busy = false; return new Response("settling", { status: 409 }); }
			if (options.deferFirstPost && !accepted.length) await new Promise<void>(resolve => { releasePost = resolve; });
			accepted.push(text); busy = true;
			messages.push({ id: `u${accepted.length}`, role: "user", content: text, timestamp: Date.now() });
			return Response.json({ ok: true });
		}
		if (url.includes("/api/jobs")) return Response.json({ turnInFlight: busy });
		if (url.endsWith("/stream")) {
			streamCount++;
			return new Response(new ReadableStream({ start(controller) {
				init.signal?.addEventListener("abort", () => controller.close(), { once: true });
			} }));
		}
		if (url === "/api/chats/chat_interrupt") return Response.json({ messages, turnInFlight: busy });
		throw new Error(`unexpected request: ${url}`);
	}) as typeof fetch;
	const model = new SessionModel({ chatId: "chat_interrupt", initialMessages: [], fetch: fetcher, pollMs: 1, waitMaxMs: 100 });
	return { model, calls, accepted, start: async () => { void model.resumeStream(false); await until(() => streamCount === 1); }, release: () => releasePost?.(), streams: () => streamCount };
}

it("new prompt aborts an unfinished response and sends once settlement releases it", async () => {
	const f = fixture({ delaySettle: true });
	try {
		await f.start();
		assert.equal(await f.model.steer("  focus on my question  "), true);
		await until(() => f.streams() === 2);
		assert.deepEqual(f.accepted, ["focus on my question"]);
		assert.deepEqual(f.calls, ["abort", "post:focus on my question", "post:focus on my question"]);
		assert.equal(f.model.status, "submitted");
		assert.equal(f.model.getState().steerQueue.length, 0);
	} finally { f.model.stop(); }
});

it("a response finishing before interruption falls back to an ordinary send", async () => {
	const f = fixture({ abortStatus: 409 });
	try {
		await f.start();
		assert.equal(await f.model.steer("new direction"), true);
		await until(() => f.streams() === 2);
		assert.deepEqual(f.accepted, ["new direction"]);
	} finally { f.model.stop(); }
});

it("failed interruption retains the original stream and reports failure without sending", async () => {
	const f = fixture({ abortStatus: 503 });
	try {
		await f.start();
		assert.equal(await f.model.steer("new direction"), false);
		assert.deepEqual(f.accepted, []);
		assert.equal(f.streams(), 1);
		assert.equal(f.model.status, "submitted");
		assert.match(f.model.getState().error?.message ?? "", /interruption failed/);
		assert.equal(f.model.getState().steerQueue.length, 0);
	} finally { f.model.stop(); }
});

it("rapid prompts serialize acceptance, then interrupt without waiting for either reply", async () => {
	const f = fixture({ deferFirstPost: true });
	try {
		await f.start();
		const first = f.model.steer("first");
		const second = f.model.steer("second");
		await until(() => f.calls.includes("post:first"));
		assert.deepEqual(f.calls, ["abort", "post:first"]);
		f.release();
		assert.deepEqual(await Promise.all([first, second]), [true, true]);
		assert.deepEqual(f.calls, ["abort", "post:first", "abort", "post:second"]);
		assert.deepEqual(f.accepted, ["first", "second"]);
		assert.equal(f.model.getState().steerQueue.length, 0);
	} finally { f.model.stop(); }
});
