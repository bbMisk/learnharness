import assert from 'node:assert/strict';
import {test} from 'node:test';
import {statementMathIssue} from '../src/agent/subagents/extraction-math.ts';

for(const source of [
 'Update w_j.',
 'The objective is J(w)=||Xw−y||²/(2N).',
 'The variance is σ²/n.',
 'Set x = y.',
 'The probability is 1/4.',
 String.raw`The gradient is \nabla f.`,
 String.raw`The answer is $\frac{1}{$.`,
 'Recall $x_1.',
]) test(`rejects math that would display incorrectly: ${source}`,()=>assert.ok(statementMathIssue(source)));
for(const source of [
 String.raw`Update $w_j$ using $J(w)=\frac{\lVert Xw-y\rVert^2}{2N}$.`,
 String.raw`Legacy \(x_1\) and \[\begin{aligned}a&=b\\ c&=d\end{aligned}\].`,
 'A derivative measures a local rate of change.',
 'The event happened on 10/28/2026 and the path was /usr/bin.',
 'The code `x_i = values[1/4]` is literal.\n```python\nx_j = 1/4\n```',
 String.raw`The cost is $\$5$ and the discount is $1/4$.`,
 String.raw`The gradient is $\\nabla f$.`,
]) test(`accepts correctly displayed content without rewriting it: ${source}`,()=>assert.equal(statementMathIssue(source),null));

test('keeps legitimate matrix row breaks before letter-valued cells',()=>{
 assert.equal(statementMathIssue(String.raw`The matrix is $\begin{pmatrix}a&b\\x&y\end{pmatrix}$.`),null);
});
test('code escapes cannot consume a code span closer',()=>{
 assert.equal(statementMathIssue('A path example: `C:\\`.'),null);
});
