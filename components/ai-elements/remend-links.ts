import remend, { type RemendHandler } from "remend";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";

/**
 * Link completion that leaves math alone (owner, 2026-11-05). Remend's own
 * link handler reads the `[` of a half-open interval like $[n,\infty)$ as an
 * unfinished link and appends "](streamdown:incomplete-link)" to the finished
 * message. Without completion, a link still streaming renders its truncated
 * URL as a clickable autolink (hunt finding). So: hide every `[` inside math
 * from remend's link handler, run it, and put the brackets back. A link
 * outside math still gets remend's hardened placeholder while it streams.
 */

const HIDDEN = ""; // a private-use character never produced by the tutor

const LINKS_ONLY = {
	singleTilde: false,
	comparisonOperators: false,
	htmlTags: false,
	setextHeadings: false,
	links: true,
	images: true,
	boldItalic: false,
	bold: false,
	italic: false,
	inlineCode: false,
	strikethrough: false,
	katex: false,
	inlineKatex: false,
} as const;

function escaped(text: string, i: number): boolean {
	let slashes = 0;
	for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) slashes++;
	return slashes % 2 === 1;
}

/** In math that hasn't closed yet (still streaming), hide every `[` except
 *  one that starts a link (`[text](`): that shape is a link, and a link still
 *  streaming must keep remend's hardened placeholder (round-2 hunt finding:
 *  "$5. See [source](https://ex…"), nor the `[` of an image (`![`), which
 *  remend drops until it completes (round-4). */
function hideUnclosed(tail: string): string {
	return tail.replace(/(?<!!)\[(?![^\]\n]*\]\()/g, HIDDEN);
}

type MdNode = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MdNode[] };

/** Math and code ranges exactly as the renderer's parser sees them (owner,
 *  2026-11-05, after rounds 2–13 of hand-written delimiter rules kept
 *  disagreeing with Markdown): the same micromark math extension Streamdown's
 *  math plugin uses (singleDollarTextMath), so pairing, paragraphs, blocks,
 *  code spans and fences all follow the real rules. */
function parse(text: string): { ranges: Array<[number, number]>; lastBlockStart: number } {
	const ranges: Array<[number, number]> = [];
	// GFM too, as the renderer parses it (remark-gfm): table cells bound math (round-14 hunt finding).
	const tree = fromMarkdown(text, { extensions: [gfm(), math({ singleDollarTextMath: true })], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] }) as MdNode;
	const walk = (node: MdNode) => {
		if (node.type === "inlineMath" || node.type === "math" || node.type === "inlineCode" || node.type === "code") {
			const from = node.position?.start.offset;
			const to = node.position?.end.offset;
			if (typeof from === "number" && typeof to === "number") ranges.push([from, to]);
			return;
		}
		for (const child of node.children ?? []) walk(child);
	};
	walk(tree);
	return { ranges, lastBlockStart: tree.children?.at(-1)?.position?.start.offset ?? 0 };
}

/** `[` inside math or code → HIDDEN (no link exists there; remend's link
 *  completion would otherwise read the `[` of $[n,\infty)$ as a link). While
 *  a message streams, the parser sees an unclosed `$` as plain text: if the
 *  last block still holds an unpaired `$` outside math and code, what
 *  follows it may be math still arriving, so its brackets are hidden too
 *  (links and images excepted, above). */
function prepare(text: string): { hidden: string; lastBlockStart: number } {
	const { ranges, lastBlockStart } = parse(text);
	// One pass marks covered positions (linear; a per-character range scan was quadratic).
	const mask = new Uint8Array(text.length);
	for (const [from, to] of ranges) mask.fill(1, Math.max(0, from), Math.min(text.length, to));
	// Parser offsets are UTF-16 code units, the same units as string indexes.
	let hidden = "";
	for (let i = 0; i < text.length; i++) hidden += text[i] === "[" && mask[i] === 1 ? HIDDEN : text[i];
	// The streaming tail: the last unpaired `$` in the final block.
	for (let i = text.length - 1; i >= lastBlockStart; i--) {
		if (text[i] === "$" && !escaped(text, i) && mask[i] !== 1) {
			return { hidden: hidden.slice(0, i + 1) + hideUnclosed(hidden.slice(i + 1)), lastBlockStart };
		}
	}
	return { hidden, lastBlockStart };
}

/** Where the final region starts: just after the last blank line that is
 *  outside fenced code and $$ display math. Everything before it is
 *  finished blocks, so a streaming render parses only the tail (the
 *  renderer re-runs this on every chunk; parsing the whole reply each time
 *  cost several ms on long replies). 0 when there is no such line. */
export function finalRegionStart(text: string): number {
	let fence: string | null = null;
	let display = false;
	let start = 0;
	let pos = 0;
	for (const line of text.split("\n")) {
		pos += line.length + 1;
		// Any indentation: a fence nested in a list may sit 4+ spaces in (round-16
		// hunt finding). Over-detecting only widens the parsed region, which is safe.
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		if ((line.match(/\$\$/g) ?? []).length % 2 === 1) display = !display;
		if (!display && line.trim() === "") start = pos;
	}
	return Math.min(start, text.length);
}

export function hideMathBrackets(text: string): string {
	return prepare(text).hidden;
}

/** Only the final block can end in a link still streaming: earlier blocks are
 *  finished, so link repair runs on the final block alone. That is faster
 *  (remend's link scan is slow on long texts) and right: an unmatched `[`
 *  in an earlier paragraph is plain text, never an unfinished link. */
export function completeLinksOutsideMath(text: string): string {
	if (!text.includes("[")) return text;
	// The marker character already in the text would be turned into "[": fall back to plain completion.
	if (text.includes(HIDDEN)) return remend(text, LINKS_ONLY);
	const region = finalRegionStart(text);
	const tail = text.slice(region);
	if (!tail.includes("[")) return text;
	const { hidden, lastBlockStart } = prepare(tail);
	return text.slice(0, region) + (hidden.slice(0, lastBlockStart) + remend(hidden.slice(lastBlockStart), LINKS_ONLY)).replaceAll(HIDDEN, "[");
}

/** Runs where remend's own link handler would (priority 20, before bold/italic). */
export const mathAwareLinks: RemendHandler = { name: "mathAwareLinks", handle: completeLinksOutsideMath, priority: 20 };
