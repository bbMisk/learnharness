import assert from "node:assert/strict";
import { it } from "node:test";
import { restoreInterruptedDraft } from "../components/chat.tsx";

it("failed interruptions preserve every rejected prompt and a newer unsent draft", () => {
	let draft = "A newer draft with an attachment: \"/uploads/image.png\"";
	draft = restoreInterruptedDraft(draft, "First rejected prompt");
	draft = restoreInterruptedDraft(draft, "Second rejected prompt");
	assert.equal(draft, "A newer draft with an attachment: \"/uploads/image.png\"\n\nFirst rejected prompt\n\nSecond rejected prompt");
	assert.equal(restoreInterruptedDraft("", "Rejected prompt"), "Rejected prompt");
});
