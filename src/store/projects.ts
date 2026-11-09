import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { ProjectRecord } from "../core/projects.ts";
import { cleanName } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { writeFileAtomic } from "./write-file.ts";
export function createProjectStore(root: string) {
	const validId = (id: string) => /^project_[a-zA-Z0-9_-]+$/.test(id);
	const file = (id: string) => {
		if (!validId(id)) throw new Error("Invalid project id.");
		return path.join(root, id + ".json");
	};
	const get = (id: string): ProjectRecord | null => {
		// A malformed id (a bad link) is simply not found.
		if (!validId(id)) return null;
		try {
			const record = JSON.parse(fs.readFileSync(file(id), "utf8"));
			return record.id === id && Array.isArray(record.fileIds) ? record : null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[project ${id}] could not be read:`, error);
			return null;
		}
	};
	const save = (record: ProjectRecord) => {
		fs.mkdirSync(root, { recursive: true });
		writeFileAtomic(file(record.id), JSON.stringify(record, null, 2), { mode: 0o600 });
		emit("chats-changed", {});
		return record;
	};
	const list = (): ProjectRecord[] => {
		try {
			return fs
				.readdirSync(root)
				.filter((f) => f.endsWith(".json"))
				.map((f) => get(f.slice(0, -5)))
				.filter((p): p is ProjectRecord => !!p)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[projects] could not be listed:", error);
			return [];
		}
	};
	return {
		get,
		list,
		create(name: string) {
			const now = new Date().toISOString();
			return save({
				id: "project_" + randomUUID(),
				name: cleanName(name) || "New project",
				instructions: "",
				fileIds: [],
				createdAt: now,
				updatedAt: now,
			});
		},
		/** Delete the project record (its chats are the caller's to move first). */
		remove(id: string): boolean {
			try {
				fs.unlinkSync(file(id));
			} catch {
				return false;
			}
			emit("chats-changed", {});
			return true;
		},
		/** Whether another project already has this name (case-insensitive). */
		nameTaken(name: string, exceptId?: string): boolean {
			const wanted = cleanName(name).toLowerCase();
			return list().some((project) => project.id !== exceptId && project.name.toLowerCase() === wanted);
		},
		update(id: string, updates: Partial<Pick<ProjectRecord, "name" | "instructions" | "fileIds">>) {
			const record = get(id);
			if (!record) throw new Error("Project not found.");
			return save({
				...record,
				...updates,
				name: cleanName(updates.name ?? "") || record.name,
				fileIds: updates.fileIds ? [...new Set(updates.fileIds)] : record.fileIds,
				updatedAt: new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString(),
			});
		},
	};
}
export const projectStore = createProjectStore(path.join(PATHS.data, "projects"));
