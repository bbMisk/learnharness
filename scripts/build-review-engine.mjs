import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const vendor = path.join(root, "vendor/fsrs");
const manifest = JSON.parse(await fs.readFile(path.join(vendor, "manifest.json"), "utf8"));
const target = path.join(os.tmpdir(), `learnharness-fsrs-${manifest.fsrsVersion}`);
const cargo = process.env.CARGO ?? path.join(os.homedir(), ".cargo/bin/cargo");
const run = args => {
	const result = spawnSync(cargo, args, { cwd: vendor, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "Rust build failed");
	return result.stdout;
};
run(["test", "--locked", "--target-dir", target]);
run(["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", target]);
const lock = await fs.readFile(path.join(vendor, "Cargo.lock"), "utf8");
const pinned = lock.match(/name = "fsrs"\nversion = "([^"]+)"\nsource = "[^"]+"\nchecksum = "([^"]+)"/);
if (!pinned || pinned[1] !== manifest.fsrsVersion || pinned[2] !== manifest.fsrsCrateChecksum) throw new Error("Rust dependency differs from the Anki-pinned provenance manifest");
const binary = await fs.readFile(path.join(target, "wasm32-unknown-unknown/release/learnharness_fsrs.wasm"));
manifest.sha256 = createHash("sha256").update(binary).digest("hex");
manifest.wasmFile = `fsrs-${manifest.fsrsVersion}.${manifest.sha256.slice(0, 16)}.wasm`;
manifest.engineId = `anki-${manifest.ankiVersion}-fsrs-${manifest.fsrsVersion}-policy${manifest.policyVersion}-${manifest.sha256.slice(0, 16)}`;
await fs.writeFile(path.join(vendor, "engine.wasm"), binary);
await fs.writeFile(path.join(vendor, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await fs.writeFile(path.join(vendor, "reference-vectors.json"), run(["run", "--locked", "--example", "reference", "--target-dir", target]));
console.log(`Built ${manifest.engineId}. Run review tests before committing the engine update.`);
