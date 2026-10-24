import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createChatGPTProvider, subscriptionPayload } from "../src/agent/chatgpt.ts";

// Each test file runs in its own process. Import config only after choosing
// disposable credential storage; never inspect the developer's real tokens.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chatgpt-test-"));
process.env.LH_AUTH_FILE = path.join(temp, "auth.json");
const { chatGPTStore, createChatGPTStore } = await import("../src/store/chatgpt.ts");
const service = await import("../src/server/chatgpt.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { Type } = await import("typebox");
const originalFetch = globalThis.fetch;
const model = { ...openaiProvider().getModels().find((m) => m.id === "gpt-6.1-sol")!, provider: "chatgpt" };
assert.ok(model.id);
let tokenCount = 0;
let oauthNonce = "";
let tokenError: string | undefined;
let rejectScope = false;
let invalidSignature = false;
let tokenGate: Promise<void> | undefined, tokenStarted: (() => void) | undefined;
let revokeGate: Promise<void> | undefined, revokeStarted: (() => void) | undefined;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;

before(async () => {
	pair = await generateKeyPair("RS256");
	jwk = { ...await exportJWK(pair.publicKey), kid: "fixture", alg: "RS256", use: "sig" };
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
		if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" });
		if (url === "https://auth.openai.com/jwks") return Response.json({ keys: [jwk] });
		if (url === "https://auth.openai.com/revoke") { revokeStarted?.(); await revokeGate; return new Response(null, { status: 200 }); }
		if (url === "https://api.openai.com/v1/models") return Response.json({ models: [{ slug: model.id, display_name: "Account model", visibility: "list" }, { slug: "hidden-model", visibility: "hidden" }] });
		if (url === "https://auth.openai.com/api/accounts/oauth/token") {
			tokenCount++;
			const signingNonce = oauthNonce;
			tokenStarted?.(); await tokenGate;
			const body = new URLSearchParams(String(init?.body));
			assert.equal(body.get("resource"), "https://api.openai.com/v1");
			assert.equal(body.get("client_id"), "oaiapp_fixture");
			if (tokenError) return Response.json({ error: tokenError }, { status: 400 });
			const signingKey = invalidSignature ? (await generateKeyPair("RS256")).privateKey : pair.privateKey;
			const idToken = await new SignJWT({ nonce: signingNonce, email: "fixture@example.test" }).setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer("https://auth.openai.com").setAudience("oaiapp_fixture").setSubject("fixture-subject").setIssuedAt().setExpirationTime("5m").sign(signingKey);
			return Response.json({ access_token: `fixture-access-${tokenCount}`, refresh_token: `fixture-refresh-${tokenCount}`, id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: rejectScope ? "openid email" : "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct" });
		}
		throw new Error(`Unexpected network request to ${new URL(url).origin}`);
	};
});
after(async () => { await service.chatGPTAction("cancel"); globalThis.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); });

async function authorize(accountId?: string, extra: Record<string, string> = {}) {
	const url = new URL(await service.startChatGPTLogin(accountId));
	oauthNonce = url.searchParams.get("nonce")!;
	const callback = new URL(url.searchParams.get("redirect_uri")!);
	callback.search = new URLSearchParams({ code: "fixture-code", state: url.searchParams.get("state")!, client_id: "oaiapp_fixture", ...extra }).toString();
	return { url, response: await fetch(callback) };
}

describe("ChatGPT subscription authorization", { concurrency: false }, () => {
	it("rejects cross-origin and remote credential mutations", () => {
		assert.throws(() => service.checkChatGPTRequest(new Request("http://127.0.0.1:3000/api/chatgpt", { headers: { origin: "https://example.test" } })), /local app/);
		assert.throws(() => service.checkChatGPTRequest(new Request("https://example.test/api/chatgpt", { headers: { origin: "https://example.test" } })), /local app/);
		service.checkChatGPTRequest(new Request("http://127.0.0.1:3000/api/chatgpt", { headers: { origin: "http://127.0.0.1:3000" } }));
	});
	it("uses PKCE, verifies signed identity, preserves host and registration, and exposes no tokens", async () => {
		const { url, response } = await authorize();
		assert.equal(response.status, 200);
		assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
		assert.equal(url.searchParams.get("code_challenge_method"), "S256");
		assert.equal(url.searchParams.get("agent_name_hint"), "LearnHarness (Hanson fork)");
		const state = chatGPTStore.read();
		assert.equal(state.accounts[0]!.subject, "fixture-subject");
		assert.equal(fs.statSync(path.join(temp, "chatgpt/accounts.json")).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.join(temp, "chatgpt")).mode & 0o777, 0o700);
		assert.ok(!JSON.stringify(service.chatGPTStatus()).includes("fixture-access"));
		const returning = new URL(await service.startChatGPTLogin(state.active));
		assert.equal(returning.searchParams.get("client_id"), "oaiapp_fixture");
		assert.equal(returning.searchParams.get("ext_agent_host_id"), state.hostId);
		assert.ok(returning.searchParams.has("id_token_hint"));
		assert.ok(!returning.searchParams.has("agent_name_hint"));
		await service.chatGPTAction("cancel");
	});
	it("rejects wrong state and signed-in identity mismatches without changing credentials", async () => {
		const before = chatGPTStore.read();
		const url = new URL(await service.startChatGPTLogin(before.active));
		const callback = new URL(url.searchParams.get("redirect_uri")!);
		callback.search = new URLSearchParams({ state: "😀".repeat(43), code: "fixture-code", client_id: "oaiapp_fixture" }).toString();
		assert.equal((await fetch(callback)).status, 400);
		assert.deepEqual(chatGPTStore.read(), before);
		await service.chatGPTAction("cancel");
		invalidSignature = true;
		try { assert.equal((await authorize(before.active)).response.status, 400); } finally { invalidSignature = false; }
		assert.deepEqual(chatGPTStore.read(), before);
	});
	it("lists only the signed-in account's eligible known models", async () => {
		await service.refreshChatGPTModels(true);
		const account = chatGPTStore.read().accounts[0]!;
		assert.deepEqual(account.models.map((m) => m.id), [model.id]);
		assert.equal(account.models[0]!.provider, "chatgpt");
		assert.deepEqual(account.models[0]!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
	it("a cancelled token exchange cannot replace credentials or cancel a newer sign-in", async () => {
		const before = chatGPTStore.read();
		let release!: () => void;
		tokenGate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { tokenStarted = resolve; });
		const old = authorize(before.active);
		await started;
		await service.chatGPTAction("cancel");
		await service.startChatGPTLogin(before.active);
		release();
		assert.equal((await old).response.status, 400);
		assert.equal(service.chatGPTStatus().pending, true);
		assert.deepEqual(chatGPTStore.read(), before);
		tokenGate = undefined; tokenStarted = undefined;
		await service.chatGPTAction("cancel");
	});
	it("serializes rotating refreshes across concurrent requests", async () => {
		await chatGPTStore.update((state) => { state.accounts[0]!.expires = 1; });
		const before = tokenCount;
		const tokens = await Promise.all(Array.from({ length: 6 }, () => service.chatGPTAccessToken()));
		assert.equal(tokenCount, before + 1);
		assert.equal(new Set(tokens).size, 1);
	});
	it("preserves credentials after transient refresh errors and clears terminally revoked tokens", async () => {
		await chatGPTStore.update((state) => { state.accounts[0]!.expires = 1; });
		const before = chatGPTStore.read();
		tokenError = "temporarily_unavailable";
		await assert.rejects(service.chatGPTAccessToken());
		assert.deepEqual(chatGPTStore.read(), before);
		tokenError = "invalid_grant";
		await assert.rejects(service.chatGPTAccessToken(), /Sign in/);
		assert.equal(chatGPTStore.read().accounts[0]!.access, undefined);
		assert.equal(chatGPTStore.read().accounts[0]!.clientId, "oaiapp_fixture");
		tokenError = undefined;
	});
	it("retains identity without allowing inference when plan permission was declined", async () => {
		rejectScope = true;
		try { assert.equal((await authorize(chatGPTStore.read().active)).response.status, 200); } finally { rejectScope = false; }
		assert.equal(service.chatGPTStatus().connected, false);
		await assert.rejects(service.chatGPTAccessToken(), /Connect your ChatGPT plan/);
		await service.chatGPTAction("disconnect", chatGPTStore.read().active);
		assert.equal(chatGPTStore.read().accounts[0]!.refresh, undefined);
	});
	it("sign-out stops new inference before remote revocation finishes", async () => {
		assert.equal((await authorize(chatGPTStore.read().active)).response.status, 200);
		let release!: () => void;
		revokeGate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { revokeStarted = resolve; });
		const signingOut = service.chatGPTAction("disconnect", chatGPTStore.read().active);
		await started;
		assert.equal(service.chatGPTStatus().connected, false);
		await assert.rejects(service.chatGPTAccessToken(), /Connect your ChatGPT plan/);
		release(); await signingOut;
		assert.equal(chatGPTStore.read().accounts[0]!.refresh, undefined);
		revokeGate = undefined; revokeStarted = undefined;
	});
	it("serializes independent store instances without losing updates", async () => {
		const dir = path.join(temp, "parallel");
		const stores = [createChatGPTStore(dir), createChatGPTStore(dir)];
		await Promise.all(Array.from({ length: 4 }, (_, i) => stores[i % 2]!.update(async (state) => { await new Promise((r) => setTimeout(r, 5)); state.accounts.push({ id: String(i), email: "fixture", subject: "fixture", clientId: "fixture", expires: 0, scopes: [], models: [], catalogAt: 0 }); })));
		assert.equal(stores[0]!.read().accounts.length, 4);
	});
});

describe("subscription transport", () => {
	it("removes API-only fields and namespaces teaching tools", () => {
		const body = subscriptionPayload({ input: [{ role: "system", content: "Teach" }, { type: "function_call", name: "quiz" }], tools: [{ type: "function", name: "quiz" }], max_output_tokens: 100, temperature: 1, previous_response_id: "old", store: true, stream: false });
		assert.equal(body.store, false); assert.equal(body.stream, true);
		assert.equal(body.max_output_tokens, undefined); assert.equal(body.temperature, undefined); assert.equal(body.previous_response_id, undefined);
		assert.equal((body.tools as { type: string }[])[0]!.type, "namespace");
		assert.equal((body.input as { role: string }[])[0]!.role, "developer");
	});
	it("fails closed on truncated streams and incomplete responses, including after partial output", async () => {
		const provider = createChatGPTProvider({ models: () => [model], accessToken: async () => "fixture-access" });
		for (const event of ["", 'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","output":[]}}\n\n']) {
			let captured: Record<string, unknown> = {};
			const result = await provider.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] }), { fetch: async (input, init) => { const request = new Request(input, init); assert.equal(request.url, "https://api.openai.com/v1/responses"); assert.equal(request.headers.get("authorization"), "Bearer fixture-access"); captured = JSON.parse(await request.text()); return new Response(event, { headers: { "content-type": "text/event-stream" } }); } }).result();
			assert.equal(result.stopReason, "error");
			assert.equal(result.provider, "chatgpt");
			assert.equal(captured.max_output_tokens, undefined);
		}
	});
	it("completes a teaching tool round and replays its namespaced call and result", async () => {
		await authorize(chatGPTStore.read().active);
		await service.refreshChatGPTModels(true);
		const { piEngineForSpec } = await import("../src/server/runtime-models.ts");
		const engine = piEngineForSpec({ provider: "chatgpt", id: model.id, thinkingLevel: "off" });
		const requests: Record<string, unknown>[] = [];
		const event = (type: string, value: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
		let executed = 0;
		const fetchFixture: typeof fetch = async (input, init) => {
			requests.push(JSON.parse(await new Request(input, init).text()));
			const item = requests.length === 1 ? { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "again", namespace: "learnharness", arguments: "{}" } : { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "Completed", annotations: [] }], status: "completed" };
			return new Response(event("response.output_item.added", { output_index: 0, item }) + event("response.output_item.done", { output_index: 0, item }) + event("response.completed", { response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }), { headers: { "content-type": "text/event-stream" } });
		};
		const agent = createTeacherAgent(undefined, { chatId: "fixture-chat", engine: { ...engine, streamFn: (m, c, o) => engine.streamFn(m, c, { ...o, fetch: fetchFixture }) }, tools: { again: { name: "again", label: "again", description: "Fixture local tool", parameters: Type.Object({}), execute: async () => { executed++; return { content: [{ type: "text", text: "Fixture tool result" }], details: {} }; } } } });
		await agent.prompt("Run the fixture tool, then finish.");
		assert.equal(executed, 1);
		assert.equal(requests.length, 2);
		const replay = requests[1]!.input as { type?: string; namespace?: string }[];
		assert.equal(replay.find((item) => item.type === "function_call")?.namespace, "learnharness");
		assert.ok(replay.some((item) => item.type === "function_call_output"));
		assert.equal(agent.state.messages.at(-1)?.role, "assistant");
		for (const message of agent.state.messages) if (message.role === "assistant") assert.equal(message.provider, "chatgpt");
	});
});
