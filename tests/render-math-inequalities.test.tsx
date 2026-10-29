import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MessageResponse } from "../components/ai-elements/message.tsx";

const equation = String.raw`\begin{aligned}
P(r<R<r+dr)
&\approx \frac{1}{2\pi\sigma^2}e^{-r^2/(2\sigma^2)}\cdot 2\pi r\,dr\\
&=\frac{r}{\sigma^2}e^{-r^2/(2\sigma^2)}\,dr.
\end{aligned}`;
const markdown = `Before the equation.\n\n$$\n${equation}\n$$\n\nThe remaining factor reflects ring area.`;

for (const mode of ["static", "streaming"] as const) {
	test(`${mode}: complete probability inequalities render as math without swallowing subsequent prose`, () => {
		const html = renderToStaticMarkup(<MessageResponse mode={mode}>{markdown}</MessageResponse>);
		const { document } = parseHTML(html);
		assert.equal(document.querySelector("annotation")?.textContent?.trim(), equation);
		assert.ok(document.querySelector(".katex-display"), "the full expression is display math");
		assert.equal(document.querySelectorAll(".katex-error").length, 0);
		assert.ok(document.documentElement.textContent?.includes("The remaining factor reflects ring area."));
	});
}


test("streaming preserves inline inequalities and repairs unfinished emphasis", () => {
	const { document } = parseHTML(renderToStaticMarkup(
		<MessageResponse>{"For $R<r$, **keep teaching"}</MessageResponse>,
	));
	assert.equal(document.querySelector("annotation")?.textContent, "R<r");
	assert.equal(document.querySelector("strong")?.textContent, "keep teaching");
});

test("HTML sanitization remains active alongside probability math", () => {
	const input = markdown + '\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script>';
	const { document } = parseHTML(renderToStaticMarkup(<MessageResponse>{input}</MessageResponse>));
	assert.equal(document.querySelector("annotation")?.textContent?.trim(), equation);
	assert.equal(document.querySelectorAll("script, [onerror]").length, 0);
});
