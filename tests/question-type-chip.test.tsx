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
import * as fs from "node:fs";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let active: Element = dom.document.body;
Object.defineProperty(dom.document, "activeElement", { get: () => active });
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 900 });
dom.window.HTMLElement.prototype.focus = function () { active = this; };
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
const { QuestionTypeChip, showsQuestionTypeChip } = await import("../components/question-type-chip.tsx");
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

/** The chat's wiring: the stored value lives in the chat, the chip saves it. */
function Harness({ initial, cram = false, agentTools }: { initial?: QuestionType; cram?: boolean; agentTools?: Record<string, boolean> }) {
	const [stored, setStored] = React.useState(initial);
	return <QuestionTypeChip chatId="chat_1" stored={stored} cram={cram} initialAgentTools={agentTools} onSaved={setStored} />;
}

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
	const state = { settings: initial, calls: [] as Array<{ url: string; method: string; body?: unknown }>, failPut: false, agent };
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		state.calls.push({ url, method, ...(body ? { body } : {}) });
		if (url === "/api/settings") return Response.json({ settings: { version: 1, agent: state.agent } });
		assert.equal(url, "/api/chats/chat_1/settings");
		if (method === "GET") return Response.json({ settings: state.settings });
		if (state.failPut) return Response.json({ error: "no" }, { status: 500 });
		state.settings = { ...state.settings, ...body };
		return Response.json({ settings: state.settings });
	}) as typeof fetch;
	return state;
}

it("labels: the stored type, else cram Mixed, else the app-wide mechanic", async () => {
	fakeApi({});
	const host = await mount(<Harness initial="saq" />);
	assert.equal(chip().textContent, "Qs: SAQ");
	await act(async () => root!.render(<Harness key="mcq" initial="mcq" cram />));
	assert.equal(chip().textContent, "Qs: MCQ", "an explicit choice wins over cram");
	await act(async () => root!.render(<Harness key="mixed" initial="mixed" />));
	assert.equal(chip().textContent, "Qs: Mixed");
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
	assert.equal(menu(), null);
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
	assert.equal(menu(), null, "the chip toggles it closed");
});

it("a pick saves only { questionType } through the chat settings API and updates at once", async () => {
	const api = fakeApi({ model: MODEL, thinkingLevel: "low" });
	await mount(<Harness />);
	const chatCalls = () => api.calls.filter((c) => c.url !== "/api/settings");
	await click(chip());
	await click(option("saq"));
	assert.equal(chip().textContent, "Qs: SAQ");
	assert.equal(menu(), null, "the menu closes on a saved pick");
	assert.deepEqual(chatCalls(), [{ url: "/api/chats/chat_1/settings", method: "PUT", body: { questionType: "saq" } }], "no read-then-write of the model fields");
	assert.deepEqual(api.settings, { model: MODEL, thinkingLevel: "low", questionType: "saq" });
	await click(chip());
	await click(option("mixed"));
	assert.equal(chip().textContent, "Qs: Mixed");
	assert.deepEqual(chatCalls().at(-1), { url: "/api/chats/chat_1/settings", method: "PUT", body: { questionType: "mixed" } });
	// Re-picking the type this view shows still writes: another device may
	// have changed the stored value meanwhile.
	api.settings = { ...api.settings, questionType: "mcq" };
	await click(chip());
	await click(option("mixed"));
	assert.deepEqual(chatCalls().at(-1), { url: "/api/chats/chat_1/settings", method: "PUT", body: { questionType: "mixed" } });
	assert.equal(chatCalls().length, 3);
	assert.equal(api.settings.questionType, "mixed");
	assert.equal(menu(), null);
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
	assert.match(chat, /\{showsQuestionTypeChip\(kind, phases\.at\(-1\) \?\? "probe"\) && \(\s*<QuestionTypeChip chatId=\{chatId\} stored=\{questionType\} cram=\{cram\}/);
	assert.match(chat, /setQuestionType\(sanitizeQuestionType\(record\.settings\?\.questionType\)\)/, "a record sync re-reads it (another device's pick)");
});
