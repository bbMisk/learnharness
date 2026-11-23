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
	/** Thinking levels the agent offered for this model at the last Check connection ([] = none, or never learned). */
	levels: string[];
	defaultLevel?: string;
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
const MAX_LEVELS = 16;
/** The same rule as agent/antigravity/models.ts: lowercase letters, digits, `_` or `-`, at most 32 characters. */
const LEVEL_VALUE = /^[a-z0-9_-]{1,32}$/;

function levels(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value.filter((level): level is string => typeof level === "string" && LEVEL_VALUE.test(level) && !seen.has(level) && !!seen.add(level)).slice(0, MAX_LEVELS);
}

/** No link, no control character, at most 200 characters (the same rule as agent/antigravity/models.ts). */
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() && value.length <= MAX_TEXT && !value.includes("://") && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : undefined;
}

export function sanitizeAntigravityRecord(raw: unknown): AntigravityRecord {
	const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	const seen = new Set<string>();
	const models = (Array.isArray(record.models) ? record.models : []).flatMap((entry): AntigravityModelEntry[] => {
		const value = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
		const id = text(value.id);
		if (!id || seen.has(id)) return [];
		const named = value.name === undefined || value.name === null || value.name === "" ? id : text(value.name);
		if (!named) return [];
		seen.add(id);
		const offered = levels(value.levels);
		const defaultLevel = typeof value.defaultLevel === "string" && offered.includes(value.defaultLevel) ? value.defaultLevel : undefined;
		return [{ id, name: named, levels: offered, ...(defaultLevel ? { defaultLevel } : {}) }];
	}).slice(0, MAX_MODELS);
	const agentVersion = typeof record.agentVersion === "string" && /^\d+\.\d+\.\d+$/.test(record.agentVersion) ? record.agentVersion : undefined;
	const checkedAt = typeof record.checkedAt === "string" && !Number.isNaN(Date.parse(record.checkedAt)) ? record.checkedAt : undefined;
	return { version: 1, enabled: record.enabled === true, models, ...(agentVersion ? { agentVersion } : {}), ...(checkedAt ? { checkedAt } : {}) };
}

type Patch = Partial<Omit<AntigravityRecord, "version">>;

export interface AntigravityStore {
	read(): AntigravityRecord;
	/** A patch, or a function of the current record (one read) that returns one. */
	update(patch: Patch | ((current: AntigravityRecord) => Patch)): AntigravityRecord;
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
			const current = read();
			const next = sanitizeAntigravityRecord({ ...current, ...(typeof patch === "function" ? patch(current) : patch) });
			// Lesson turns save the model list each time: skip the write when nothing changed.
			if (JSON.stringify(next) === JSON.stringify(current)) return next;
			fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, `${JSON.stringify(next, null, "\t")}\n`);
			cache = undefined;
			return next;
		},
	};
}

export const ANTIGRAVITY_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "antigravity.json");
export const antigravityStore = createAntigravityStore(ANTIGRAVITY_FILE);
