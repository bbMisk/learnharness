export interface ProjectRecord {
	id: string;
	name: string;
	instructions: string;
	fileIds: string[];
	/** Live-linked folders (absolute paths on the server's disk); never copied. */
	folders?: string[];
	createdAt: string;
	updatedAt: string;
}
export interface ProjectFile {
	id: string;
	name: string;
	path: string;
	size: number;
	url: string;
}
export interface ProjectFolder {
	path: string;
	name: string;
	/** False when the folder is gone or no longer a readable directory. */
	available: boolean;
}
export interface ProjectView extends ProjectRecord {
	files: ProjectFile[];
	/** Absent from servers older than project folders. */
	linkedFolders?: ProjectFolder[];
	missingFileIds?: string[];
}

export type ProjectSummary = Pick<ProjectRecord, "id" | "name">;
