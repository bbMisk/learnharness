/**
 * THE MEMOIZED TRANSCRIPT (components/transcript-rows.tsx): while a reply
 * streams, settled rows — and settled parts of the very group the reply is
 * growing — never re-render; only the streaming row does. Counted through
 * the artifact registry (a probe renderer renders once per part render).
 * The control run feeds full projectView output (fresh objects every
 * update): the same probes then re-render on every update.
 */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { LhMessage } from "../src/core/native-messages.ts";
import { projectView, type LhViewMessage, type LiveTurnState } from "../src/core/view.ts";
import { createViewProjector } from "../src/core/view-incremental.ts";
import { phaseTimeline } from "../src/core/phases.ts";
import type { ArtifactPartProps } from "../src/core/index.ts";

const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window,
	document,
	Node: window.Node,
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	Event: window.Event,
	CustomEvent: window.CustomEvent,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (handle: number) => clearTimeout(handle),
	// Radix Collapsible (the reasoning row) reads computed animation styles.
	getComputedStyle: () => ({ animationName: "none", getPropertyValue: () => "" }),
});
const { artifactRenderers } = await import("../components/artifacts/index.ts");
const { TranscriptRows } = await import("../components/transcript-rows.tsx");

const renders = new Map<string, number>();
function RenderProbe({ part }: ArtifactPartProps) {
	const id = String(part.toolCallId);
	renders.set(id, (renders.get(id) ?? 0) + 1);
	return <div data-probe={id} />;
}
artifactRenderers.render_probe = RenderProbe;

const usage = { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 };
const user = (id: string, text: string) => ({ id, role: "user", content: text, timestamp: 0 }) as unknown as LhMessage;
const assistant = (id: string, content: object[]) =>
	({ id, role: "assistant", content, stopReason: "stop", usage, provider: "test", model: "test", timestamp: 0 }) as unknown as LhMessage;
const probe = (id: string) => ({ type: "toolCall", id, name: "render_probe", arguments: {} });
const probeResult = (id: string) =>
	({ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: "render_probe", content: [], details: { id }, isError: false, timestamp: 0 }) as unknown as LhMessage;

/** 40 settled exchanges, each with a probe card; the last group (the one
 *  the reply streams into) carries its own probe. */
function settledHistory(): LhMessage[] {
	const out: LhMessage[] = [];
	for (let g = 0; g < 40; g++) {
		out.push(user(`u${g}`, `question ${g}`));
		out.push(assistant(`a${g}`, [{ type: "thinking", thinking: `t${g}` }, { type: "text", text: `answer **${g}**` }, probe(`p${g}`)]));
		out.push(probeResult(`p${g}`));
	}
	return out;
}

const SHOW_ALL = { hidesMessage: () => false, hiddenParts: () => 0 };
const noop = () => {};

type SetView = (v: { messages: LhViewMessage[]; streaming: boolean; activeMessageId?: string }) => void;
function Harness({ initial, expose }: { initial: { messages: LhViewMessage[]; streaming: boolean; activeMessageId?: string }; expose: (set: SetView) => void }) {
	const [view, set] = useState(initial);
	expose(set);
	return (
		<div>
			<TranscriptRows
				messages={view.messages}
				phases={phaseTimeline(view.messages)}
				transcript={SHOW_ALL}
				streaming={view.streaming}
				activeMessageId={view.activeMessageId}
				malformedQuestions={[]}
				busy={view.streaming}
				questionPending={false}
				compacting={false}
				onRetryQuestion={noop}
				onOpenPlan={noop}
			/>
		</div>
	);
}

const roots: { root: Root; host: HTMLElement }[] = [];
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	renders.clear();
});

async function mount(messages: LhViewMessage[], streaming = false): Promise<{ host: HTMLElement; setView: SetView }> {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	let setView!: SetView;
	await act(async () => root.render(<Harness initial={{ messages, streaming }} expose={(set) => (setView = set)} />));
	return { host, setView: (v) => setView(v) };
}

/** Streams a reply that merges into the last assistant group; returns the
 *  per-probe render counts after `updates` stream updates. */
async function streamReply(project: (m: LhMessage[], l?: LiveTurnState) => LhViewMessage[], updates: number) {
	const base = settledHistory();
	const { host, setView } = await mount(project(base));
	assert.equal(renders.size, 40);
	for (const n of renders.values()) assert.equal(n, 1, "one render per probe at mount");
	let reply = "";
	for (let i = 0; i < updates; i++) {
		reply += ` word${i}`;
		const live: LiveTurnState = { inFlight: true, streamingIds: new Set(["s1"]), executions: new Map() };
		const messages = project([...base, assistant("s1", [{ type: "text", text: reply }])], live);
		await act(async () => setView({ messages, streaming: true }));
		assert.ok(host.textContent!.includes(`word${i}`), "the streaming text renders");
	}
	return { host, counts: new Map(renders) };
}

describe("streaming leaves settled transcript rows alone", () => {
	it("settled rows and settled parts of the growing group render once", async () => {
		const projector = createViewProjector();
		const { host, counts } = await streamReply((m, l) => projector.project(m, l), 10);
		for (const [id, n] of counts) assert.equal(n, 1, `${id} re-rendered ${n - 1} times while the reply streamed`);
		assert.ok(host.textContent!.includes("word9"));
	});

	it("control: fresh projections (the old path) re-render every probe per update", async () => {
		const { counts } = await streamReply((m, l) => projectView(m, l), 3);
		for (const [id, n] of counts) assert.equal(n, 4, `${id}: mount + 3 updates`);
	});

	it("incremental updates render the same markup as a fresh mount", async () => {
		const projector = createViewProjector();
		const base = settledHistory();
		const steps: Array<[LhMessage[], LiveTurnState | undefined, boolean]> = [];
		let reply = "";
		for (let i = 0; i < 5; i++) {
			reply += ` $x_${i}$ word${i}`;
			steps.push([[...base, assistant("s1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: reply }])], { inFlight: true, streamingIds: new Set(["s1"]), executions: new Map() }, true]);
		}
		const done = [...base, assistant("s1", [{ type: "text", text: reply }, probe("p_new")]), probeResult("p_new"), user("u_next", "thanks")];
		steps.push([done, undefined, false]);
		const { host, setView } = await mount(projector.project(base));
		for (const [messages, live, streaming] of steps) {
			await act(async () => setView({ messages: projector.project(messages, live), streaming }));
			const fresh = await mount(projectView(messages, live), streaming);
			// useId values differ between roots; everything else must match.
			const markup = (el: HTMLElement) => el.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_");
			assert.equal(markup(host), markup(fresh.host));
		}
		assert.ok(host.querySelector('[data-probe="p_new"]'));
	});
});

describe("the thinking row follows the message being written (round-4 hunt)", () => {
	it("a hidden tracking-only step does not re-activate the previous step's reasoning", async () => {
		const native = [
			user("u1", "cram me"),
			assistant("a1", [{ type: "thinking", thinking: "planning" }, { type: "toolCall", id: "c1", name: "note_mistake", arguments: { text: "x" } }]),
			({ id: "r_c1", role: "toolResult", toolCallId: "c1", toolName: "note_mistake", content: [{ type: "text", text: "{}" }], details: { ok: true, id: "m1", text: "x" }, isError: false, timestamp: 0 }) as unknown as LhMessage,
			assistant("a2", [{ type: "toolCall", id: "c2", name: "note_mistake", arguments: { text: "y" } }]),
		];
		const live: LiveTurnState = { inFlight: true, streamingIds: new Set(["a1", "a2"]), executions: new Map() };
		const view = projectView(native, live);
		const { host, setView } = await mount(view, true);
		await act(async () => setView({ messages: view, streaming: true, activeMessageId: "a2" }));
		assert.ok(!host.textContent!.includes("Thinking..."), "a1's reasoning is not shown as still thinking while hidden a2 streams");
		assert.ok(host.textContent!.includes("AGENT’S THINKING"));
		await act(async () => setView({ messages: view, streaming: true, activeMessageId: "a1" }));
		assert.ok(host.textContent!.includes("Thinking..."), "the message being written keeps its live thinking row");
	});
});
