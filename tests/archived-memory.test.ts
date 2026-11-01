import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-archived-memory-"));
process.env.LH_DATA_DIR = temp;
process.env.LH_AUTH_FILE = path.join(temp, "auth.json");
const { chatStore, isChatCached, setChatOrganization } = await import("../src/store/chats.ts");
after(() => fs.rmSync(temp, { recursive: true, force: true }));

it("archived chats are listed but not kept in memory; active and opened ones are", () => {
	const active = chatStore.createChat("Active lesson");
	const archived = chatStore.createChat("Old lesson");
	setChatOrganization(archived.id, { archived: true });
	assert.equal(isChatCached(archived.id), false, "archiving drops it from memory");
	assert.equal(isChatCached(active.id), true);
	// A cold list (as after a restart) summarizes both and keeps only the active one.
	fs.utimesSync(path.join(temp, "chats", `${archived.id}.json`), new Date(), new Date(Date.now() + 1000));
	const list = chatStore.listChats();
	assert.deepEqual(list.map((chat) => [chat.title, !!chat.archived]).sort(), [
		["Active lesson", false],
		["Old lesson", true],
	]);
	assert.equal(isChatCached(archived.id), false);
	assert.equal(isChatCached(active.id), true);
	// Opening an archived chat still works and caches it while in use.
	assert.equal(chatStore.getChat(archived.id)!.title, "Old lesson");
	assert.equal(isChatCached(archived.id), true);
	// Restoring keeps it cached like any active chat.
	setChatOrganization(archived.id, { archived: false });
	assert.equal(isChatCached(archived.id), true);
});
