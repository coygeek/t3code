import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveStartupFolderProject } from "./startupFolder";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const folder = "/workspace/WIP";

function project(
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot = folder,
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: "WIP",
    workspaceRoot,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
  };
}

function dependencies(projects: EnvironmentProject[] = []) {
  return {
    environmentId: primaryId,
    directory: folder,
    browse: vi.fn(async (_partialPath: string) => ({ parentPath: folder })),
    readProjects: () => projects,
    createProject: vi.fn(async (_workspaceRoot: string) => ProjectId.make("created")),
    waitForProject: vi.fn(async (): Promise<void> => undefined),
  };
}

describe("resolveStartupFolderProject", () => {
  it("reuses the primary environment project even when a remote project has the same path", async () => {
    const deps = dependencies([project(remoteId, "remote-project"), project(primaryId, "local")]);

    await expect(resolveStartupFolderProject(deps)).resolves.toEqual({
      environmentId: primaryId,
      projectId: "local",
    });
    expect(deps.createProject).not.toHaveBeenCalled();
  });

  it("matches a home-relative preference against the absolute path resolved by its server", async () => {
    const deps = dependencies([project(primaryId, "local", "/home/developer/WIP/")]);
    deps.directory = "  ~/WIP  ";
    deps.browse.mockResolvedValue({ parentPath: "/home/developer/WIP" });

    await expect(resolveStartupFolderProject(deps)).resolves.toEqual({
      environmentId: primaryId,
      projectId: "local",
    });
    expect(deps.browse).toHaveBeenCalledWith("~/WIP/");
    expect(deps.createProject).not.toHaveBeenCalled();
  });

  it("uses the server's home directory when the configured folder is blank", async () => {
    const deps = dependencies([project(primaryId, "home", "/home/developer")]);
    deps.directory = "  ";
    deps.browse.mockResolvedValue({ parentPath: "/home/developer" });

    await expect(resolveStartupFolderProject(deps)).resolves.toEqual({
      environmentId: primaryId,
      projectId: "home",
    });
    expect(deps.browse).toHaveBeenCalledWith("~/");
  });

  it("creates an absent local project once and reuses it on the next startup", async () => {
    const projects = [project(remoteId, "remote-project")];
    const deps = dependencies(projects);
    deps.waitForProject.mockImplementation(async () => {
      if (!projects.some((entry) => entry.environmentId === primaryId)) {
        projects.push(project(primaryId, "created"));
      }
    });

    const first = await resolveStartupFolderProject(deps);
    const second = await resolveStartupFolderProject(deps);

    expect(first).toEqual({ environmentId: primaryId, projectId: "created" });
    expect(second).toEqual(first);
    expect(deps.createProject).toHaveBeenCalledExactlyOnceWith(folder);
  });

  it("does not create a project or return a navigation target when folder validation fails", async () => {
    const deps = dependencies();
    const failure = new Error("Directory does not exist");
    deps.browse.mockRejectedValue(failure);
    const navigate = vi.fn();

    await expect(resolveStartupFolderProject(deps).then(navigate)).rejects.toBe(failure);
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.waitForProject).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("waits for the project to reach the client before returning its navigation target", async () => {
    const deps = dependencies();
    let releaseReceipt = () => {};
    const receipt = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    let reportWaiting = () => {};
    const waiting = new Promise<void>((resolve) => {
      reportWaiting = resolve;
    });
    deps.waitForProject.mockImplementation(() => {
      reportWaiting();
      return receipt;
    });
    const navigate = vi.fn();
    const result = resolveStartupFolderProject(deps).then(navigate);

    await waiting;
    expect(deps.createProject).toHaveBeenCalledExactlyOnceWith(folder);
    expect(navigate).not.toHaveBeenCalled();
    releaseReceipt();
    await result;
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      projectId: "created",
    });
  });
});
