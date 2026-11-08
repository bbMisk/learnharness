/**
 * The markdown render caches change speed only: KaTeX output memoized per
 * math element (components/katex-cache.ts), finished blocks' parsed output
 * reused (components/cached-block.tsx), the span override hook-free and the
 * code highlighter loaded on first use. base-html.json is the markup the
 * pre-cache renderer produced for samples.json; every render must match it
 * byte for byte, cold and warm.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, type ExtraProps } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { code as eagerCode } from "@streamdown/code";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { Reasoning, ReasoningContent } from "../components/ai-elements/reasoning.tsx";
import { CachedBlock } from "../components/cached-block.tsx";
import { memoizeRehypeKatex } from "../components/katex-cache.ts";
import { MarkdownSpan } from "../components/md-blocks.tsx";
import { code as lazyCode } from "../components/code-highlighter.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/markdown-parity/${name}`, import.meta.url), "utf8")) as Record<string, string>;
const samples = fixture("samples.json");
const baseHtml = fixture("base-html.json");

const variants = {
	finished: (md: string) => <MessageResponse>{md}</MessageResponse>,
	streaming: (md: string) => <MessageResponse streaming>{md}</MessageResponse>,
	static: (md: string) => <MessageResponse mode="static">{md}</MessageResponse>,
	reasoning: (md: string) => <Reasoning open><ReasoningContent>{md}</ReasoningContent></Reasoning>,
};

describe("render parity with the pre-cache renderer", () => {
	it("prose, math, tables, code, callouts and KaTeX errors render identically, cold and warm", () => {
		for (const pass of ["cold", "warm"]) {
			for (const [name, md] of Object.entries(samples)) {
				for (const [variant, render] of Object.entries(variants)) {
					assert.equal(renderToStaticMarkup(render(md)), baseHtml[`${name}:${variant}`], `${name}:${variant} (${pass})`);
				}
			}
		}
	});

	it("the span override is a plain function for ordinary spans", () => {
		// A hook called outside a render would throw.
		assert.equal(renderToStaticMarkup(<>{MarkdownSpan({ className: "mord", children: "x" })}</>), '<span class="mord">x</span>');
	});
});

type Hast = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: Hast[]; value?: string };
type Transform = (tree: Hast, file: unknown) => void;

describe("KaTeX memo", () => {
	const [rehypeKatex, options] = createMathPlugin({ singleDollarTextMath: true }).rehypePlugin as [(o?: object) => Transform, object];
	const text = (value: string): Hast => ({ type: "text", value });
	const inline = (tex: string): Hast => ({ type: "element", tagName: "code", properties: { className: ["language-math", "math-inline"] }, children: [text(tex)] });
	const display = (tex: string): Hast => ({
		type: "element", tagName: "pre", properties: {},
		children: [{ type: "element", tagName: "code", properties: { className: ["language-math", "math-display"] }, children: [text(tex)] }],
	});
	const p = (...children: Hast[]): Hast => ({ type: "element", tagName: "p", properties: {}, children });
	const file = () => {
		const messages: { reason: string; ruleId?: string }[] = [];
		return { messages, message: (reason: string, o: { ruleId?: string }) => messages.push({ reason, ruleId: o.ruleId }) };
	};
	const setup = () => {
		let renders = 0;
		const counted = (o?: object): Transform => {
			const transform = rehypeKatex(o);
			return (tree, f) => {
				renders++;
				transform(tree, f);
			};
		};
		return { memo: memoizeRehypeKatex(counted as never)(options) as unknown as Transform, renders: () => renders };
	};
	const plain = (tree: Hast) => {
		const f = file();
		rehypeKatex(options)(tree, f);
		return { tree, messages: f.messages };
	};

	it("renders each distinct element once and keeps inline and display apart", () => {
		const { memo, renders } = setup();
		const lesson = () => ({ type: "root", children: [p(inline("x^2"), text(" and "), inline("x^2")), display("x^2"), p(inline("\\frac{1}{"))] });
		const expected = plain(lesson());
		for (const pass of [1, 2]) {
			const tree = lesson();
			const f = file();
			memo(tree, f);
			assert.deepEqual(tree, expected.tree, `pass ${pass}`);
		}
		assert.equal(renders(), 3, "inline x^2, display x^2 and the error, once each");
	});

	it("hands out copies, so changing a rendered tree never reaches the memo", () => {
		const { memo } = setup();
		const first: Hast = { type: "root", children: [p(inline("y"))] };
		memo(first, file());
		first.children![0]!.children![0]!.properties!.className = ["changed"];
		const second: Hast = { type: "root", children: [p(inline("y"))] };
		memo(second, file());
		assert.deepEqual(second, plain({ type: "root", children: [p(inline("y"))] }).tree);
	});

	it("leaves unusual math shapes to rehype-katex unchanged", () => {
		const { memo, renders } = setup();
		const odd = (): Hast => ({
			type: "root",
			children: [p({ type: "element", tagName: "code", properties: { className: ["language-math"] }, children: [text("a"), { type: "element", tagName: "b", properties: {}, children: [text("c")] }] }), p(inline("z"))],
		});
		const tree = odd();
		memo(tree, file());
		assert.deepEqual(tree, plain(odd()).tree);
		assert.equal(renders(), 1, "one whole-tree pass");
	});
});

describe("finished block cache", () => {
	let parses = 0;
	const countParses = () => () => {
		parses++;
	};
	const render = (md: string, extra: Partial<React.ComponentProps<typeof Streamdown>> = {}) =>
		renderToStaticMarkup(<Streamdown BlockComponent={CachedBlock} remarkPlugins={[countParses]} parseIncompleteMarkdown={false} {...extra}>{md}</Streamdown>);

	it("parses a finished block once, then reuses it", () => {
		parses = 0;
		const first = render("Alpha one.\n\nBeta two.");
		const cold = parses;
		assert.ok(cold >= 2, "one parse per block");
		assert.equal(render("Alpha one.\n\nBeta two."), first);
		assert.equal(parses, cold, "no parse on the second render");
	});

	it("keys on configuration as well as source", () => {
		const P1 = ({ children }: React.ComponentProps<"p"> & ExtraProps) => <p data-p="1">{children}</p>;
		const P2 = ({ children }: React.ComponentProps<"p"> & ExtraProps) => <p data-p="2">{children}</p>;
		assert.match(render("Gamma.", { components: { p: P1 } }), /data-p="1"/);
		assert.match(render("Gamma.", { components: { p: P2 } }), /data-p="2"/);
	});

	it("never caches streaming blocks", () => {
		parses = 0;
		render("Delta.", { parseIncompleteMarkdown: true });
		render("Delta.", { parseIncompleteMarkdown: true });
		assert.equal(parses, 2);
	});
});

describe("lazy code highlighter", () => {
	it("keeps the plugin's themes and highlights through the callback once loaded", async () => {
		assert.deepEqual(lazyCode.getThemes(), eagerCode.getThemes());
		assert.equal(lazyCode.getThemes(), lazyCode.getThemes());
		const options = { code: "const answer = 42;", language: "ts" as const, themes: eagerCode.getThemes() };
		const tokens = await new Promise((resolve) => {
			assert.equal(lazyCode.highlight(options, resolve), null, "nothing until the module loads");
		});
		const expected = await new Promise((resolve) => {
			const now = eagerCode.highlight(options, resolve);
			if (now) resolve(now);
		});
		assert.deepEqual(tokens, expected);
		assert.deepEqual(lazyCode.highlight(options), expected, "loaded: answers synchronously from the plugin's cache");
		assert.equal(lazyCode.supportsLanguage("python" as never), eagerCode.supportsLanguage("python" as never));
		assert.deepEqual(lazyCode.getSupportedLanguages(), eagerCode.getSupportedLanguages());
	});
});
