/** The display transforms remember results by input text; a cached answer
 *  must always equal a fresh computation, including after eviction. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { repairMathForDisplay, transformMathDelimiters } from "../src/core/math-delims.ts";

const samples = [
	"plain prose",
	"inline \\(x^2\\) and display \\[\\int_0^1 f\\]",
	"$a \\\\alpha + b$ with \\\\beta outside",
	"```\n\\(not math in code\\)\n```\nthen \\(y\\)",
	"price is \\$5 and $x\\$y$",
	"> quoted \\(z\\)\n\n- list $\\frac12$",
	// Same long prefix, different endings: a cache keyed on part of the text would collide.
	"shared prefix shared prefix \\(a\\)",
	"shared prefix shared prefix \\[b\\]",
	"shared prefix shared prefix \\\\gamma",
];

let fresh = 0;
async function uncached() {
	return (await import(`../src/core/math-delims.ts?fresh=${++fresh}`)) as typeof import("../src/core/math-delims.ts");
}

it("cached results equal fresh results, on repeat and after eviction", async () => {
	const inputs = [...samples, ...Array.from({ length: 2100 }, (_, i) => `n${i}: \\(x_${i}\\) $y_${i}$`), ...samples];
	for (const text of inputs) {
		const reference = await uncached();
		assert.equal(transformMathDelimiters(text), reference.transformMathDelimiters(text), text);
		assert.equal(repairMathForDisplay(text), reference.repairMathForDisplay(text), text);
	}
});
