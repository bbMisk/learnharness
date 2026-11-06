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
