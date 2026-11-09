import { NAME_MAX_CHARS } from "@/src/core";
import { projectStore } from "@/src/server";
export async function GET() {
	return Response.json({ projects: projectStore.list().map(({ id, name }) => ({ id, name })) });
}
export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	if (typeof body?.name !== "string" || !body.name.trim()) return Response.json({ error: "Enter a project name." }, { status: 400 });
	if (body.name.length > NAME_MAX_CHARS) return Response.json({ error: `Project names can be at most ${NAME_MAX_CHARS} characters.` }, { status: 400 });
	if (projectStore.nameTaken(body.name)) return Response.json({ error: "A project with that name already exists." }, { status: 400 });
	return Response.json(projectStore.create(body.name), { status: 201 });
}
