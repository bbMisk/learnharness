import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The only file name a spawn may run under NODE_ENV=test: the repo's mock agent. */
export const MOCK_AGENT_BASENAME = "mock-agy.mjs";

type BinaryLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	cwd?: string;
	isExecutable: (path: string) => boolean;
};

function searchSpec(env: BinaryLookup["env"], platform: NodeJS.Platform, homeDir: string): { paths: path.PlatformPath; name: string; knownDirs: string[] } {
	if (platform === "win32") {
		const paths = path.win32;
		// Direct spawn uses no shell, so only a real .exe counts.
		return { paths, name: "agy.exe", knownDirs: [paths.join(homeDir, ".local", "bin"), paths.join(env.APPDATA ?? paths.join(homeDir, "AppData", "Roaming"), "npm")] };
	}
	const paths = path.posix;
	return {
		paths,
		name: "agy",
		knownDirs: [
			paths.join(homeDir, ".local", "bin"),
			env.npm_config_prefix ? paths.join(env.npm_config_prefix, "bin") : paths.join(homeDir, ".npm-global", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
			// Only on PATH after shell init, so desktop launches never see them.
			...(env.USER ? [paths.join("/etc/profiles/per-user", env.USER, "bin")] : []),
			paths.join(homeDir, ".nix-profile", "bin"),
			"/run/current-system/sw/bin",
		],
	};
}

/** PATH, then the usual user bin folders (claude-code/binary.ts's list). File checks only. */
export function resolveAgyBinary({ env, platform, homeDir, cwd, isExecutable }: BinaryLookup): string | null {
	const { paths, name, knownDirs } = searchSpec(env, platform, homeDir);
	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);
	const checked = new Set<string>();
	for (const dir of [...pathDirs, ...knownDirs]) {
		// The server's cwd matters only for a relative PATH entry (on Windows also for a drive-relative one);
		// a folder listed twice is checked once.
		const candidate = platform !== "win32" && paths.isAbsolute(dir) ? paths.join(dir, name) : paths.resolve(cwd ?? process.cwd(), dir, name);
		if (checked.has(candidate)) continue;
		checked.add(candidate);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

export function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

/**
 * The agent binary, or null. `LH_AGY_BINARY` (an absolute path) wins.
 * Guard 1: under NODE_ENV=test the default search never runs, so only
 * `LH_AGY_BINARY` or an injected resolver can name a binary in tests.
 */
export function getAgyBinary(env: Record<string, string | undefined> = process.env): string | null {
	const override = env.LH_AGY_BINARY;
	if (override) return path.isAbsolute(override) && isExecutableFile(override) ? override : null;
	if (env.NODE_ENV === "test") return null;
	return resolveAgyBinary({ env, platform: process.platform, homeDir: os.homedir(), isExecutable: isExecutableFile });
}

export class AgentSpawnRefused extends Error {}

/** Guard 2: under NODE_ENV=test nothing but the mock agent may start, whatever path was resolved. */
export function assertAgentSpawnAllowed(binary: string): void {
	if (process.env.NODE_ENV !== "test") return;
	let real = binary;
	try { real = fs.realpathSync(binary); } catch { /* a missing file fails the check below */ }
	if (path.basename(real) !== MOCK_AGENT_BASENAME) {
		throw new AgentSpawnRefused(`Refusing to start ${path.basename(real)} under NODE_ENV=test: only ${MOCK_AGENT_BASENAME} may run in tests.`);
	}
}

export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export type LaunchAgent = (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams | null;

/** Production launcher: resolve, guard, then spawn with no shell. Tests inject both seams. */
export function createAgentLauncher({
	findBinary = getAgyBinary,
	spawnProcess = spawn,
}: { findBinary?: () => string | null; spawnProcess?: SpawnProcess } = {}): LaunchAgent {
	return (args, options) => {
		const binary = findBinary();
		if (!binary) return null;
		assertAgentSpawnAllowed(binary);
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: "pipe" });
	};
}
