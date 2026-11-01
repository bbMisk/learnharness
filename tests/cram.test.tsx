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
const { CRAM_INSTRUCTIONS, CRAM_PROBE_INSTRUCTIONS, withTeachingStyle } = await import("../src/core/cram.ts");
const { chatStore, setChatOrganization } = await import("../src/store/chats.ts");
const { POST } = await import("../app/api/chats/route.ts");
const { PUT } = await import("../app/api/chats/[id]/route.ts");
const { ModeSwitch } = await import("../components/mode-switch.tsx");
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

it("a cram lesson gets a short probe, then the cram loop; Teach and practice are unchanged", () => {
	const project = "Project: Quant Methods.";
	assert.equal(withTeachingStyle(project, { style: "cram", messages: [] }), `${project}\n\n${CRAM_PROBE_INSTRUCTIONS}`);
	assert.equal(withTeachingStyle(project, { style: "cram", messages: probeDone }), `${project}\n\n${CRAM_INSTRUCTIONS}`);
	assert.equal(withTeachingStyle("", { style: "cram", messages: probeDone }), CRAM_INSTRUCTIONS);
	assert.equal(withTeachingStyle(project, { messages: probeDone }), project);
	assert.equal(withTeachingStyle(project, { style: "cram", kind: "practice", messages: [] }), project);
	// Short probe off (Settings): the full probe, then the cram loop.
	assert.equal(withTeachingStyle(project, { style: "cram", messages: [] }, false), project);
	assert.equal(withTeachingStyle(project, { style: "cram", messages: probeDone }, false), `${project}\n\n${CRAM_INSTRUCTIONS}`);
	assert.match(CRAM_PROBE_INSTRUCTIONS, /at most two quick questions/);
	assert.match(CRAM_INSTRUCTIONS, /don't ask for approval/);
	assert.match(CRAM_INSTRUCTIONS, /careless slip/);
	assert.match(CRAM_INSTRUCTIONS, /lightning round[\s\S]*one new instance of every class/);
});

it("creating a cram session flags the lesson; practice ignores it", async () => {
	const create = async (body: unknown) =>
		(await (
			await POST(
				new Request("http://test/api/chats", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			)
		).json()) as { id: string };
	const cram = await create({ title: "HW4 tomorrow", style: "cram" });
	assert.equal(chatStore.getChat(cram.id)!.style, "cram");
	const practice = await create({ title: "Drill", kind: "practice", style: "cram" });
	assert.equal(chatStore.getChat(practice.id)!.style, undefined);
	const teach = await create({ title: "Learn it properly" });
	assert.equal(chatStore.getChat(teach.id)!.style, undefined);
});

it("the flag survives a model change and other organization edits", () => {
	const chat = chatStore.createChat("Cram test");
	setChatOrganization(chat.id, { style: "cram" });
	chatStore.saveSettings(chat.id, { model: { provider: "chatgpt", id: "gpt-6.1-terra" } });
	setChatOrganization(chat.id, { pinned: true });
	assert.equal(chatStore.getChat(chat.id)!.style, "cram");
});

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.replaceChildren();
});

it("the switch offers Teach, Practice and Cram and reports the choice", async () => {
	const chosen: string[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<ModeSwitch mode="teach" modes={["teach", "practice", "cram"]} onChange={(m) => chosen.push(m)} />));
	const buttons = [...host.querySelectorAll("button")];
	assert.deepEqual(
		buttons.map((b) => b.textContent),
		["Teach", "Practice", "Cram"],
	);
	assert.equal(buttons[0]!.getAttribute("aria-pressed"), "true");
	await act(async () => buttons[2]!.click());
	assert.deepEqual(chosen, ["cram"]);
	// Hidden modes are not offered; with one mode left there is no switch.
	await act(async () => root!.render(<ModeSwitch mode="teach" modes={["teach", "cram"]} onChange={() => {}} />));
	assert.deepEqual(
		[...host.querySelectorAll("button")].map((b) => b.textContent),
		["Teach", "Cram"],
	);
	await act(async () => root!.render(<ModeSwitch mode="teach" modes={["teach"]} onChange={() => {}} />));
	assert.equal(host.querySelector("button"), null);
});

it("hidden modes: known, unique, never all of them", async () => {
	const { parseHiddenModes, visibleModes, sanitizeUserSettings } = await import("../src/core/settings.ts");
	assert.deepEqual(parseHiddenModes(["practice", "practice"]), ["practice"]);
	assert.equal(parseHiddenModes(["teach", "practice", "cram"]), undefined);
	assert.equal(parseHiddenModes(["quiz"]), undefined);
	assert.deepEqual(visibleModes(["practice"]), ["teach", "cram"]);
	assert.deepEqual(visibleModes(undefined), ["teach", "practice", "cram"]);
	assert.deepEqual(sanitizeUserSettings({ version: 1, general: { hiddenModes: ["practice"] } })?.general, { hiddenModes: ["practice"] });
	const { parseGeneralSettingsBody } = await import("../src/server/settings-body.ts");
	assert.equal(parseGeneralSettingsBody({ hiddenModes: ["teach", "practice", "cram"] }).ok, false);
	assert.deepEqual(parseGeneralSettingsBody({ hiddenModes: ["practice"] }), { ok: true, settings: { hiddenModes: ["practice"] } });
});

it("the Settings chips hide and show modes, keeping at least one", async () => {
	const { SessionModeChips } = await import("../components/settings/session-mode-chips.tsx");
	const changes: string[][] = [];
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<SessionModeChips hidden={["practice"]} onChange={(h) => changes.push(h)} />));
	const chip = (m: string) => host.querySelector(`[data-testid="session-mode-${m}"]`) as HTMLButtonElement;
	assert.equal(chip("practice").getAttribute("aria-pressed"), "false");
	await act(async () => chip("practice").click());
	await act(async () => chip("cram").click());
	assert.deepEqual(changes, [[], ["practice", "cram"]]);
	await act(async () => root!.render(<SessionModeChips hidden={["practice", "cram"]} onChange={(h) => changes.push(h)} />));
	assert.equal(chip("teach").disabled, true, "the last mode shown cannot be hidden");
});

it("the chat endpoint switches a lesson in and out of cram, never a practice session", async () => {
	const put = (id: string, body: unknown) =>
		PUT(
			new Request(`http://test/api/chats/${id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			{
				params: Promise.resolve({ id }),
			},
		);
	const lesson = chatStore.createChat("Lesson");
	assert.equal((await put(lesson.id, { style: "cram" })).status, 200);
	assert.equal(chatStore.getChat(lesson.id)!.style, "cram");
	assert.equal((await put(lesson.id, { style: null })).status, 200);
	assert.equal(chatStore.getChat(lesson.id)!.style, undefined);
	assert.equal((await put(lesson.id, { style: "speedrun", title: "Renamed" })).status, 400);
	assert.equal(chatStore.getChat(lesson.id)!.title, "Lesson", "a rejected request writes nothing");
	const practice = chatStore.createChat("Drill", "practice");
	assert.equal((await put(practice.id, { style: "cram" })).status, 400);
	assert.equal(chatStore.getChat(practice.id)!.style, undefined);
});

it("the header Cram chip saves the switch and reports a failed save", async () => {
	const { CramToggle } = await import("../components/cram-toggle.tsx");
	const bodies: unknown[] = [];
	let ok = true;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return ok ? Response.json({ ok: true }) : new Response("no", { status: 500 });
	}) as typeof fetch;
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	function Harness() {
		const [on, setOn] = React.useState(false);
		return <CramToggle chatId="chat_1" on={on} onChange={setOn} />;
	}
	await act(async () => root!.render(<Harness />));
	const chip = () => host.querySelector('[data-testid="cram-toggle"]') as HTMLButtonElement;
	assert.equal(chip().getAttribute("aria-pressed"), "false");
	await act(async () => chip().click());
	assert.equal(chip().getAttribute("aria-pressed"), "true");
	await act(async () => chip().click());
	assert.equal(chip().getAttribute("aria-pressed"), "false");
	assert.deepEqual(bodies, [{ style: "cram" }, { style: null }]);
	ok = false;
	await act(async () => chip().click());
	assert.equal(chip().getAttribute("aria-pressed"), "false", "unchanged when the save fails");
	assert.match(host.textContent!, /Couldn't switch/);
});

it("Reveal questions: cram mode by default, or always, or never", async () => {
	const { revealsQuestions, sanitizeUserSettings } = await import("../src/core/settings.ts");
	assert.equal(revealsQuestions(undefined, true), true);
	assert.equal(revealsQuestions(undefined, false), false);
	assert.equal(revealsQuestions("always", false), true);
	assert.equal(revealsQuestions("never", true), false);
	assert.deepEqual(sanitizeUserSettings({ version: 1, general: { revealQuestions: "always" } })?.general, { revealQuestions: "always" });
	assert.deepEqual(sanitizeUserSettings({ version: 1, general: { revealQuestions: "sometimes" } })?.general, {});
	const { parseGeneralSettingsBody } = await import("../src/server/settings-body.ts");
	assert.equal(parseGeneralSettingsBody({ revealQuestions: "sometimes" }).ok, false);
});
