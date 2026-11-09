/**
 * Update-banner render tests (Wave C, 2026-10-10): the banner is a pure
 * function of the shell's observational status — hidden without a bridge
 * or snapshot/event, visible with the downloaded
 * status, Restart wired to the bridge. The subscribe effect only runs
 * client-side, so the SSR pass pins the hidden state; the pushed state is
 * exercised by mounting with the bridge stubbed (classic-JSX shim as in
 * render-sidebar.test.tsx).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { parseHTML } from "linkedom";
import UpdateBanner from "../components/update-banner.tsx";
import type { UpdateState } from "../components/settings/update-settings.tsx";

// linkedom as the DOM for the interactive pass (first createRoot test in
// the repo — the banner's push→render→click flow needs real effects).
// The window.lh bridge type is declared globally by components/sidebar.tsx.
const dom = parseHTML("<html><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;

describe("update banner (Wave C)", () => {
	afterEach(() => {
		delete (window as { lh?: unknown }).lh;
	});

	it("renders nothing with no bridge (browser / SSR)", () => {
		const html = renderToStaticMarkup(<UpdateBanner />);
		assert.equal(html, "");
	});

	it("renders nothing when the bridge exists but no status has arrived", () => {
		const listeners: Array<(s: UpdateState) => void> = [];
		(window as { lh?: unknown }).lh = {
			onUpdateStatus: (cb: (s: UpdateState) => void) => {
				listeners.push(cb);
				return () => {};
			},
			installUpdate: () => {},
		};
		const html = renderToStaticMarkup(<UpdateBanner />);
		assert.equal(html, "");
		void listeners;
	});

	it("shows the version + Restart once the downloaded push arrives, and Restart installs", async () => {
		let pushed: ((s: UpdateState) => void) | null = null;
		let installed = 0;
		(window as { lh?: unknown }).lh = {
			onUpdateStatus: (cb: (s: UpdateState) => void) => {
				pushed = cb;
				return () => {};
			},
			installUpdate: () => {
				installed += 1;
			},
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = ReactDOMClient.createRoot(host);
		flushSync(() => root.render(<UpdateBanner />));
		assert.equal(host.innerHTML, "", "hidden before the push");

		await new Promise((r) => setTimeout(r, 0));
		flushSync(() => pushed?.({ status: "downloaded", version: "0.3.1", revision: 1 }));
		assert.ok(host.innerHTML.includes("0.3.1"), "the version renders");
		assert.ok(host.innerHTML.includes("Restart"), "the restart affordance renders");
		// Its own band: the bottom inset grows by its height, so it covers no control.
		assert.match(host.querySelector<HTMLElement>("[data-testid='update-banner']")!.className, /bottom-\[calc\(var\(--lh-safe-bottom\)-2\.75rem\)\] .*h-11/);
		assert.ok(document.documentElement.classList.contains("lh-update-band"), "the layout keeps the band clear");

		const button = host.querySelector<HTMLButtonElement>("[data-testid='update-banner'] button");
		assert.ok(button, "restart button exists");
		button!.click();
		assert.equal(installed, 1, "Restart asks the shell to quit-and-install");
		assert.equal(button!.textContent, "Restart to update");
		root.unmount();
		host.remove();
	});

	/* macOS self-updater card states (owner, 2026-11-03). */
	async function mountWith(state: UpdateState) {
		let pushed: ((s: UpdateState) => void) | null = null;
		let installed = 0;
		(window as { lh?: unknown }).lh = {
			onUpdateStatus: (cb: (s: UpdateState) => void) => { pushed = cb; return () => {}; },
			installUpdate: () => { installed += 1; },
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = ReactDOMClient.createRoot(host);
		flushSync(() => root.render(<UpdateBanner />));
		await new Promise((r) => setTimeout(r, 0));
		flushSync(() => pushed?.(state));
		return { host, push: (next: UpdateState) => flushSync(() => pushed?.(next)), installed: () => installed, done: () => { root.unmount(); host.remove(); } };
	}

	it("asks to move the app to Applications when it can't update in place", async () => {
		const m = await mountWith({ status: "move-to-applications", version: "0.4.1", revision: 1 });
		const card = m.host.querySelector("[data-testid='update-banner']");
		assert.ok(card, "card shows");
		assert.equal(card!.getAttribute("data-status"), "move-to-applications");
		assert.ok(card!.textContent!.includes("Move LearnHarness to Applications to get updates"));
		assert.equal(card!.querySelectorAll("a").length, 0);
		assert.ok(!card!.textContent!.includes("Restart"));
		m.done();
	});

	it("links the permanent installer when the app's folder isn't writable", async () => {
		const m = await mountWith({ status: "manual-download", version: "0.4.1", revision: 1 });
		const card = m.host.querySelector("[data-testid='update-banner']")!;
		assert.ok(card.textContent!.includes("LearnHarness 0.4.1 is available"));
		const link = card.querySelector("a")!;
		assert.equal(link.textContent, "Download update");
		assert.equal(link.getAttribute("href"), "https://github.com/bbMisk/learnharness/releases/latest/download/LearnHarness-arm64.dmg");
		assert.equal(link.getAttribute("target"), "_blank");
		assert.equal(m.installed(), 0);
		m.done();
	});

	it("stays hidden for in-progress and error states, and dismissal is per state and version", async () => {
		const m = await mountWith({ status: "downloading", version: "0.4.1", revision: 1 });
		assert.equal(m.host.innerHTML, "");
		m.push({ status: "error", version: null, revision: 2 });
		assert.equal(m.host.innerHTML, "");
		m.push({ status: "move-to-applications", version: "0.4.1", revision: 3 });
		flushSync(() => m.host.querySelector<HTMLButtonElement>("[aria-label='Dismiss update notification']")!.click());
		assert.equal(m.host.innerHTML, "", "dismissed");
		assert.ok(!document.documentElement.classList.contains("lh-update-band"), "the layout takes the space back");
		m.push({ status: "move-to-applications", version: "0.4.2", revision: 4 });
		assert.ok(m.host.innerHTML.includes("Move LearnHarness"), "a newer version shows again");
		m.done();
	});
});
