/**
 * The fork's CSS in app/globals.css, read as text and evaluated for a given
 * session-area width (linkedom has no layout or container queries). Only
 * what those rules use: var() with fallbacks, calc/min/max, rem, px, cqw.
 */
import fs from "node:fs";

export const GLOBALS_CSS = fs.readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

/** The body of the `@container session (min-width: 60rem)` block that holds `selector`. */
export function sessionQueryHolding(selector: string): string {
	const re = /@container session \(min-width: 60rem\) \{([\s\S]*?)\n\}/g;
	for (const m of GLOBALS_CSS.matchAll(re)) if (m[1]!.includes(selector)) return m[1]!;
	throw new Error(`no session container query holds ${selector}`);
}

/** The declarations every rule in `block` gives `cls` (later rules win). */
export function declarationsFor(block: string, cls: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selectors = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim());
		if (!selectors.includes(cls)) continue;
		const body = m[2]!.replace(/\/\*[\s\S]*?\*\//g, "");
		for (const d of body.split(";")) {
			const at = d.indexOf(":");
			if (at > 0) out.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
		}
	}
	return out;
}

/** Evaluate a declaration to px for an area `areaPx` wide, with `vars` the
 *  inherited custom properties (e.g. --lh-transcript-max) and the element's own. */
export function evalPx(value: string, own: Map<string, string>, inherited: Record<string, string>, areaPx: number, rem = 16): number {
	const resolve = (v: string, depth = 0): string => {
		if (depth > 20) throw new Error("var cycle");
		return v.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => {
			const found = own.get(name) ?? inherited[name] ?? fallback;
			if (found === undefined) throw new Error(`unset ${name} with no fallback`);
			return `(${resolve(found, depth + 1)})`;
		});
	};
	let expr = resolve(value);
	while (/var\(/.test(expr)) expr = resolve(expr);
	expr = expr
		.replace(/(-?\d*\.?\d+)cqw/g, (_, n: string) => `(${(Number(n) / 100) * areaPx})`)
		.replace(/(-?\d*\.?\d+)rem/g, (_, n: string) => `(${Number(n) * rem})`)
		.replace(/(-?\d*\.?\d+)px/g, (_, n: string) => `(${Number(n)})`)
		.replace(/\bcalc\(/g, "(")
		.replace(/\bmin\(/g, "Math.min(")
		.replace(/\bmax\(/g, "Math.max(");
	if (!/^(?:[\d\s.+\-*/(),]|Math\.min|Math\.max)*$/.test(expr)) throw new Error(`unexpected CSS expression: ${expr}`);
	return Function(`return (${expr});`)() as number;
}
