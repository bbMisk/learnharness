import remend, { type RemendHandler } from "remend";

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

/** Find the next unescaped `delim` at or after `from` (-1 if none). */
function nextDelimiter(text: string, delim: string, from: number): number {
	for (let i = text.indexOf(delim, from); i !== -1; i = text.indexOf(delim, i + 1)) {
		if (!escaped(text, i) && (delim === "$$" || text[i + 1] !== "$")) return i;
	}
	return -1;
}

/** `[` inside $…$ and $$…$$ (and an unclosed trailing span, while it streams) → HIDDEN. */
export function hideMathBrackets(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const open = text.indexOf("$", i);
		if (open === -1) break;
		if (escaped(text, open)) {
			out += text.slice(i, open + 1);
			i = open + 1;
			continue;
		}
		const delim = text[open + 1] === "$" ? "$$" : "$";
		const start = open + delim.length;
		const close = nextDelimiter(text, delim, start);
		const end = close === -1 ? text.length : close;
		out += text.slice(i, start) + text.slice(start, end).replaceAll("[", HIDDEN);
		if (close === -1) return out;
		out += delim;
		i = close + delim.length;
	}
	return out + text.slice(i);
}

export function completeLinksOutsideMath(text: string): string {
	if (!text.includes("[")) return text;
	// The marker character already in the text would be turned into "[": fall back to plain completion.
	if (text.includes(HIDDEN)) return remend(text, LINKS_ONLY);
	return remend(hideMathBrackets(text), LINKS_ONLY).replaceAll(HIDDEN, "[");
}

/** Runs where remend's own link handler would (priority 20, before bold/italic). */
export const mathAwareLinks: RemendHandler = { name: "mathAwareLinks", handle: completeLinksOutsideMath, priority: 20 };
