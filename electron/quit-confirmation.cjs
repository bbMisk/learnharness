const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/** Device-local, separate from host learning settings. One outstanding dialog. */
function createQuitConfirmation(userData, showMessageBox, quit) {
	const file = path.join(userData, "window-preferences.json");
	let pending = null;
	function skipped() {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8")).skipQuitConfirmation === true;
		} catch {
			return false;
		}
	}
	return function confirmQuit(window) {
		if (pending) return pending;
		pending = (async () => {
			if (skipped()) {
				quit();
				return;
			}
			const result = await showMessageBox(window, {
				type: "question",
				message: "Quit LearnHarness?",
				buttons: ["Cancel", "Quit"],
				defaultId: 0,
				cancelId: 0,
				checkboxLabel: "Don't show this again",
				checkboxChecked: false,
				noLink: true,
			});
			if (result.response !== 1) return;
			if (result.checkboxChecked) {
				fs.mkdirSync(userData, { recursive: true });
				const temp = file + "." + randomUUID() + ".tmp";
				fs.writeFileSync(temp, JSON.stringify({ skipQuitConfirmation: true }), { mode: 0o600 });
				fs.renameSync(temp, file);
			}
			quit();
		})().finally(() => {
			pending = null;
		});
		return pending;
	};
}
module.exports = { createQuitConfirmation };
