import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { activeChatGPTAccount, chatGPTConnected, chatGPTStore, type ChatGPTAccount } from "../store/chatgpt.ts";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const random = () => randomBytes(32).toString("base64url");
const jsonHeaders = { "Cache-Control": "no-store" };

export class ChatGPTError extends Error {
	constructor(message: string, public status = 400, public code?: string, public requestId?: string) { super(message); }
}
async function tokenRequest(body: URLSearchParams) {
	const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new ChatGPTError("ChatGPT authorization failed. Try connecting again.", response.status, typeof data.error === "string" ? data.error : undefined, response.headers.get("x-request-id") ?? undefined);
	if (typeof data.access_token !== "string" || typeof data.expires_in !== "number" || data.expires_in <= 0 || (data.token_type ?? "").toLowerCase() !== "bearer") throw new ChatGPTError("ChatGPT returned an invalid token response.");
	return data;
}

let discovery: Promise<{ issuer: string; jwks_uri: string; revocation_endpoint: string }> | undefined;
async function openIDConfig() {
	discovery ??= fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) }).then(async (r) => {
		if (!r.ok) throw new ChatGPTError("Could not load ChatGPT sign-in configuration.");
		const data = await r.json();
		if (data.issuer !== ISSUER || new URL(data.jwks_uri).origin !== ISSUER || new URL(data.revocation_endpoint).origin !== ISSUER) throw new ChatGPTError("Unexpected ChatGPT sign-in configuration.");
		return data;
	}).catch((error) => { discovery = undefined; throw error; });
	return discovery;
}
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
export async function validateChatGPTIdentity(idToken: string, clientId: string, nonce: string) {
	const config = await openIDConfig();
	jwks ??= createRemoteJWKSet(new URL(config.jwks_uri));
	const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUER, audience: clientId, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat", "nonce"] });
	if (payload.nonce !== nonce || !payload.sub) throw new ChatGPTError("ChatGPT identity validation failed.");
	return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : "ChatGPT account" };
}

type Pending = { server: Server; state: string; nonce: string; verifier: string; redirectUri: string; clientId?: string; accountId?: string; busy: boolean; timer: ReturnType<typeof setTimeout> };
// Survive Next development reloads without spawning multiple callback listeners.
const runtime = globalThis as typeof globalThis & { learnHarnessChatGPT?: { pending?: Pending; starting?: boolean; error?: string; catalogs?: Map<string, Promise<void>> } };
const live = runtime.learnHarnessChatGPT ??= {};
function stopPending(expected?: Pending) {
	if (live.pending && (!expected || live.pending === expected)) {
		clearTimeout(live.pending.timer);
		live.pending.server.close();
		live.pending.server.closeIdleConnections();
		live.pending = undefined;
	}
}
function safeEqual(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }

export async function startChatGPTLogin(accountId?: string) {
	if (live.pending || live.starting) throw new ChatGPTError("A ChatGPT sign-in is already pending. Cancel it first.", 409);
	live.starting = true;
	try {
	const saved = await chatGPTStore.update((state) => {
		const account = accountId ? state.accounts.find((a) => a.id === accountId) : undefined;
		if (accountId && !account) throw new ChatGPTError("Unknown ChatGPT account.");
		return { hostId: state.hostId, account };
	});
	const state = random(), nonce = random(), verifier = random();
	const server = createServer(async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		const pending = live.pending;
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "GET" || url.pathname !== "/auth/callback") { res.writeHead(404).end("Not found"); return; }
		if (!pending || pending.server !== server || !safeEqual(url.searchParams.get("state") ?? "", pending.state)) { res.writeHead(400).end("Invalid authorization state."); return; }
		if (pending.busy) { res.writeHead(409).end("Authorization is already being processed."); return; }
		pending.busy = true;
		try {
			if (url.searchParams.has("error")) throw new ChatGPTError("ChatGPT connection was declined. You can try again from settings.");
			const clientId = url.searchParams.get("client_id") ?? pending.clientId;
			if (!clientId || clientId === "dynamic_agent_client" || (pending.clientId && clientId !== pending.clientId)) throw new ChatGPTError("Invalid ChatGPT client registration.");
			const code = url.searchParams.get("code");
			if (!code) throw new ChatGPTError("No authorization code was returned.");
			const token = await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE }));
			if (typeof token.id_token !== "string" || typeof token.refresh_token !== "string" || typeof token.scope !== "string") throw new ChatGPTError("ChatGPT returned incomplete credentials.");
			const identity = await validateChatGPTIdentity(token.id_token, clientId, pending.nonce);
			await chatGPTStore.update((store) => {
				if (live.pending !== pending) throw new ChatGPTError("This ChatGPT sign-in was cancelled.");
				const previous = pending.accountId ? store.accounts.find((a) => a.id === pending.accountId) : undefined;
				if (pending.accountId && (!previous || previous.subject !== identity.subject || previous.clientId !== clientId)) throw new ChatGPTError("The signed-in account does not match the selected registration.");
				const account: ChatGPTAccount = { id: previous?.id ?? randomUUID(), ...identity, clientId, access: token.access_token, refresh: token.refresh_token, idToken: token.id_token, expires: Date.now() + token.expires_in * 1000, scopes: token.scope.split(/\s+/), models: [], catalogAt: 0, welcomeSeen: previous?.welcomeSeen };
				store.accounts = [...store.accounts.filter((a) => a.id !== account.id), account];
				store.active = account.id;
			});
			live.error = undefined;
			res.writeHead(200).end("ChatGPT is connected. Return to LearnHarness to choose your models.");
		} catch (error) {
			const message = error instanceof ChatGPTError ? error.message : "ChatGPT connection could not be verified. Please try again.";
			if (live.pending === pending) live.error = message;
			res.writeHead(400).end(message);
		} finally { stopPending(pending); }
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
	const address = server.address();
	if (!address || typeof address === "string") throw new ChatGPTError("Could not start the local sign-in listener.");
	const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
	const timer = setTimeout(() => { if (live.pending?.server === server) { live.error = "ChatGPT sign-in timed out. Please try again."; stopPending(); } }, 5 * 60 * 1000);
	timer.unref();
	live.pending = { server, state, nonce, verifier, redirectUri, clientId: saved.account?.clientId, accountId, busy: false, timer };
	live.error = undefined;
	const query = new URLSearchParams({ client_id: saved.account?.clientId ?? "dynamic_agent_client", ext_agent_host_id: saved.hostId, response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
	if (saved.account) {
		if (saved.account.idToken) query.set("id_token_hint", saved.account.idToken);
		query.set("login_hint", saved.account.email);
		if (!saved.account.scopes.includes("chatgpt.tokens.use.direct")) query.set("prompt", "consent");
	} else query.set("agent_name_hint", "LearnHarness (Hanson fork)");
	return `${ISSUER}/api/accounts/authorize?${query}`;
	} finally { live.starting = false; }
}

export function chatGPTStatus() {
	const state = chatGPTStore.read();
	const active = state.accounts.find((a) => a.id === state.active);
	return { accounts: state.accounts.map((a) => ({ id: a.id, label: `${a.email} · ${a.id.slice(0, 8)}`, connected: !!a.access && !a.signedOut, planEnabled: !!a.access && !a.signedOut && a.scopes.includes("chatgpt.tokens.use.direct") })), active: state.active, connected: chatGPTConnected(), pending: !!live.pending || !!live.starting, error: live.error, welcome: !!active?.access && !active.signedOut && !active.welcomeSeen && active.scopes.includes("chatgpt.tokens.use.direct") };
}

export async function chatGPTAccessToken(expectedAccountId?: string): Promise<string> {
	const account = activeChatGPTAccount();
	if (expectedAccountId && account?.id !== expectedAccountId) throw new ChatGPTError("The active ChatGPT account changed. Please try again.", 409);
	if (!account?.access || !account.refresh || account.signedOut || !account.scopes.includes("chatgpt.tokens.use.direct")) throw new ChatGPTError("Connect your ChatGPT plan in settings before starting a lesson.", 401);
	if (account.expires > Date.now() + 180000) return account.access;
	// Lock and re-read across processes: rotating tokens must only refresh once.
	return chatGPTStore.update(async (state) => {
		const current = state.accounts.find((a) => a.id === account.id);
		if (!current?.access || !current.refresh || current.signedOut) throw new ChatGPTError("Sign in with ChatGPT again.", 401);
		if (current.expires > Date.now() + 180000) return current.access;
		try {
			const token = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", client_id: current.clientId, refresh_token: current.refresh, resource: RESOURCE }));
			current.access = token.access_token;
			current.refresh = typeof token.refresh_token === "string" ? token.refresh_token : current.refresh;
			current.expires = Date.now() + token.expires_in * 1000;
			if (typeof token.scope === "string") current.scopes = token.scope.split(/\s+/);
			if (!current.scopes.includes("chatgpt.tokens.use.direct")) return "";
			return current.access!;
		} catch (error) {
			if (error instanceof ChatGPTError && ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(error.code ?? "")) {
				delete current.access; delete current.refresh; delete current.idToken; current.models = [];
				live.error = "ChatGPT access has expired or was revoked. Sign in again.";
				return ""; // Persist the cleared tokens before reporting the error.
			}
			throw error;
		}
	}).then((token) => {
		if (!token) throw new ChatGPTError("Sign in with ChatGPT again.", 401);
		if (activeChatGPTAccount()?.id !== account.id) throw new ChatGPTError("The active ChatGPT account changed. Please try again.", 409);
		return token;
	});
}

export async function refreshChatGPTModels(force = false) {
	const account = activeChatGPTAccount();
	if (!chatGPTConnected() || !account || (!force && account.catalogAt > Date.now() - 60000)) return;
	const catalogs = live.catalogs ??= new Map();
	if (catalogs.has(account.id)) return catalogs.get(account.id);
	const promise = (async () => {
		const access = await chatGPTAccessToken(account.id);
		const response = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000) });
		if (!response.ok) throw new ChatGPTError(`ChatGPT model discovery failed (${response.status}). Check your plan access in ChatGPT settings.`, response.status, undefined, response.headers.get("x-request-id") ?? undefined);
		const data = await response.json();
		if (!Array.isArray(data.models)) throw new ChatGPTError("Unexpected ChatGPT model catalog.");
		const known = openaiProvider().getModels();
		const models = data.models.filter((m: { visibility?: string }) => m.visibility === "list").flatMap((m: { slug: string; display_name?: string }) => {
			const template = known.find((k) => k.id === m.slug);
			return template ? [{ ...template, id: m.slug, name: m.display_name ?? template.name, provider: "chatgpt", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] : [];
		});
		if (!models.length) throw new ChatGPTError("Your ChatGPT account returned no models supported by this app version.");
		await chatGPTStore.update((state) => {
			const current = state.accounts.find((a) => a.id === account.id);
			if (current?.access && state.active === account.id) { current.models = models; current.catalogAt = Date.now(); }
		});
	})();
	catalogs.set(account.id, promise);
	try { await promise; live.error = undefined; } catch (error) { live.error = error instanceof ChatGPTError ? error.message : "Could not refresh ChatGPT models. Try again."; throw error; } finally { catalogs.delete(account.id); }
}

export async function chatGPTAction(action: string, accountId?: string) {
	if (action === "cancel") { stopPending(); return; }
	if (action === "switch") {
		await chatGPTStore.update((state) => { const a = state.accounts.find((a) => a.id === accountId); if (!a?.access || a.signedOut) throw new ChatGPTError("Reconnect this ChatGPT account first."); state.active = a.id; a.catalogAt = 0; });
		await refreshChatGPTModels(true); return;
	}
	if (action === "welcome") { await chatGPTStore.update((state) => { const a = state.accounts.find((a) => a.id === state.active); if (a) a.welcomeSeen = true; }); return; }
	if (action === "refresh") { await refreshChatGPTModels(true); return; }
	if (action !== "disconnect") throw new ChatGPTError("Unknown ChatGPT action.");
	stopPending();
	let revoked = true;
	const saved = await chatGPTStore.update((state) => {
		const account = state.accounts.find((a) => a.id === accountId);
		if (!account) throw new ChatGPTError("Unknown ChatGPT account.");
		account.signedOut = true; // Stop new inference before contacting OpenAI.
		return { refresh: account.refresh, clientId: account.clientId };
	});
	if (saved.refresh) {
		try {
			const config = await openIDConfig();
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const response = await fetch(config.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: saved.refresh, token_type_hint: "refresh_token", client_id: saved.clientId }), signal: AbortSignal.timeout(10000) });
					if (response.status === 200) break;
					if (attempt || response.status < 500) { revoked = false; break; }
				} catch { if (attempt) { revoked = false; break; } }
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
		} catch { revoked = false; }
	}
	await chatGPTStore.update((state) => {
		const account = state.accounts.find((a) => a.id === accountId);
		// A concurrent reconnect owns its replacement tokens.
		if (!account?.signedOut || account.refresh !== saved.refresh) return;
		delete account.access; delete account.refresh; delete account.idToken;
		account.models = []; account.catalogAt = 0;
	});
	live.error = revoked ? undefined : "Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings → Usage.";
}

/** Credential-changing routes are loopback-only and require a same-origin POST. */
export function checkChatGPTRequest(request: Request) {
	const url = new URL(request.url);
	// Next's standalone Request URL is canonicalized to localhost even when
	// the browser uses 127.0.0.1. Host carries the actual requested authority.
	const authority = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`);
	const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
	if (!loopback.has(url.hostname) || !loopback.has(authority.hostname) || authority.username || authority.password || authority.pathname !== "/" || request.headers.get("origin") !== authority.origin) throw new ChatGPTError("ChatGPT connections can only be managed from this local app.", 403);
}
export function chatGPTErrorResponse(error: unknown) {
	return Response.json({ error: error instanceof ChatGPTError ? error.message : "ChatGPT connection failed. Please try again.", ...(error instanceof ChatGPTError ? { code: error.code, requestId: error.requestId } : {}) }, { status: error instanceof ChatGPTError && error.status >= 400 && error.status <= 599 ? error.status : 500, headers: jsonHeaders });
}
