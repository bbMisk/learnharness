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
	/** At teardown: run `stop` (the owner's shutdown), then FAIL if any child outlives it. */
	onTeardown(stop: () => void): void;
	/** Set only by the Sign in tests: otherwise teardown FAILS if `authenticate` was ever sent. */
	allowSignIn: boolean;
}

function exited(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export function mockHarness(t: TestContext, initial: MockScenario = {}): MockHarness {
	const dir = mkdtempSync(join(tmpdir(), "lh-agy-test-"));
	const logFile = join(dir, "mock.log");
	let scenario = initial;
	const children: ChildProcessWithoutNullStreams[] = [];
	const stops: (() => void)[] = [];
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
		onTeardown(stop) { stops.push(stop); },
		allowSignIn: false,
	};
	t.after(async () => {
		for (const stop of stops) stop();
		let deadline = Date.now() + 4000;
		while (children.some((child) => !exited(child)) && Date.now() < deadline) await sleep(20);
		const survivors = children.filter((child) => !exited(child)).length;
		for (const child of children) if (!exited(child)) child.kill("SIGKILL");
		deadline = Date.now() + 2000;
		while (children.some((child) => !exited(child)) && Date.now() < deadline) await sleep(20);
		// Only the user's Sign in click sends authenticate: never a lesson turn, a check or a helper run.
		const signIns = harness.allowSignIn ? 0 : harness.methods().filter((method) => method === "authenticate").length;
		rmSync(dir, { recursive: true, force: true });
		assert.equal(survivors, 0, "a mock agent process outlived its owner's shutdown");
		assert.equal(signIns, 0, "authenticate was sent without a Sign in click");
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
