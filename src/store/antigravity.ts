/**
 * Hanson's fork: <DATA_ROOT>/antigravity.json, the Antigravity provider's
 * own record (docs/antigravity.md). Kept out of the upstream settings
 * schema on purpose. Everything read is sanitized; writes are atomic.
 */
import fs from "node:fs";
import path from "node:path";

import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export interface AntigravityModelEntry {
	id: string;
	name: string;
}

export interface AntigravityRecord {
	version: 1;
	/** The user's opt-in. Off unless the file says exactly `true`. */
	enabled: boolean;
	/** The last model list the agent reported. */
	models: AntigravityModelEntry[];
	agentVersion?: string;
	checkedAt?: string;
}

const MAX_MODELS = 200;
const MAX_TEXT = 200;

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() && value.length <= MAX_TEXT ? value : undefined;
}

export function sanitizeAntigravityRecord(raw: unknown): AntigravityRecord {
	const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	const seen = new Set<string>();
	const models = (Array.isArray(record.models) ? record.models : []).flatMap((entry): AntigravityModelEntry[] => {
		const value = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
		const id = text(value.id);
		if (!id || seen.has(id)) return [];
		seen.add(id);
		return [{ id, name: text(value.name) ?? id }];
	}).slice(0, MAX_MODELS);
	const agentVersion = typeof record.agentVersion === "string" && /^\d+\.\d+\.\d+$/.test(record.agentVersion) ? record.agentVersion : undefined;
	const checkedAt = typeof record.checkedAt === "string" && !Number.isNaN(Date.parse(record.checkedAt)) ? record.checkedAt : undefined;
	return { version: 1, enabled: record.enabled === true, models, ...(agentVersion ? { agentVersion } : {}), ...(checkedAt ? { checkedAt } : {}) };
}

export interface AntigravityStore {
	read(): AntigravityRecord;
	update(patch: Partial<Omit<AntigravityRecord, "version">>): AntigravityRecord;
}

export function createAntigravityStore(file: string): AntigravityStore {
	// The catalog reads this on every model lookup; re-parse only when the file changes.
	let cache: { key: string; record: AntigravityRecord } | undefined;
	const read = (): AntigravityRecord => {
		let stat: fs.Stats | undefined;
		try { stat = fs.statSync(/* turbopackIgnore: true */ file, { throwIfNoEntry: false }); } catch { stat = undefined; }
		if (!stat) return sanitizeAntigravityRecord(undefined);
		const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
		if (cache?.key === key) return structuredClone(cache.record);
		let record: AntigravityRecord;
		try { record = sanitizeAntigravityRecord(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8"))); }
		catch { record = sanitizeAntigravityRecord(undefined); }
		cache = { key, record };
		return structuredClone(record);
	};
	return {
		read,
		update(patch) {
			const next = sanitizeAntigravityRecord({ ...read(), ...patch });
			fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, `${JSON.stringify(next, null, "\t")}\n`);
			cache = undefined;
			return next;
		},
	};
}

export const ANTIGRAVITY_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "antigravity.json");
export const antigravityStore = createAntigravityStore(ANTIGRAVITY_FILE);
