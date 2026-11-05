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
	assert.equal(hideMathBrackets("$p = \\$ [q$ then [r"), "$p = \\$ \uE000q$ then [r", "an escaped dollar doesn't close math either");
});
