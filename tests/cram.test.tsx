import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { LhMessage } from "../src/core/native-messages.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cram-"));
process.env.LH_DATA_DIR = temp;
process.env.LH_AUTH_FILE = path.join(temp, "auth.json");
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { CRAM_INSTRUCTIONS, STYLE_GO_AHEAD, withTeachingStyle } = await import("../src/core/cram.ts");
const { chatStore, setChatOrganization } = await import("../src/store/chats.ts");
const { CramChoice } = await import("../components/cram-choice.tsx");
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const probeDone: LhMessage[] = [
	{
		id: "probe",
		role: "assistant",
		content: [{ type: "toolCall", id: "call_probe", name: "probe_done", arguments: { assessment: "Knows the basics." } }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 1,
	} as never,
	{
		id: "probe-result",
		role: "toolResult",
		toolCallId: "call_probe",
		toolName: "probe_done",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	} as never,
];

it("adds the cram instructions only to a cram teach session past its probe", () => {
	const project = "Project: Physics midterm.";
	assert.equal(withTeachingStyle(project, { style: "cram", messages: probeDone }), `${project}\n\n${CRAM_INSTRUCTIONS}`);
	assert.equal(withTeachingStyle("", { style: "cram", messages: probeDone }), CRAM_INSTRUCTIONS);
	assert.equal(withTeachingStyle(project, { style: "cram", messages: [] }), project, "the prober never sees it");
	assert.equal(withTeachingStyle(project, { messages: probeDone }), project, "Teach keeps the full method");
	assert.equal(withTeachingStyle(project, { style: "cram", kind: "practice", messages: probeDone }), project);
	assert.match(CRAM_INSTRUCTIONS, /class of problem/);
	assert.match(CRAM_INSTRUCTIONS, /careless slip/);
});

it("stores the choice on the chat, survives a model change, and clears", () => {
	const chat = chatStore.createChat("Cram test");
	assert.equal(setChatOrganization(chat.id, { style: "cram" }).style, "cram");
	chatStore.saveSettings(chat.id, { model: { provider: "chatgpt", id: "gpt-6.1-terra" } });
	assert.equal(chatStore.getChat(chat.id)!.style, "cram", "the model picker's save keeps the style");
	setChatOrganization(chat.id, { pinned: true });
	assert.equal(chatStore.getChat(chat.id)!.style, "cram", "other organization edits keep it");
	setChatOrganization(chat.id, { style: null });
	assert.equal(chatStore.getChat(chat.id)!.style, undefined);
});

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.replaceChildren();
});
async function mount(onChosen: (style: string, text: string) => void) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<CramChoice chatId="chat_1" onChosen={onChosen} />));
	return host;
}
const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;

it("saves the choice before sending the go-ahead, and reports a failed save", async () => {
	const requests: Array<{ url: string; body: unknown }> = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		requests.push({ url, body: JSON.parse(String(init.body)) });
		return Response.json({ ok: true });
	}) as typeof fetch;
	const chosen: Array<[string, string]> = [];
	const host = await mount((style, text) => chosen.push([style, text]));
	await act(async () => button(host, "Cram for a test").click());
	assert.deepEqual(requests, [{ url: "/api/chats/chat_1", body: { style: "cram" } }]);
	assert.deepEqual(chosen, [["cram", STYLE_GO_AHEAD.cram]]);
	await act(async () => button(host, "Teach it").click());
	assert.deepEqual(requests[1]!.body, { style: null });
	assert.deepEqual(chosen[1], ["teach", STYLE_GO_AHEAD.teach]);

	globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
	await act(async () => button(host, "Cram for a test").click());
	assert.equal(chosen.length, 2, "nothing is sent when the choice was not saved");
	assert.match(host.textContent!, /could not be saved/);
});
