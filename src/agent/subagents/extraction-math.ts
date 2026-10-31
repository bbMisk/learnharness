import katex from "katex";
import { repairMathForDisplay } from "../../core/math-delims.ts";

// Reject clear notation, not ambiguous ordinary words. The generator supplies
// the actual LaTeX; this check never guesses or rewrites a mathematical claim.
const BARE_MATH = new RegExp(
	[
		String.raw`\\[A-Za-z]+`, // Commands without delimiters.
		String.raw`\b[A-Za-z][A-Za-z0-9]*[_^][{(A-Za-z0-9−-]`, // Scripts.
		String.raw`[∑∫∏∇∂√≤≥≠∈⊆∩∪→∀∃¬∧∨²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]`,
		String.raw`(?<![\p{L}])[\p{Script=Greek}](?![\p{L}])`,
		String.raw`(?<![\w/])\d+\s*\/\s*\d+(?![\w/])`, // Fractions, excluding paths/dates.
		String.raw`\b[A-Za-z]\w*(?:\([^\n.]*?\))?\s*(?:=|[<>]=?)\s*[A-Za-z0-9({−-]`,
		String.raw`\|\|[^\n]+?\|\|`,
	].join("|"),
	"u",
);

function escaped(text: string, at: number) {
	let count = 0;
	for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) count++;
	return count % 2 === 1;
}

function closing(text: string, marker: string, from: number, exactRun = false) {
	for (let at = text.indexOf(marker, from); at !== -1; at = text.indexOf(marker, at + marker.length)) {
		if (marker[0] !== "`" && marker[0] !== "~" && escaped(text, at)) continue;
		if (exactRun && (text[at - 1] === marker[0] || text[at + marker.length] === marker[0])) continue;
		return at;
	}
	return -1;
}

/** Validation only. The existing submit-agent error channel asks the model to
 * correct and re-submit before any graph write or coverage checkpoint. */
export function statementMathIssue(statement: string): string | null {
	const text = repairMathForDisplay(statement);
	let prose = "",
		from = 0;
	for (let i = 0; i < text.length; ) {
		// Code owns its underscores, equations and dollar signs.
		const code = /^(`+|~{3,})/.exec(text.slice(i));
		if (code && (text[i] === "`" || i === 0 || text[i - 1] === "\n")) {
			const marker = code[1]!;
			const end = closing(text, marker, i + marker.length, true);
			if (end === -1) return "Close the code span/fence in the statement.";
			prose += text.slice(from, i) + " ";
			i = end + marker.length;
			from = i;
			continue;
		}
		if (escaped(text, i)) {
			i++;
			continue;
		}
		let open = "",
			close = "",
			display = false;
		if (text.startsWith("$$", i)) {
			open = close = "$$";
			display = true;
		} else if (text[i] === "$") open = close = "$";
		else if (text.startsWith("\\(", i)) {
			open = "\\(";
			close = "\\)";
		} else if (text.startsWith("\\[", i)) {
			open = "\\[";
			close = "\\]";
			display = true;
		}
		if (!open) {
			i++;
			continue;
		}
		const end = closing(text, close, i + open.length, open[0] === "$");
		if (end === -1) return `Close the math delimiter ${JSON.stringify(open)} in the statement.`;
		const formula = text.slice(i + open.length, end);
		if (!formula.trim()) return "Math delimiters must contain an expression.";
		try {
			katex.renderToString(formula, { displayMode: display, throwOnError: true, trust: false, strict: "error", maxExpand: 1000 });
		} catch (error) {
			const detail = error instanceof Error ? error.message.slice(0, 180) : String(error);
			return `Invalid LaTeX ${JSON.stringify(formula.slice(0, 100))}: ${detail}. Correct the notation without changing the claim.`;
		}
		prose += text.slice(from, i) + " ";
		i = end + close.length;
		from = i;
	}
	prose += text.slice(from);
	const bare = BARE_MATH.exec(prose);
	return bare
		? `Math notation ${JSON.stringify(bare[0])} is outside LaTeX delimiters. Use $...$ for variables/equations and proper commands such as \\frac{...}{...}, or put literal code in backticks. Keep the claim unchanged and re-submit the findings.`
		: null;
}

export function findingsMathIssue(value: { propositions: ReadonlyArray<{ id: string; statement: string }> }): string | null {
	for (const proposition of value.propositions) {
		const issue = statementMathIssue(proposition.statement);
		if (issue) return `propositions: ${JSON.stringify(proposition.id)}: ${issue}`;
	}
	return null;
}
