import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { appendFilePaths, useFileDrop } from "../components/file-drop.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

/** A reload or chat switch keeps only the draft text: the attachment chips
 *  must come back from it instead of turning into raw quoted paths. */
test("attachment chips come back from a restored draft", async () => {
	const image = "/data/uploads/70454e0d-6758-4020-9823-61b065a96445/file/test.png";
	const doc = "/Users/me/notes/weird name 😀.txt";
	const folder = "/Users/me/notes/";
	const draft = appendFilePaths("hello", [image, doc, folder]);
	let files!: ReturnType<typeof useFileDrop>;
	function Field() {
		files = useFileDrop(draft, () => {}, { hideImagePaths: true });
		return null;
	}
	const host = document.createElement("div");
	const root = createRoot(host);
	await act(async () => root.render(<Field />));
	try {
		assert.deepEqual(files.previews.map(({ name, image, url }) => ({ name, image, url })), [
			{ name: "test.png", image: true, url: "/api/files/70454e0d-6758-4020-9823-61b065a96445?preview=1" },
			{ name: "weird name 😀.txt", image: false, url: doc },
		]);
		// The paths stay in the draft but out of the visible text; the folder stays text.
		assert.equal(files.text, `hello\n${JSON.stringify(folder)}`);
	} finally {
		await act(async () => root.unmount());
	}
});
