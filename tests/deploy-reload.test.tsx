import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { DeployReload } = await import("../components/deploy-reload.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

let root: Root | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});

async function reconnect(served: string, extra = "") {
	globalThis.fetch = (async () => Response.json({ app: "learnharness", status: "ok", build: served })) as typeof fetch;
	let open: () => void = () => {};
	const channel = () => ({
		close() {},
		onOpen(cb: () => void) {
			open = cb;
		},
		onEvent() {},
	});
	let reloads = 0;
	const host = document.createElement("div");
	host.innerHTML = extra;
	document.body.append(host);
	const mount = document.createElement("div");
	document.body.append(mount);
	root = createRoot(mount);
	await act(async () =>
		root!.render(
			<ServerEventsProvider connect={channel}>
				<DeployReload build="build-a" reload={() => reloads++} />
			</ServerEventsProvider>,
		),
	);
	await act(async () => {
		open();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return { reloads: () => reloads, pill: () => document.querySelector('[data-testid="deploy-reload"]') };
}

it("does nothing while the server runs the same build", async () => {
	const r = await reconnect("build-a");
	assert.equal(r.reloads(), 0);
	assert.equal(r.pill(), null);
});

it("offers a reload after a deploy and never reloads by itself", async () => {
	const r = await reconnect("build-b");
	assert.equal(r.reloads(), 0, "attachments and side-tutor state live only in the page");
	const pill = r.pill() as HTMLButtonElement | null;
	assert.ok(pill, "the reload pill is shown");
	pill.click();
	assert.equal(r.reloads(), 1);
});
