export interface ProjectRecord {
    id: string;
    name: string;
    instructions: string;
    fileIds: string[];
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
export interface ProjectView extends ProjectRecord {
    files: ProjectFile[];
}

export type ProjectSummary = Pick<ProjectRecord, "id" | "name">;
