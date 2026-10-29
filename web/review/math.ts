import { repairMathForDisplay } from "../../src/core/math-delims.ts";
import renderMath from "katex/contrib/auto-render";

export function renderReviewText(element: HTMLElement, text: string) {
 element.textContent = repairMathForDisplay(text);
 renderMath(element, { throwOnError: false, trust: false, strict: "ignore", delimiters: [{ left: "$$", right: "$$", display: true }, { left: "\\[", right: "\\]", display: true }, { left: "\\(", right: "\\)", display: false }, { left: "$", right: "$", display: false }] });
}
