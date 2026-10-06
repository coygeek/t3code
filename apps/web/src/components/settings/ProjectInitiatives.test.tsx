// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Initiative,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

const state = vi.hoisted(() => ({
  supported: true,
  connected: true,
  initiatives: [] as Initiative[],
  queries: vi.fn(),
  commands: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: { supportsInitiatives: state.supported },
  }),
}));
vi.mock("../../state/entities", () => ({
  useProject: () => null,
  useThreadShell: () => null,
  useThreadShells: () => [],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === null
        ? null
        : typeof atom === "object" && atom !== null && "projectId" in atom
          ? { initiatives: state.initiatives }
          : { tasks: [] },
    error: null,
    isPending: false,
  }),
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    initiativesLive: (target: unknown) => {
      state.queries(target);
      return (target as { input: unknown }).input;
    },
    scheduledTasksLive: () => "tasks",
    providersValueAtom: () => "providers",
    createInitiative: "create",
    updateInitiative: "update",
    setInitiativeStatus: "status",
    setScheduledTaskEnabled: "toggle",
  },
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { create: "thread", watchPullRequest: "watch" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => state.commands.get(command),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
}));
vi.mock("./scheduledTasksSettings.logic", () => ({
  scheduledTaskDefaultModel: () => ({
    instanceId: ProviderInstanceId.make("chosen-provider"),
    model: "chosen-model",
  }),
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => <a href={params ? `/${params.environmentId}/${params.threadId}` : to}>{children}</a>,
}));
vi.mock("./settingsLayout", () => ({
  useRelativeTimeTick: () => undefined,
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

import { ProjectInitiatives } from "./ProjectInitiatives";

const environmentId = EnvironmentId.make("remote-environment");
const projectId = ProjectId.make("same-repository");
function initiative(id: string): Initiative {
  return {
    id,
    projectId,
    coordinatorThreadId: ThreadId.make(`coordinator-${id}`),
    title: `Initiative ${id}`,
    objective: `Objective ${id}`,
    definitionOfDone: "",
    brief: `Brief ${id}`,
    plan: `Plan ${id}`,
    decisions: "",
    links: "",
    blockers: "",
    userActions: "",
    results: "",
    status: "active",
    coordinatorMissing: false,
    createdAt: "2026-10-05T12:00:00Z",
    updatedAt: "2026-10-05T12:00:00Z",
    workers: [
      {
        threadId: ThreadId.make(`worker-${id}`),
        parentThreadId: ThreadId.make(`coordinator-${id}`),
        title: `Worker ${id}`,
        status: "completed",
        result: `Result ${id}`,
      },
    ],
  };
}

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(<ProjectInitiatives environmentId={environmentId} projectId={projectId} />);
  });
}
function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button missing: ${label}`);
  return match;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function type(label: string, value: string) {
  const controlId = [...container.querySelectorAll("label")].find(
    (entry) => entry.textContent?.trim() === label,
  )?.htmlFor;
  const control = controlId
    ? container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id="${controlId}"]`)
    : null;
  if (!control) throw new Error(`Field missing: ${label}`);
  await act(async () => {
    const prototype =
      control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function coordinatorSelect() {
  const controlId = [...container.querySelectorAll("label")].find(
    (entry) => entry.querySelector("span")?.textContent?.trim() === "Coordinator",
  )?.htmlFor;
  const control = controlId
    ? container.querySelector<HTMLSelectElement>(`select[id="${controlId}"]`)
    : null;
  if (!control) throw new Error("Coordinator selector missing");
  return control;
}
async function selectCoordinator(value: string) {
  await act(async () => {
    const control = coordinatorSelect();
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.supported = true;
  state.connected = true;
  state.initiatives = [initiative("first"), initiative("second")];
  state.queries.mockClear();
  state.commands.clear();
  for (const command of ["create", "update", "status", "toggle", "thread", "watch"])
    state.commands.set(
      command,
      vi.fn().mockResolvedValue(AsyncResult.success(state.initiatives[0]!)),
    );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("project initiatives", () => {
  it("does not subscribe or allow creation on an older server", async () => {
    state.supported = false;
    await render();
    expect(state.queries).not.toHaveBeenCalled();
    expect(button("New initiative").disabled).toBe(true);
    expect(container.textContent).toContain("Update this environment's server");
  });

  it("keeps two objectives and workers separate in the same remote project", async () => {
    await render();
    expect(state.queries).toHaveBeenCalledWith({ environmentId, input: { projectId } });
    expect(container.textContent).toContain("Objective first");
    expect(container.textContent).not.toContain("Objective second");
    await click("Initiative secondactive");
    expect(container.textContent).toContain("Brief second");
    expect(container.textContent).toContain("Plan second");
    expect(container.textContent).toContain("Result second");
    expect(container.textContent).not.toContain("Result first");
    expect(container.querySelector('a[href="/remote-environment/worker-second"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="/remote-environment/coordinator-second"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Worker completion does not complete");
  });

  it("keeps lifecycle errors visible and observes paused and reopened records", async () => {
    await render();
    state.commands
      .get("status")!
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Connection lost"))));
    await click("Pause");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
    expect(button("Pause").disabled).toBe(false);
    state.initiatives = [{ ...state.initiatives[0]!, status: "paused" }, state.initiatives[1]!];
    await render();
    expect(container.textContent).toContain("running coordinator and worker turns continue");
    await click("Resume");
    expect(state.commands.get("status")).toHaveBeenLastCalledWith({
      environmentId,
      input: { id: "first", status: "active" },
    });
    state.initiatives = [{ ...state.initiatives[0]!, status: "completed" }, state.initiatives[1]!];
    await render();
    await click("Reopen");
    expect(container.textContent).toContain("Brief first");
    expect(container.textContent).toContain("Result first");
  });

  it("retries a failed initiative save with the same configured coordinator", async () => {
    await render();
    await click("New initiative");
    await type("Title", "New work");
    await type("Objective (required)", "Deliver the work");
    state.commands
      .get("create")!
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Save failed"))));
    await submit();
    expect(container.textContent).toContain("The coordinator was created");
    const threadCall = state.commands.get("thread")!.mock.calls[0]![0];
    expect(threadCall.input.modelSelection).toEqual({
      instanceId: "chosen-provider",
      model: "chosen-model",
    });
    expect(threadCall.input.runtimeMode).toBe(DEFAULT_SERVER_SETTINGS.defaultRuntimeMode);
    await submit();
    expect(state.commands.get("thread")).toHaveBeenCalledTimes(1);
    expect(state.commands.get("create")).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId,
        input: expect.objectContaining({
          projectId,
          coordinatorThreadId: threadCall.input.threadId,
          title: "New work",
          objective: "Deliver the work",
        }),
      }),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("saves only edited fields so coordinator progress arriving during editing survives", async () => {
    await render();
    await click("Edit brief and progress");
    await type("Title", "Renamed initiative");
    state.initiatives = [
      { ...state.initiatives[0]!, plan: "New coordinator plan" },
      state.initiatives[1]!,
    ];
    await render();
    await submit();
    expect(state.commands.get("update")).toHaveBeenCalledWith({
      environmentId,
      input: { id: "first", title: "Renamed initiative" },
    });
  });

  it("keeps a live coordinator fixed even when a replacement change event is attempted", async () => {
    await render();
    await click("Edit brief and progress");
    expect(coordinatorSelect().disabled).toBe(true);
    expect([...coordinatorSelect().options].some((option) => option.value === "")).toBe(false);
    await type("Title", "Renamed with original coordinator");
    // An injected option and change event must not bypass the locked coordinator field.
    const replacement = document.createElement("option");
    replacement.value = "";
    coordinatorSelect().append(replacement);
    await selectCoordinator("");
    await submit();
    expect(state.commands.get("thread")).not.toHaveBeenCalled();
    expect(state.commands.get("update")).toHaveBeenCalledWith({
      environmentId,
      input: { id: "first", title: "Renamed with original coordinator" },
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(["available", "changed", "unavailable"] as const)(
    "rejects a replacement before creating a thread when the latest coordinator is %s",
    async (latestState) => {
      state.initiatives = [
        { ...state.initiatives[0]!, coordinatorMissing: true },
        state.initiatives[1]!,
      ];
      await render();
      await click("Edit brief and progress");
      await selectCoordinator("");
      state.initiatives =
        latestState === "unavailable"
          ? [state.initiatives[1]!]
          : [
              {
                ...state.initiatives[0]!,
                coordinatorMissing: latestState === "changed",
                ...(latestState === "changed"
                  ? { coordinatorThreadId: ThreadId.make("replacement-from-another-client") }
                  : {}),
              },
              state.initiatives[1]!,
            ];
      await render();
      await submit();
      expect(state.commands.get("thread")).not.toHaveBeenCalled();
      expect(state.commands.get("update")).not.toHaveBeenCalled();
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
        latestState === "unavailable"
          ? "no longer available"
          : "Only a missing coordinator can be replaced",
      );
    },
  );

  it("creates and attaches a replacement when the saved coordinator is still missing", async () => {
    state.initiatives = [
      { ...state.initiatives[0]!, coordinatorMissing: true },
      state.initiatives[1]!,
    ];
    await render();
    await click("Edit brief and progress");
    expect(coordinatorSelect().disabled).toBe(false);
    await selectCoordinator("");
    await submit();
    expect(state.commands.get("thread")).toHaveBeenCalledTimes(1);
    const coordinatorThreadId = state.commands.get("thread")!.mock.calls[0]![0].input.threadId;
    expect(state.commands.get("update")).toHaveBeenCalledWith({
      environmentId,
      input: { id: "first", coordinatorThreadId },
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
