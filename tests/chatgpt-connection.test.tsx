import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChatGPTConnection } from "../components/chatgpt-connection.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; });

it("opens official sign-in, shows the first-use confirmation, and notifies setup only after dismissal", async () => {
	let pending = false, connected = false, welcome = false, notified = 0;
	let poll: (() => void) | undefined;
	const actions: string[] = [], opened: string[] = [];
	Object.assign(dom.window, { open: (url: string) => opened.push(url) });
	globalThis.setInterval = ((callback: () => void) => { poll = callback; return 1; }) as unknown as typeof setInterval;
	globalThis.clearInterval = (() => {}) as typeof clearInterval;
	window.addEventListener("lh:settings-saved", () => notified++);
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), "/api/chatgpt");
		if (init?.method === "POST") {
			const action = JSON.parse(String(init.body)).action as string;
			actions.push(action);
			if (action === "connect") { pending = true; return Response.json({ url: "https://auth.openai.com/api/accounts/authorize?fixture=true" }); }
			if (action === "welcome") welcome = false;
		}
		return Response.json({ accounts: [], pending, connected, welcome });
	};
	const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ChatGPTConnection />));
	const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Continue with ChatGPT")!;
	await act(async () => button.click());
	assert.equal(opened.length, 1); assert.match(opened[0]!, /^https:\/\/auth\.openai\.com\//);
	assert.equal(notified, 0);
	assert.ok(document.body.textContent?.includes("Finish sign-in"));
	pending = false; connected = true; welcome = true;
	await act(async () => { poll!(); });
	assert.deepEqual(actions, ["connect", "refresh"]);
	assert.equal(notified, 0);
	assert.ok(document.querySelector('[role="dialog"]'));
	const gotIt = [...document.querySelectorAll("button")].find((b) => b.textContent === "Got it")!;
	await act(async () => gotIt.click());
	assert.equal(notified, 1);
	assert.equal(document.querySelector('[role="dialog"]'), null);
	assert.ok(!actions.some((a) => /chat|session/.test(a)));
});
