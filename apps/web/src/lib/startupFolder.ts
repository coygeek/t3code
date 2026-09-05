import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  ensureBrowseDirectoryPath,
  findProjectByPath,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

/** Resolve on the owning server before matching projects, including home-relative paths. */
export async function resolveStartupFolderProject(input: {
  environmentId: EnvironmentId;
  directory: string;
  browse: (partialPath: string) => Promise<{ parentPath: string }>;
  readProjects: () => ReadonlyArray<EnvironmentProject>;
  createProject: (workspaceRoot: string) => Promise<ProjectId>;
  waitForProject: (projectRef: ScopedProjectRef) => Promise<unknown>;
}): Promise<ScopedProjectRef> {
  const { parentPath } = await input.browse(
    ensureBrowseDirectoryPath(input.directory.trim() || "~/"),
  );
  const existing = findProjectByPath(
    input.readProjects().filter((project) => project.environmentId === input.environmentId),
    parentPath,
  );
  const projectId = existing?.id ?? (await input.createProject(parentPath));
  const projectRef = scopeProjectRef(input.environmentId, projectId);
  await input.waitForProject(projectRef);
  return projectRef;
}
