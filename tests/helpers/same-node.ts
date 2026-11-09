/** Node identity asserts for DOM tests. Never hand a DOM node to
 *  assert.equal and friends: a failing compare prints both nodes, and a
 *  linkedom node reaches the whole document, so the message grows without
 *  bound (it once took hundreds of GB, outside the V8 heap cap). */
import { AssertionError } from "node:assert";

/** A short label: tag, data-testid and aria-label, never the node. */
export function describeNode(node: unknown): string {
	if (node === null) return "null";
	if (node === undefined) return "undefined";
	const el = node as { nodeName?: unknown; getAttribute?: (name: string) => string | null };
	if (typeof el.nodeName !== "string") return `<${typeof node}>`;
	const attr = (name: string) => (typeof el.getAttribute === "function" ? el.getAttribute(name) : null);
	const testid = attr("data-testid");
	const label = attr("aria-label");
	return `<${el.nodeName.toLowerCase()}${testid ? ` data-testid="${testid}"` : ""}${label ? ` aria-label="${label}"` : ""}>`;
}

/** `actual === expected`, with a failure message that names both nodes. */
export function assertSameNode(actual: unknown, expected: unknown, message?: string): void {
	if (actual === expected) return;
	const [want, got] = [describeNode(expected), describeNode(actual)];
	throw new AssertionError({ message: `${message ? message + ": " : ""}expected ${want}, got ${got === want ? "another " + got : got}` });
}

/** `actual !== expected`, with the same short message. */
export function assertNotSameNode(actual: unknown, expected: unknown, message?: string): void {
	if (actual !== expected) return;
	throw new AssertionError({ message: `${message ? message + ": " : ""}expected a node other than ${describeNode(expected)}` });
}
