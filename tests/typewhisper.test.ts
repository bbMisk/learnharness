import assert from "node:assert/strict";
import { after, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTypeWhisperClient, checkTypeWhisperRequest, isTypeWhisperError } from "../src/server/typewhisper.ts";
import { TypeWhisperDictationController } from "../components/typewhisper-dictation.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-typewhisper-test-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const file = path.join(temp, "discovery.json");
fs.writeFileSync(file, JSON.stringify({ port: 8978, token: "fixture-private-token" }), { mode: 0o600 });
const id = "00000000-0000-4000-8000-000000000001";

it("recognizes errors from another route bundle without exposing arbitrary exceptions", () => {
	assert.equal(isTypeWhisperError(Object.assign(new Error("Unknown session"), { code: "learnharness_typewhisper_error", status: 404 })), true);
	assert.equal(isTypeWhisperError(new Error("internal secret")), false);
	assert.equal(isTypeWhisperError(Object.assign(new Error("internal"), { code: "learnharness_typewhisper_error", status: 200 })), false);
});

it("uses authenticated fixed-loopback controls, preserves insertion ownership, and exposes no secrets or transcript", async () => {
	const urls: string[] = [];
	let status = "recording";
	const client = createTypeWhisperClient(file, async (input, init) => {
		const url = String(input); urls.push(url);
		assert.ok(url.startsWith("http://127.0.0.1:8978/v1/dictation/"));
		assert.equal(init?.headers && new Headers(init.headers).get("authorization"), "Bearer fixture-private-token");
		assert.equal(init?.redirect, "error");
		if (url.endsWith("/start")) return Response.json({ id, status: "recording" });
		if (url.endsWith("/stop")) { status = "processing"; return Response.json({ id, status: "stopped" }); }
		return Response.json({ id, status, transcription: { text: "Private transcript" }, latency: { complete: status === "completed" } });
	});
	await assert.rejects(client.session(id), /Unknown/);
	assert.equal(urls.length, 0);
	assert.deepEqual(await client.start(), { id, status: "recording" });
	assert.deepEqual(await client.stop(id), { id, status: "processing" });
	status = "completed";
	assert.deepEqual(await client.session(id), { id, status: "completed" });
	const before = urls.length;
	await client.stop(id); // F3 may already have stopped it.
	assert.equal(urls.length, before + 1, "does not issue another stop after completion");
});

it("fails clearly when TypeWhisper is unavailable or authentication is disabled", async () => {
	const absent = createTypeWhisperClient(path.join(temp, "absent"), async () => { throw new Error("must not call"); });
	await assert.rejects(absent.start(), /enable its API Server/);
	const insecure = path.join(temp, "insecure"); fs.writeFileSync(insecure, JSON.stringify({ port: 8978 }));
	await assert.rejects(createTypeWhisperClient(insecure).start(), /Require API Token/);
	const network = createTypeWhisperClient(file, async () => { throw new Error("fixture-private-token"); });
	await assert.rejects(network.start(), (error: Error) => error.message.includes("Cannot reach") && !error.message.includes("fixture-private-token"));
});

it("refuses remote, cross-origin, and cross-site control requests", () => {
	for (const request of [
		new Request("https://example.test/api/stt/typewhisper"),
		new Request("http://localhost:3000/api/stt/typewhisper", { method: "POST", headers: { origin: "https://example.test" } }),
		new Request("http://localhost:3000/api/stt/typewhisper", { headers: { "sec-fetch-site": "cross-site" } }),
	]) assert.throws(() => checkTypeWhisperRequest(request), /local app/);
	checkTypeWhisperRequest(new Request("http://localhost:3000/api/stt/typewhisper", { method: "POST", headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" } }));
});

it("reports silence clearly without forwarding arbitrary provider errors or transcript text", async () => {
	const client = createTypeWhisperClient(file, async (url) => Response.json(String(url).endsWith("/start")
		? { id, status: "recording" } : { id, status: "failed", error: "No speech recognized", transcription: { text: "private" } }));
	await client.start();
	assert.deepEqual(await client.session(id), { id, status: "failed", message: "No speech recognized. Try speaking while TypeWhisper is recording." });
});

it("queues Stop during startup, sends it once, and waits until TypeWhisper finishes inserting", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const actions: string[] = [];
	let checks = 0;
	const controller = new TypeWhisperDictationController(async (action) => {
		actions.push(action);
		if (action === "start") await gate;
		return { id, status: action === "session" ? (++checks > 1 ? "completed" : "processing") : "recording" };
	}, () => {}, 1);
	controller.start(); controller.start();
	const a = controller.finish(), b = controller.finish();
	assert.equal(controller.phase, "stopping");
	release(); await Promise.all([a, b]);
	assert.deepEqual(actions, ["start", "stop", "session", "session"]);
	assert.equal(controller.phase, "idle");
});

it("detects F3 completion without issuing a duplicate stop or appending text again", async () => {
	const actions: string[] = [];
	const controller = new TypeWhisperDictationController(async (action) => { actions.push(action); return { id, status: action === "session" ? "completed" : "recording" }; }, () => {}, 1);
	controller.start();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(actions, ["start", "session"]);
	assert.equal(controller.phase, "idle");
});

it("surfaces failures and stops an owned recording when the page unmounts", async () => {
	let stopped = false;
	const controller = new TypeWhisperDictationController(async (action) => { if (action === "stop") stopped = true; return { id, status: action === "session" ? (stopped ? "completed" : "recording") : "recording" }; }, () => {}, 1);
	controller.start(); controller.dispose(); await controller.finish();
	assert.equal(stopped, true);
	let message: string | null = null;
	const failure = new TypeWhisperDictationController(async () => { throw new Error("TypeWhisper is offline"); }, (_phase, error) => { message = error; });
	failure.start(); await failure.finish(); assert.equal(message, "TypeWhisper is offline");
});
