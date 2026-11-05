/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import { readFileAccessSettings } from "../store/settings.ts";

export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	if (!path.isAbsolute(folder)) throw new Error("Invalid file-access folder for this server filesystem");
	return path.resolve(folder);
}

/** The app's upload store (src/store/uploads.ts): only files the learner
 *  attached themselves land there. Restricted mode keeps them readable
 *  (fork: pasted screenshots, iPad/shared-host attachments, project files
 *  all arrive as uploads), else turning the restriction on would silently
 *  break attachments. Only this folder, never the rest of the data folder;
 *  fs-shared's mandatory denials still run first. */
export function uploadsFolder(): string {
	return path.join(PATHS.data, "uploads");
}

export function fileAccessPolicy(): FileAccessPolicy {
	const result = readFileAccessSettings();
	if (!result.ok) return { restricted: true, folders: [], error: result.error };
	const folders = result.settings.folders.map((folder) => expandFolder(folder));
	// Added only once it exists, so a fresh install reports no "unavailable folder".
	if (result.settings.restricted && fs.existsSync(uploadsFolder())) folders.push(uploadsFolder());
	return { restricted: result.settings.restricted, folders };
}

/** Safe UI diagnostic, no raw JSON/file contents. A corrupt record must
 * not make the restriction toggle appear safely OFF while reads are blocked. */
export function fileAccessConfigurationError(): string | null {
	const result = readFileAccessSettings();
	return result.ok ? null : result.error;
}
