import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";

describe("Thinking while reading preference", () => {
	it("defaults off for first boot and existing settings records", () => {
		for (const record of [null, { version: 1 }, { version: 1, general: { autoUpdate: false } }]) {
			assert.equal(resolveSettings(record).general.showReadingThinking, false);
		}
	});

	it("keeps explicit on/off choices through validation and storage sanitization", () => {
		for (const showReadingThinking of [true, false]) {
			const general = { autoUpdate: false, showReadingThinking };
			const parsed = parseGeneralSettingsBody(general);
			assert.ok(parsed.ok);
			assert.deepEqual(parsed.settings, general);
			const stored = sanitizeUserSettings(JSON.parse(JSON.stringify({ version: 1, general: parsed.settings })));
			assert.deepEqual(stored?.general, general);
			assert.equal(resolveSettings(stored).general.showReadingThinking, showReadingThinking);
		}
	});

	it("rejects invalid writes and safely defaults off for malformed stored values", () => {
		for (const showReadingThinking of ["true", 1, null, {}, []]) {
			assert.equal(parseGeneralSettingsBody({ showReadingThinking }).ok, false);
			const stored = sanitizeUserSettings({ version: 1, general: { autoUpdate: false, showReadingThinking } });
			assert.deepEqual(stored?.general, { autoUpdate: false });
			assert.equal(resolveSettings(stored).general.showReadingThinking, false);
		}
	});
});
