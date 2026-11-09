import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import type { AgentSettings } from "../src/core";

// Adding a file-access folder asks the server first: a refusal shows in the
// field and saves nothing; a warning shows after the folder is added.
const dom = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
});
if (!globalThis.navigator) Object.assign(globalThis, { navigator: { userAgent: "", platform: "" } });
Object.assign(dom.document, { oninput: null });
const checks: Record<string, { error?: string; warning?: string }> = {
	"/data": { error: "That is LearnHarness's own data folder." },
	"/later": { warning: "Added, but that folder doesn't exist yet." },
};
const bodies: Record<string, unknown> = {
	"/api/search": { available: false, engine: null, reason: "" },
	"/api/keys": { keys: [] },
	"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
	"/api/settings/prompts": { prober: [], teacher: [], practice: [] },
};
let slow: (() => void)[] | null = null;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
	if (url === "/api/settings/file-access") {
		if (slow) await new Promise<void>((resolve) => slow!.push(resolve));
		return Response.json(checks[(JSON.parse(String(init?.body)) as { folder: string }).folder] ?? {});
	}
	assert.ok(url in bodies, `unexpected request: ${url}`);
	return Response.json(bodies[url]);
}) as typeof fetch;
const { createRoot } = await import("react-dom/client");
const { AgentSection } = await import("../components/settings/agent-section.tsx");

it("the server's refusal and warning show in the field", async () => {
	const writes: AgentSettings[] = [];
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<AgentSection agent={{ fileAccess: { restricted: true, folders: [] } }} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={(next) => { writes.push(next); }} onModelsChange={() => {}} onCompactionChange={() => {}} />);
	});
	const add = async (folder: string) => {
		const input = document.querySelector<HTMLInputElement>('[data-testid="file-access-add"]')!;
		// linkedom reports no default type; React tracks text input by it.
		input.setAttribute("type", "text");
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, folder);
		await act(async () => { input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
		await act(async () => {
			document.querySelector<HTMLButtonElement>('[data-testid="file-access-add-button"]')!.click();
			await new Promise((resolve) => setTimeout(resolve, 5)); // the check's round trip
		});
		const notice = (kind: string) => document.querySelector(`[data-testid="file-access-input-${kind}"]`)?.textContent ?? null;
		return { error: notice("error"), warning: notice("warning") };
	};
	assert.deepEqual(await add("/data"), { error: "That is LearnHarness's own data folder.", warning: null });
	assert.equal(writes.length, 0, "a refused folder saves nothing");
	// A warning is not styled or announced as an error.
	assert.deepEqual(await add("/later"), { error: null, warning: "Added, but that folder doesn't exist yet." });
	assert.equal(document.querySelector('[data-testid="file-access-input-warning"]')?.getAttribute("role"), "status");
	assert.deepEqual(writes.at(-1)?.fileAccess, { restricted: true, folders: ["/later"] });
	await act(async () => root.unmount());
});

it("on a slow server, quick adds all land and newer typing survives the check", async () => {
	const writes: AgentSettings[] = [];
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<AgentSection agent={{ fileAccess: { restricted: true, folders: [] } }} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={(next) => { writes.push(next); }} onModelsChange={() => {}} onCompactionChange={() => {}} />);
	});
	const input = () => document.querySelector<HTMLInputElement>('[data-testid="file-access-add"]')!;
	const type = async (text: string) => {
		input().setAttribute("type", "text");
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), text);
		await act(async () => { input().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
	};
	const enter = async () => {
		await act(async () => { input().dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" })); });
	};
	const release = async () => {
		for (let i = 0; i < 20 && !slow!.length; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
		await act(async () => { slow!.shift()!(); await new Promise((resolve) => setTimeout(resolve, 5)); });
	};
	slow = [];
	await type("/a"); await enter();
	await type("/b"); await enter();
	await type("/c");
	await release();
	assert.equal(input().value, "/c", "text typed during the check is kept");
	await release();
	assert.deepEqual(writes.at(-1)?.fileAccess?.folders, ["/a", "/b"], "the second add keeps the first");
	slow = null;
	await act(async () => root.unmount());
});

it("a folder add that fails to save is not kept: the text stays, a retry adds it, and the next add leaves it out", async () => {
	const writes: AgentSettings[] = [];
	let fail = true;
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<AgentSection agent={{ fileAccess: { restricted: true, folders: ["/tmp"] } }} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={async (next) => { writes.push(next); return !fail; }} onModelsChange={() => {}} onCompactionChange={() => {}} />);
	});
	const input = () => document.querySelector<HTMLInputElement>('[data-testid="file-access-add"]')!;
	const add = async (text: string) => {
		input().setAttribute("type", "text");
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), text);
		await act(async () => { input().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
		await act(async () => {
			input().dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" }));
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	};
	await add("/usr/local");
	assert.equal(input().value, "/usr/local", "a failed save keeps the typed folder");
	fail = false;
	await add("/usr/local");
	assertSameNode(document.querySelector('[data-testid="file-access-input-error"]'), null, "the retry is not refused as already listed");
	assert.deepEqual(writes.at(-1)?.fileAccess?.folders, ["/tmp", "/usr/local"]);
	await act(async () => root.unmount());

	const root2 = createRoot(document.getElementById("root")!);
	writes.length = 0;
	fail = true;
	await act(async () => {
		root2.render(<AgentSection agent={{ fileAccess: { restricted: true, folders: ["/tmp"] } }} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={async (next) => { writes.push(next); return !fail; }} onModelsChange={() => {}} onCompactionChange={() => {}} />);
	});
	await add("/usr/local");
	fail = false;
	await add("/opt");
	assert.deepEqual(writes.at(-1)?.fileAccess?.folders, ["/tmp", "/opt"], "the failed folder does not come back");
	await act(async () => root2.unmount());
});

it("on a slow server, quick Agent changes all land, each on top of the last", async () => {
	const writes: AgentSettings[] = [];
	const pending: (() => void)[] = [];
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<AgentSection agent={{ fileAccess: { restricted: true, folders: ["/tmp", "/usr/local", "/opt"] } }} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={(next) => { writes.push(next); return new Promise<boolean>((resolve) => pending.push(() => resolve(true))); }}
			onModelsChange={() => {}} onCompactionChange={() => {}} />);
	});
	const click = async (selector: string) => {
		await act(async () => { document.querySelector<HTMLButtonElement>(selector)!.click(); });
	};
	const settle = async () => {
		for (let i = 0; i < 20; i++) {
			await act(async () => { pending.shift()?.(); await new Promise((resolve) => setTimeout(resolve, 2)); });
		}
	};
	await click('[data-testid="toggle-tool-research"]');
	await click('[data-testid="toggle-tool-demo"]');
	await click('[aria-label="Remove /usr/local"]');
	await click('[aria-label="Remove /opt"]');
	await settle();
	assert.equal(writes.length, 4);
	assert.deepEqual(writes.at(-1)?.tools, { research: false, demo: false }, "the first toggle survives the second");
	assert.deepEqual(writes.at(-1)?.fileAccess?.folders, ["/tmp"], "the first remove survives the second");
	await act(async () => root.unmount());
});
