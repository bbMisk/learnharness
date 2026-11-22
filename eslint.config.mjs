import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * ESLint with one job here: ENFORCE THE IMPORT LAW (the shell/core
 * architecture, docs/architecture.md). Everything else stays out of the
 * way — this is not a style linter.
 *
 *   components/**  →  "@/src/core"  (the pure core barrel) — ONLY
 *   app/**         →  "@/src/core" + "@/src/server" (the server barrel) — ONLY
 *   src/core/**    →  never imports src/agent, src/server, src/store (pure
 *                    core: adapters implement core/ports.ts, never the reverse)
 *   src/agent/**   →  never imports src/server, src/store (dependencies —
 *                    the storage ports, the composition — arrive via
 *                    factories/closures from the chat-handler)
 *
 * tests/ and scripts/ are internal — unrestricted.
 */

export default defineConfig([
	// electron/** — the desktop shell: plain Node, no framework, outside the
// import law (same rationale as scripts/).
	globalIgnores([".next/**", "node_modules/**", "data/**", "next-env.d.ts", "scripts/**", "electron/**", "dist/**"]),
	{
		files: ["**/*.{js,mjs,ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
		},
		plugins: { "@next/next": nextPlugin, import: importPlugin },
		settings: {
			"import/resolver": { typescript: { alwaysTryTypes: true } },
		},
		rules: {
			...nextPlugin.configs.recommended.rules,
			"import/no-restricted-paths": [
				"error",
				{
					zones: [
						{
							target: "./components",
							from: "./src",
							// NOTE: the plugin resolves `except` relative to the zone's `from` path.
							except: ["./core/index.ts"],
							message:
								"Browser shell imports ONLY the pure core barrel: `from \"@/src/core\"` (architecture: docs/architecture.md).",
						},
						{
							target: "./app",
							from: "./src",
							except: ["./core/index.ts", "./server/index.ts"],
							message:
								"app/ (transport + server components) imports ONLY the barrels: `@/src/core` and `@/src/server` (architecture: docs/architecture.md).",
						},
						{
							target: "./src/core",
							from: ["./src/agent", "./src/server", "./src/store"],
							message:
								"Pure core never imports IO layers (agent/server/store): adapters implement core/ports.ts, and the composition root (src/server/stores.ts) passes them in (architecture: docs/architecture.md).",
						},
						{
							target: "./src/agent",
							from: ["./src/server", "./src/store"],
							message:
								"The agent layer receives its dependencies (storage ports via factories/closures) — it never imports the server layer or store adapters (architecture: docs/architecture.md).",
						},
					],
				},
			],
		},
	},
	// FORK: a failing assert.equal on a DOM node prints the node; a linkedom
	// node reaches the whole document and the message grows without bound.
	// Fork-owned tests only: test files that exist at upstream/main keep
	// upstream's assertions, so a merge never rewrites them. Without that ref
	// (a clone with no upstream remote) the rule is skipped.
	{
		files: ["tests/**/*.{ts,tsx}"],
		ignores: upstreamTestFiles() ?? ["tests/**"],
		rules: {
			"no-restricted-syntax": [
				"error",
				...[
					'Identifier[name="focused"].arguments',
					'MemberExpression[property.name="activeElement"].arguments',
					'CallExpression[callee.property.name="querySelector"].arguments',
					'TSNonNullExpression.arguments > CallExpression[callee.property.name="querySelector"]',
				].map((node) => ({
					selector: `CallExpression[callee.object.name="assert"][callee.property.name=/^(not)?(deep)?(strict)?equal$/i] > ${node}`,
					message: "Compare DOM nodes with assertSameNode (tests/helpers/same-node.ts): assert prints the node on failure.",
				})),
			],
		},
	},
]);

/** Test files that exist at upstream/main (read from git on each lint run,
 *  so a newly merged upstream test is exempt with no manual step), or
 *  null when the ref is unavailable. */
function upstreamTestFiles() {
	try {
		const out = execFileSync("git", ["-C", fileURLToPath(new URL(".", import.meta.url)), "ls-tree", "-r", "--name-only", "upstream/main", "--", "tests"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n").filter(Boolean);
	} catch {
		return null;
	}
}
