/**
 * FORK: what the chat page offers under each side-chat switch value
 * (src/core/fork-config.ts). The switch is read once at module load, so
 * each mode renders in its own child process: LH_FORK_SIDE_CHAT=questions
 * (honoured only under NODE_ENV=test) flips the child to upstream's side
 * questions.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("./helpers/side-chat-switch-child.tsx", import.meta.url));

function render(mode: "tutor" | "questions") {
	const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
	if (mode === "questions") env.LH_FORK_SIDE_CHAT = "questions";
	else delete env.LH_FORK_SIDE_CHAT;
	const run = spawnSync(process.execPath, ["--import", "tsx", child], { env, encoding: "utf8", timeout: 120_000 });
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as {
		mode: string; html: string; actions: string[]; teacherPrompt: string; segments: string[];
	};
}

describe("the side-chat switch", () => {
	it("tutor (default): the side tutor is offered, no side-question entry point exists", () => {
		const r = render("tutor");
		assert.equal(r.mode, "tutor");
		assert.match(r.html, /aria-label="Open side tutor"/);
		assert.doesNotMatch(r.html, /side-conversation-button/);
		assert.ok(r.actions.includes("toggle-side-tutor"));
		assert.ok(!r.actions.includes("toggle-question-thread"));
		assert.doesNotMatch(r.teacherPrompt, /Learner–helper conversations/);
		assert.ok(!r.segments.includes("shared/35-side-conversations.md"));
	});

	it("questions: upstream's side questions are offered and the side tutor's entry points are off", () => {
		const r = render("questions");
		assert.equal(r.mode, "questions");
		assert.match(r.html, /data-testid="side-conversation-button"/, "the transcript renders the side entry through the fork's rows");
		assert.doesNotMatch(r.html, /aria-label="Open side tutor"/);
		assert.ok(r.actions.includes("toggle-question-thread"));
		assert.ok(!r.actions.includes("toggle-side-tutor"));
		assert.match(r.teacherPrompt, /Learner–helper conversations/);
		assert.ok(r.segments.includes("shared/35-side-conversations.md"));
	});
});
