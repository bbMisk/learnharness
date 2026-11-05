/** A finished message is rendered as written (owner, LEC 3, 2026-11-05): the
 *  unfinished-Markdown repair read the `[` of a half-open interval like
 *  $[n,\infty)$ as an unfinished link and appended "](streamdown:incomplete-link)".
 *  The repair now runs only while text streams. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse, ToolContentResponse } from "../components/ai-elements/message.tsx";
import { Reasoning, ReasoningContent } from "../components/ai-elements/reasoning.tsx";

const lesson = "It can also run off to infinity, the way the sets $[n,\\infty)$ share no point.\n\nAccept the plan or tell me what to change.";

it("finished prose, questions and thinking keep an interval as written", () => {
	for (const html of [
		renderToStaticMarkup(<MessageResponse>{lesson}</MessageResponse>),
		renderToStaticMarkup(<ToolContentResponse>{lesson}</ToolContentResponse>),
		renderToStaticMarkup(<Reasoning open><ReasoningContent>{lesson}</ReasoningContent></Reasoning>),
	]) {
		assert.doesNotMatch(html, /incomplete-link|\[blocked\]/);
		assert.match(html, /Accept the plan/);
	}
});

it("text still streaming keeps the library's repairs", () => {
	assert.match(renderToStaticMarkup(<MessageResponse streaming>{"a **bold"}</MessageResponse>), /<strong[^>]*>bold<\/strong>/);
	assert.doesNotMatch(renderToStaticMarkup(<MessageResponse>{"a **bold"}</MessageResponse>), /<strong/);
});
