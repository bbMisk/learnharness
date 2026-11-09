/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { isWithin, realSourcePath, type FileAccessPolicy } from "../agent/tools/file-access.ts";
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

/** The Settings editor's check before it lists a new folder: the app's own
 *  data folder, a second spelling of a listed folder (a symlink such as
 *  /private/tmp for /tmp) and a file are refused; a folder that doesn't
 *  exist yet, or that the server can't read, is listed with a warning,
 *  since that may change later. */
export function checkNewFolder(
	folder: string,
	listed: readonly string[],
	dataDir: string = PATHS.data,
	home: string = os.homedir(),
): { error?: string; warning?: string } {
	const real = (entry: string) => { try { return realSourcePath(expandFolder(entry, home)); } catch { return null; } };
	const unreadable = { warning: "Added, but LearnHarness can't read that folder." };
	const target = real(folder);
	if (target === null) return unreadable;
	const data = real(path.resolve(dataDir));
	if (data !== null && isWithin(target, data)) return { error: "That is LearnHarness's own data folder." };
	if (listed.some((entry) => real(entry) === target)) return { error: "That folder is already listed." };
	let stat: fs.Stats;
	try { stat = fs.statSync(target); } catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { warning: "Added, but that folder doesn't exist yet." } : unreadable;
	}
	if (!stat.isDirectory()) return { error: "That's a file, not a folder." };
	try { fs.accessSync(target, fs.constants.R_OK | fs.constants.X_OK); } catch { return unreadable; }
	return {};
}

