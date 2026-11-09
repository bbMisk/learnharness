/**
 * The header's question-type chip (owner, 2026-11-03) in linkedom: its
 * "Qs: …" labels and how an unset lesson resolves, the three-option menu,
 * saving through the chat settings API (the model fields re-sent as read),
 * a failed save, and where the header shows it (not for practice, not while
 * the prober runs).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import * as fs from "node:fs";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let active: Element = dom.document.body;
// As in a browser: a removed element loses focus, a disabled one can't take it.
Object.defineProperty(dom.document, "activeElement", { get: () => (active.isConnected ? active : dom.document.body) });
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 900 });
dom.window.HTMLElement.prototype.focus = function () { if (!(this as HTMLButtonElement).disabled) active = this; };
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 20, bottom: 44, left: 900, right: 1000, width: 100, height: 24, x: 900, y: 20, toJSON() {} });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
});
const { createRoot } = await import("react-dom/client");
type Root = ReturnType<typeof createRoot>;
const { QuestionTypeChip, showsQuestionTypeChip, useLessonQuestionType } = await import("../components/question-type-chip.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { CramToggle, useLessonCram } = await import("../components/cram-toggle.tsx");
const { notifySettingsSaved } = await import("../components/settings-signal.ts");
type QuestionType = "mcq" | "saq" | "mixed";

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.replaceChildren();
});

const MODEL = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
const chip = () => document.querySelector('[data-testid="question-type-chip"]') as HTMLButtonElement;
const menu = () => document.querySelector('[data-testid="question-type-menu"]');
const option = (type: string) => document.querySelector(`[data-testid="question-type-option-${type}"]`) as HTMLButtonElement;
const click = async (element: HTMLElement) => {
	assert.ok(element);
	await act(async () => element.click());
};

/** The window's events channel, faked: server frames and reconnects on demand. */
function fakeEvents() {
	let open = () => {};
	const handlers = new Map<string, (data: string) => void>();
	return {
		source: { close() {}, onOpen: (cb: () => void) => { open = cb; }, onEvent: (name: string, cb: (data: string) => void) => { handlers.set(name, cb); } },
		server: (name: string, payload: unknown) => act(async () => handlers.get(name)?.(JSON.stringify(payload))),
		reconnect: () => act(async () => open()),
	};
}
let events = fakeEvents();
const connect = () => events.source;

/** The chat's wiring (components/chat.tsx): the stored value lives in the
 *  always-mounted view's useLessonQuestionType, the chip saves through it. */
function Lesson({ initial, cram = false, agentTools }: { initial?: QuestionType; cram?: boolean; agentTools?: Record<string, boolean> }) {
	const lesson = useLessonQuestionType("chat_1", initial);
	return <QuestionTypeChip chatId="chat_1" stored={lesson.questionType} cram={cram} initialAgentTools={agentTools} beginSave={lesson.begin} />;
}
function Harness(props: { initial?: QuestionType; cram?: boolean; agentTools?: Record<string, boolean> }) {
	return <ServerEventsProvider connect={connect}><Lesson {...props} /></ServerEventsProvider>;
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function mount(element: React.ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(element));
	return host;
}

/** A fake chat settings API: GET the record's settings, PUT merges the
 *  named fields (the route's field-level write); /api/settings serves the
 *  Agent section. */
function fakeApi(initial: Record<string, unknown>, agent: Record<string, unknown> = {}) {
	const state = { settings: initial, calls: [] as Array<{ url: string; method: string; body?: unknown }>, failPut: false, agent, style: null as string | null };
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		state.calls.push({ url, method, ...(body ? { body } : {}) });
		if (url === "/api/settings") return Response.json({ settings: { version: 1, agent: state.agent } });
		if (url === "/api/chats/chat_1?only=style") return Response.json({ style: state.style });
		if (url === "/api/chats/chat_1" && method === "PUT") {
			state.style = body.style;
			return Response.json({ ok: true });
		}
		assert.equal(url, "/api/chats/chat_1/settings");
		if (method === "GET") return Response.json({ settings: state.settings });
		if (state.failPut) return Response.json({ error: "no" }, { status: 500 });
		state.settings = { ...state.settings, ...body };
		return Response.json({ settings: state.settings });
	}) as typeof fetch;
	return state;
}

it("labels: the stored type, else cram Mixed, else the app-wide mechanic", async () => {
	fakeApi({ questionType: "saq" });
	const host = await mount(<Harness initial="saq" />);
	assert.equal(chip().textContent, "Qs: SAQ");
	fakeApi({ questionType: "mcq" });
	await act(async () => root!.render(<Harness key="mcq" initial="mcq" cram />));
	assert.equal(chip().textContent, "Qs: MCQ", "an explicit choice wins over cram");
	fakeApi({ questionType: "mixed" });
	await act(async () => root!.render(<Harness key="mixed" initial="mixed" />));
	assert.equal(chip().textContent, "Qs: Mixed");
	fakeApi({});
	await act(async () => root!.render(<Harness key="cram" cram />));
	assert.equal(chip().textContent, "Qs: Mixed", "unset cram lesson");
	await act(async () => root!.render(<Harness key="teach" />));
	assert.equal(chip().textContent, "Qs: MCQ", "unset lesson, multiple choice app-wide");
	fakeApi({}, { tools: { explain: true } });
	await act(async () => root!.render(<Harness key="free" agentTools={{ explain: true }} />));
	assert.equal(chip().textContent, "Qs: SAQ", "unset lesson, free recall app-wide");
	assert.ok(host.contains(chip()));
});

it("follows a Settings → Agent change for an unset lesson", async () => {
	const api = fakeApi({});
	await mount(<Harness />);
	assert.equal(chip().textContent, "Qs: MCQ");
	api.agent = { tools: { explain: true } };
	await act(async () => notifySettingsSaved("agent"));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	assert.equal(chip().textContent, "Qs: SAQ");
});

it("re-reads the app-wide mechanic on mount: a change made while it was hidden shows", async () => {
	fakeApi({}, { tools: { explain: true } });
	await mount(<Harness agentTools={{}} />);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	assert.equal(chip().textContent, "Qs: SAQ", "the page's served value was stale");
});

it("only the latest Agent read lands: a slower, older response never restores the label", async () => {
	const held: Array<(response: Response) => void> = [];
	globalThis.fetch = (async (url: string) => {
		if (url === "/api/chats/chat_1/settings") return Response.json({ settings: {} });
		assert.equal(url, "/api/settings");
		return new Promise<Response>((resolve) => held.push(resolve));
	}) as typeof fetch;
	const agent = (explain: boolean) => Response.json({ settings: { version: 1, agent: { tools: { explain } } } });
	await mount(<Harness agentTools={{}} />);
	for (const resolve of held.splice(0)) await act(async () => resolve(agent(false)));
	await act(async () => notifySettingsSaved("agent"));
	await act(async () => notifySettingsSaved("agent"));
	assert.equal(held.length, 2, "one read per save");
	await act(async () => held[1]!(agent(true)));
	assert.equal(chip().textContent, "Qs: SAQ");
	await act(async () => held[0]!(agent(false)));
	assert.equal(chip().textContent, "Qs: SAQ", "the superseded read is discarded");
});

it("opens a three-option menu with the current type checked", async () => {
	fakeApi({});
	await mount(<Harness cram />);
	assertSameNode(menu(), null);
	assert.equal(chip().getAttribute("aria-expanded"), "false");
	await click(chip());
	assert.ok(menu());
	assert.equal(chip().getAttribute("aria-expanded"), "true");
	assert.deepEqual(
		[...menu()!.querySelectorAll("button")].map((b) => [b.getAttribute("data-testid"), b.querySelector("span")!.textContent, b.getAttribute("aria-pressed")]),
		[
			["question-type-option-mcq", "MCQ", "false"],
			["question-type-option-saq", "SAQ", "false"],
			["question-type-option-mixed", "Mixed", "true"],
		],
	);
	await click(chip());
	assertSameNode(menu(), null, "the chip toggles it closed");
});

it("a pick saves only { questionType } through the chat settings API, updates at once, then reconciles", async () => {
	const api = fakeApi({ model: MODEL, thinkingLevel: "low" });
	await mount(<Harness />);
	await settle();
	const mountReads = api.calls.length;
	const chatCalls = () => api.calls.slice(mountReads).filter((c) => c.url !== "/api/settings");
	const PUT = (questionType: string) => ({ url: "/api/chats/chat_1/settings", method: "PUT", body: { questionType } });
	const GET = { url: "/api/chats/chat_1/settings", method: "GET" };
	await click(chip());
	await click(option("saq"));
	await settle();
	assert.equal(chip().textContent, "Qs: SAQ");
	assertSameNode(menu(), null, "the menu closes on a saved pick");
	assert.deepEqual(chatCalls(), [PUT("saq"), GET], "no read-then-write of the model fields; one reconcile read after the commit");
	assert.deepEqual(api.settings, { model: MODEL, thinkingLevel: "low", questionType: "saq" });
	await click(chip());
	await click(option("mixed"));
	await settle();
	assert.equal(chip().textContent, "Qs: Mixed");
	assert.deepEqual(chatCalls().slice(-2), [PUT("mixed"), GET]);
	// Re-picking the type this view shows still writes: another device may
	// have changed the stored value meanwhile.
	api.settings = { ...api.settings, questionType: "mcq" };
	await click(chip());
	await click(option("mixed"));
	await settle();
	assert.deepEqual(chatCalls().slice(-2), [PUT("mixed"), GET]);
	assert.equal(chatCalls().length, 6);
	assert.equal(api.settings.questionType, "mixed");
	assertSameNode(menu(), null);
});

it("Esc or a saved pick hands focus back to the chip", async () => {
	fakeApi({ model: MODEL });
	await mount(<Harness initial="mcq" />);
	await settle();
	await click(chip());
	await settle();
	assertSameNode(document.activeElement, menu(), "the menu takes focus");
	await act(async () => { document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })); });
	assertSameNode(menu(), null);
	assertSameNode(document.activeElement, chip(), "Esc: back to the chip");
	await click(chip());
	await settle();
	option("mixed").focus();
	await click(option("mixed"));
	await settle();
	assertSameNode(menu(), null);
	assertSameNode(document.activeElement, chip(), "a pick: back to the chip, once the save re-enables it");
});

it("a failed save changes nothing and says so", async () => {
	const api = fakeApi({ model: MODEL });
	api.failPut = true;
	const host = await mount(<Harness initial="mcq" />);
	await click(chip());
	await click(option("mixed"));
	assert.equal(chip().textContent, "Qs: MCQ");
	assert.match(host.textContent!, /Couldn't switch/);
	assert.deepEqual(api.settings, { model: MODEL });
});

it("the header shows it for lessons past the probe, never for practice", () => {
	assert.equal(showsQuestionTypeChip("teach", "probe"), false, "not while the prober runs");
	assert.equal(showsQuestionTypeChip("teach", "plan"), true);
	assert.equal(showsQuestionTypeChip("teach", "teach"), true);
	for (const phase of ["probe", "plan", "teach"] as const) assert.equal(showsQuestionTypeChip("practice", phase), false);
	// The chat wires it beside the Cram chip, gated on the session's current phase.
	const chat = fs.readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /\{showsQuestionTypeChip\(kind, phases\.at\(-1\) \?\? "probe"\) && \(\s*<QuestionTypeChip chatId=\{chatId\} stored=\{lessonQuestionType\.questionType\} cram=\{cram\} initialAgentTools=\{agentTools\} beginSave=\{lessonQuestionType\.begin\} \/>/);
	assert.match(chat, /const lessonQuestionType = useLessonQuestionType\(chatId, initialQuestionType\);/, "owned by the always-mounted view");
});

it("a slow save response never restores a label a newer refresh replaced", async () => {
	events = fakeEvents();
	let stored: Record<string, unknown> = { model: MODEL };
	let releasePut!: () => void;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url === "/api/settings") return Response.json({ settings: { version: 1, agent: {} } });
		assert.equal(url, "/api/chats/chat_1/settings");
		if (init?.method !== "PUT") return Response.json({ settings: stored });
		stored = { ...stored, ...JSON.parse(String(init.body)) };
		const confirmed = stored;
		return new Promise<Response>((resolve) => { releasePut = () => resolve(Response.json({ settings: confirmed })); });
	}) as typeof fetch;
	await mount(<Harness initial="mcq" />);
	await click(chip());
	await click(option("saq"));
	// Another device saves Mixed; its record-changed reaches this tab first.
	stored = { ...stored, questionType: "mixed" };
	await events.server("chat-settings-changed", { chatId: "chat_1" });
	await settle();
	assert.equal(chip().textContent, "Qs: Mixed");
	await act(async () => releasePut());
	await settle();
	assert.equal(chip().textContent, "Qs: Mixed", "the older save's response is superseded");
});

it("a chat-settings-changed for this chat or a reconnect re-reads the stored type; another chat's event does not", async () => {
	events = fakeEvents();
	const api = fakeApi({ model: MODEL, questionType: "mcq" });
	await mount(<Harness initial="mcq" />);
	api.settings = { ...api.settings, questionType: "mixed" };
	await events.server("chat-settings-changed", { chatId: "chat_2" });
	await settle();
	assert.equal(chip().textContent, "Qs: MCQ");
	await events.reconnect();
	await settle();
	assert.equal(chip().textContent, "Qs: Mixed", "missed while disconnected, healed on reconnect");
	api.settings = { ...api.settings, questionType: "saq" };
	await events.server("chat-settings-changed", { chatId: "chat_1" });
	await settle();
	assert.equal(chip().textContent, "Qs: SAQ");
});

it("an unset lesson follows Settings → Agent saved in another window, and on reconnect", async () => {
	events = fakeEvents();
	const api = fakeApi({});
	await mount(<Harness />);
	await settle();
	assert.equal(chip().textContent, "Qs: MCQ");
	api.agent = { tools: { explain: true } };
	await events.server("settings-changed", { section: "general" });
	await settle();
	assert.equal(chip().textContent, "Qs: MCQ", "other sections are ignored");
	await events.server("settings-changed", { section: "agent" });
	await settle();
	assert.equal(chip().textContent, "Qs: SAQ");
	api.agent = { tools: { explain: false } };
	await events.reconnect();
	await settle();
	assert.equal(chip().textContent, "Qs: MCQ");
});

it("reads the stored type once on mount: a save that landed after the page rendered shows", async () => {
	events = fakeEvents();
	fakeApi({ model: MODEL, questionType: "mixed" });
	await mount(<Harness initial="mcq" />);
	await settle();
	assert.equal(chip().textContent, "Qs: Mixed", "the page was served before another window's save");
});

/** The chat's full header wiring: cram and the question type, both live. */
function LiveLesson() {
	const { cram, begin } = useLessonCram("chat_1", false);
	const lesson = useLessonQuestionType("chat_1", undefined);
	return (
		<>
			<CramToggle chatId="chat_1" on={cram} beginSave={begin} />
			<QuestionTypeChip chatId="chat_1" stored={lesson.questionType} cram={cram} beginSave={lesson.begin} />
		</>
	);
}
const cramChip = () => document.querySelector('[data-testid="cram-toggle"]') as HTMLButtonElement;

it("cram switched in another window: chats-changed, a reconnect or the mount read refreshes the Cram chip and the label", async () => {
	events = fakeEvents();
	const api = fakeApi({});
	await mount(<ServerEventsProvider connect={connect}><LiveLesson /></ServerEventsProvider>);
	await settle();
	assert.equal(chip().textContent, "Qs: MCQ");
	assert.equal(cramChip().getAttribute("aria-pressed"), "false");
	api.style = "cram";
	await events.server("chats-changed", {});
	await settle();
	assert.equal(chip().textContent, "Qs: Mixed", "an unset lesson in cram resolves Mixed, as the server does");
	assert.equal(cramChip().getAttribute("aria-pressed"), "true");
	api.style = null;
	await events.reconnect();
	await settle();
	assert.equal(chip().textContent, "Qs: MCQ");
	assert.equal(cramChip().getAttribute("aria-pressed"), "false");
	// A fresh mount reads the style the page may have missed.
	await act(async () => root!.unmount());
	api.style = "cram";
	await mount(<ServerEventsProvider connect={connect}><LiveLesson /></ServerEventsProvider>);
	await settle();
	assert.equal(cramChip().getAttribute("aria-pressed"), "true");
});

it("a slow Cram save response never restores a style a newer read replaced", async () => {
	events = fakeEvents();
	let style: string | null = null;
	let releasePut!: () => void;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url === "/api/settings") return Response.json({ settings: { version: 1, agent: {} } });
		if (url === "/api/chats/chat_1/settings") return Response.json({ settings: {} });
		if (url === "/api/chats/chat_1?only=style") return Response.json({ style });
		assert.equal(url, "/api/chats/chat_1");
		style = JSON.parse(String(init!.body)).style;
		return new Promise<Response>((resolve) => { releasePut = () => resolve(Response.json({ ok: true })); });
	}) as typeof fetch;
	await mount(<ServerEventsProvider connect={connect}><LiveLesson /></ServerEventsProvider>);
	await settle();
	await click(cramChip());
	// Another window switches it back off; its chats-changed arrives first.
	style = null;
	await events.server("chats-changed", {});
	await settle();
	assert.equal(cramChip().getAttribute("aria-pressed"), "false");
	await act(async () => releasePut());
	await settle();
	assert.equal(cramChip().getAttribute("aria-pressed"), "false", "the older save's response is superseded");
	assert.equal(chip().textContent, "Qs: MCQ");
});

/** A chat API whose PUTs can be held BEFORE they commit and whose GETs can
 *  fail: the server's value is what a GET sees at the moment it is served. */
function racingApi(initial: { questionType?: string; style?: string | null }) {
	const state = { questionType: initial.questionType, style: initial.style ?? null, failGets: 0, holdPuts: false, held: [] as Array<() => void>, gets: 0 };
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url === "/api/settings") return Response.json({ settings: { version: 1, agent: {} } });
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			const commit = () => {
				if ("questionType" in body) state.questionType = body.questionType;
				if ("style" in body) state.style = body.style;
			};
			const respond = () => (url.endsWith("/settings") ? Response.json({ settings: { questionType: state.questionType } }) : Response.json({ ok: true }));
			if (!state.holdPuts) {
				commit();
				return respond();
			}
			return new Promise<Response>((resolve) => state.held.push(() => { commit(); resolve(respond()); }));
		}
		state.gets++;
		if (state.failGets > 0) {
			state.failGets--;
			return Response.json({ error: "down" }, { status: 503 });
		}
		if (url === "/api/chats/chat_1?only=style") return Response.json({ style: state.style });
		assert.equal(url, "/api/chats/chat_1/settings");
		return Response.json({ settings: state.questionType ? { questionType: state.questionType } : {} });
	}) as typeof fetch;
	return state;
}

it("a read served before the save committed cannot leave the label stale: the save reconciles", async () => {
	events = fakeEvents();
	const api = racingApi({ questionType: "mcq" });
	await mount(<Harness initial="mcq" />);
	await settle();
	api.holdPuts = true;
	await click(chip());
	await click(option("saq"));
	// A refresh starts after the save did, and is served before it commits.
	await events.server("chat-settings-changed", { chatId: "chat_1" });
	await settle();
	assert.equal(chip().textContent, "Qs: MCQ", "the refresh read the old value");
	await act(async () => api.held.shift()!());
	await settle();
	assert.equal(chip().textContent, "Qs: SAQ", "the post-commit read wins over the stale one");
});

it("the reconcile read retries with backoff, and a newer change from another window still wins", async () => {
	events = fakeEvents();
	const api = racingApi({ questionType: "mcq" });
	await mount(<Harness initial="mcq" />);
	await settle();
	api.holdPuts = true;
	await click(chip());
	await click(option("saq"));
	await events.server("chat-settings-changed", { chatId: "chat_1" });
	await settle();
	api.failGets = 1;
	const gets = api.gets;
	await act(async () => api.held.shift()!());
	await settle();
	assert.equal(chip().textContent, "Qs: MCQ", "the first reconcile read failed");
	// Another window saves Mixed before the retry.
	api.questionType = "mixed";
	await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
	assert.equal(api.gets, gets + 2, "one failed read, one retry");
	assert.equal(chip().textContent, "Qs: Mixed", "the retry reads the newest value");
});

it("the Cram chip reconciles after a save the same way", async () => {
	events = fakeEvents();
	const api = racingApi({ style: null });
	await mount(<ServerEventsProvider connect={connect}><LiveLesson /></ServerEventsProvider>);
	await settle();
	api.holdPuts = true;
	await click(cramChip());
	await events.server("chats-changed", {});
	await settle();
	assert.equal(cramChip().getAttribute("aria-pressed"), "false", "the refresh read the old style");
	await act(async () => api.held.shift()!());
	await settle();
	assert.equal(cramChip().getAttribute("aria-pressed"), "true");
	assert.equal(chip().textContent, "Qs: Mixed");
});
