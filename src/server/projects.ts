import { projectStore } from "../store/projects.ts";
import { uploadStore } from "../store/uploads.ts";
import type { ProjectView } from "../core/projects.ts";
export { projectStore };
export async function projectView(id: string): Promise<ProjectView | null> {
	const project = projectStore.get(id);
	if (!project) return null;
	const resolved = await Promise.allSettled(project.fileIds.map((id) => uploadStore.read(id)));
	const files = resolved.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
	const missingFileIds = project.fileIds.filter((_, index) => resolved[index]?.status === "rejected");
	return { ...project, files, ...(missingFileIds.length ? { missingFileIds } : {}) };
}
/** Resolve fresh each turn: editing the project updates existing chats too. */
export async function projectInstructions(id?: string): Promise<string> {
	if (!id) return "";
	const project = await projectView(id);
	if (!project) return "";
	return [
		"## Current project: " + project.name,
		project.instructions ? "User project instructions:\n" + project.instructions : "",
		project.missingFileIds?.length
			? "Some shared project files are unavailable. Their contents were not supplied; ask the learner to upload them again if needed."
			: "",
		project.files.length
			? "Shared project files available to this chat. Use the existing read/PDF tools to inspect relevant files:\n" +
				project.files.map((f) => "- " + f.name + ": " + JSON.stringify(f.path)).join("\n")
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}
