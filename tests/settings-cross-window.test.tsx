import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

// Another window's save (the server's settings-changed event) refreshes this
// window: the live appearance, and the open dialog's record — so the next
// section PUT from here never writes back a stale copy of that section.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
});
const { createRoot } = await import("react-dom/client");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { AppearanceProvider, useAppearance } = await import("../components/settings/appearance.tsx");
const { SettingsDialogBody } = await import("../components/settings/settings-dialog-body.tsx");

const realFetch = globalThis.fetch;
let stored: Record<string, unknown> = { version: 1, appearance: { mdRendering: { headingWeight: 900 } } };
const puts: { url: string; body: unknown }[] = [];
let settingsReads = 0;
let root: Root | null = null;
let host: HTMLElement | null = null;
let emit: (name: string, data: unknown) => void = () => {};
let seen: ReturnType<typeof useAppearance>["appearance"] | null = null;

function Probe() { seen = useAppearance().appearance; return null; }

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	host?.remove();
	root = null; host = null;
	globalThis.fetch = realFetch;
	puts.length = 0;
	settingsReads = 0;
});

async function mount(children: React.ReactNode) {
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url === "/api/settings") { settingsReads++; return Response.json({ settings: stored }); }
		if (init?.method === "PUT") { puts.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({}); }
		return Response.json({});
	}) as typeof fetch;
	const listeners = new Map<string, (data: string) => void>();
	emit = (name, data) => listeners.get(name)?.(JSON.stringify(data));
	const connect = () => ({ close() {}, onOpen() {}, onEvent(name: string, cb: (data: string) => void) { listeners.set(name, cb); } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<ServerEventsProvider connect={connect}><AppearanceProvider>{children}</AppearanceProvider></ServerEventsProvider>);
	});
}

describe("settings saved in another window", () => {
	it("re-applies appearance live", async () => {
		await mount(<Probe />);
		assert.equal(seen?.mdRendering.headingWeight, 900);
		stored = { version: 1, appearance: { background: "#202830", mdRendering: { headingWeight: 300 } } };
		await act(async () => { emit("settings-changed", { section: "appearance" }); });
		assert.equal(seen?.background, "#202830");
		assert.equal(seen?.mdRendering.headingWeight, 300);
	});

	it("refreshes the open dialog's record", async () => {
		stored = { version: 1, appearance: { mdRendering: { headingWeight: 900 } } };
		await mount(<SettingsDialogBody initialSection="appearance" onClose={() => {}} />);
		const before = settingsReads;
		stored = { version: 1, appearance: { mdRendering: { headingWeight: 300 } } };
		await act(async () => { emit("settings-changed", { section: "appearance" }); });
		assert.ok(settingsReads > before, "the dialog re-reads the record");
		const input = document.querySelector<HTMLInputElement>('[data-testid="input-heading-weight"]');
		assert.equal(input?.value, "300");
	});
});
