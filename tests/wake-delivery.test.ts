import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { SteerInput } from "../src/core/input-events.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-wake-delivery-"));
process.env.LH_DATA_DIR = path.join(home, "data");
process.env.LH_AUTH_FILE = path.join(home, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const jobs = await import("../src/server/jobs.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { buildProbeHandoffSteer, buildSubagentSteer } = await import("../src/core/contracts.ts");
after(() => fs.rmSync(home, { recursive: true, force: true }));

function question(): LhMessage {
	return {
		id: "question", role: "assistant", timestamp: 1,
		content: [{ type: "toolCall", id: "probe-call", name: "probe", arguments: { question: "What is the wave speed?" } }],
		api: "openai-completions", provider: "test", model: "test", stopReason: "toolUse",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function pdfFor(chatId: string, name: string) {
	const job = jobStore.createJob({ kind: "pdf", chatId, toolCallId: name });
	const result = { path: `${name}.pdf`, brief: "Lecture read.", question: "What does this lecture cover?", pagesRead: [1], pagesConsulted: [1] };
	jobStore.updateJob(job.id, { result });
	return buildSubagentSteer(job, result);
}

function recordWakes(wakes: string[][]) {
	jobs.setTurnRunner(async (id, input) => {
		const steers = (input as SteerInput).steers;
		wakes.push(steers.map((s) => s.id));
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...steers]);
		return 200;
	});
}

async function advance(t: TestContext, ms = 1000) {
	t.mock.timers.tick(ms);
	await setImmediate();
}

it("a PDF delivered during questioning cannot erase the later probe handoff", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const chat = chatStore.createChat("PDF to probe handoff regression");
	chatStore.saveMessages(chat.id, [question()]);
	const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "pdf-call" });
	const result = { path: "lecture.pdf", brief: "Wave speed equals frequency times wavelength.", question: "What is the wave speed?", pagesRead: [1], pagesConsulted: [1] };
	jobStore.updateJob(job.id, { result });
	const pdf = buildSubagentSteer(job, result);
	const wakes: string[][] = [];
	jobs.setTurnRunner(async (id, input) => {
		const steers = (input as SteerInput).steers;
		wakes.push(steers.map((s) => s.id));
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...steers]);
		return 200;
	});
	const pdfDelivery = jobs.deliverJobResult(pdf);
	await advance(t);
	assert.equal(wakes.length, 0);

	// The answer run receives the PDF and poses another question. Settlement
	// clears the delivered queue while the old implementation still waits.
	assert.ok(beginTurn(chat.id));
	jobs.registerLiveAgent(chat.id, { steer() {} } as never);
	chatStore.saveMessages(chat.id, [pdf, question()]);
	jobs.unregisterLiveAgent(chat.id);
	endTurn(chat.id);
	jobs.settleSteers(chat.id, [pdf]);
	await pdfDelivery;
	await advance(t);

	// The last answer run concludes the probe. Its handoff must survive the
	// earlier PDF delivery's queue being removed and recreated.
	assert.ok(beginTurn(chat.id));
	jobs.registerLiveAgent(chat.id, { steer() {} } as never);
	chatStore.saveMessages(chat.id, [pdf]);
	const handoff = buildProbeHandoffSteer(chat.id);
	let acknowledged = false;
	const delivery = jobs.deliverJobResult(handoff).then(() => { acknowledged = true; });
	jobs.unregisterLiveAgent(chat.id);
	endTurn(chat.id);
	jobs.settleSteers(chat.id, []);
	for (let i = 0; i < 4; i++) await advance(t);
	assert.deepEqual(wakes, [[handoff.id]], "the teacher starts exactly once");
	assert.ok(acknowledged, "the handoff caller receives its acknowledgement");
	assert.ok(chatStore.getChat(chat.id)!.messages.some((m) => m.id === handoff.id));
	await delivery;
});

it("arrivals during the grace period are delivered together from the current queue", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const chat = chatStore.createChat("Overlapping arrivals");
	const first = pdfFor(chat.id, "first");
	const second = pdfFor(chat.id, "second");
	const wakes: string[][] = [];
	recordWakes(wakes);
	const a = jobs.deliverJobResult(first);
	await advance(t, 500);
	const b = jobs.deliverJobResult(second);
	await advance(t);
	await Promise.all([a, b]);
	assert.deepEqual(wakes, [[first.id, second.id]]);
	const duplicate = jobs.deliverJobResult(first);
	await advance(t);
	await duplicate;
	assert.equal(wakes.length, 1, "a durable delivery is not replayed");
});

it("a conflict retry preserves both the original batch and newer arrivals", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const chat = chatStore.createChat("Conflict plus new arrival");
	const first = pdfFor(chat.id, "first");
	const second = pdfFor(chat.id, "second");
	const wakes: string[][] = [];
	let release!: (status: number) => void;
	jobs.setTurnRunner(async (id, input) => {
		const steers = (input as SteerInput).steers;
		wakes.push(steers.map((s) => s.id));
		if (wakes.length === 1) return new Promise<number>((resolve) => { release = resolve; });
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...steers]);
		return 200;
	});
	const a = jobs.deliverJobResult(first);
	await advance(t);
	const b = jobs.deliverJobResult(second);
	release(409);
	await setImmediate();
	await advance(t, 500);
	await Promise.all([a, b]);
	assert.deepEqual(wakes, [[first.id], [first.id, second.id]], "retry retains arrival order");
});

it("a failed wake retains its obligation without discarding a newer delivery", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const chat = chatStore.createChat("Failure plus new arrival");
	const first = pdfFor(chat.id, "first");
	const second = pdfFor(chat.id, "second");
	let release!: (status: number) => void;
	const wakes: string[][] = [];
	jobs.setTurnRunner(async (id, input) => {
		const steers = (input as SteerInput).steers;
		wakes.push(steers.map((s) => s.id));
		if (wakes.length === 1) return new Promise<number>((resolve) => { release = resolve; });
		chatStore.saveMessages(id, [...chatStore.getChat(id)!.messages, ...steers]);
		return 200;
	});
	let acknowledged = false;
	const failed = jobs.deliverJobResult(first).then(() => { acknowledged = true; });
	await advance(t);
	const delivered = jobs.deliverJobResult(second);
	release(500);
	await setImmediate();
	await advance(t);
	assert.equal(acknowledged, false, "a failed start is not durable acceptance");
	await delivered;
	chatStore.saveMessages(chat.id, [...chatStore.getChat(chat.id)!.messages, first]);
	jobs.noteSteersDurable(chat.id, [first]);
	await failed;
	assert.equal(acknowledged, true, "the original caller resolves only after canonical persistence");
	assert.deepEqual(wakes, [[first.id], [second.id]]);
});

it("blocked questions and dismissals leave no polling task; settlement retries them", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const dismissed of [false, true]) {
		const chat = chatStore.createChat(dismissed ? "Dismissal pause" : "Question pause");
		const tail = dismissed ? [{
			id: "dismissed", role: "toolResult", timestamp: 1, toolCallId: "probe-call", toolName: "probe",
			content: [{ type: "text", text: "Skipped" }], details: { dismissed: true }, isError: false,
		} as LhMessage] : [];
		chatStore.saveMessages(chat.id, [question(), ...tail]);
		const handoff = buildProbeHandoffSteer(chat.id);
		const wakes: string[][] = [];
		recordWakes(wakes);
		const delivery = jobs.deliverJobResult(handoff);
		await advance(t);
		const read = chatStore.getChat;
		let reads = 0;
		chatStore.getChat = (id) => { reads++; return read(id); };
		try {
			for (let i = 0; i < 4; i++) await advance(t, 60_000);
			assert.equal(reads, 0, "the paused queue has no background poller");
		} finally { chatStore.getChat = read; }
		assert.equal(wakes.length, 0);
		chatStore.saveMessages(chat.id, [{ id: "next", role: "user", content: "Continue", timestamp: 2 }]);
		jobs.settleSteers(chat.id, []);
		await advance(t);
		await delivery;
		assert.deepEqual(wakes, [[handoff.id]]);
	}
});

it("deleting a chat settles a parked handoff instead of leaking its caller", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { deleteChatSession } = await import("../src/server/chats.ts");
	const chat = chatStore.createChat("Deleted while parked");
	chatStore.saveMessages(chat.id, [question()]);
	let settled = false;
	const discarded = jobs.deliverJobResult(buildProbeHandoffSteer(chat.id)).then(() => { settled = true; });
	await advance(t);
	assert.equal((await deleteChatSession(chat.id, "preserve-graph")).ok, true);
	await advance(t);
	await discarded;
	assert.equal(settled, true, "deletion discards the session obligation");
	assert.equal(chatStore.getChat(chat.id), null);
});
