import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useChatOrganization } from "../components/chat-organization.ts";
import type { ChatListItem } from "../src/core/contracts/chat.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });

const chats = [{ id: "chat_a", title: "A" }] as ChatListItem[];
const projects = [{ id: "project_p", name: "Physics" }];
let root: Root;
let host: HTMLElement;
let organize: ReturnType<typeof useChatOrganization>;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	mock.restoreAll();
});

function Harness({ refresh, dropProjectId }: { refresh: () => Promise<void>; dropProjectId?: string }) {
	organize = useChatOrganization({ chats, projects, refresh, dropProjectId });
	return null;
}
async function mount(ok: boolean, dropProjectId?: string) {
	const requests: { url: string; body: unknown }[] = [];
	let respond = () => {};
	const response = new Promise<void>((resolve) => (respond = resolve));
	mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		requests.push({ url, body: JSON.parse(String(init.body)) });
		await response;
		return { ok } as Response;
	});
	let refreshes = 0;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(<Harness refresh={async () => void refreshes++} dropProjectId={dropProjectId} />));
	return { requests, refreshes: () => refreshes, respond: () => respond() };
}
async function move(fixture: Awaited<ReturnType<typeof mount>>, projectId: string | null) {
	await act(async () => organize.moveChat("chat_a", projectId));
	const pending = organize.moveStatus;
	await act(async () => {
		fixture.respond();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return pending;
}

it("a successful move saves the project, refreshes, and names the destination", async () => {
	const fixture = await mount(true);
	assert.equal(await move(fixture, "project_p"), "Moving chat…");
	assert.deepEqual(fixture.requests, [{ url: "/api/chats/chat_a", body: { projectId: "project_p" } }]);
	assert.equal(fixture.refreshes(), 1);
	assert.equal(organize.moveStatus, "Moved to Physics.");
	assert.equal(organize.updateError, null);
});

it("a failed move clears the status and reports the error", async () => {
	const fixture = await mount(false);
	assert.equal(await move(fixture, "project_p"), "Moving chat…");
	assert.equal(fixture.requests.length, 1);
	assert.equal(fixture.refreshes(), 0);
	assert.equal(organize.moveStatus, "");
	assert.equal(organize.updateError, "Chat could not be updated. Try again.");
});

it("moving a chat to where it already is sends nothing", async () => {
	const fixture = await mount(true);
	assert.equal(await move(fixture, null), "");
	assert.equal(fixture.requests.length, 0);
	assert.equal(organize.moveStatus, "");
});

it("a chat dropped on a project page's drop target moves into that project", async () => {
	const fixture = await mount(true, "project_p");
	const event = {
		dataTransfer: { types: ["application/x-learnharness-chat"], getData: () => "chat_a" },
		preventDefault() {},
		stopPropagation() {},
	} as unknown as React.DragEvent<HTMLElement>;
	await act(async () => organize.chatDrop.handlers.onDrop(event));
	await act(async () => {
		fixture.respond();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.deepEqual(fixture.requests, [{ url: "/api/chats/chat_a", body: { projectId: "project_p" } }]);
	assert.equal(organize.moveStatus, "Moved to Physics.");
});
