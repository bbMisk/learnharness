import { projectStore } from "../store/projects.ts";
import { uploadStore } from "../store/uploads.ts";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { isWithin, realSourcePath } from "../agent/tools/file-access.ts";
import type { ProjectFolder, ProjectView } from "../core/projects.ts";
export { projectStore };

function readableFolder(folder: string): boolean {
	try {
		const real = fs.realpathSync.native(folder);
		if (!fs.statSync(real).isDirectory()) return false;
		fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function linkedFolder(folder: string): ProjectFolder {
	return { path: folder, name: path.basename(folder) || folder, available: readableFolder(folder) };
}

/** The server-side check before a folder is linked to a project: an absolute
 *  path to an existing, readable directory on this computer, not
 *  LearnHarness's own data folder and not already linked. Returns the
 *  normalized path to store, or an error the page can show. */
export function checkProjectFolder(
	folder: unknown,
	linked: readonly string[],
	dataDir: string = PATHS.data,
): { path: string } | { error: string } {
	if (typeof folder !== "string" || !folder || folder.includes("\0") || !path.isAbsolute(folder))
		return { error: "Choose a folder on this computer." };
	const normalized = path.resolve(folder);
	let real: string;
	try {
		real = realSourcePath(normalized);
	} catch {
		return { error: "LearnHarness can't read that folder." };
	}
	let data: string | null = null;
	try {
		data = realSourcePath(path.resolve(dataDir));
	} catch {
		/* No data folder yet: nothing to refuse. */
	}
	if (data !== null && isWithin(real, data)) return { error: "That folder holds LearnHarness's own data." };
	let stat: fs.Stats;
	try {
		stat = fs.statSync(real);
	} catch {
		return { error: "That folder doesn't exist." };
	}
	if (!stat.isDirectory()) return { error: "That's a file, not a folder." };
	if (!readableFolder(real)) return { error: "LearnHarness can't read that folder." };
	const realOf = (entry: string) => {
		try {
			return realSourcePath(entry);
		} catch {
			return entry;
		}
	};
	if (linked.some((entry) => realOf(entry) === real)) return { error: "That folder is already in this project." };
	return { path: normalized };
}

/** Every existing folder linked to any project: restricted File access
 *  keeps them readable (owner decision 2026-11-17), the way it keeps the
 *  upload store readable. Missing folders are left out so they don't show
 *  up as "unavailable allowed folder" noise. */
export function linkedProjectFolders(): string[] {
	return [...new Set(projectStore.list().flatMap((project) => project.folders ?? []))].filter(readableFolder);
}
export async function projectView(id: string): Promise<ProjectView | null> {
	const project = projectStore.get(id);
	if (!project) return null;
	const resolved = await Promise.allSettled(project.fileIds.map((id) => uploadStore.read(id)));
	const files = resolved.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
	const missingFileIds = project.fileIds.filter((_, index) => resolved[index]?.status === "rejected");
	const folders = project.folders ?? [];
	return { ...project, folders, files, linkedFolders: folders.map(linkedFolder), ...(missingFileIds.length ? { missingFileIds } : {}) };
}
/** Resolve fresh each turn: editing the project updates existing chats too. */
export async function projectInstructions(id?: string): Promise<string> {
	if (!id) return "";
	const project = await projectView(id);
	if (!project) return "";
	const linkedFolders = project.linkedFolders ?? [];
	return [
		"## Current project: " + project.name,
		project.instructions ? "User project instructions:\n" + project.instructions : "",
		project.missingFileIds?.length
			? "Some shared project files are unavailable. Their contents were not supplied; ask the learner to upload them again if needed."
			: "",
		project.files.length
			? "Shared project files available to this chat. Use the existing read/PDF tools to inspect relevant files:\n" +
				project.files.map((f) => "- " + f.name + ": " + JSON.stringify(f.path)).join("\n")
			: "",
		linkedFolders.some((f) => f.available)
			? "Shared project folders, linked live from the learner's disk (contents may change between turns). Browse them with ls/find/grep, then use the read/PDF tools on relevant files:\n" +
				linkedFolders.filter((f) => f.available).map((f) => "- " + f.name + "/: " + JSON.stringify(f.path)).join("\n")
			: "",
		linkedFolders.some((f) => !f.available)
			? "Some linked project folders are missing or unreadable, so their contents are unavailable: " +
				linkedFolders.filter((f) => !f.available).map((f) => JSON.stringify(f.path)).join(", ")
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}
