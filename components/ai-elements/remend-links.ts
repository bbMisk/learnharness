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

/** Length of the run of `$` starting at `i`. */
function dollarRun(text: string, i: number): number {
	let n = 0;
	while (text[i + n] === "$") n++;
	return n;
}

/** The next run of exactly `size` `ch` characters at or after `from` (a
 *  code span closes only on a backtick run of its own length; round-9 hunt
 *  finding). -1 if none. */
function nextRun(text: string, ch: string, size: number, from: number): number {
	for (let i = text.indexOf(ch, from); i !== -1; ) {
		let run = 0;
		while (text[i + run] === ch) run++;
		if (run === size) return i;
		i = text.indexOf(ch, i + run);
	}
	return -1;
}

/** The next unescaped run of exactly `size` dollars at or after `from`, as
 *  the Markdown math parser pairs them (like code-span backticks): a `$`
 *  never closes on half of a `$$` (round-8 hunt finding). -1 if none. */
function nextDelimiter(text: string, size: number, from: number): number {
	for (let i = text.indexOf("$", from); i !== -1; ) {
		const run = dollarRun(text, i);
		if (run === size && !escaped(text, i)) return i;
		i = text.indexOf("$", i + run);
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

/** A fenced code block opening at line start `i` (up to 3 spaces, then 3+
 *  backticks or tildes): the index just past its closing fence line, or the
 *  end of the text while the fence is still open (streaming). -1 if none. */
function fenceEnd(text: string, i: number): number {
	const open = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i, i + 64));
	if (!open) return -1;
	const fence = open[1]!;
	const closing = new RegExp(`\\n {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*(?=\\n|$)`, "g");
	closing.lastIndex = i + open[0].length;
	const close = closing.exec(text);
	return close ? close.index + close[0].length : text.length;
}

/** The end of the paragraph containing `from` (a blank line), or -1 if it
 *  runs to the end of the text. */
function paragraphEnd(text: string, from: number): number {
	const blank = /\n[ \t]*\n/g;
	blank.lastIndex = from;
	return blank.exec(text)?.index ?? -1;
}

/** `[` inside $…$ and $$…$$ → HIDDEN, following Markdown's boundaries
 *  (hunt findings, rounds 2–6): code spans and fenced code (``` or ~~~,
 *  even while still streaming) open no math, and their brackets are hidden
 *  too (no link exists inside code); inline $…$ must close within
 *  its paragraph, else that `$` is literal (a price), except in the last
 *  paragraph, where it may be math still streaming. */
export function hideMathBrackets(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if ((ch === "`" || ch === "~" || ch === " ") && (i === 0 || text[i - 1] === "\n")) {
			const end = fenceEnd(text, i);
			if (end !== -1) {
				// No link exists inside code; remend doesn't know ~~~ fences (round-6 hunt finding).
				out += text.slice(i, end).replaceAll("[", HIDDEN);
				i = end;
				continue;
			}
		}
		if (ch === "`" && !escaped(text, i)) {
			let run = 1;
			while (text[i + run] === "`") run++;
			const close = nextRun(text, "`", run, i + run);
			// An unmatched run is literal backticks in Markdown, not a code span
			// (round-5 hunt finding: an escaped or lone backtick hid later math).
			const end = close === -1 ? i + run : close + run;
			out += text.slice(i, end).replaceAll("[", HIDDEN);
			i = end;
			continue;
		}
		if (ch === "$" && !escaped(text, i)) {
			const size = dollarRun(text, i);
			if (size > 2) {
				out += text.slice(i, i + size);
				i += size;
				continue;
			}
			const delim = "$".repeat(size);
			const start = i + size;
			let close = nextDelimiter(text, size, start);
			const para = size === 1 ? paragraphEnd(text, start) : -1;
			if (para !== -1 && close > para) close = -1;
			if (close === -1) {
				// Last paragraph: math may still be streaming. Earlier: a literal `$`.
				if (para === -1) return out + text.slice(i, start) + hideUnclosed(text.slice(start));
				out += text.slice(i, start);
				i = start;
				continue;
			}
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
