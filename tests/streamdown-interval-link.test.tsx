/** Half-open intervals are not links (owner, LEC 3, 2026-11-05): remend's
 *  link completion read the `[` of $[n,\infty)$ as an unfinished link and
 *  appended "](streamdown:incomplete-link)" to finished messages. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import remend from "remend";
import { renderToStaticMarkup } from "react-dom/server";

const { MessageResponse, streamdownRemend } = await import("../components/ai-elements/message.tsx");
const remendLinks = await import("../components/ai-elements/remend-links.ts");

const lessonLines = [
	"It can also run off to infinity, the way the sets $[n,\\infty)$ share no point.\n\nAccept the plan or tell me what to change.",
	"$\\left(\\bigcup F_n\\right)^c = (-\\infty,0] \\cup [2,\\infty)$, which matches what you get by intersecting the sets $F_n^c = (-\\infty,\\tfrac1n) \\cup (2-\\tfrac1n,\\infty)$.\n\nThe next question is an example from p. 3.",
];

it("the app's repair options leave interval text untouched", () => {
	for (const text of lessonLines) {
		assert.match(remend(text, { htmlTags: false }), /streamdown:incomplete-link/, "the library default appends the marker (the bug)");
		assert.equal(remend(text, streamdownRemend), text);
	}
});

it("a rendered message with an interval shows no link marker", () => {
	for (const text of lessonLines) {
		const html = renderToStaticMarkup(<MessageResponse>{text}</MessageResponse>);
		assert.doesNotMatch(html, /incomplete-link/);
		assert.match(html, /next question|Accept the plan/);
	}
});

it("other streaming repairs still run (an unclosed bold closes)", () => {
	assert.equal(remend("a **bold", streamdownRemend), "a **bold**");
});

it("a link still streaming outside math keeps the hardened placeholder (hunt finding)", () => {
	const marker = "](streamdown:incomplete-link)";
	assert.ok(remend("see [source](https://example.com/pa", streamdownRemend).endsWith(marker), "unfinished URL: no clickable truncated link");
	assert.ok(remend("see [partial text", streamdownRemend).endsWith(marker));
	assert.ok(remend("an interval $[0,1)$ and then [a link](https://ex", streamdownRemend).endsWith(marker), "math earlier in the text doesn't hide a real link");
	const image = "text ![diagram](https://example.com/a.p";
	assert.equal(remend(image, streamdownRemend), remend(image, { htmlTags: false }), "an unfinished image is handled like the library default (dropped until complete)");
	assert.equal(remend("done: [a link](https://example.com).", streamdownRemend), "done: [a link](https://example.com).");
});

it("a price or a code span before a streaming link doesn't hide it (round-2 hunt finding)", () => {
	const marker = "](streamdown:incomplete-link)";
	for (const text of [
		"The cost is $5. See [source](https://example.com/pa",
		"Run `echo $HOME` and see [source](https://example.com/pa",
		"```sh\necho $PATH\n```\nThen [source](https://example.com/pa",
	]) {
		assert.ok(remend(text, streamdownRemend).endsWith(marker), text);
		const html = renderToStaticMarkup(<MessageResponse>{text}</MessageResponse>);
		assert.doesNotMatch(html, /href="https:\/\/example\.com\/pa"/, `no clickable truncated URL: ${text}`);
	}
	// Still streaming math keeps its interval: no link shape after the `[`.
	assert.equal(remend("so $[n,\\infty", streamdownRemend), "so $[n,\\infty");
	assert.equal(remendLinks.hideMathBrackets("`$x` [a]"), "`$x` [a]", "code spans open no math");
	// Round-5 hunt finding: an escaped or unmatched backtick is not a code span.
	for (const text of ["Type \\` for a backtick. The interval is $[0,1)$.", "a lone ` then $[0,1)$ here"]) {
		assert.doesNotMatch(remend(text, streamdownRemend), /incomplete-link/, text);
	}
	// Round-6 hunt findings: a price never pairs with math in a later paragraph,
	// and tilde (or backtick) fences hide their dollars, even while still open.
	assert.ok(remend("The cost is $5.\n\nSee [source](https://example.com/pa", streamdownRemend).endsWith(marker));
	assert.ok(remend("The cost is $5.\n\nSee [partial", streamdownRemend).endsWith(marker), "a price's `$` is literal once its paragraph ends");
	// Round-11 hunt finding: math never pairs across a code fence or with a `$` inside code.
	for (const text of [
		"```\necho $HOME\n```\nPrice $5. See [source](https://example.com/part",
		"~~~\necho $HOME\n~~~\nPrice $5. See [source](https://example.com/part",
		// Round-12 hunt finding: a heading, list item or quote starts a new block.
		"# Total $10\nPrice $5. See [source](https://example.com/part",
		"- item $10\n\nPrice $5. See [source](https://example.com/part",
		"> quoted $10\n\nPrice $5. See [source](https://example.com/part",
	]) {
		assert.match(remend(text, streamdownRemend), /\[source\]\(streamdown:incomplete-link\)/, text);
		assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{text}</MessageResponse>), /href="https:\/\/example\.com\/part"/, text);
	}
	// Where the renderer's own parser makes math of a span, a link inside it is plain math text:
	// nothing clickable either way (round-11 case with a code span after the price).
	assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{"Price $5. See [source](https://example.com/part `echo $HOME`"}</MessageResponse>), /href="https:\/\/example\.com\/part"/);
	// Round-13 hunt finding: backtick runs never pair across paragraphs.
	const paras = "A ``literal backtick.\n\nSee [source](https://example.com/pa then ``here`";
	assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{paras}</MessageResponse>), /href="https:\/\/example\.com\/pa"/);
	assert.match(remend(paras, streamdownRemend), /streamdown:incomplete-link/);
	// Only the final block can hold a link still streaming: an unmatched `[` in a finished
	// earlier paragraph is plain text and puts no marker at the end of the message, and a
	// malformed link there no longer swallows the rest of the message (the library default
	// replaces everything after it with the placeholder).
	const malformed = "See [source](https://example.com/part and more.\n\nNext paragraph with words.";
	assert.equal(remend(malformed, { htmlTags: false }), "See [source](streamdown:incomplete-link)", "library default drops the rest");
	assert.match(renderToStaticMarkup(<MessageResponse>{malformed}</MessageResponse>), /Next paragraph with words\./);
	assert.equal(remend("A stray [note here.\n\nThe interval is $[0,1)$.", streamdownRemend), "A stray [note here.\n\nThe interval is $[0,1)$.");
	// Round-14 hunt finding: table cells bound math, as in the renderer's GFM parse.
	const table = "| Cost | Source |\n| --- | --- |\n| $5 | [source](https://example.com/$10";
	assert.match(remend(table, streamdownRemend), /streamdown:incomplete-link/);
	assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{table}</MessageResponse>), /href="https:\/\/example\.com\/\$10"/);
	assert.equal(remend("| a | b |\n| --- | --- |\n| $[0,1)$ | $[2,3)$ |", streamdownRemend), "| a | b |\n| --- | --- |\n| $[0,1)$ | $[2,3)$ |");
	// Only the final region is parsed: blank lines inside fences and $$ display math don't start it.
	const { finalRegionStart } = remendLinks;
	assert.equal(finalRegionStart("a\n\nb"), 3);
	assert.equal(finalRegionStart("a\n\n```\nx\n\ny\n```\nz"), 3, "a blank line inside a fence is not a boundary");
	assert.equal(finalRegionStart("a\n\n$$\nx\n\ny\n$$\nz"), 3, "nor one inside display math");
	assert.equal(finalRegionStart("a\n\n```\nstill streaming\n\n"), 3, "an open fence keeps its blank lines");
	assert.equal(finalRegionStart("no blank line"), 0);
	// Round-17 hunt finding: an indented paragraph after a blank line continues its list item.
	const listed = "- outer\n  - inner\n\n    See [source](https://example.com/pa";
	assert.equal(finalRegionStart(listed), 0);
	assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{listed}</MessageResponse>), /href="https:\/\/example\.com\/pa"/);
	assert.match(remend(listed, streamdownRemend), /streamdown:incomplete-link/);
	assert.equal(finalRegionStart("- a\n\nNext paragraph"), 5, "a non-indented line after a blank starts the region");
	// Round-16 hunt finding: a fence nested in a list, indented 4 spaces, keeps its blank lines.
	const nested = "- Example:\n    ```text\n  first\n\n  [n, infinity)\n    ```";
	assert.equal(finalRegionStart(nested), 0);
	assert.doesNotMatch(remend(nested, streamdownRemend), /incomplete-link/);
	assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{nested}</MessageResponse>), /incomplete-link/);
	// Round-9 hunt finding: a code span closes only on a backtick run of its own length.
	const ticks = "A `` literal [source](https://example.com/pa ``` end";
	assert.match(remend(ticks, streamdownRemend), /streamdown:incomplete-link/);
	assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{ticks}</MessageResponse>), /href="https:\/\/example\.com\/pa"/);
	// Round-8 hunt finding: a single `$` never closes on half of a `$$`.
	const display = "Price $5. See [source](https://example.com/pa\n$$x$$";
	assert.match(remend(display, streamdownRemend), /\[source\]\(streamdown:incomplete-link\)/);
	assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{display}</MessageResponse>), /href="https:\/\/example\.com\/pa"/);
	assert.equal(remend("so $$\\bigcup [0,1)$$ and $[2,3)$ here", streamdownRemend), "so $$\\bigcup [0,1)$$ and $[2,3)$ here");
	const across = "The cost is $5.\n\nSee [source](https://example.com/pa\n\nThe equation is $x$.";
	// A malformed link in a finished middle paragraph: nothing after it is lost, and the
	// price never pairs with the later equation (the renderer's parser keeps them apart).
	const acrossHtml = renderToStaticMarkup(<MessageResponse>{across}</MessageResponse>);
	assert.match(acrossHtml, /The equation is/);
	assert.doesNotMatch(remend(across, streamdownRemend), /incomplete-link/);
	for (const text of [
		"~~~sh\necho $HOME\n~~~\n\nThe interval is $[0,1)$.",
		"```sh\necho $HOME\n```\n\nThe interval is $[0,1)$.",
		"Still streaming:\n~~~sh\necho $HOME [x\n",
	]) {
		assert.doesNotMatch(remend(text, streamdownRemend), /incomplete-link/, text);
	}
	// An escaped backtick before a real code span, and an unmatched double run, leave the interval alone.
	for (const text of ["Type \\` then $[0,1)$ and `x` here.", "a `` b $[0,1)$ and `c` d"]) {
		assert.equal(remend(text, streamdownRemend), text, text);
	}
	// Round-4 hunt finding: a price before an unfinished image keeps the library's image handling.
	const image = "Price $5 ![diagram";
	assert.equal(remend(image, streamdownRemend), remend(image, { htmlTags: false }));
});

it("brackets inside math never count as links, closed or still streaming", () => {
	const keep = [
		"$$\\bigcap_n [0, \\tfrac1n] \\cup [2,\\infty)$$ is the set.",
		"half-open $[a,b)$, and $x\\in[0,1)$",
		"streaming math $[n,\\infty",
		"costs \\$5 and $[0,1)$ here",
	];
	for (const text of keep) assert.equal(remend(text, streamdownRemend), text, text);
	const { hideMathBrackets } = remendLinks;
	assert.equal(hideMathBrackets("a [x] $[y)$ b"), "a [x] $\uE000y)$ b");
	assert.equal(hideMathBrackets("\\$[x] $[y"), "\\$[x] $\uE000y", "an escaped dollar opens no math");
	// Inside math a backslash escapes nothing (the renderer's parser): `\$` closes it.
	assert.equal(hideMathBrackets("$p = \\$ [q$ then [r](x"), "$p = \\$ [q$ then [r](x");
});
