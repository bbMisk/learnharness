/**
 * The Antigravity settings row (components/settings/antigravity-status.tsx)
 * and its route file. The browser side never learns the server switch from a
 * bundled constant: it renders nothing unless GET /api/antigravity says
 * `available: true`, and a switched-off server answers 200 `{ available: false }`.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

import { AntigravityProviderStatus, antigravityStatusLabel } from "../components/settings/antigravity-status.tsx";
import { onSettingsSaved } from "../components/settings-signal.ts";
import type { AntigravityStatus } from "../src/core/contracts/antigravity.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]');
const check = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-check"]');
const label = () => document.querySelector('[role="status"]')?.textContent;

type Call = { method: string; url: string; body?: unknown; intent: string | null; cache?: string };

function fixture(respond: (call: Call) => Response | Promise<Response>): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, intent: new Headers(init?.headers).get("x-learnharness-antigravity"), cache: init?.cache };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return calls;
}

async function mount() {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<AntigravityProviderStatus />));
}

afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

const base: AntigravityStatus = { available: true, enabled: false, installed: true, models: 0 };

test("hidden while the API says available: false (switch off), errors, fails, or answers garbage; nothing is logged", async (t) => {
	const logged: unknown[] = [];
	const originals = { error: console.error, warn: console.warn };
	console.error = (...args: unknown[]) => { logged.push(args); };
	console.warn = (...args: unknown[]) => { logged.push(args); };
	t.after(() => Object.assign(console, originals));
	for (const respond of [
		() => Response.json({ available: false }),
		() => Response.json({ ...base, available: false }),
		() => Response.json({ ...base, available: undefined }),
		() => Response.json({ error: "Not found" }, { status: 404 }),
		() => new Response("not json", { status: 200 }),
		() => { throw new Error("offline"); },
		() => Response.json({ enabled: "yes" }),
	]) {
		const calls = fixture(respond);
		await mount();
		assert.equal(host!.innerHTML, "");
		assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET /api/antigravity"]);
		assert.equal(calls[0]!.intent, "1");
		assert.equal(calls[0]!.cache, "no-store");
		await act(async () => root?.unmount()); host?.remove(); root = undefined;
	}
	assert.deepEqual(logged, []);
});

test("off by default: the toggle is off, the caution line shows, no check button", async () => {
	fixture(() => Response.json(base));
	await mount();
	assert.equal(toggle()?.getAttribute("aria-checked"), "false");
	assert.equal(check(), null);
	assert.match(document.body.textContent ?? "", /Uses your Google Antigravity account\. Google's terms restrict using consumer plans through third-party apps\./);
});

test("the toggle PUTs { enabled }, then fires the keys signal so the model picker refetches", async () => {
	let state = { ...base };
	const calls = fixture((call) => {
		if (call.method === "PUT") state = { ...state, enabled: (call.body as { enabled: boolean }).enabled };
		return Response.json(state);
	});
	const signals: string[] = [];
	const stop = onSettingsSaved((section) => signals.push(section));
	try {
		await mount();
		await act(async () => toggle()!.click());
		assert.deepEqual(calls[1], { method: "PUT", url: "/api/antigravity", body: { enabled: true }, intent: "1", cache: "no-store" });
		assert.equal(toggle()?.getAttribute("aria-checked"), "true");
		assert.equal(label(), "Installed · not checked");
		assert.deepEqual(signals, ["keys"]);
		await act(async () => toggle()!.click());
		assert.deepEqual(calls[2]!.body, { enabled: false });
		assert.equal(check(), null);
	} finally { stop(); }
});

test("check connection POSTs and shows each status", async () => {
	const answers: AntigravityStatus[] = [
		{ ...base, enabled: true, problem: 'Not signed in to Antigravity. Run "agy" in a terminal and sign in, then check again in Settings.' },
		{ ...base, enabled: true, models: 3, agentVersion: "1.5.12", checkedAt: "2026-11-23T12:00:00.000Z" },
	];
	const calls = fixture((call) => Response.json(call.method === "POST" ? answers.shift()! : { ...base, enabled: true }));
	await mount();
	assert.equal(label(), "Installed · not checked");
	await act(async () => check()!.click());
	assert.deepEqual(calls[1], { method: "POST", url: "/api/antigravity", body: { action: "check" }, intent: "1", cache: "no-store" });
	assert.equal(label(), 'Not signed in to Antigravity. Run "agy" in a terminal and sign in, then check again in Settings.');
	await act(async () => check()!.click());
	assert.equal(label(), "Connected · 3 models · agy 1.5.12");
});

test("a failed check keeps the last status and says so", async () => {
	fixture((call) => call.method === "POST" ? new Response(null, { status: 500 }) : Response.json({ ...base, enabled: true }));
	await mount();
	await act(async () => check()!.click());
	assert.equal(document.querySelector('[role="alert"]')?.textContent, "Could not check Antigravity.");
	assert.equal(label(), "Installed · not checked");
});

test("status labels", () => {
	assert.equal(antigravityStatusLabel({ ...base, installed: false }), "Not installed");
	assert.equal(antigravityStatusLabel({ ...base, installed: false, problem: "x" }), "Not installed");
	assert.equal(antigravityStatusLabel({ ...base }), "Installed · not checked");
	assert.equal(antigravityStatusLabel({ ...base, checkedAt: "t", models: 1 }), "Connected · 1 model");
	assert.equal(antigravityStatusLabel({ ...base, checkedAt: "t", models: 2, agentVersion: "1.5.12" }), "Connected · 2 models · agy 1.5.12");
});

test("not installed: Check connection stays pressable, so installing agy and pressing it again works", async () => {
	let installed = false;
	const calls = fixture((call) => Response.json({ ...base, enabled: true, installed: call.method === "POST" ? (installed = true) : installed, ...(call.method === "POST" ? { checkedAt: "2026-11-23T12:00:00.000Z", models: 2 } : {}) }));
	await mount();
	assert.equal(label(), "Not installed");
	assert.equal(check()?.disabled, false);
	await act(async () => check()!.click());
	assert.equal(calls[1]!.method, "POST");
	assert.equal(label(), "Connected · 2 models");
});

test("while the switch is off the route answers GET with 200 { available: false } only, and PUT/POST with 404", async () => {
	const previous = process.env.LH_FORK_ANTIGRAVITY;
	process.env.LH_FORK_ANTIGRAVITY = "0";
	// The server barrel loads the stores: keep them out of the checkout's data folder.
	const data = mkdtempSync(join(tmpdir(), "lh-agy-route-"));
	process.env.LH_DATA_DIR ??= data;
	process.env.LH_AUTH_FILE ??= join(data, "auth.json");
	try {
		const route = await import("../app/api/antigravity/route.ts");
		const get = await route.GET(new Request("http://localhost/api/antigravity", { headers: { "x-learnharness-antigravity": "1" } }));
		assert.equal(get.status, 200);
		assert.deepEqual(await get.json(), { available: false });
		for (const method of ["PUT", "POST"] as const) {
			const response = await route[method](new Request("http://localhost/api/antigravity", { method, headers: { "x-learnharness-antigravity": "1" }, body: "{}" }));
			assert.equal(response.status, 404, method);
		}
	} finally {
		if (previous === undefined) delete process.env.LH_FORK_ANTIGRAVITY; else process.env.LH_FORK_ANTIGRAVITY = previous;
		rmSync(data, { recursive: true, force: true });
	}
});

test("Sign in: the main action when the last check found no sign-in, a small secondary one otherwise; disabled while a sign-in runs", async () => {
	const { ANTIGRAVITY_NOT_SIGNED_IN } = await import("../src/core/contracts/antigravity.ts");
	const signIn = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-sign-in"]');
	const order = () => [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).filter((id) => id === "antigravity-sign-in" || id === "antigravity-check");
	// Not signed in: Sign in comes first.
	let finish!: (r: Response) => void;
	const calls = fixture((call) => call.method === "POST" ? new Promise((resolve) => { finish = resolve; }) : Response.json({ ...base, enabled: true, problem: ANTIGRAVITY_NOT_SIGNED_IN }));
	await mount();
	assert.deepEqual(order(), ["antigravity-sign-in", "antigravity-check"]);
	assert.equal(signIn()!.disabled, false);
	await act(async () => signIn()!.click());
	assert.deepEqual(calls.at(-1)!.body, { action: "signIn" });
	assert.equal(calls.at(-1)!.intent, "1");
	assert.match(label() ?? "", /Signing in/);
	assert.equal(signIn()!.disabled, true);
	assert.equal(check()!.disabled, true);
	await act(async () => finish(Response.json({ ...base, enabled: true, models: 2, checkedAt: "2026-11-23T00:00:00.000Z" })));
	assert.match(label() ?? "", /^Connected · 2 models/);
	// Connected: Sign in stays reachable as a secondary action after Check.
	assert.deepEqual(order(), ["antigravity-check", "antigravity-sign-in"]);
	await act(async () => root?.unmount());
	// A sign-in already running (another window pressed it): shown and disabled.
	fixture(() => Response.json({ ...base, enabled: true, signingIn: true }));
	host?.remove(); await mount();
	assert.match(label() ?? "", /Signing in/);
	assert.equal(signIn()!.disabled, true);
});
