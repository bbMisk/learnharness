import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { projectStore, projectView } from "@/src/server";
import { ProjectPage } from "@/components/project-page";
export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
	const project = projectStore.get((await params).id);
	return project ? { title: project.name } : {};
}
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
