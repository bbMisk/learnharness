/** Sends reuse a loaded ChatGPT model list and refresh it in the background
 *  (owner 2026-10-31); only a missing list is awaited. */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-catalog-prepare-"));
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_DATA_DIR = path.join(directory, "data");
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
await fs.writeFile(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const require = createRequire(import.meta.url);
const { SCOPES } = require("../electron/chatgpt.cjs");
await fs.writeFile(
	path.join(directory, "chatgpt-credentials.json"),
	JSON.stringify({
		version: 1,
		hostId: "fixture-host",
		allowBackgroundUse: true,
		activeId: "fixture-account",
		registrations: [
			{
				id: "fixture-account",
				clientId: "oaiapp_fixture",
				issuer: "https://auth.openai.com",
				subject: "fixture-subject",
				email: "fixture@example.invalid",
				tokens: {
					accessToken: "fixture-access",
					refreshToken: "fixture-refresh",
					idToken: "fixture-id",
					scopes: SCOPES,
					expiresAt: Date.now() + 3600000,
				},
			},
		],
	}),
	{ mode: 0o600 },
);
const { webSubscriptionOwner } = await import("../src/server/web-subscriptions.ts");
const chat = await import("../src/agent/chatgpt-bridge.ts");
const { piModels } = await import("../src/agent/models.ts");
const { prepareConnectionCatalog } = await import("../src/server/model-catalog.ts");
const modelsRoute = await import("../app/api/models/route.ts");
const model = piModels()
	.getModels("openai")
	.find((entry) => entry.api === "openai-responses")!;

let catalogRequests = 0;
let hold: Promise<void> | null = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
	assert.equal(String(input), "https://api.openai.com/v1/models", "unexpected network request");
	catalogRequests++;
	if (hold) await hold;
	return Response.json({ models: [{ slug: model.id, display_name: "Fixture ChatGPT", visibility: "list" }] });
};
after(async () => {
	webSubscriptionOwner().close();
	globalThis.fetch = originalFetch;
	await fs.rm(directory, { recursive: true, force: true });
});

test("with no model list yet, a send waits for it", async () => {
	webSubscriptionOwner();
	assert.equal(chat.chatGPTModels().length, 0);
	await prepareConnectionCatalog("chatgpt");
	assert.ok(chat.chatGPTModels().length > 0, "the list loaded before the send continued");
});

test("with a list loaded, a send continues while the refresh runs in the background", async () => {
	const before = catalogRequests;
	let release!: () => void;
	hold = new Promise<void>((resolve) => (release = resolve));
	const settled = await Promise.race([
		prepareConnectionCatalog("chatgpt").then(() => "returned"),
		new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 200)),
	]);
	assert.equal(settled, "returned", "the send did not wait for the OpenAI round trip");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(catalogRequests, before + 1, "the list is still refreshed");
	release();
	hold = null;
});

test("the model list endpoint answers from the loaded list while it refreshes", async () => {
	const before = catalogRequests;
	let release!: () => void;
	hold = new Promise<void>((resolve) => (release = resolve));
	const settled = await Promise.race([
		modelsRoute.GET().then((response) => response.status),
		new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 200)),
	]);
	assert.equal(settled, 200, "the picker did not wait for the OpenAI round trip");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(catalogRequests, before + 1, "the list is still refreshed");
	release();
	hold = null;
});
