/** Optional per-model tutor instructions (core/model-instructions.ts). */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

// The data-dir seam, before any config-loading import (this file owns it).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-model-instructions-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const { modelInstructionsFor, suggestedModelInstructions } = await import("../src/core/model-instructions.ts");
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { PUT: putSettingsSection } = await import("../app/api/settings/[section]/route.ts");
const { readSettingsRecord } = await import("../src/server/index.ts");
const { sideChatResponse } = await import("../src/server/side-chat.ts");

const opus = { provider: "claude-code", id: "opus" };

describe("model instructions", () => {
	it("add a prompt section only for the exact model that has saved text", () => {
		const map = { "claude-code:opus": "Slow down." };
		assert.equal(modelInstructionsFor(map, opus), "User instructions for this model:\nSlow down.");
		assert.equal(modelInstructionsFor(map, { provider: "anthropic", id: "opus" }), "");
		assert.equal(modelInstructionsFor({ "claude-code:opus": "  " }, opus), "");
		assert.equal(modelInstructionsFor(undefined, opus), "");
		assert.equal(modelInstructionsFor(map, null), "");
	});

	it("are off by default: nothing is stored or applied until the learner saves text", () => {
		assert.deepEqual(resolveSettings(null).agent.modelInstructions, {});
		assert.match(suggestedModelInstructions("opus") ?? "", /^Slow down\./);
		assert.match(suggestedModelInstructions("gpt-6.1-terra") ?? "", /^Don't over-split\./);
		assert.equal(suggestedModelInstructions("gpt-6.1-sol"), undefined);
	});

	it("validate on write, drop empty text, and stay lenient on read", () => {
		const ok = parseAgentSettingsBody({ modelInstructions: { "claude-code:opus": "Slow down.", "chatgpt:gpt-6.1-terra": "" } });
		assert.ok(ok.ok);
		assert.deepEqual(ok.settings.modelInstructions, { "claude-code:opus": "Slow down." });
		for (const modelInstructions of [[], "text", { a: 1 }, { a: "x".repeat(8001) }]) {
			assert.equal(parseAgentSettingsBody({ modelInstructions }).ok, false);
		}
		const read = sanitizeUserSettings({ version: 1, agent: { modelInstructions: { a: "keep", b: 3, c: " " } } })!;
		assert.deepEqual(read.agent!.modelInstructions, { a: "keep" });
	});

	it("persist through the settings route", async () => {
		const response = await putSettingsSection(
			new Request("http://test/api/settings/agent", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelInstructions: { "claude-code:opus": "Slow down." } }),
			}),
			{ params: Promise.resolve({ section: "agent" }) },
		);
		assert.equal(response.status, 200);
		assert.deepEqual(readSettingsRecord()?.agent?.modelInstructions, { "claude-code:opus": "Slow down." });
	});

	it("reach the side tutor's system prompt for the lesson's model", async () => {
		const prompts: string[] = [];
		const faux = createFauxCore({});
		// The request carries the system prompt as its leading system message.
		faux.setResponses([(context: { messages: unknown[] }) => {
			prompts.push(JSON.stringify(context.messages[0]));
			return fauxAssistantMessage([fauxText("Sure.")]);
		}]);
		const spec = { provider: "openai", id: "gpt-6.1-sol", thinkingLevel: "high" as const };
		const settings = resolveSettings({ version: 1, agent: { modelInstructions: { "openai:gpt-6.1-sol": "SIDE_SENTINEL" } } });
		const chat = { id: "lesson", title: "Lesson", messages: [], settings: { model: { provider: spec.provider, id: spec.id } } };
		const response = await sideChatResponse(
			new Request("http://localhost/api/chats/lesson/side", {
				method: "POST",
				body: JSON.stringify({ snapshot: { context: "Teacher: hi.", truncated: false, model: spec }, messages: [{ role: "user", content: "Why?" }] }),
			}),
			"lesson",
			{
				getChat: () => chat as never,
				settings: () => settings,
				keyPresent: () => true,
				refresh: async () => {},
				engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }) as never,
			},
		);
		assert.equal(response.status, 200);
		await response.text();
		assert.equal(prompts.length, 1);
		assert.ok(prompts[0]!.includes("You are the learner's temporary side tutor"));
		assert.ok(prompts[0]!.includes("User instructions for this model:\\nSIDE_SENTINEL"));
	});
});
