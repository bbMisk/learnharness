import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { AUTH_FILE } from "../../config.ts";
import type { Model } from "@earendil-works/pi-ai";

export interface ChatGPTAccount {
	id: string;
	email: string;
	subject: string;
	clientId: string;
	access?: string;
	refresh?: string;
	idToken?: string;
	expires: number;
	scopes: string[];
	models: Model<"openai-responses">[];
	catalogAt: number;
	welcomeSeen?: boolean;
	signedOut?: boolean;
}
export interface ChatGPTState {
	version: 1;
	hostId: string;
	active?: string;
	accounts: ChatGPTAccount[];
}

/** Separate from API keys and learning records; never sent to a renderer. */
export function createChatGPTStore(dir: string) {
	const file = path.join(dir, "accounts.json");
	function read(): ChatGPTState {
		try {
			const state = JSON.parse(fs.readFileSync(file, "utf8")) as ChatGPTState;
			if (state.version !== 1 || !state.hostId || !Array.isArray(state.accounts)) throw new Error("Invalid ChatGPT credential store");
			return state;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, hostId: "", accounts: [] };
			throw error; // A damaged store must not silently discard registrations.
		}
	}
	async function update<T>(fn: (state: ChatGPTState) => T | Promise<T>): Promise<T> {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
		const release = await lockfile.lock(file, { realpath: false, stale: 30000, retries: { retries: 80, minTimeout: 100, maxTimeout: 250 } });
		try {
			const state = read();
			state.hostId ||= `urn:uuid:${randomUUID()}`;
			const result = await fn(state);
			const tmp = `${file}.${randomUUID()}.tmp`;
			try {
				fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
				fs.renameSync(tmp, file);
			} finally { fs.rmSync(tmp, { force: true }); }
			return result;
		} finally { await release(); }
	}
	return { read, update };
}

export const chatGPTStore = createChatGPTStore(path.join(path.dirname(AUTH_FILE), "chatgpt"));
export function activeChatGPTAccount() {
	const state = chatGPTStore.read();
	return state.accounts.find((a) => a.id === state.active);
}
export function chatGPTConnected() {
	const account = activeChatGPTAccount();
	return !!account?.access && !!account.refresh && !account.signedOut && account.scopes.includes("chatgpt.tokens.use.direct");
}
