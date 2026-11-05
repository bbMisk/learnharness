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

/** In math that hasn't closed yet (still streaming, or a lone `$` like a
 *  price), hide every `[` except one that starts a link (`[text](`): that
 *  shape is a link, and a link still streaming must keep remend's hardened
 *  placeholder (round-2 hunt finding: "$5. See [source](https://ex…"), nor
 *  the `[` of an image (`![`), which remend drops until it completes
 *  (round-4 hunt finding). */
function hideUnclosed(tail: string): string {
	return tail.replace(/(?<!!)\[(?![^\]\n]*\]\()/g, HIDDEN);
}

/** `[` inside $…$ and $$…$$ → HIDDEN. Code spans and fences are copied
 *  through untouched (a `$HOME` in code opens no math). */
export function hideMathBrackets(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === "`" && !escaped(text, i)) {
			let run = 1;
			while (text[i + run] === "`") run++;
			const close = text.indexOf("`".repeat(run), i + run);
			// An unmatched run is literal backticks in Markdown, not a code span
			// (round-5 hunt finding: an escaped or lone backtick hid later math).
			const end = close === -1 ? i + run : close + run;
			out += text.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "$" && !escaped(text, i)) {
			const delim = text[i + 1] === "$" ? "$$" : "$";
			const start = i + delim.length;
			const close = nextDelimiter(text, delim, start);
			if (close === -1) return out + text.slice(i, start) + hideUnclosed(text.slice(start));
			out += text.slice(i, start) + text.slice(start, close).replaceAll("[", HIDDEN) + delim;
			i = close + delim.length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

export function completeLinksOutsideMath(text: string): string {
	if (!text.includes("[")) return text;
	// The marker character already in the text would be turned into "[": fall back to plain completion.
	if (text.includes(HIDDEN)) return remend(text, LINKS_ONLY);
	return remend(hideMathBrackets(text), LINKS_ONLY).replaceAll(HIDDEN, "[");
}

/** Runs where remend's own link handler would (priority 20, before bold/italic). */
export const mathAwareLinks: RemendHandler = { name: "mathAwareLinks", handle: completeLinksOutsideMath, priority: 20 };
