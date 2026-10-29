import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class TypeWhisperError extends Error {
	readonly code = "learnharness_typewhisper_error";
	constructor(message: string, public status = 503) { super(message); }
}

/** Next can bundle this module separately for different routes. A process-wide
 * client may throw an error from another bundle, so constructor identity is
 * not a reliable transport boundary. */
export function isTypeWhisperError(error: unknown): error is TypeWhisperError {
	return error instanceof Error && "code" in error && error.code === "learnharness_typewhisper_error" &&
		"status" in error && typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
}

/** Fixed loopback destination; credentials never reach the renderer or logs.
 * Only sessions created through this adapter may be queried or stopped. */
export function createTypeWhisperClient(
	discoveryFile = path.join(os.homedir(), "Library/Application Support/TypeWhisper/api-discovery.json"),
	request: typeof fetch = globalThis.fetch,
) {
	const sessions = new Set<string>();
	async function rpc(endpoint: string, method = "GET") {
		let discovery: { port?: number; token?: string };
		try { discovery = JSON.parse(await readFile(discoveryFile, "utf8")); }
		catch { throw new TypeWhisperError("Open TypeWhisper and enable its API Server in Settings → Advanced."); }
		if (!Number.isInteger(discovery.port) || discovery.port! < 1 || discovery.port! > 65535 || typeof discovery.token !== "string" || !discovery.token.trim()) {
			throw new TypeWhisperError("Enable Require API Token in TypeWhisper → Settings → Advanced.");
		}
		let response: Response;
		try {
			response = await request(`http://127.0.0.1:${discovery.port}/v1/dictation/${endpoint}`, {
				method, headers: { Authorization: `Bearer ${discovery.token}` }, signal: AbortSignal.timeout(60_000), redirect: "error",
			});
		} catch { throw new TypeWhisperError("Cannot reach TypeWhisper. Open it and check its API Server. F3 still controls TypeWhisper directly."); }
		if (!response.ok) {
			throw new TypeWhisperError(response.status === 409
				? "TypeWhisper is busy or could not start. Check its menu bar indicator."
				: response.status === 401 ? "TypeWhisper authentication changed. Restart its API Server."
				: "TypeWhisper could not complete the request. Check its menu bar indicator.", response.status === 409 ? 409 : 503);
		}
		return response.json();
	}
	function owned(id: string) {
		if (!UUID.test(id) || !sessions.has(id)) throw new TypeWhisperError("Unknown LearnHarness dictation session.", 404);
	}
	async function session(id: string) {
		owned(id);
		const result = await rpc(`transcription?id=${encodeURIComponent(id)}`);
		if (!["recording", "processing", "completed", "failed"].includes(result.status)) throw new TypeWhisperError("Unexpected TypeWhisper session status.");
		// TypeWhisper inserts the transcript itself. Returning/appending text here
		// would insert it twice, and would expose unrelated transcript metadata.
		return { id, status: result.latency?.failed ? "failed" : result.status as string,
			...(result.error === "No speech recognized" ? { message: "No speech recognized. Try speaking while TypeWhisper is recording." } : {}) };
	}
	return {
		async start() {
			const result = await rpc("start", "POST");
			if (typeof result.id !== "string" || !UUID.test(result.id)) throw new TypeWhisperError("TypeWhisper returned no dictation session.");
			sessions.add(result.id);
			if (sessions.size > 100) sessions.delete(sessions.values().next().value!);
			return { id: result.id, status: "recording" };
		},
		session,
		async stop(id: string) {
			const current = await session(id);
			// F3 may already have stopped this session. Never stop a newer one.
			if (current.status !== "recording") return current;
			const result = await rpc("stop", "POST");
			if (result.id !== id) throw new TypeWhisperError("TypeWhisper's active recording changed.", 409);
			return { id, status: "processing" };
		},
	};
}

const runtime = globalThis as typeof globalThis & { learnHarnessTypeWhisper?: ReturnType<typeof createTypeWhisperClient> };
export const typeWhisper = runtime.learnHarnessTypeWhisper ??= createTypeWhisperClient();

export function checkTypeWhisperRequest(request: Request) {
	const url = new URL(request.url);
	const authority = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`);
	const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
	const origin = request.headers.get("origin");
	if (!loopback.has(url.hostname) || !loopback.has(authority.hostname) ||
		(origin !== null && origin !== authority.origin) || request.headers.get("sec-fetch-site") === "cross-site" ||
		(request.method === "POST" && origin !== authority.origin)) {
		throw new TypeWhisperError("TypeWhisper can only be controlled from this local app.", 403);
	}
}
