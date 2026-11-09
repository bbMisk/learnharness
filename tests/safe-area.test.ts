/** The safe-area inset reader shared by menus, tooltips and popovers (iPad/iPhone Home Screen app). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { safeAreaInsets } from "../components/safe-area.ts";

test("reads the --lh-safe-* variables; zero when styles are unavailable", () => {
	const g = globalThis as Record<string, unknown>;
	const saved = { gcs: g.getComputedStyle, doc: g.document };
	try {
		delete g.getComputedStyle;
		assert.deepEqual(safeAreaInsets(), { top: 0, bottom: 0, left: 0, right: 0 }, "no getComputedStyle: zero insets");
		const vars: Record<string, string> = { "--lh-safe-top": "24px", "--lh-safe-bottom": " 20px", "--lh-safe-left": "0px", "--lh-safe-right": "" };
		g.document = { documentElement: {} };
		g.getComputedStyle = () => ({ getPropertyValue: (name: string) => vars[name] ?? "" });
		assert.deepEqual(safeAreaInsets(), { top: 24, bottom: 20, left: 0, right: 0 });
	} finally {
		g.getComputedStyle = saved.gcs;
		g.document = saved.doc;
	}
});

test("Radix's dialog scroll lock keeps the body's safe-area padding (New project)", async () => {
	const fs = await import("node:fs");
	// The lock (react-remove-scroll-bar) injects `body[data-scroll-locked] { padding-top: 0px; … }`.
	const css = fs.readFileSync("app/globals.css", "utf-8");
	const rule = /body,\s*html body\[data-scroll-locked\] \{\s*padding: var\(--lh-safe-top\)[^}]*var\(--lh-safe-bottom\)/;
	assert.match(css, rule, "a more specific selector restores the padding under the lock");
});
