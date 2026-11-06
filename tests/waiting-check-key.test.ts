/** Enter/Space open the waiting check only when focus is on nothing that uses the key
 *  (Space on a focused <summary> used to open the check). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { opensWaitingCheck } from "../components/waiting-check-key.ts";

const { document } = parseHTML(`<html><body>
	<div id="plain">text</div>
	<details><summary id="summary">PDF result</summary>body</details>
	<select id="select"><option>a</option></select>
	<a id="link" href="#x">link</a>
	<button id="button"><span id="inside-button">go</span></button>
	<div id="aria" role="switch">toggle</div>
	<input id="text" /><input id="range" type="range" />
	<textarea id="area"></textarea>
	<div id="editable" contenteditable="true">x</div>
</body></html>`);
const el = (id: string) => document.getElementById(id) as unknown as Element;
const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: k, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...mods });

test("plain Enter or Space on nothing interactive opens the check", () => {
	for (const k of ["Enter", " "]) {
		assert.equal(opensWaitingCheck(key(k), el("plain")), true, JSON.stringify(k));
		assert.equal(opensWaitingCheck(key(k), null), true);
		assert.equal(opensWaitingCheck(key(k), el("range")), true, "a range slider has no Enter/Space action");
	}
});

test("focused controls and typing surfaces keep their own Enter/Space", () => {
	for (const id of ["summary", "select", "link", "button", "inside-button", "aria", "text", "area"]) {
		for (const k of ["Enter", " "]) assert.equal(opensWaitingCheck(key(k), el(id)), false, `${id} ${JSON.stringify(k)}`);
	}
});

test("modifiers: Shift+Space scrolls, Shift+Enter is left alone, Alt never opens", () => {
	assert.equal(opensWaitingCheck(key(" ", { shiftKey: true }), el("plain")), false);
	assert.equal(opensWaitingCheck(key(" ", { metaKey: true }), el("plain")), false);
	assert.equal(opensWaitingCheck(key("Enter", { shiftKey: true }), el("plain")), false);
	assert.equal(opensWaitingCheck(key("Enter", { altKey: true }), el("plain")), false);
	assert.equal(opensWaitingCheck(key("Enter", { metaKey: true }), el("plain")), true, "Cmd+Enter still opens, as before");
	assert.equal(opensWaitingCheck(key("a"), el("plain")), false);
});
