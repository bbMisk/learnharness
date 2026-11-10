/** A refused action's message: the server's own line, or `fallback` when the
 *  request never got an answer (fetch's raw "Failed to fetch" TypeError, an
 *  unreadable body). */
export function actionError(error: unknown, fallback: string): string {
	return error instanceof Error && error.name === "Error" && error.message ? error.message : fallback;
}

/** Rename a chat; every view of it (sidebar row, chat header) hears lh:chat-renamed. Throws on failure. */
export async function renameChat(id: string, title: string): Promise<void> {
	const res = await fetch(`/api/chats/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) throw new Error(`rename failed: ${res.status}`);
	window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title } }));
}

/** Rename a project, guarding against an edit from another Mac (the route compares `expected`). */
export async function renameProject(id: string, name: string, expected: string): Promise<void> {
	const response = await fetch("/api/projects/" + id, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, expected: { name: expected } }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error || "Could not rename the project.");
	}
}
