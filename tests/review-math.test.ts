import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { renderReviewText } from "../web/review/math.ts";

function rendered(text: string) {
 const { document, Node } = parseHTML('<html><body><div id="card"></div></body></html>');
 const previous = { document: globalThis.document, Node: globalThis.Node };
 Object.assign(globalThis, { document, Node });
 try {
  const card = document.getElementById('card')!;
  renderReviewText(card, text);
  return { annotations: [...card.querySelectorAll('annotation[encoding="application/x-tex"]')].map(n => n.textContent?.trim()), errors: card.querySelectorAll('.katex-error').length, card };
 } finally { Object.assign(globalThis, previous); }
}

test('flashcard solutions render subscripts and the least-squares norm fraction', () => {
 const formula = String.raw`J(w)=\frac{\lVert Xw-y\rVert^2}{2N}`;
 const result = rendered(`Update $w_j$. The objective is $${formula}$.`);
 assert.deepEqual(result.annotations, ['w_j', formula]);
 assert.equal(result.errors, 0);
 assert.ok(result.card.querySelector('.mfrac'), 'a real fraction, not a slash in plain prose');
});

test('flashcards share the existing display-only repair of double-escaped commands', () => {
 const result = rendered(String.raw`The gradient is $\\nabla J(w)$, with $\frac{1}{N}$.`);
 assert.deepEqual(result.annotations, [String.raw`\nabla J(w)`, String.raw`\frac{1}{N}`]);
 assert.ok(result.card.querySelector('.katex-html')!.textContent?.includes('∇'));
 assert.equal(result.errors, 0);
});

test('flashcard display math preserves aligned rows and keeps untrusted text inert', () => {
 const formula=String.raw`\begin{aligned}a&=b\\ c&=d\end{aligned}`;
 const result=rendered(`<img src=x onerror=alert(1)>\n\\[\n${formula}\n\\]`);
 assert.deepEqual(result.annotations,[formula]);
 assert.ok(result.card.querySelector('.katex-display'));
 assert.equal(result.card.querySelectorAll('img,script').length,0);
 assert.equal(result.errors,0);
});
