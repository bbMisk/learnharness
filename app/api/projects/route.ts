import { projectStore } from "@/src/server";
export async function GET() {
	return Response.json({ projects: projectStore.list().map(({ id, name }) => ({ id, name })) });
}
export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	if (typeof body?.name !== "string" || !body.name.trim() || body.name.length > 200)
		return Response.json({ error: "Enter a project name." }, { status: 400 });
	return Response.json(projectStore.create(body.name), { status: 201 });
}
