import { projectStore, projectView, uploadStore } from "@/src/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const project = await projectView((await params).id);
	return project ? Response.json(project) : Response.json({ error: "Project not found." }, { status: 404 });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!projectStore.get(id)) return Response.json({ error: "Project not found." }, { status: 404 });
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object"
		|| (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200))
		|| (body.instructions !== undefined && (typeof body.instructions !== "string" || body.instructions.length > 32000))
		|| (body.expected !== undefined && (!body.expected || typeof body.expected !== "object"))
		|| ["addFileIds", "removeFileIds"].some(key => body[key] !== undefined && (!Array.isArray(body[key]) || body[key].some((id: unknown) => typeof id !== "string")))) {
		return Response.json({ error: "Invalid project settings." }, { status: 400 });
	}
	if (["name", "instructions"].some(field => body[field] !== undefined && typeof body.expected?.[field] !== "string")) return Response.json({ error: "Reload this project before saving. Keep a copy of your edits." }, { status: 400 });
	if (body.fileIds !== undefined) return Response.json({ error: "Reload the project before removing files." }, { status: 400 });
	try {
		await Promise.all((body.addFileIds || []).map((id: string) => uploadStore.read(id)));
		// No await between comparison and write: edits and file deltas use the current host record.
		const current = projectStore.get(id)!;
		const conflicts = (["name", "instructions"] as const).filter(field => body[field] !== undefined
			&& body.expected?.[field] !== undefined && current[field] !== body.expected[field] && current[field] !== body[field]);
		if (conflicts.length) return Response.json({ error: "This project changed on another Mac. Your edits are still here.", conflicts, project: await projectView(id) }, { status: 409 });
		projectStore.update(id, {
			...(body.name !== undefined ? { name: body.name } : {}),
			...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
			...(body.addFileIds || body.removeFileIds ? { fileIds: [...current.fileIds.filter(file => !body.removeFileIds?.includes(file)), ...(body.addFileIds || [])] } : {}),
		});
		return Response.json(await projectView(id));
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not save project." }, { status: 400 });
	}
}
