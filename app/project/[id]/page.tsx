import { notFound } from "next/navigation";
import { projectView } from "@/src/server";
import { ProjectPage } from "@/components/project-page";
export const dynamic = "force-dynamic";
export default async function Page({
	params,
}: {
	params: Promise<{
		id: string;
	}>;
}) {
	const project = await projectView((await params).id);
	if (!project) notFound();
	return <ProjectPage key={project.id} initial={project} />;
}
