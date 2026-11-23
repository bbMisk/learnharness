/**
 * The two guards that keep the real `agy` from ever running under tests
 * (src/agent/antigravity/binary.ts). Nothing here executes a real binary:
 * the decoy files are written by the test and guard 2 refuses them first.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import { AgentSpawnRefused, assertAgentSpawnAllowed, createAgentLauncher, getAgyBinary, resolveAgyBinary } from "../src/agent/antigravity/binary.ts";
import { MOCK_AGY } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

function decoyDir(t: TestContext): { dir: string; agy: string; marker: string } {
	const dir = mkdtempSync(join(tmpdir(), "lh-agy-decoy-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const marker = join(dir, "ran");
	const agy = join(dir, "agy");
	// If anything ever executed this decoy, the marker would appear.
	writeFileSync(agy, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
	return { dir, agy, marker };
}

test("guard 1: under NODE_ENV=test the default search finds nothing, even with an agy on PATH", (t) => {
	const { dir } = decoyDir(t);
	assert.equal(process.env.NODE_ENV, "test");
	assert.equal(getAgyBinary({ ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, LH_AGY_BINARY: undefined }), null);
	// The real PATH also holds the owner's agy; still nothing.
	assert.equal(getAgyBinary({ ...process.env, LH_AGY_BINARY: undefined }), null);
});

test("guard 1: outside tests the same lookup would find it (file checks only, nothing runs)", (t) => {
	const { dir, agy, marker } = decoyDir(t);
	const found = getAgyBinary({ PATH: dir, NODE_ENV: "production", HOME: dir });
	assert.equal(found, agy);
	assert.equal(resolveAgyBinary({ env: { PATH: dir }, platform: "linux", homeDir: dir, isExecutable: (path) => path === agy }), agy);
	assert.equal(existsSync(marker), false);
});

test("LH_AGY_BINARY must be an absolute path to an executable file", (t) => {
	const { agy } = decoyDir(t);
	assert.equal(getAgyBinary({ NODE_ENV: "test", LH_AGY_BINARY: MOCK_AGY }), MOCK_AGY);
	assert.equal(getAgyBinary({ NODE_ENV: "test", LH_AGY_BINARY: agy }), agy);
	assert.equal(getAgyBinary({ NODE_ENV: "test", LH_AGY_BINARY: "agy" }), null);
	assert.equal(getAgyBinary({ NODE_ENV: "test", LH_AGY_BINARY: join(tmpdir(), "missing-agy") }), null);
});

test("guard 2: the launcher refuses any binary but the mock before spawning", (t) => {
	const { agy, marker } = decoyDir(t);
	let spawned = 0;
	const launch = createAgentLauncher({ findBinary: () => agy, spawnProcess: () => { spawned++; throw new Error("must not spawn"); } });
	assert.throws(() => launch(["acp", "--sandbox"], { cwd: tmpdir(), env: {} as NodeJS.ProcessEnv }), AgentSpawnRefused);
	assert.equal(spawned, 0);
	assert.equal(existsSync(marker), false);
	assert.throws(() => assertAgentSpawnAllowed(join(tmpdir(), "agy")), AgentSpawnRefused);
});

test("guard 2: a symlink named mock-agy.mjs that points at another binary is refused", (t) => {
	const { dir, agy, marker } = decoyDir(t);
	const disguised = join(dir, "mock-agy.mjs");
	symlinkSync(agy, disguised);
	let spawned = 0;
	const launch = createAgentLauncher({ findBinary: () => disguised, spawnProcess: () => { spawned++; throw new Error("must not spawn"); } });
	assert.throws(() => launch(["acp", "--sandbox"], { cwd: tmpdir(), env: {} as NodeJS.ProcessEnv }), AgentSpawnRefused);
	assert.equal(spawned, 0);
	assert.equal(existsSync(marker), false);
});

test("guard 2 admits the mock, and no binary means no spawn", () => {
	assert.doesNotThrow(() => assertAgentSpawnAllowed(MOCK_AGY));
	let spawned = 0;
	const launch = createAgentLauncher({ findBinary: () => null, spawnProcess: () => { spawned++; throw new Error("must not spawn"); } });
	assert.equal(launch(["acp", "--sandbox"], { cwd: tmpdir(), env: {} as NodeJS.ProcessEnv }), null);
	assert.equal(spawned, 0);
});
