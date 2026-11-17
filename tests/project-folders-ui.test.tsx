import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

/* Project Files links folders live (owner 2026-11-17): the local desktop app
 * offers Add folder and accepts dropped folders; web and remote-server
 * windows keep files only. */
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const { ProjectPage } = await import("../components/project-page.tsx");
const { useFileDrop } = await import("../components/file-drop.ts");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });
const base = {
	id: "project_fixture",
	name: "Fixture",
	instructions: "",
	fileIds: [],
	files: [],
	createdAt: "2026-11-17T00:00:00.000Z",
	updatedAt: "2026-11-17T00:00:00.000Z",
};
let root: Root;
let host: HTMLElement;
const realFetch = globalThis.fetch;
const setLh = (value: unknown) => Object.defineProperty(dom.window, "lh", { configurable: true, value });
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	globalThis.fetch = realFetch;
	setLh(undefined);
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function mount(initial: object, puts: object[] = []) {
	let current = { ...base, ...initial };
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/chats") return new Response(JSON.stringify({ chats: [] }));
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			puts.push(body);
			const folders = [...(current as { folders?: string[] }).folders ?? [], ...(body.addFolders ?? [])];
			current = { ...current, updatedAt: "2026-11-17T00:00:01.000Z", folders, linkedFolders: folders.map((p) => ({ path: p, name: p.split("/").pop()!, available: true })) } as typeof current;
		}
		return new Response(JSON.stringify(current));
	}) as typeof fetch;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<AppRouterContext.Provider value={router as never}>
				<ServerEventsProvider connect={quietChannel}>
					<ProjectPage initial={current} />
				</ServerEventsProvider>
			</AppRouterContext.Provider>,
		),
	);
	await settle();
}
const addFolderButton = () => host.querySelector('[data-testid="project-add-folder"]') as HTMLButtonElement | null;

it("the desktop app's Add folder links the picked folder and lists it as one row", async () => {
	setLh({ chooseAttachmentFolder: async () => "/Users/me/Course Notes" });
	const puts: object[] = [];
	await mount({}, puts);
	assert.ok(addFolderButton(), "Add folder is offered on the local desktop app");
	assert.match(host.textContent ?? "", /Drop files or folders here/);
	await act(async () => addFolderButton()!.click());
	await settle();
	assert.deepEqual(puts, [{ addFolders: ["/Users/me/Course Notes"] }]);
	const rows = host.querySelectorAll('[data-testid="project-folder"]');
	assert.equal(rows.length, 1);
	assert.match(rows[0]!.textContent ?? "", /Course Notes/);
	assert.match(rows[0]!.textContent ?? "", /\/Users\/me\/Course Notes/);
});

it("a refused folder shows the server's reason and adds no row", async () => {
	setLh({ chooseAttachmentFolder: async () => "/Users/me/Notes" });
	await mount({});
	const realPut = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		init?.method === "PUT"
			? new Response(JSON.stringify({ error: "That folder is already in this project." }), { status: 400 })
			: realPut(input, init)) as typeof fetch;
	await act(async () => addFolderButton()!.click());
	await settle();
	assert.match(host.textContent ?? "", /That folder is already in this project\./);
	assert.equal(host.querySelectorAll('[data-testid="project-folder"]').length, 0);
});

it("a missing linked folder says so and can be removed", async () => {
	const puts: object[] = [];
	await mount({ folders: ["/gone/Old"], linkedFolders: [{ path: "/gone/Old", name: "Old", available: false }] }, puts);
	assert.match(host.textContent ?? "", /Folder not found: \/gone\/Old/);
	await act(async () => (host.querySelector('[aria-label="Remove folder Old"]') as HTMLButtonElement).click());
	await settle();
	assert.deepEqual(puts, [{ removeFolders: ["/gone/Old"] }]);
});

for (const [name, lh] of [["web", undefined], ["remote-server desktop", { remoteServer: true, chooseAttachmentFolder: async () => "/x" }]] as const) {
	it(`${name}: no Add folder button, files-only copy`, async () => {
		setLh(lh);
		await mount({});
		assert.equal(addFolderButton(), null);
		assert.match(host.textContent ?? "", /Drop files here, or choose Add files\./);
	});
}

it("a dropped folder goes to onFolder by its native path, even where files upload", async () => {
	setLh({ getPathForFile: () => "/Users/me/Dropped", chooseAttachmentFolder: async () => null });
	const linked: string[] = [];
	let drop: ReturnType<typeof useFileDrop> | undefined;
	let draft = "";
	function Probe() {
		drop = useFileDrop(draft, (next) => { draft = next; }, { uploadAll: true, onFolder: async (path) => { linked.push(path); } });
		return null;
	}
	host = document.createElement("div");
	root = createRoot(host);
	await act(async () => root.render(<Probe />));
	const folder = new File([], "Dropped");
	await act(async () => drop!.addFiles([folder], new Set([folder])));
	assert.deepEqual(linked, ["/Users/me/Dropped"]);
	assert.equal(draft, "", "the folder never enters a draft");
	assert.equal(drop!.error, "");
	assert.equal(drop!.canAddFolder(), true);
});

it("without onFolder, an upload-only drop still refuses folders", async () => {
	setLh({ getPathForFile: () => "/Users/me/Dropped" });
	let drop: ReturnType<typeof useFileDrop> | undefined;
	function Probe() {
		drop = useFileDrop("", () => {}, { uploadAll: true });
		return null;
	}
	host = document.createElement("div");
	root = createRoot(host);
	await act(async () => root.render(<Probe />));
	const folder = new File([], "Dropped");
	await act(async () => drop!.addFiles([folder], new Set([folder])));
	assert.match(drop!.error, /Folders can't be added here/);
});
