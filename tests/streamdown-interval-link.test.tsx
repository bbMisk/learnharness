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
