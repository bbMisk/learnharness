/**
 * Shared harness for the Antigravity tests: every child they start is the
 * mock agent (tests/fixtures/antigravity/mock-agy.mjs), started through the
 * production launcher so both binary guards stay on the path.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

import { createAgentLauncher, type LaunchAgent } from "../../src/agent/antigravity/binary.ts";

if (process.env.NODE_ENV !== "test") throw new Error("The Antigravity tests must run with NODE_ENV=test.");

export const MOCK_AGY = fileURLToPath(new URL("../fixtures/antigravity/mock-agy.mjs", import.meta.url));

export type MockScenario = Record<string, unknown>;
export type MockLogEntry = { kind: string; line?: string; argv?: string[]; cwd?: string; envNames?: string[]; pid?: number; answer?: unknown };

export interface MockHarness {
	launch: LaunchAgent;
	children: ChildProcessWithoutNullStreams[];
	spawns: number;
	log(): MockLogEntry[];
	/** Every JSON message the mock received, in order, across all its processes. */
	received(): Record<string, unknown>[];
	methods(): string[];
	/** Fails unless every child started so far has exited within `ms`. */
	assertNoChildren(ms?: number): Promise<void>;
	setScenario(next: MockScenario): void;
}

function exited(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export function mockHarness(t: TestContext, initial: MockScenario = {}): MockHarness {
	const dir = mkdtempSync(join(tmpdir(), "lh-agy-test-"));
	const logFile = join(dir, "mock.log");
	let scenario = initial;
	const children: ChildProcessWithoutNullStreams[] = [];
	const harness: MockHarness = {
		children,
		spawns: 0,
		launch: createAgentLauncher({
			findBinary: () => MOCK_AGY,
			spawnProcess: (command, args, options) => {
				harness.spawns++;
				const child = spawn(command, args, { ...options, env: { ...options.env, MOCK_AGY_SCENARIO: JSON.stringify(scenario), MOCK_AGY_LOG: logFile } as NodeJS.ProcessEnv });
				children.push(child);
				return child;
			},
		}),
		log() {
			let text = "";
			try { text = readFileSync(logFile, "utf8"); } catch { return []; }
			return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as MockLogEntry);
		},
		received() {
			return harness.log().filter((entry) => entry.kind === "recv" && entry.line?.trim()).map((entry) => JSON.parse(entry.line!) as Record<string, unknown>);
		},
		methods() {
			return harness.received().flatMap((message) => typeof message.method === "string" ? [message.method] : []);
		},
		async assertNoChildren(ms = 3000) {
			const deadline = Date.now() + ms;
			while (children.some((child) => !exited(child)) && Date.now() < deadline) await sleep(20);
			assert.ok(children.every(exited), "every mock agent process has exited");
		},
		setScenario(next) { scenario = next; },
	};
	t.after(async () => {
		for (const child of children) if (!exited(child)) child.kill("SIGKILL");
		const deadline = Date.now() + 2000;
		while (children.some((child) => !exited(child)) && Date.now() < deadline) await sleep(20);
		rmSync(dir, { recursive: true, force: true });
	});
	return harness;
}

/** Poll until `check` is true or fail after `ms`. */
export async function waitFor(check: () => boolean, ms = 3000, what = "condition"): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(10);
	}
}
