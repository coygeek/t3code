import type { EnvironmentId, Initiative, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  useEnvironmentServerConfig,
  useProjects,
  useThreadShell,
  useThreadShells,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  initiativeCoordinatorChoices,
  initiativeDraft,
  initiativeFields,
  initiativeStatusEffect,
  initiativeStatusLabel,
  initiativeUpdateFromDraft,
} from "./initiativePresentation";
import { useScheduledTaskEditor } from "./scheduled-task-editor";
import { editDraft } from "./scheduledTaskDraft";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

type InitiativeTarget = { readonly environmentId: EnvironmentId; readonly initiativeId: string };
type InitiativeEditorTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly initiativeId?: string;
};
type InitiativeRoutes = {
  SettingsInitiatives: undefined;
  SettingsInitiative: InitiativeTarget;
  SettingsInitiativeEditor: InitiativeEditorTarget;
  SettingsScheduledTasks: undefined;
  SettingsScheduledTaskEdit: undefined;
  Thread: { readonly environmentId: string; readonly threadId: string };
};

function Action(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center rounded-xl bg-subtle-strong px-4 py-3 active:opacity-70 disabled:opacity-50"
    >
      <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function Content({ children }: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      {children}
    </ScrollView>
  );
}

function Notice({ children }: { readonly children: ReactNode }) {
  return <Text className="p-4 text-base leading-normal text-foreground-muted">{children}</Text>;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Alert.alert(title, String(squashAtomCommandFailure(result)));
  }
}

export function SettingsInitiativesRouteScreen() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Initiatives" trailing={<AndroidSettingsEnvironmentFilter />}>
        <Content>
          <Notice>
            Keep an objective, plan, and worker results together. Direct the work in its coordinator
            conversation.
          </Notice>
          {selectedTargets.length === 0 ? (
            <Notice>Connect an environment to view and create initiatives.</Notice>
          ) : (
            selectedTargets.map((environment) => (
              <EnvironmentInitiatives
                key={environment.environmentId}
                environment={environment}
                projectIds={
                  selectedProjectKey === null
                    ? null
                    : (selectedGroup?.members
                        .filter(
                          (member) => member.project.environmentId === environment.environmentId,
                        )
                        .map((member) => member.project.id) ?? [])
                }
              />
            ))
          )}
        </Content>
      </SettingsScreen>
    </>
  );
}

function EnvironmentInitiatives(props: {
  readonly environment: SettingsTarget;
  readonly projectIds: readonly ProjectId[] | null;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<InitiativeRoutes>>();
  const environmentId = props.environment.environmentId;
  const supported = props.environment.serverConfig.supportsInitiatives === true;
  const initiatives = useEnvironmentQuery(
    supported ? serverEnvironment.initiativesLive({ environmentId, input: {} }) : null,
  );
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      (props.projectIds === null || props.projectIds.includes(project.id)),
  );
  const visible = initiatives.data?.initiatives.filter(
    (initiative) => props.projectIds === null || props.projectIds.includes(initiative.projectId),
  );
  return (
    <SettingsSection title={props.environment.label}>
      {!supported ? (
        <Notice>Update this environment's server to use initiatives.</Notice>
      ) : (
        <View className="gap-3 p-4">
          {initiatives.error ? (
            <>
              <Text className="text-base text-danger-foreground">{initiatives.error}</Text>
              <Action label="Retry" onPress={initiatives.refresh} />
            </>
          ) : !initiatives.data ? (
            <Notice>Loading initiatives…</Notice>
          ) : visible?.length === 0 ? (
            <Notice>No initiatives in these projects yet.</Notice>
          ) : (
            visible?.map((initiative) => (
              <Pressable
                key={initiative.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${initiative.title}, ${initiativeStatusLabel[initiative.status]}`}
                onPress={() =>
                  navigation.navigate("SettingsInitiative", {
                    environmentId,
                    initiativeId: initiative.id,
                  })
                }
                className="gap-1 border-b border-border-subtle py-3 active:opacity-70"
              >
                <Text className="text-lg font-t3-medium text-foreground">{initiative.title}</Text>
                <Text className="text-sm text-foreground-muted">
                  {projects.find((project) => project.id === initiative.projectId)?.title ??
                    "Project"}
                  {" · "}
                  {initiativeStatusLabel[initiative.status]}
                  {" · "}
                  {initiative.workers.length} workers
                </Text>
                <Text className="text-base text-foreground-muted" numberOfLines={2}>
                  {initiative.objective}
                </Text>
              </Pressable>
            ))
          )}
          {projects.map((project) => (
            <Action
              key={project.id}
              label={`New initiative in ${project.title}`}
              onPress={() =>
                navigation.navigate("SettingsInitiativeEditor", {
                  environmentId,
                  projectId: project.id,
                })
              }
            />
          ))}
          {projects.length === 0 ? <Notice>No projects match these filters.</Notice> : null}
        </View>
      )}
    </SettingsSection>
  );
}

export function SettingsInitiativeRouteScreen({ route }: StaticScreenProps<InitiativeTarget>) {
  const { environmentId, initiativeId } = route.params;
  const config = useEnvironmentServerConfig(environmentId);
  const supported = config?.supportsInitiatives === true;
  const query = useEnvironmentQuery(
    supported ? serverEnvironment.initiativesLive({ environmentId, input: {} }) : null,
  );
  const initiative = query.data?.initiatives.find((entry) => entry.id === initiativeId);
  return (
    <SettingsScreen title={initiative?.title ?? "Initiative"}>
      <Content>
        {!supported ? (
          <Notice>Connect to a server that supports initiatives to view this work.</Notice>
        ) : query.error ? (
          <>
            <Text className="p-4 text-base text-danger-foreground">{query.error}</Text>
            <Action label="Retry" onPress={query.refresh} />
          </>
        ) : !query.data ? (
          <Notice>Loading initiative…</Notice>
        ) : !initiative ? (
          <Notice>This initiative is no longer available in this environment.</Notice>
        ) : (
          <InitiativeOverview environmentId={environmentId} initiative={initiative} />
        )}
      </Content>
    </SettingsScreen>
  );
}

function InitiativeOverview(props: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
}) {
  const { environmentId, initiative } = props;
  const navigation = useNavigation<NativeStackNavigationProp<InitiativeRoutes>>();
  const [changingStatus, setChangingStatus] = useState(false);
  const setStatus = useAtomCommand(serverEnvironment.setInitiativeStatus, {
    label: "initiative status",
    reportFailure: false,
  });
  const openThread = (threadId: ThreadId) =>
    navigation.navigate("Thread", { environmentId, threadId });
  const changeStatus = async (status: Initiative["status"]) => {
    if (changingStatus) return;
    setChangingStatus(true);
    try {
      reportFailure(
        "Could not update initiative",
        await setStatus({ environmentId, input: { id: initiative.id, status } }),
      );
    } finally {
      setChangingStatus(false);
    }
  };
  return (
    <>
      <SettingsSection title={initiativeStatusLabel[initiative.status]}>
        <View className="gap-3 p-4">
          <Text className="text-base leading-normal text-foreground-muted">
            {initiativeStatusEffect[initiative.status]}
          </Text>
          {initiative.coordinatorMissing ? (
            <Text className="text-base text-danger-foreground">
              The coordinator is unavailable. Edit the initiative to attach another conversation.
            </Text>
          ) : null}
          <Action
            label="Open coordinator to steer work"
            disabled={initiative.coordinatorMissing}
            onPress={() => openThread(initiative.coordinatorThreadId)}
          />
          <Action
            label={
              initiative.coordinatorMissing
                ? "Attach coordinator and edit brief"
                : "Edit initiative brief"
            }
            onPress={() =>
              navigation.navigate("SettingsInitiativeEditor", {
                environmentId,
                projectId: initiative.projectId,
                initiativeId: initiative.id,
              })
            }
          />
          <Action
            label={
              initiative.status === "active"
                ? "Pause initiative"
                : initiative.status === "paused"
                  ? "Resume initiative"
                  : "Reopen initiative"
            }
            disabled={changingStatus}
            onPress={() => {
              const next = initiative.status === "active" ? "paused" : "active";
              Alert.alert(
                next === "paused" ? "Pause initiative?" : "Allow automatic work?",
                initiativeStatusEffect[next],
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: next === "paused" ? "Pause" : "Continue",
                    onPress: () => void changeStatus(next),
                  },
                ],
              );
            }}
          />
          {initiative.status !== "completed" ? (
            <Action
              label="Complete initiative"
              disabled={changingStatus}
              onPress={() =>
                Alert.alert("Complete initiative?", initiativeStatusEffect.completed, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Complete", onPress: () => void changeStatus("completed") },
                ])
              }
            />
          ) : null}
          <Text className="text-sm text-foreground-muted">
            Updated {new Date(initiative.updatedAt).toLocaleString()}
          </Text>
        </View>
      </SettingsSection>
      {initiativeFields
        .filter((field) => field.key !== "title")
        .map((field) => (
          <SettingsSection key={field.key} title={field.label}>
            <Text className="p-4 text-base leading-normal text-foreground" selectable>
              {initiative[field.key] || "No entries yet."}
            </Text>
          </SettingsSection>
        ))}
      <SettingsSection title="Workers">
        {initiative.workers.length === 0 ? (
          <Notice>The coordinator's delegated workers will appear here.</Notice>
        ) : (
          initiative.workers.map((worker) => (
            <Pressable
              key={worker.threadId}
              accessibilityRole="button"
              accessibilityLabel={`Open worker ${worker.title}, ${worker.status}`}
              onPress={() => openThread(worker.threadId)}
              className="gap-2 border-b border-border-subtle p-4 active:opacity-70"
            >
              <Text className="text-base font-t3-medium text-foreground">{worker.title}</Text>
              <Text className="text-sm capitalize text-foreground-muted">{worker.status}</Text>
              {worker.result ? (
                <Text className="text-base text-foreground" selectable>
                  {worker.result}
                </Text>
              ) : null}
              <Text className="text-sm text-foreground-muted">
                Open conversation to inspect, stop, or redirect.
              </Text>
            </Pressable>
          ))
        )}
      </SettingsSection>
      <InitiativeAutomations environmentId={environmentId} initiative={initiative} />
    </>
  );
}

function InitiativeAutomations(props: {
  readonly environmentId: EnvironmentId;
  readonly initiative: Initiative;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<InitiativeRoutes>>();
  const { startEditor } = useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const coordinator = useThreadShell({
    environmentId: props.environmentId,
    threadId: props.initiative.coordinatorThreadId,
  });
  const linkedTasks = tasks.data?.tasks.filter(
    (task) => task.threadId === props.initiative.coordinatorThreadId,
  );
  return (
    <SettingsSection title="Automations">
      <View className="gap-3 p-4">
        <Text className="text-base text-foreground-muted">
          Schedules, webhooks, and pull request watches can wake the coordinator while the
          initiative is active. Manage them with the existing task and conversation controls.
        </Text>
        {tasks.error ? (
          <Text className="text-base text-danger-foreground">{tasks.error}</Text>
        ) : !tasks.data ? (
          <Notice>Loading linked tasks…</Notice>
        ) : linkedTasks?.length === 0 ? (
          <Notice>No schedules or webhooks attached to this coordinator.</Notice>
        ) : (
          linkedTasks?.map((task) => (
            <Action
              key={task.id}
              label={`${task.title} · ${task.schedule.type === "webhook" ? "Webhook" : "Schedule"} · ${task.enabled ? "Enabled" : "Paused"}`}
              onPress={() => {
                startEditor({
                  environmentId: props.environmentId,
                  environmentLabel:
                    availableTargets.find((target) => target.environmentId === props.environmentId)
                      ?.label ?? "Environment",
                  draft: editDraft(task),
                });
                navigation.navigate("SettingsScheduledTaskEdit");
              }}
            />
          ))
        )}
        <Action
          label="Manage schedules and webhooks"
          onPress={() => navigation.navigate("SettingsScheduledTasks")}
        />
        {coordinator?.pullRequests
          .filter((link) => link.watch !== undefined)
          .map((link) => (
            <Action
              key={`${link.repository}:${link.number}`}
              label={`Watching ${link.repository} #${link.number}`}
              onPress={() => {
                void tryOpenExternalUrl(link.url, "pull-request").then((opened) => {
                  if (!opened)
                    Alert.alert("Unable to open pull request", "The link could not be opened.");
                });
              }}
            />
          ))}
        <Action
          label="Manage pull request watches in coordinator"
          disabled={props.initiative.coordinatorMissing}
          onPress={() =>
            navigation.navigate("Thread", {
              environmentId: props.environmentId,
              threadId: props.initiative.coordinatorThreadId,
            })
          }
        />
      </View>
    </SettingsSection>
  );
}

export function SettingsInitiativeEditorRouteScreen({
  route,
}: StaticScreenProps<InitiativeEditorTarget>) {
  const { environmentId, projectId, initiativeId } = route.params;
  const config = useEnvironmentServerConfig(environmentId);
  const supported = config?.supportsInitiatives === true;
  const query = useEnvironmentQuery(
    supported ? serverEnvironment.initiativesLive({ environmentId, input: {} }) : null,
  );
  const initiative = query.data?.initiatives.find((entry) => entry.id === initiativeId);
  return (
    <SettingsScreen title={initiativeId ? "Edit initiative" : "New initiative"}>
      {!supported ? (
        <Content>
          <Notice>Connect to a server that supports initiatives to save this work.</Notice>
        </Content>
      ) : query.error ? (
        <Content>
          <Text className="p-4 text-base text-danger-foreground">{query.error}</Text>
          <Action label="Retry" onPress={query.refresh} />
        </Content>
      ) : !query.data ? (
        <Content>
          <Notice>Loading initiative…</Notice>
        </Content>
      ) : initiativeId && !initiative ? (
        <Content>
          <Notice>This initiative is no longer available.</Notice>
        </Content>
      ) : (
        <InitiativeEditor
          key={initiativeId ?? `${environmentId}:${projectId}`}
          target={route.params}
          initiative={initiative}
          initiatives={query.data.initiatives}
        />
      )}
    </SettingsScreen>
  );
}

function InitiativeEditor(props: {
  readonly target: InitiativeEditorTarget;
  readonly initiative: Initiative | undefined;
  readonly initiatives: readonly Initiative[];
}) {
  const { environmentId, projectId } = props.target;
  const navigation = useNavigation<NativeStackNavigationProp<InitiativeRoutes>>();
  const rootNavigation = useNavigation();
  const [initial] = useState(() => initiativeDraft(props.initiative));
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const create = useAtomCommand(serverEnvironment.createInitiative, {
    label: "initiative create",
    reportFailure: false,
  });
  const update = useAtomCommand(serverEnvironment.updateInitiative, {
    label: "initiative update",
    reportFailure: false,
  });
  const availableChoices = initiativeCoordinatorChoices(
    useThreadShells(),
    environmentId,
    projectId,
    props.initiatives,
    props.initiative?.id,
  );
  const canAttachCoordinator = !props.initiative || props.initiative.coordinatorMissing;
  const choices = canAttachCoordinator
    ? availableChoices
    : availableChoices.filter((thread) => thread.id === props.initiative?.coordinatorThreadId);
  const config = useEnvironmentServerConfig(environmentId);
  const coordinatorExists =
    choices.some((thread) => thread.id === draft.coordinatorThreadId) ||
    (props.initiative !== undefined &&
      !props.initiative.coordinatorMissing &&
      draft.coordinatorThreadId === props.initiative.coordinatorThreadId);
  const canSave =
    config?.supportsInitiatives === true &&
    coordinatorExists &&
    draft.title.trim().length > 0 &&
    draft.objective.trim().length > 0 &&
    !saving;
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const preventRemove = !saved && (changed || saving);
  usePreventRemove(preventRemove, ({ data }) => {
    if (saving) {
      Alert.alert("Saving initiative", "Wait for the initiative to finish saving before leaving.");
      return;
    }
    Alert.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  useEffect(() => {
    if (!saved) return;
    const frame = requestAnimationFrame(() => navigation.goBack());
    return () => cancelAnimationFrame(frame);
  }, [navigation, saved]);
  const save = async () => {
    if (!canSave || draft.coordinatorThreadId === null) return;
    setSaving(true);
    const input = {
      ...draft,
      coordinatorThreadId: draft.coordinatorThreadId,
      title: draft.title.trim(),
      objective: draft.objective.trim(),
    };
    try {
      const result = props.initiative
        ? await update({
            environmentId,
            input: initiativeUpdateFromDraft(
              props.initiative.id,
              initial,
              draft,
              initiativeDraft(props.initiative),
            ),
          })
        : await create({ environmentId, input: { ...input, projectId } });
      reportFailure("Could not save initiative", result);
      if (result._tag !== "Failure") setSaved(true);
    } catch (error) {
      Alert.alert(
        "Could not save initiative",
        error instanceof Error ? error.message : "The initiative could not be saved. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerBackVisible: false,
            gestureEnabled: !preventRemove,
            unstable_headerLeftItems: () => [
              withNativeGlassHeaderItem({
                type: "button",
                label: "",
                accessibilityLabel: "Back",
                icon: { type: "sfSymbol", name: "chevron.backward" },
                onPress: () => navigation.goBack(),
              }),
            ],
          }}
        />
      ) : null}
      <Content>
        <SettingsSection title="Coordinator conversation">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground-muted">
              {canAttachCoordinator
                ? "Choose a conversation in this project. Each initiative has its own coordinator. Create a conversation, then return here to select it."
                : "This conversation coordinates the initiative. Change its provider through the conversation's existing handoff controls."}
            </Text>
            <ControlPillMenu
              actions={choices.map((thread) => ({
                id: thread.id,
                title: thread.title || "Untitled conversation",
                state: thread.id === draft.coordinatorThreadId ? "on" : "off",
              }))}
              onPressAction={({ nativeEvent }) => {
                const thread = choices.find((choice) => choice.id === nativeEvent.event);
                if (thread && !saving)
                  setDraft((current) => ({ ...current, coordinatorThreadId: thread.id }));
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Choose coordinator conversation"
                disabled={saving || choices.length === 0 || !canAttachCoordinator}
                className="min-h-11 justify-center py-3 disabled:opacity-50"
              >
                <Text className="text-base text-foreground">
                  {choices.find((thread) => thread.id === draft.coordinatorThreadId)?.title ??
                    (canAttachCoordinator ? "Choose coordinator" : "Coordinator conversation")}
                </Text>
              </Pressable>
            </ControlPillMenu>
            {!coordinatorExists && draft.coordinatorThreadId !== null ? (
              <Text className="text-base text-danger-foreground">
                Choose an available coordinator before saving.
              </Text>
            ) : null}
            {canAttachCoordinator && choices.length === 0 ? (
              <Notice>No available conversations in this project yet.</Notice>
            ) : null}
            {canAttachCoordinator ? (
              <Action
                label="Create coordinator conversation"
                disabled={saving}
                onPress={() =>
                  rootNavigation.navigate("NewTaskSheet", {
                    screen: "NewTaskDraft",
                    params: { environmentId, projectId, title: "Initiative coordinator" },
                  })
                }
              />
            ) : null}
          </View>
        </SettingsSection>
        <SettingsSection title="Work brief">
          {initiativeFields.map((field) => (
            <View key={field.key} className="gap-2 border-b border-border-subtle p-4">
              <Text className="text-sm font-t3-medium text-foreground-muted">
                {field.label}
                {field.key === "title" || field.key === "objective" ? " (required)" : ""}
              </Text>
              <AppTextInput
                accessibilityLabel={field.label}
                value={draft[field.key]}
                onChangeText={(value) =>
                  setDraft((current) => ({ ...current, [field.key]: value }))
                }
                editable={!saving}
                multiline={field.key !== "title"}
                textAlignVertical="top"
                className="min-h-11 font-sans text-base text-foreground"
              />
            </View>
          ))}
        </SettingsSection>
        <Action
          label={saving ? "Saving…" : "Save initiative"}
          disabled={!canSave}
          onPress={() => void save()}
        />
      </Content>
    </>
  );
}
