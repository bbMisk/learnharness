/**
 * The full record refresh's apply gate (components/record-sync.ts): a record
 * fetched before the learner sent must never replace the view that holds
 * the send. Compaction's record-changed still drives this refresh.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { it } from "node:test";
import { recordSyncVerdict } from "../components/record-sync.ts";

it("applies only when nothing moved while the fetch was in flight", () => {
	const messages = [{ id: "a" }];
	assert.equal(recordSyncVerdict({ busy: false, messages }, { busy: false, messages }), "apply");
	// The settle path: the fallback busy flag clears during the fetch.
	assert.equal(recordSyncVerdict({ busy: true, messages }, { busy: false, messages }), "apply");
});

it("a send during the fetch: skip — the turn's own settle re-syncs", () => {
	const before = [{ id: "a" }];
	const withSend = [...before, { id: "optimistic" }];
	assert.equal(recordSyncVerdict({ busy: false, messages: before }, { busy: true, messages: withSend }), "skip");
	assert.equal(recordSyncVerdict({ busy: false, messages: before }, { busy: true, messages: before }), "skip", "a turn started even before its message rendered");
	assert.equal(recordSyncVerdict({ busy: true, messages: before }, { busy: true, messages: withSend }), "skip");
});

it("idle but the local record advanced: fetch again rather than apply the older snapshot", () => {
	const before = [{ id: "a" }];
	assert.equal(recordSyncVerdict({ busy: false, messages: before }, { busy: false, messages: [...before, { id: "dismissed" }] }), "retry");
});

it("the chat view gates its full refresh on it, snapshotting before the fetch", () => {
	// Merge with upstream 0.6.1: the full refresh goes through the session's
	// canonical read (session-core readRecord), whose isCurrent runs after the
	// fetched body and right before adoption. The verdict is that isCurrent.
	const chat = fs.readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	const sync = chat.slice(chat.indexOf("const syncFromServer = useCallback"), chat.indexOf("// The settled terminal's other half"));
	const start = sync.indexOf("const start = moment();");
	const read = sync.indexOf("await readRecord({ isCurrent: () => (gate.verdict = recordSyncVerdict(start, moment())) === \"apply\" })");
	assert.ok(start >= 0 && start < read, "snapshot → fetch+verdict → apply");
	assert.match(sync, /if \(!record\) return gate\.verdict === "retry" && retries > 0 \? syncFromServer\(retries - 1\) : false;/, "skip applies nothing; retry fetches again");
	assert.match(sync, /const moment = \(\) => \(\{ busy: busyRef\.current, messages: nativeMessagesRef\.current \}\);/);
	const core = fs.readFileSync(new URL("../components/session-core.ts", import.meta.url), "utf8");
	const body = core.slice(core.indexOf("async readRecord("), core.indexOf("/** Read-only canonical adoption"));
	const fetched = body.indexOf("await this.fetchView(");
	const verdict = body.indexOf("options.isCurrent?.() === false) return undefined;");
	const apply = body.indexOf("this.replaceMessages(record.messages");
	assert.ok(fetched >= 0 && fetched < verdict && verdict < apply, "the canonical read: fetch → verdict → apply");
});
