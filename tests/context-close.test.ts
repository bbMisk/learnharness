import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { it } from "node:test";
import { actionForBinding, eventBinding } from "../src/core/keyboard.ts";
const { createQuitConfirmation } = createRequire(import.meta.url)("../electron/quit-confirmation.cjs");

it("recognizes the tutor shortcut", () => {
	assert.equal(actionForBinding(eventBinding({key:"S",code:"KeyS",metaKey:true,ctrlKey:false,altKey:false,shiftKey:true} as KeyboardEvent)), "toggle-side-tutor");
});
it("Cancel keeps the app and preference unchanged; remembered confirmation survives restart", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-quit-"));
	try {
		let quit = 0, dialogs = 0;
		let answer = { response: 0, checkboxChecked: true };
		const confirm = createQuitConfirmation(root, async (_window:unknown, options:{checkboxLabel:string;cancelId:number}) => { dialogs++; assert.match(options.checkboxLabel, /Don't show/); assert.equal(options.cancelId, 0); return answer; }, () => { quit++; });
		await confirm(null);
		assert.equal(quit, 0); assert.equal(fs.existsSync(path.join(root, "window-preferences.json")), false);
		answer = { response: 1, checkboxChecked: false };
		await confirm(null); assert.equal(quit, 1);
		await confirm(null); assert.equal(dialogs, 3, "without the checkbox the dialog remains enabled");
		answer = { response: 1, checkboxChecked: true };
		await confirm(null); assert.equal(dialogs, 4);
		const reopened = createQuitConfirmation(root, () => { throw new Error("Must not prompt again"); }, () => { quit++; });
		await reopened(null); assert.equal(quit, 4);
		assert.equal(fs.statSync(path.join(root, "window-preferences.json")).mode & 0o777, 0o600);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it("repeated close requests share one pending confirmation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-quit-pending-"));
	try {
		let dialogs = 0, resolve!: (value:unknown) => void;
		const confirm = createQuitConfirmation(root, () => { dialogs++; return new Promise(r => { resolve = r; }); }, () => { throw new Error("Cancel must not quit"); });
		const first = confirm(null), second = confirm(null);
		assert.equal(first, second); assert.equal(dialogs, 1);
		resolve({ response: 0, checkboxChecked: false }); await first;
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
