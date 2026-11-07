/** Code-split surfaces: same markup once loaded, no blank frame once warmed, providers stay mounted. */
import React, { act, Component, type ReactNode } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent });
const { preloadable } = await import("../components/preloadable.tsx");
const { ChainTableOverlay } = await import("../components/chain-table-lazy.tsx");
const { SetupDialog } = await import("../components/setup-dialog-lazy.tsx");
const { SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const roots: Root[] = [];
const originalFetch = globalThis.fetch;
async function mount(element: React.ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host, { onCaughtError() {} });
	roots.push(root);
	await act(async () => root.render(element));
	return { host, root };
}
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.innerHTML = "";
	delete window.lh;
	globalThis.fetch = originalFetch;
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const Card = ({ label }: { label: string }) => <p data-testid="card">{label}</p>;

describe("preloadable", () => {
	it("renders nothing until the chunk arrives, then the component", async () => {
		const chunk = deferred<typeof Card>();
		const Lazy = preloadable(() => chunk.promise);
		const { host } = await mount(<Lazy label="ready" />);
		assert.equal(host.innerHTML, "");
		await act(async () => chunk.resolve(Card));
		assert.equal(host.innerHTML, renderToStaticMarkup(<Card label="ready" />));
	});

	it("once preloaded renders on the first frame, including server markup", async () => {
		const Lazy = preloadable(async () => Card);
		await Lazy.preload();
		assert.equal(renderToStaticMarkup(<Lazy label="warm" />), renderToStaticMarkup(<Card label="warm" />));
	});

	it("a failed load reaches the error boundary and a later mount retries", async () => {
		let attempts = 0;
		const Lazy = preloadable(async () => {
			if (++attempts === 1) throw new Error("Loading chunk failed");
			return Card;
		});
		class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
			state = { failed: false };
			static getDerivedStateFromError() { return { failed: true }; }
			render() { return this.state.failed ? "failed" : this.props.children; }
		}
		const first = await mount(<Boundary><Lazy label="x" /></Boundary>);
		assert.equal(first.host.textContent, "failed");
		const second = await mount(<Lazy label="retried" />);
		assert.equal(second.host.textContent, "retried");
		assert.equal(attempts, 2);
	});
});

describe("split dialogs and overlays", () => {
	it("the setup dialog wrapper renders nothing while closed", async () => {
		const { host } = await mount(<SetupDialog open={false} onClose={() => {}} onDone={() => {}} />);
		assert.equal(host.innerHTML, "");
	});

	it("the chain table mounts on first open and keeps its state after closing", async () => {
		globalThis.fetch = (async () => Response.json({ sources: [], organization: { folders: [] } })) as typeof fetch;
		const props = { nodes: [], chains: [], sessions: {}, fileSources: {}, onClose: () => {} };
		const view = (open: boolean) => (
			<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
				<ChainTableOverlay open={open} {...props} />
			</ServerEventsProvider>
		);
		const overlay = () => document.querySelector('[data-testid="chain-table-overlay"]');
		const { host, root } = await mount(view(false));
		assert.equal(host.innerHTML, "");
		await act(async () => root.render(view(true)));
		await act(async () => {});
		assert.ok(overlay());
		const sortName = () => host.querySelector<HTMLElement>('[data-testid="sort-name"]')!;
		assert.equal(sortName().getAttribute("aria-sort"), "ascending");
		await act(async () => sortName().click());
		assert.equal(sortName().getAttribute("aria-sort"), "descending");
		await act(async () => root.render(view(false)));
		assert.equal(overlay(), null);
		await act(async () => root.render(view(true)));
		assert.ok(overlay(), "a reopen renders on the first frame");
		assert.equal(sortName().getAttribute("aria-sort"), "descending", "the table's state survives closing");
	});

	it("settings: providers and their subscriptions stay mounted while the body is split out", async () => {
		globalThis.fetch = (async () => Response.json({ settings: { version: 1 } })) as typeof fetch;
		let subscriptions = 0;
		let opener: ((section?: string) => void) | undefined;
		window.lh = {
			expandWindow() {},
			chatgpt: { status: async () => null, onChange: () => { subscriptions++; return () => {}; } },
		} as unknown as typeof window.lh;
		function Opener() {
			opener = useSettingsDialog().open;
			return <span>app</span>;
		}
		const { host } = await mount(<SettingsDialogProvider><Opener /></SettingsDialogProvider>);
		assert.equal(host.textContent, "app");
		assert.equal(subscriptions, 1, "the ChatGPT connection subscribes while the dialog is closed");
		assert.equal(document.querySelector('[data-testid="settings-dialog"]'), null);
		await act(async () => opener!("keyboard"));
		await act(async () => {});
		assert.ok(document.querySelector('[data-testid="settings-dialog"]'));
		assert.equal(document.querySelector('[data-testid="settings-nav-keyboard"]')!.getAttribute("aria-current"), "true");
		assert.equal(subscriptions, 1, "opening never remounts the providers");
	});
});
