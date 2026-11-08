"use client";

/**
 * Streamdown's Block with the parsed output of finished blocks kept. Switching
 * chats unmounts the transcript, and every remount re-parsed each block
 * (Markdown → HAST → math → React elements). A finished block's elements
 * depend only on its source and the parser configuration, so they are reused.
 *
 * Block renders a context provider around an internal, hook-free component
 * that does the parsing. This calls Block's render function, then calls that
 * inner component in place, so the parse runs through Streamdown's own
 * pipeline; only its result is stored. Streaming, incomplete and animated
 * blocks take the same path uncached, so a block never changes
 * element shape, and never remounts, when its message finishes. Block's own
 * memo comparison is kept.
 */

import { Block, type BlockProps } from "streamdown";
import { cloneElement, isValidElement, memo, type ReactElement, type ReactNode } from "react";

const MAX_BLOCKS = 3000;
const parsed = new Map<string, ReactNode>();

const block = Block as unknown as {
	type: (props: BlockProps) => ReactElement<{ children: ReactNode }>;
	compare: (prev: BlockProps, next: BlockProps) => boolean;
};

const ids = new WeakMap<object, number>();
let lastId = 0;
/** A stable token per plugin, option object or component (by identity). */
function token(value: unknown): string {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return JSON.stringify(value) ?? "u";
	let id = ids.get(value);
	if (id === undefined) ids.set(value, (id = ++lastId));
	return `#${id}`;
}

/** The cache key for the inner parser's props. Arrays (plugin lists) and the
 *  components map are keyed by their entries, which keep their identity
 *  across Streamdown instances; other props by value or identity. The source
 *  goes last, after a fixed `children=` marker, so keys cannot collide. */
function keyOf({ children, ...props }: Record<string, unknown>): string {
	const config = Object.keys(props)
		.sort()
		.map((name) => {
			const value = props[name];
			if (Array.isArray(value)) return `${name}=[${value.map((p) => (Array.isArray(p) ? p.map(token).join("+") : token(p))).join(",")}]`;
			if (name === "components" && value && typeof value === "object") {
				return `${name}={${Object.entries(value).map(([k, v]) => `${k}:${token(v)}`).join(",")}}`;
			}
			return `${name}=${token(value)}`;
		});
	return `${config.join("\n")}\nchildren=${typeof children === "string" ? children : token(children)}`;
}

/** The parser element: the first descendant whose type is a component. */
function parserOf(el: ReactElement<{ children?: ReactNode }>): ReactElement<Record<string, unknown>> | null {
	const child = el.props.children;
	if (!isValidElement<Record<string, unknown>>(child)) return null;
	return typeof child.type === "function" ? child : parserOf(child);
}

/** `el` with the parser element replaced by its output. */
function withOutput(el: ReactElement<{ children?: ReactNode }>, output: ReactNode): ReactElement {
	const child = el.props.children as ReactElement<{ children?: ReactNode }>;
	return cloneElement(el, undefined, typeof child.type === "function" ? output : withOutput(child, output));
}

export const CachedBlock = memo(function CachedBlock(props: BlockProps) {
	const el = block.type(props);
	const parser = parserOf(el);
	if (!parser) return el;
	const render = parser.type as (p: Record<string, unknown>) => ReactNode;
	// The animate plugin's output depends on its own state.
	if (props.shouldParseIncompleteMarkdown || props.isIncomplete || props.animatePlugin) return withOutput(el, render(parser.props));
	const key = keyOf(parser.props);
	let output = parsed.get(key);
	if (output === undefined) {
		output = render(parser.props);
		if (parsed.size >= MAX_BLOCKS) parsed.delete(parsed.keys().next().value!);
	} else {
		parsed.delete(key);
	}
	parsed.set(key, output);
	return withOutput(el, output);
}, block.compare);
