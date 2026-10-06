import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type PullRequestDetail,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as InitiativeService from "../project/InitiativeService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";

const coordinatorId = ThreadId.make("initiative-coordinator");
const projectId = ProjectId.make("initiative-project");
const at = "2026-10-05T12:00:00.000Z";
const watch: ThreadPullRequestWatch = {
  startedAt: at,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: at,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
};
const thread = (id: ThreadId): ProjectionStore.ProjectionThreadPullRequests => ({
  id,
  projectId,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  settledOverride: null,
  settledAt: null,
  pullRequests: [
    {
      host: "github.com",
      repository: "org/repo",
      number: 1,
      url: "https://github.com/org/repo/pull/1",
      source: "agent",
      linkedAt: at,
      snapshot: null,
      stack: null,
      watch,
    },
  ],
});
const detail: PullRequestDetail = {
  provider: "github",
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId,
  projectTitle: "Initiative",
  workspaceRoot: "/workspace/initiative",
  repository: "org/repo",
  number: 1,
  title: "Work",
  body: "",
  url: "https://github.com/org/repo/pull/1",
  author: { login: "agent", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: at,
  updatedAt: at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent",
};

it.effect.each([
  {
    pauseDuringRead: false,
    label:
      "keeps inactive initiative watches while unrelated watches continue, then reports on resume",
  },
  {
    pauseDuringRead: true,
    label: "preserves a watch update when the initiative pauses during the host read",
  },
])("$label", ({ pauseDuringRead }) =>
  Effect.gen(function* () {
    const allowed = yield* Ref.make(pauseDuringRead);
    const pauseNextRead = yield* Ref.make(pauseDuringRead);
    const threads = yield* Ref.make<ReadonlyArray<ProjectionStore.ProjectionThreadPullRequests>>([
      thread(coordinatorId),
      ...(pauseDuringRead ? [] : [thread(ThreadId.make("unrelated-coordinator"))]),
    ]);
    const commands = yield* Ref.make<
      ReadonlyArray<
        Extract<OrchestrationV2ServerCommand, { readonly type: "thread.pull-request-watch.sync" }>
      >
    >([]);
    const withAutomaticWorkAllowed: InitiativeService.InitiativeService["Service"]["withAutomaticWorkAllowed"] =
      (threadId, work) =>
        Effect.gen(function* () {
          const active = yield* Ref.get(allowed);
          if (!active && threadId === coordinatorId) {
            return yield* new InitiativeService.InitiativeAutomaticWorkBlockedError({ threadId });
          }
          return yield* work;
        });
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(InitiativeService.InitiativeService)({
        isAutomaticWorkAllowed: (threadId) =>
          Ref.get(allowed).pipe(Effect.map((active) => active || threadId !== coordinatorId)),
        withAutomaticWorkAllowed,
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadsWithPullRequests: () => Ref.get(threads),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type === "thread.pull-request-watch.sync") {
              yield* Ref.update(commands, (current) => [...current, command]);
              yield* Ref.update(threads, (current) =>
                current.map((item) =>
                  item.id !== command.threadId
                    ? item
                    : {
                        ...item,
                        pullRequests: item.pullRequests?.map((link) =>
                          command.watch === null
                            ? { ...link, watch: undefined }
                            : { ...link, watch: command.watch },
                        ),
                      },
                ),
              );
            }
            return {} as Orchestrator.OrchestratorV2DispatchResult;
          }),
      }),
      Layer.mock(PullRequestService.PullRequestService)({
        watchFingerprint: () => Effect.succeed(null),
        detail: () =>
          Effect.gen(function* () {
            if (yield* Ref.get(pauseNextRead)) {
              yield* Ref.set(pauseNextRead, false);
              yield* Ref.set(allowed, false);
            }
            return detail;
          }),
        activity: () =>
          Effect.succeed({
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            reviewThreads: [],
            commits: [],
          }),
      }),
    );
    const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(layerDependencies));
    yield* reactor.sweep;
    const paused = (yield* Ref.get(threads)).find((item) => item.id === coordinatorId)!;
    assert.deepEqual(paused.pullRequests?.[0]?.watch, watch);
    const firstCommands = yield* Ref.get(commands);
    assert.equal(firstCommands.filter((command) => command.threadId === coordinatorId).length, 0);
    assert.equal(firstCommands.length, pauseDuringRead ? 0 : 1);

    yield* Ref.set(allowed, true);
    yield* reactor.sweep;
    const resumed = (yield* Ref.get(threads)).find((item) => item.id === coordinatorId)!;
    assert.equal(resumed.pullRequests?.[0]?.watch?.headSha, detail.headSha);
    const wakes = (yield* Ref.get(commands)).filter(
      (command) =>
        command.type === "thread.pull-request-watch.sync" &&
        command.threadId === coordinatorId &&
        command.wake !== undefined,
    );
    assert.equal(wakes.length, 1);
    yield* reactor.sweep;
    assert.equal(
      (yield* Ref.get(commands)).filter(
        (command) =>
          command.type === "thread.pull-request-watch.sync" &&
          command.threadId === coordinatorId &&
          command.wake !== undefined,
      ).length,
      1,
    );
  }),
);
