import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { ProjectRecord } from "../core/projects.ts";
import { emit } from "../core/events.ts";
import { writeFileAtomic } from "./write-file.ts";
export function createProjectStore(root: string) {
	const file = (id: string) => {
		if (!/^project_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid project id.");
		return path.join(root, id + ".json");
	};
	const get = (id: string): ProjectRecord | null => {
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
	return {
		get,
		list(): ProjectRecord[] {
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
		},
		create(name: string) {
			const now = new Date().toISOString();
			return save({
				id: "project_" + randomUUID(),
				name: name.trim() || "New project",
				instructions: "",
				fileIds: [],
				createdAt: now,
				updatedAt: now,
			});
		},
		update(id: string, updates: Partial<Pick<ProjectRecord, "name" | "instructions" | "fileIds">>) {
			const record = get(id);
			if (!record) throw new Error("Project not found.");
			return save({
				...record,
				...updates,
				name: updates.name?.trim() || record.name,
				fileIds: updates.fileIds ? [...new Set(updates.fileIds)] : record.fileIds,
				updatedAt: new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString(),
			});
		},
	};
}
export const projectStore = createProjectStore(path.join(PATHS.data, "projects"));
