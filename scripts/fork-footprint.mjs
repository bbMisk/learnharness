#!/usr/bin/env node
/**
 * fork-footprint.mjs — how much of the fork lives inside upstream-owned files.
 *
 * A file is upstream-owned when it exists at the upstream ref. Its footprint is
 * the fork's changed lines there (added + deleted, from
 * `git diff --numstat <ref> HEAD`). Fork-owned files are not counted: they never
 * conflict on an upstream merge.
 *
 * Usage: node scripts/fork-footprint.mjs [upstream-ref] [--json]
 * The ref defaults to upstream/main.
 */
import { execFileSync } from "node:child_process";

const SCOPE_DIRS = ["app/", "components/", "src/", "electron/", "lib/", "scripts/", "tests/"];
const SCOPE_FILES = new Set(["proxy.ts", "next.config.ts", "package.json"]);
const TOP = 25;

const args = process.argv.slice(2);
const json = args.includes("--json");
const ref = args.find((a) => !a.startsWith("--")) ?? "upstream/main";

function git(...gitArgs) {
	return execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function inScope(file) {
	return SCOPE_FILES.has(file) || SCOPE_DIRS.some((dir) => file.startsWith(dir));
}

function isTest(file) {
	return file.startsWith("tests/") || /\.test\.[cm]?[jt]sx?$/.test(file);
}

const upstreamFiles = new Set(git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean));
const rows = [];
for (const line of git("diff", "--numstat", "--no-renames", ref, "HEAD").split("\n")) {
	if (!line) continue;
	const [added, deleted, file] = line.split("\t");
	if (!upstreamFiles.has(file) || !inScope(file)) continue;
	const binary = added === "-";
	const a = binary ? 0 : Number(added);
	const d = binary ? 0 : Number(deleted);
	rows.push({ file, added: a, deleted: d, changed: a + d, kind: isTest(file) ? "test" : "product", binary });
}
rows.sort((x, y) => y.changed - x.changed || x.file.localeCompare(y.file));

function total(list) {
	return {
		changed: list.reduce((s, r) => s + r.changed, 0),
		added: list.reduce((s, r) => s + r.added, 0),
		deleted: list.reduce((s, r) => s + r.deleted, 0),
		files: list.length,
	};
}

const summary = {
	ref,
	head: git("rev-parse", "--short", "HEAD").trim(),
	total: total(rows),
	product: total(rows.filter((r) => r.kind === "product")),
	test: total(rows.filter((r) => r.kind === "test")),
	top: rows.slice(0, TOP),
	files: rows,
};

if (json) {
	process.stdout.write(JSON.stringify(summary, null, "\t") + "\n");
} else {
	const fmt = (t) => `${t.changed} changed lines (+${t.added} -${t.deleted}) in ${t.files} files`;
	console.log(`Fork footprint in upstream-owned files, ${ref}..${summary.head}`);
	console.log(`  total:   ${fmt(summary.total)}`);
	console.log(`  product: ${fmt(summary.product)}`);
	console.log(`  tests:   ${fmt(summary.test)}`);
	console.log(`\nTop ${Math.min(TOP, rows.length)} files:`);
	for (const r of summary.top) {
		const tag = r.kind === "test" ? " [test]" : "";
		console.log(`  ${String(r.changed).padStart(6)}  +${r.added} -${r.deleted}  ${r.file}${tag}${r.binary ? " (binary)" : ""}`);
	}
}
