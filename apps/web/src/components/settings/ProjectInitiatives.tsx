import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  ThreadId,
  type EnvironmentId,
  type Initiative,
  type InitiativeStatus,
  type InitiativeUpdateInput,
  type ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { newThreadId } from "../../lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProject, useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { scheduledTaskDefaultModel } from "./scheduledTasksSettings.logic";
import { SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const METADATA_FIELDS = [
  ["objective", "Objective"],
  ["definitionOfDone", "Definition of done"],
  ["brief", "Brief"],
  ["plan", "Current plan"],
  ["decisions", "Decisions"],
  ["links", "Links"],
  ["blockers", "Blockers"],
  ["userActions", "Requested user actions"],
  ["results", "Results"],
] as const;
type MetadataKey = (typeof METADATA_FIELDS)[number][0];
type Draft = Record<MetadataKey, string> & { title: string; coordinatorThreadId: string };

function draftFromInitiative(initiative: Initiative | null): Draft {
  return {
    title: initiative?.title ?? "",
    coordinatorThreadId: initiative?.coordinatorThreadId ?? "",
    objective: initiative?.objective ?? "",
    definitionOfDone: initiative?.definitionOfDone ?? "",
    brief: initiative?.brief ?? "",
    plan: initiative?.plan ?? "",
    decisions: initiative?.decisions ?? "",
    links: initiative?.links ?? "",
    blockers: initiative?.blockers ?? "",
    userActions: initiative?.userActions ?? "",
    results: initiative?.results ?? "",
  };
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The initiative could not be saved.";
}

/** Initiative membership belongs to one physical project on one environment. */
export function ProjectInitiatives({
  environmentId,
  projectId,
  label,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label?: string;
}) {
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const supported = environment?.serverConfig?.supportsInitiatives === true;
  const query = useEnvironmentQuery(
    supported ? serverEnvironment.initiativesLive({ environmentId, input: { projectId } }) : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ initiative: Initiative | null } | null>(null);
  const initiatives = query.data?.initiatives ?? [];
  const selected =
    initiatives.find((initiative) => initiative.id === selectedId) ?? initiatives[0] ?? null;
  useRelativeTimeTick(60_000);

  return (
    <SettingsSection
      title={label ? `Initiatives · ${label}` : "Initiatives"}
      variant="plain"
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={!supported || !connected}
          onClick={() => setEditor({ initiative: null })}
        >
          New initiative
        </Button>
      }
    >
      {!supported ? (
        <p className="text-sm text-muted-foreground">
          {connected
            ? "Update this environment's server to use initiatives."
            : "Connect this environment to load its initiatives."}
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Keep an objective, plan and worker results together. Open the coordinator to give
            direction while work runs.
          </p>
          {!connected && (
            <p role="status" className="text-sm text-muted-foreground">
              This environment is disconnected. Reconnect to make changes.
            </p>
          )}
          {query.error && (
            <p role="alert" className="text-sm text-destructive">
              {query.error}
            </p>
          )}
          {query.isPending && !query.data && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading initiatives…
            </p>
          )}
          {query.data && initiatives.length === 0 && (
            <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
              Create an initiative for a body of work that spans several tasks. Each initiative has
              its own coordinator and saved progress.
            </p>
          )}
          {initiatives.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Choose initiative">
              {initiatives.map((initiative) => (
                <Button
                  key={initiative.id}
                  size="sm"
                  variant={selected?.id === initiative.id ? "secondary" : "outline"}
                  aria-pressed={selected?.id === initiative.id}
                  onClick={() => setSelectedId(initiative.id)}
                >
                  {initiative.title}
                  <Badge variant="outline">{initiative.status}</Badge>
                </Button>
              ))}
            </div>
          )}
          {selected && (
            <InitiativeOverview
              key={selected.id}
              initiative={selected}
              environmentId={environmentId}
              connected={connected}
              onEdit={() => setEditor({ initiative: selected })}
            />
          )}
        </div>
      )}
      {editor && (
        <InitiativeEditor
          key={editor.initiative?.id ?? "new"}
          environmentId={environmentId}
          projectId={projectId}
          initiative={editor.initiative}
          initiatives={initiatives}
          connected={connected && supported}
          onClose={() => setEditor(null)}
          onSaved={(initiative) => {
            setSelectedId(initiative.id);
            setEditor(null);
          }}
        />
      )}
    </SettingsSection>
  );
}

function ThreadLink({
  environmentId,
  threadId,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  children: ReactNode;
}) {
  return (
    <Link
      className="text-sm text-primary underline underline-offset-4"
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
    >
      {children}
    </Link>
  );
}

function InitiativeOverview({
  initiative,
  environmentId,
  connected,
  onEdit,
}: {
  initiative: Initiative;
  environmentId: EnvironmentId;
  connected: boolean;
  onEdit: () => void;
}) {
  const setStatus = useAtomCommand(serverEnvironment.setInitiativeStatus, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const coordinator = useThreadShell(scopeThreadRef(environmentId, initiative.coordinatorThreadId));
  const project = useProject({ environmentId, projectId: initiative.projectId });
  const changeStatus = async (status: InitiativeStatus) => {
    if (busy || !connected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setStatus({ environmentId, input: { id: initiative.id, status } });
      if (result._tag === "Failure") setError(failureMessage(result));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="min-w-0 space-y-5 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-base font-medium">{initiative.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Updated {formatRelativeTimeLabel(initiative.updatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!connected || busy} onClick={onEdit}>
            Edit brief and progress
          </Button>
          {initiative.status === "active" && (
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || busy}
              onClick={() => void changeStatus("paused")}
            >
              Pause
            </Button>
          )}
          {initiative.status === "paused" && (
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || busy}
              onClick={() => void changeStatus("active")}
            >
              Resume
            </Button>
          )}
          {initiative.status !== "completed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || busy}
              onClick={() => void changeStatus("completed")}
            >
              Mark complete
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || busy}
              onClick={() => void changeStatus("active")}
            >
              Reopen
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {initiative.status === "active"
          ? "Active. Worker completion does not complete this initiative."
          : initiative.status === "paused"
            ? "Paused. New automatic coordinator turns are blocked; running coordinator and worker turns continue. Stop them in their chats if needed."
            : "Completed. Automatic wakes are blocked. Reopen to continue with the saved brief and history."}
      </p>
      {initiative.coordinatorMissing ? (
        <p role="alert" className="text-sm text-destructive">
          The coordinator is no longer available. Edit this initiative to attach another thread.
        </p>
      ) : (
        <ThreadLink environmentId={environmentId} threadId={initiative.coordinatorThreadId}>
          Open coordinator{coordinator ? `: ${coordinator.title}` : ""} to steer work
        </ThreadLink>
      )}
      <div className="space-y-4">
        {METADATA_FIELDS.map(([key, label]) =>
          initiative[key] || key === "objective" || key === "plan" ? (
            <section key={key} className="min-w-0">
              <h4 className="mb-1 text-sm font-medium">{label}</h4>
              {initiative[key] ? (
                <ChatMarkdown
                  text={initiative[key]}
                  cwd={project?.workspaceRoot}
                  environmentId={environmentId}
                  className="text-sm"
                  headingLevelOffset={4}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No plan recorded yet.</p>
              )}
            </section>
          ) : null,
        )}
      </div>
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Workers ({initiative.workers.length})</h4>
        {initiative.workers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No delegated workers yet. Ask the coordinator to delegate tasks when the work can run in
            parallel.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {initiative.workers.map((worker) => (
              <li key={worker.threadId} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <ThreadLink environmentId={environmentId} threadId={worker.threadId}>
                    {worker.title || "Worker conversation"}
                  </ThreadLink>
                  <Badge variant="outline">{worker.status}</Badge>
                </div>
                {worker.result && (
                  <ChatMarkdown
                    text={worker.result}
                    cwd={project?.workspaceRoot}
                    environmentId={environmentId}
                    className="text-sm"
                    headingLevelOffset={4}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <InitiativeAutomations
        initiative={initiative}
        environmentId={environmentId}
        coordinator={coordinator}
        connected={connected}
      />
    </article>
  );
}

function InitiativeAutomations({
  initiative,
  environmentId,
  coordinator,
  connected,
}: {
  initiative: Initiative;
  environmentId: EnvironmentId;
  coordinator: EnvironmentThreadShell | null;
  connected: boolean;
}) {
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const tasks =
    tasksQuery.data?.tasks.filter(
      (task) =>
        task.projectId === initiative.projectId && task.threadId === initiative.coordinatorThreadId,
    ) ?? [];
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: false,
  });
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: false });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busyKey || !connected) return;
    setBusyKey(key);
    setError(null);
    try {
      await action();
    } finally {
      setBusyKey(null);
    }
  };
  return (
    <section className="space-y-3 border-t pt-4">
      <h4 className="text-sm font-medium">What can wake the coordinator</h4>
      <p className="text-sm text-muted-foreground">
        Schedules, webhooks and pull request watches keep their settings when an initiative is
        paused or completed. Automatic wakes resume when the initiative is active.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {tasksQuery.error && (
        <p role="alert" className="text-sm text-destructive">
          {tasksQuery.error}
        </p>
      )}
      {tasksQuery.data && tasks.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No schedules or webhook tasks target this coordinator.
        </p>
      )}
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">{task.title}</p>
            <p className="text-xs text-muted-foreground">
              {task.schedule.type === "webhook"
                ? "Webhook"
                : task.schedule.type === "interval"
                  ? `Every ${Math.round(task.schedule.everyMs / 60_000)} minutes`
                  : `${task.schedule.timeOfDay}, environment time`}{" "}
              · {task.enabled ? "Enabled" : "Disabled"}
              {initiative.status !== "active" && task.enabled
                ? " · Wakes blocked by initiative"
                : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              className="text-sm text-primary underline underline-offset-4"
              to="/settings/scheduled-tasks"
              search={(previous) => ({
                ...previous,
                machine: environmentId,
                environmentId,
                taskId: task.id,
              })}
            >
              Manage
            </Link>
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || busyKey !== null}
              onClick={() =>
                void run(task.id, async () => {
                  const result = await toggle({
                    environmentId,
                    input: { id: task.id, enabled: !task.enabled },
                  });
                  if (result._tag === "Failure") setError(failureMessage(result));
                })
              }
            >
              {task.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
      ))}
      {(coordinator?.pullRequests ?? []).map((pr) => (
        <div
          key={`${pr.host}/${pr.repository}/${pr.number}`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
        >
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary underline underline-offset-4"
          >
            {pr.repository} #{pr.number}
          </a>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{pr.watch ? "Watching" : "Not watching"}</Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || busyKey !== null}
              onClick={() =>
                void run(pr.url, async () => {
                  const result = await watch({
                    environmentId,
                    input: {
                      threadId: initiative.coordinatorThreadId,
                      host: pr.host,
                      repository: pr.repository,
                      number: pr.number,
                      watching: !pr.watch,
                    },
                  });
                  if (result._tag === "Failure") setError(failureMessage(result));
                })
              }
            >
              {pr.watch ? "Stop watching" : "Watch"}
            </Button>
          </div>
        </div>
      ))}
      {coordinator && coordinator.pullRequests.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No pull requests linked to this coordinator.
        </p>
      )}
      <div className="flex flex-wrap gap-4">
        <Link
          className="text-sm text-primary underline underline-offset-4"
          to="/settings/scheduled-tasks"
          search={(previous) => ({ ...previous, machine: environmentId })}
        >
          Manage schedules and webhooks
        </Link>
        {!initiative.coordinatorMissing && (
          <ThreadLink environmentId={environmentId} threadId={initiative.coordinatorThreadId}>
            Manage pull requests in coordinator
          </ThreadLink>
        )}
      </div>
    </section>
  );
}

function InitiativeEditor({
  environmentId,
  projectId,
  initiative,
  initiatives,
  connected,
  onClose,
  onSaved,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  initiative: Initiative | null;
  initiatives: readonly Initiative[];
  connected: boolean;
  onClose: () => void;
  onSaved: (initiative: Initiative) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftFromInitiative(initiative));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Retain a successfully created coordinator if the next request fails, so Retry cannot
  // duplicate a thread. No agent runs until the user sends its first coordinator message.
  const [createdCoordinator, setCreatedCoordinator] = useState<ThreadId | null>(null);
  const pending = useRef(false);
  const latestInitiative = initiative
    ? initiatives.find((entry) => entry.id === initiative.id)
    : null;
  const canAttachCoordinator =
    initiative === null ||
    (initiative.coordinatorMissing &&
      latestInitiative?.coordinatorMissing === true &&
      latestInitiative.coordinatorThreadId === initiative.coordinatorThreadId);
  const project = useProject({ environmentId, projectId });
  const shells = useThreadShells();
  const candidates = shells.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === projectId &&
      thread.archivedAt === null &&
      thread.lineage?.relationshipToParent !== "subagent" &&
      (canAttachCoordinator || thread.id === initiative?.coordinatorThreadId) &&
      !initiatives.some(
        (entry) => entry.id !== initiative?.id && entry.coordinatorThreadId === thread.id,
      ),
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const defaultModel = scheduledTaskDefaultModel(settings, project, entries);
  const projectSettings = resolveProjectSettings(settings, projectId, project).settings;
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const create = useAtomCommand(serverEnvironment.createInitiative, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateInitiative, { reportFailure: false });
  const save = async () => {
    if (pending.current || !connected || !draft.title.trim() || !draft.objective.trim()) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      // Validate the latest record before creating a replacement thread. A live or
      // concurrently replaced coordinator must never leave an unused new thread behind.
      if (initiative) {
        if (!latestInitiative) {
          setError(
            "This initiative is no longer available. Close the editor and reload its overview.",
          );
          return;
        }
        const replacingCoordinator = draft.coordinatorThreadId !== initiative.coordinatorThreadId;
        if (replacingCoordinator && !canAttachCoordinator) {
          setError(
            "The coordinator is available or changed while you were editing. Close and reopen the editor to use its latest version. Only a missing coordinator can be replaced.",
          );
          return;
        }
        for (const key of ["title", ...METADATA_FIELDS.map(([field]) => field)] as const) {
          const value = key === "title" || key === "objective" ? draft[key].trim() : draft[key];
          if (value !== initiative[key] && latestInitiative[key] !== initiative[key]) {
            setError(
              "The brief or progress changed while you were editing. Close and reopen the editor to use its latest version.",
            );
            return;
          }
        }
      }
      let coordinatorThreadId = draft.coordinatorThreadId
        ? ThreadId.make(draft.coordinatorThreadId)
        : createdCoordinator;
      if (!coordinatorThreadId) {
        if (!defaultModel) {
          setError(
            "Choose an existing coordinator or configure an available default model in General settings.",
          );
          return;
        }
        const threadId = newThreadId();
        const result = await createThread({
          environmentId,
          input: {
            threadId,
            projectId,
            title: draft.title.trim(),
            modelSelection: defaultModel,
            runtimeMode: projectSettings.defaultRuntimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        });
        if (result._tag === "Failure") {
          setError(failureMessage(result));
          return;
        }
        setCreatedCoordinator(threadId);
        coordinatorThreadId = threadId;
      }
      const metadata = {
        ...draft,
        title: draft.title.trim(),
        objective: draft.objective.trim(),
        coordinatorThreadId,
      };
      const patch: InitiativeUpdateInput = { id: initiative?.id ?? "" };
      if (initiative) {
        for (const key of [
          "title",
          "coordinatorThreadId",
          ...METADATA_FIELDS.map(([field]) => field),
        ] as const) {
          if (metadata[key] === initiative[key]) continue;
          Object.assign(patch, { [key]: metadata[key] });
        }
      }
      const result = initiative
        ? await update({ environmentId, input: patch })
        : await create({ environmentId, input: { projectId, ...metadata } });
      if (result._tag === "Failure") {
        setError(failureMessage(result));
        return;
      }
      onSaved(result.value);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initiative ? "Edit initiative" : "New initiative"}</DialogTitle>
          <DialogDescription>
            Save the objective and progress. The coordinator can update these records as work
            proceeds.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={`${id}-form`}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="space-y-4"
          >
            <label className="block space-y-1 text-sm" htmlFor={`${id}-title`}>
              <span>Title</span>
              <Input
                id={`${id}-title`}
                value={draft.title}
                required
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
              />
            </label>
            <label className="block space-y-1 text-sm" htmlFor={`${id}-coordinator`}>
              <span>Coordinator</span>
              <select
                id={`${id}-coordinator`}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={draft.coordinatorThreadId}
                disabled={saving || !canAttachCoordinator}
                onChange={(event) => {
                  if (canAttachCoordinator)
                    setDraft({ ...draft, coordinatorThreadId: event.currentTarget.value });
                }}
              >
                {canAttachCoordinator && <option value="">Create a new coordinator</option>}
                {initiative &&
                  !candidates.some((thread) => thread.id === initiative.coordinatorThreadId) && (
                    <option value={initiative.coordinatorThreadId}>
                      {initiative.coordinatorMissing
                        ? "Missing coordinator, choose another"
                        : "Current coordinator"}
                    </option>
                  )}
                {candidates.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))}
              </select>
            </label>
            {initiative && !canAttachCoordinator && (
              <p className="text-xs text-muted-foreground">
                The coordinator stays with this initiative. Use its conversation's handoff controls
                to change providers. Only a missing coordinator can be replaced.
              </p>
            )}
            {!draft.coordinatorThreadId && (
              <p className="text-xs text-muted-foreground">
                {defaultModel
                  ? `Creates a coordinator with ${defaultModel.model}. Open its chat to choose permissions and a workspace, then send the first message.`
                  : "No available default model. Attach an existing thread or configure a provider in Settings."}
              </p>
            )}
            {METADATA_FIELDS.map(([key, label]) => (
              <label key={key} className="block space-y-1 text-sm" htmlFor={`${id}-${key}`}>
                <span>
                  {label}
                  {key === "objective" ? " (required)" : ""}
                </span>
                <Textarea
                  id={`${id}-${key}`}
                  rows={key === "objective" || key === "plan" ? 3 : 2}
                  value={draft[key]}
                  required={key === "objective"}
                  disabled={saving}
                  onChange={(event) => setDraft({ ...draft, [key]: event.currentTarget.value })}
                />
              </label>
            ))}
          </form>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {createdCoordinator && error && (
            <p className="text-sm text-muted-foreground">
              The coordinator was created. Retry saves this initiative with the same thread, or{" "}
              <ThreadLink environmentId={environmentId} threadId={createdCoordinator}>
                open the coordinator
              </ThreadLink>
              .
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            form={`${id}-form`}
            type="submit"
            disabled={
              saving ||
              !connected ||
              !draft.title.trim() ||
              !draft.objective.trim() ||
              (!draft.coordinatorThreadId && !defaultModel)
            }
          >
            {saving ? "Saving…" : initiative ? "Save changes" : "Create initiative"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
