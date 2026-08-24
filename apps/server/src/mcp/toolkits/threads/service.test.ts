import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  OrchestrationDispatchCommandError,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadDetailWindow,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBootstrap from "../../../orchestration/ThreadBootstrap.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as ThreadControl from "./service.ts";
import type { ThreadControlError } from "./schema.ts";

const now = "2026-08-19T00:00:00.000Z";
const parentThreadId = ThreadId.make("thread-parent");
const projectId = ProjectId.make("project-parent");

const sourceThread: OrchestrationThreadShell = {
  id: parentThreadId,
  projectId,
  title: "Parent",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: "/tmp/project-parent",
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Parent project",
  workspaceRoot: "/tmp/project-parent",
  defaultModelSelection: sourceThread.modelSelection,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};

const toThreadDetail = (
  shell: OrchestrationThreadShell,
  overrides?: Partial<OrchestrationThread>,
): OrchestrationThread => ({
  ...shell,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  ...overrides,
});

const makeControl = (input: {
  readonly commands: Array<OrchestrationCommand>;
  readonly getThread?: (threadId: ThreadId) => OrchestrationThreadShell | undefined;
  readonly children?: ReadonlyArray<OrchestrationThreadShell>;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly getDetail?: (
    threadId: ThreadId,
    window: OrchestrationThreadDetailWindow | undefined,
  ) => OrchestrationThreadDetailSnapshot | undefined;
  readonly worktreePath?: string;
  readonly domainEvents?: Stream.Stream<OrchestrationEvent>;
  readonly getProject?: (projectId: ProjectId) => OrchestrationProjectShell | undefined;
  readonly bootstrapDispatch?: ThreadBootstrap.ThreadBootstrapShape["dispatch"];
}) => {
  const additionalThreads = input.threads ?? input.children ?? [];
  const threads = [sourceThread, ...additionalThreads].filter(
    (thread, index, all) => all.findIndex((candidate) => candidate.id === thread.id) === index,
  );
  const findThread = (threadId: ThreadId) =>
    input.getThread ? input.getThread(threadId) : threads.find((thread) => thread.id === threadId);
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(findThread(threadId))),
    getProjectShellById: (requestedProjectId) =>
      Effect.succeed(
        Option.fromNullishOr(
          input.getProject
            ? input.getProject(requestedProjectId)
            : requestedProjectId === project.id
              ? project
              : undefined,
        ),
      ),
    getShellSnapshot: () =>
      Effect.succeed({ snapshotSequence: 1, projects: [project], threads, updatedAt: now }),
    getThreadDetailSnapshot: (threadId, window) => {
      const detail = input.getDetail?.(threadId, window);
      if (detail !== undefined) return Effect.succeed(Option.some(detail));
      const shell = findThread(threadId);
      return Effect.succeed(
        shell === undefined
          ? Option.none()
          : Option.some({
              snapshotSequence: 1,
              thread: toThreadDetail(shell),
              page: {
                beforeCursor: null,
                hasMore: false,
                snapshotSequence: 1,
                threadSequence: 1,
              },
            }),
      );
    },
  });
  const engineLayer = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
    streamDomainEvents: input.domainEvents ?? Stream.empty,
  });
  const startupLayer = Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
    enqueueCommand: (effect) => effect,
  });
  const bootstrapLayer = Layer.succeed(
    ThreadBootstrap.ThreadBootstrap,
    ThreadBootstrap.ThreadBootstrap.of({
      dispatch:
        input.bootstrapDispatch ??
        ((command) =>
          Effect.sync(() => {
            input.commands.push(command);
            return {
              sequence: input.commands.length,
              ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
            };
          })),
    }),
  );

  return ThreadControl.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        projectionLayer,
        engineLayer,
        startupLayer,
        bootstrapLayer,
        NodeServices.layer,
      ),
    ),
  );
};

it.effect("spawns a child chat in the parent's checkout by default", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const control = yield* makeControl({ commands });

    const result = yield* control.spawn(parentThreadId, { prompt: "Inspect the failing test" });
    const command = commands[0];

    assert.equal(command?.type, "thread.turn.start");
    if (command?.type !== "thread.turn.start") return;
    assert.equal(command.bootstrap?.createThread?.spawnedByThreadId, parentThreadId);
    assert.equal(command.bootstrap?.createThread?.projectId, projectId);
    assert.deepEqual(command.bootstrap?.createThread?.modelSelection, sourceThread.modelSelection);
    assert.equal(command.bootstrap?.createThread?.runtimeMode, sourceThread.runtimeMode);
    assert.equal(command.bootstrap?.createThread?.interactionMode, sourceThread.interactionMode);
    assert.equal(command.bootstrap?.createThread?.branch, "main");
    assert.equal(command.bootstrap?.createThread?.worktreePath, "/tmp/project-parent");
    assert.equal(command.bootstrap?.prepareWorktree, undefined);
    assert.deepEqual(command.modelSelection, sourceThread.modelSelection);
    assert.equal(command.runtimeMode, sourceThread.runtimeMode);
    assert.equal(command.interactionMode, sourceThread.interactionMode);
    assert.equal(result.thread.worktreePath, "/tmp/project-parent");
  }),
);

it.effect("spawns an isolated child worktree and runs project setup", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const control = yield* makeControl({ commands, worktreePath: "/tmp/child-worktree" });

    const result = yield* control.spawn(parentThreadId, {
      prompt: "Implement the isolated change",
      title: "Isolated child",
      worktree: {
        baseBranch: "main",
        branch: "agent/isolated-child",
        startFromOrigin: true,
      },
    });
    const command = commands[0];

    assert.equal(command?.type, "thread.turn.start");
    if (command?.type !== "thread.turn.start") return;
    assert.deepEqual(command.bootstrap?.prepareWorktree, {
      projectCwd: "/tmp/project-parent",
      baseBranch: "main",
      branch: "agent/isolated-child",
      startFromOrigin: true,
    });
    assert.equal(command.bootstrap?.runSetupScript, true);
    assert.equal(command.bootstrap?.createThread?.worktreePath, null);
    assert.equal(result.thread.branch, "agent/isolated-child");
    assert.equal(result.thread.worktreePath, "/tmp/child-worktree");
  }),
);

it.effect("rejects an isolated worktree when no base branch can be resolved", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const branchlessSource = { ...sourceThread, branch: null };
    const control = yield* makeControl({
      commands,
      getThread: (threadId) => (threadId === parentThreadId ? branchlessSource : undefined),
    });

    const error = yield* Effect.flip(
      control.spawn(parentThreadId, { prompt: "Use an isolated checkout", worktree: {} }),
    );

    assert.equal(error.reason, "invalid_worktree");
    assert.include(error.message, "base branch");
    assert.deepEqual(commands, []);
  }),
);

it.effect("derives a bounded title while preserving the complete initial prompt", () =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const prompt = `Investigate ${"a very detailed regression ".repeat(10)}`;
    const control = yield* makeControl({ commands });

    const result = yield* control.spawn(parentThreadId, { prompt });

    assert.equal(result.thread.title.length, 72);
    assert.equal(result.thread.title.endsWith("..."), true);
    assert.equal(commands[0]?.type, "thread.turn.start");
    if (commands[0]?.type === "thread.turn.start") {
      assert.equal(commands[0].message.text, prompt);
      assert.equal(commands[0].titleSeed, result.thread.title);
    }
  }),
);

it.effect("reports source_not_found when the caller chat is no longer active", () =>
  Effect.gen(function* () {
    const control = yield* makeControl({
      commands: [],
      getThread: () => undefined,
    });

    const error = yield* Effect.flip(
      control.spawn(parentThreadId, { prompt: "This must not start" }),
    );

    assert.equal(error.reason, "source_not_found");
    assert.equal(error.threadId, parentThreadId);
  }),
);

it.effect("reports source_not_found when the caller project is unavailable", () =>
  Effect.gen(function* () {
    const control = yield* makeControl({
      commands: [],
      getProject: () => undefined,
    });

    const error = yield* Effect.flip(
      control.spawn(parentThreadId, { prompt: "This must not start" }),
    );

    assert.equal(error.reason, "source_not_found");
    assert.include(error.message, "Project");
  }),
);

it.effect("inspects an unrelated chat in the same environment", () =>
  Effect.gen(function* () {
    const unrelatedId = ThreadId.make("thread-unrelated");
    const control = yield* makeControl({
      commands: [],
      getThread: (threadId) =>
        threadId === unrelatedId
          ? {
              ...sourceThread,
              id: unrelatedId,
              spawnedByThreadId: ThreadId.make("another-parent"),
            }
          : sourceThread,
    });

    const detail = yield* control.get(parentThreadId, { threadId: unrelatedId });
    assert.equal(detail.threadId, unrelatedId);
    assert.equal(detail.spawnedByThreadId, ThreadId.make("another-parent"));
    assert.equal(detail.status, "idle");
  }),
);

it.effect("reports a completed child as done", () =>
  Effect.gen(function* () {
    const child: OrchestrationThreadShell = {
      ...sourceThread,
      id: ThreadId.make("thread-completed-child"),
      spawnedByThreadId: parentThreadId,
      latestTurn: {
        turnId: TurnId.make("turn-completed-child"),
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
    };
    const control = yield* makeControl({ commands: [], children: [child] });

    const result = yield* control.list(parentThreadId, { scope: "children" });

    assert.equal(result.threads[0]?.status, "done");
    assert.equal(result.nextCursor, null);
  }),
);

it.effect("lists the environment by default and narrows only when a scope is requested", () =>
  Effect.gen(function* () {
    const directChild = {
      ...sourceThread,
      id: ThreadId.make("thread-direct-child"),
      spawnedByThreadId: parentThreadId,
      createdAt: `${now}.1`,
    };
    const grandchild = {
      ...sourceThread,
      id: ThreadId.make("thread-grandchild"),
      spawnedByThreadId: directChild.id,
      createdAt: `${now}.2`,
    };
    const unrelatedProjectThread = {
      ...sourceThread,
      id: ThreadId.make("thread-other-project"),
      projectId: ProjectId.make("project-other"),
      createdAt: `${now}.3`,
    };
    const control = yield* makeControl({
      commands: [],
      threads: [directChild, grandchild, unrelatedProjectThread],
    });

    const environment = yield* control.list(parentThreadId, {});
    const currentProject = yield* control.list(parentThreadId, { scope: "project" });
    const children = yield* control.list(parentThreadId, { scope: "children" });

    assert.deepEqual(
      environment.threads.map(({ threadId }) => threadId),
      [parentThreadId, directChild.id, grandchild.id, unrelatedProjectThread.id],
    );
    assert.deepEqual(
      currentProject.threads.map(({ threadId }) => threadId),
      [parentThreadId, directChild.id, grandchild.id],
    );
    assert.deepEqual(
      children.threads.map(({ threadId }) => threadId),
      [directChild.id],
    );
  }),
);

it.effect("bounds the default environment page to one hundred chats", () =>
  Effect.gen(function* () {
    const threads = Array.from({ length: 150 }, (_, index) => ({
      ...sourceThread,
      id: ThreadId.make(`thread-bounded-${String(index).padStart(3, "0")}`),
      createdAt: `2026-08-20T00:00:${String(index).padStart(3, "0")}Z`,
    }));
    const control = yield* makeControl({ commands: [], threads });

    const firstPage = yield* control.list(parentThreadId, {});
    const secondPage = yield* control.list(parentThreadId, { cursor: firstPage.nextCursor! });

    assert.equal(firstPage.threads.length, 100);
    assert.notEqual(firstPage.nextCursor, null);
    assert.equal(secondPage.threads.length, 51);
    assert.equal(secondPage.nextCursor, null);
    assert.equal(
      new Set([...firstPage.threads, ...secondPage.threads].map(({ threadId }) => threadId)).size,
      151,
    );
  }),
);

it.effect("maps every observable thread lifecycle to a stable control status", () =>
  Effect.gen(function* () {
    const makeThread = (
      id: string,
      overrides: Partial<OrchestrationThreadShell>,
    ): OrchestrationThreadShell => ({
      ...sourceThread,
      id: ThreadId.make(id),
      createdAt: `${now}.${id}`,
      ...overrides,
    });
    const threads = [
      makeThread("blocked-input", { hasPendingUserInput: true }),
      makeThread("blocked-approval", { hasPendingApprovals: true }),
      makeThread("working-starting", {
        session: {
          threadId: ThreadId.make("working-starting"),
          status: "starting",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      }),
      makeThread("working-turn", {
        latestTurn: {
          turnId: TurnId.make("turn-working"),
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      makeThread("error", {
        session: {
          threadId: ThreadId.make("error"),
          status: "error",
          providerName: "Claude",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "provider exited",
          updatedAt: now,
        },
      }),
      makeThread("interrupted", {
        latestTurn: {
          turnId: TurnId.make("turn-interrupted"),
          state: "interrupted",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: null,
        },
      }),
      makeThread("done", {
        latestTurn: {
          turnId: TurnId.make("turn-done"),
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: null,
        },
      }),
      makeThread("idle", {}),
    ];
    const control = yield* makeControl({ commands: [], threads });

    const result = yield* control.list(parentThreadId, {});
    const statuses = Object.fromEntries(
      result.threads.map((thread) => [thread.threadId, [thread.status, thread.blockedReason]]),
    );

    assert.deepEqual(statuses["blocked-input"], [
      "blocked",
      "The thread is waiting for user input.",
    ]);
    assert.deepEqual(statuses["blocked-approval"], [
      "blocked",
      "The thread is waiting for approval.",
    ]);
    assert.deepEqual(statuses["working-starting"], ["working", null]);
    assert.deepEqual(statuses["working-turn"], ["working", null]);
    assert.deepEqual(statuses.error, ["error", "provider exited"]);
    assert.deepEqual(statuses.interrupted, ["interrupted", null]);
    assert.deepEqual(statuses.done, ["done", null]);
    assert.deepEqual(statuses.idle, ["idle", null]);
  }),
);

it.effect("paginates environment-wide thread discovery", () =>
  Effect.gen(function* () {
    const first = { ...sourceThread, id: ThreadId.make("thread-a"), createdAt: `${now}.1` };
    const second = { ...sourceThread, id: ThreadId.make("thread-b"), createdAt: `${now}.2` };
    const third = { ...sourceThread, id: ThreadId.make("thread-c"), createdAt: `${now}.3` };
    const control = yield* makeControl({ commands: [], threads: [first, second, third] });

    const firstPage = yield* control.list(parentThreadId, { limit: 2 });
    assert.deepEqual(
      firstPage.threads.map((thread) => thread.threadId),
      [parentThreadId, first.id],
    );
    assert.notEqual(firstPage.nextCursor, null);

    const secondPage = yield* control.list(parentThreadId, {
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    assert.deepEqual(
      secondPage.threads.map((thread) => thread.threadId),
      [second.id, third.id],
    );
    assert.equal(secondPage.nextCursor, null);
  }),
);

it.effect("rejects an invalid environment-list cursor", () =>
  Effect.gen(function* () {
    const control = yield* makeControl({ commands: [] });

    const error = yield* Effect.flip(
      control.list(parentThreadId, { cursor: "not-a-valid-cursor" }),
    );

    assert.equal(error.reason, "read_failed");
    assert.include(error.message, "cursor");
  }),
);

it.effect("rejects a list cursor when the requested scope changes", () =>
  Effect.gen(function* () {
    const child = {
      ...sourceThread,
      id: ThreadId.make("thread-cursor-child"),
      spawnedByThreadId: parentThreadId,
      createdAt: `${now}.1`,
    };
    const control = yield* makeControl({ commands: [], threads: [child] });
    const environmentPage = yield* control.list(parentThreadId, {
      scope: "environment",
      limit: 1,
    });

    const error = yield* Effect.flip(
      control.list(parentThreadId, {
        scope: "children",
        cursor: environmentPage.nextCursor!,
      }),
    );

    assert.equal(error.reason, "read_failed");
    assert.include(error.message, "scope");
  }),
);

it.effect("requires the calling chat to remain active", () =>
  Effect.gen(function* () {
    const control = yield* makeControl({ commands: [] });

    const error = yield* Effect.flip(
      control.get(ThreadId.make("missing-caller"), { threadId: parentThreadId }),
    );

    assert.equal(error.reason, "source_not_found");
  }),
);

it.effect("reads complete pageable transcript records from an unrelated chat", () =>
  Effect.gen(function* () {
    const unrelatedId = ThreadId.make("thread-transcript-target");
    const unrelated = {
      ...sourceThread,
      id: unrelatedId,
      spawnedByThreadId: ThreadId.make("another-parent"),
    };
    const turnId = TurnId.make("turn-transcript");
    const windows: Array<OrchestrationThreadDetailWindow | undefined> = [];
    const control = yield* makeControl({
      commands: [],
      threads: [unrelated],
      getDetail: (_threadId, window) => {
        windows.push(window);
        return {
          snapshotSequence: 17,
          thread: toThreadDetail(unrelated, {
            messages: [
              {
                id: MessageId.make("message-user"),
                role: "user",
                text: "Investigate the regression",
                turnId,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: MessageId.make("message-assistant"),
                role: "assistant",
                text: "The regression is fixed.",
                turnId,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
            activities: [
              {
                id: EventId.make("activity-command"),
                tone: "tool",
                kind: "tool.completed",
                summary: "Focused tests passed",
                payload: { command: "vp test run" },
                turnId,
                createdAt: now,
              },
            ],
          }),
          page: {
            beforeCursor: "older-page",
            hasMore: true,
            snapshotSequence: 17,
            threadSequence: 16,
          },
        };
      },
    });

    const result = yield* control.read(parentThreadId, {
      threadId: unrelatedId,
      turnLimit: 5,
    });

    assert.deepEqual(
      result.messages.map((message) => message.text),
      ["Investigate the regression", "The regression is fixed."],
    );
    assert.equal(result.activities[0]?.summary, "Focused tests passed");
    assert.equal(result.beforeCursor, "older-page");
    assert.equal(result.hasMore, true);
    assert.equal(result.snapshotSequence, 17);
    assert.deepEqual(windows, [{ turnLimit: 5 }]);
  }),
);

it.effect("uses a bounded transcript window by default and can omit activities", () =>
  Effect.gen(function* () {
    const targetId = ThreadId.make("thread-read-defaults");
    const target = { ...sourceThread, id: targetId };
    const windows: Array<OrchestrationThreadDetailWindow | undefined> = [];
    const control = yield* makeControl({
      commands: [],
      threads: [target],
      getDetail: (_threadId, window) => {
        windows.push(window);
        return {
          snapshotSequence: 23,
          thread: toThreadDetail(target, {
            activities: [
              {
                id: EventId.make("activity-hidden"),
                tone: "tool",
                kind: "tool.completed",
                summary: "Should be omitted",
                payload: {},
                turnId: null,
                createdAt: now,
              },
            ],
          }),
          page: {
            beforeCursor: "page-before-default",
            hasMore: true,
            snapshotSequence: 23,
            threadSequence: 21,
          },
        };
      },
    });

    const result = yield* control.read(parentThreadId, {
      threadId: targetId,
      beforeCursor: "page-after-newest",
      includeActivities: false,
    });

    assert.deepEqual(windows, [{ turnLimit: 20, beforeCursor: "page-after-newest" }]);
    assert.deepEqual(result.activities, []);
    assert.equal(result.beforeCursor, "page-before-default");
    assert.equal(result.hasMore, true);
  }),
);

it.effect("returns the latest completed assistant message without an unbounded payload", () =>
  Effect.gen(function* () {
    const targetId = ThreadId.make("thread-latest-message");
    const target = { ...sourceThread, id: targetId };
    const oversized = "x".repeat(64_001);
    const control = yield* makeControl({
      commands: [],
      threads: [target],
      getDetail: () => ({
        snapshotSequence: 1,
        thread: toThreadDetail(target, {
          messages: [
            {
              id: MessageId.make("message-complete"),
              role: "assistant",
              text: oversized,
              turnId: TurnId.make("turn-complete"),
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: MessageId.make("message-streaming"),
              role: "assistant",
              text: "partial text must not replace the completed answer",
              turnId: TurnId.make("turn-streaming"),
              streaming: true,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
        page: {
          beforeCursor: null,
          hasMore: false,
          snapshotSequence: 1,
          threadSequence: 1,
        },
      }),
    });

    const result = yield* control.get(parentThreadId, { threadId: targetId });

    assert.equal(result.latestAssistantMessage?.text, "x".repeat(64_000));
    assert.equal(result.latestAssistantMessage?.truncated, true);
  }),
);

it.effect("returns target_not_found consistently for missing environment chats", () =>
  Effect.gen(function* () {
    const control = yield* makeControl({ commands: [] });
    const missing = ThreadId.make("thread-missing-target");
    const operations: ReadonlyArray<() => Effect.Effect<unknown, ThreadControlError>> = [
      () => control.get(parentThreadId, { threadId: missing }),
      () => control.read(parentThreadId, { threadId: missing }),
      () => control.send(parentThreadId, { threadId: missing, prompt: "hello" }),
      () => control.interrupt(parentThreadId, { threadId: missing }),
      () => control.wait(parentThreadId, { threadId: missing }),
    ];

    for (const operation of operations) {
      const result = yield* Effect.result(operation());
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "target_not_found");
        assert.equal(result.failure.threadId, missing);
      }
    }
  }),
);

it.effect("sends follow-ups and interrupts any environment thread", () =>
  Effect.gen(function* () {
    const childThreadId = ThreadId.make("thread-child");
    const turnId = TurnId.make("turn-child");
    const child: OrchestrationThreadShell = {
      ...sourceThread,
      id: childThreadId,
      spawnedByThreadId: ThreadId.make("another-parent"),
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const commands: Array<OrchestrationCommand> = [];
    const control = yield* makeControl({
      commands,
      getThread: (threadId) => (threadId === childThreadId ? child : sourceThread),
    });

    yield* control.send(parentThreadId, {
      threadId: childThreadId,
      prompt: "Also check the mobile path",
    });
    yield* control.interrupt(parentThreadId, { threadId: childThreadId });

    assert.equal(commands[0]?.type, "thread.turn.start");
    if (commands[0]?.type === "thread.turn.start") {
      assert.equal(commands[0].threadId, childThreadId);
      assert.equal(commands[0].message.text, "Also check the mobile path");
      assert.equal(commands[0].bootstrap, undefined);
    }
    assert.equal(commands[1]?.type, "thread.turn.interrupt");
    if (commands[1]?.type === "thread.turn.interrupt") {
      assert.equal(commands[1].threadId, childThreadId);
      assert.equal(commands[1].turnId, turnId);
    }
  }),
);

it.effect("uses the target chat's provider and modes for a cross-project follow-up", () =>
  Effect.gen(function* () {
    const targetId = ThreadId.make("thread-cross-project-send");
    const target: OrchestrationThreadShell = {
      ...sourceThread,
      id: targetId,
      projectId: ProjectId.make("project-cross-project"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5",
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    };
    const commands: Array<OrchestrationCommand> = [];
    const control = yield* makeControl({ commands, threads: [target] });

    yield* control.send(parentThreadId, {
      threadId: targetId,
      prompt: "Continue in the target's own runtime",
    });

    assert.equal(commands[0]?.type, "thread.turn.start");
    if (commands[0]?.type === "thread.turn.start") {
      assert.equal(commands[0].threadId, targetId);
      assert.deepEqual(commands[0].modelSelection, target.modelSelection);
      assert.equal(commands[0].runtimeMode, "approval-required");
      assert.equal(commands[0].interactionMode, "plan");
      assert.equal(commands[0].bootstrap, undefined);
    }
  }),
);

it.effect("waits on domain events instead of polling until a working chat completes", () =>
  Effect.gen(function* () {
    const targetId = ThreadId.make("thread-event-wait");
    const running: OrchestrationThreadShell = {
      ...sourceThread,
      id: targetId,
      latestTurn: {
        turnId: TurnId.make("turn-event-wait"),
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const completed: OrchestrationThreadShell = {
      ...running,
      latestTurn: {
        ...running.latestTurn!,
        state: "completed",
        completedAt: now,
      },
    };
    let targetReads = 0;
    const completionEvent = {
      sequence: 99,
      eventId: EventId.make("event-turn-completed"),
      aggregateKind: "thread",
      aggregateId: targetId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.turn-diff-completed",
      payload: {},
    } as OrchestrationEvent;
    const control = yield* makeControl({
      commands: [],
      threads: [running],
      domainEvents: Stream.make(completionEvent),
      getThread: (threadId) => {
        if (threadId === parentThreadId) return sourceThread;
        if (threadId !== targetId) return undefined;
        targetReads += 1;
        return targetReads === 1 ? running : completed;
      },
    });

    const result = yield* control.wait(parentThreadId, {
      threadId: targetId,
      timeoutSeconds: 5,
    });

    assert.equal(result.status, "done");
    assert.equal(result.latestTurnId, TurnId.make("turn-event-wait"));
  }),
);

it.effect("returns terminal blocked and interrupted states without waiting", () =>
  Effect.gen(function* () {
    const blocked = {
      ...sourceThread,
      id: ThreadId.make("thread-wait-blocked"),
      hasPendingUserInput: true,
    };
    const interrupted = {
      ...sourceThread,
      id: ThreadId.make("thread-wait-interrupted"),
      latestTurn: {
        turnId: TurnId.make("turn-wait-interrupted"),
        state: "interrupted" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
    };
    const control = yield* makeControl({ commands: [], threads: [blocked, interrupted] });

    const blockedResult = yield* control.wait(parentThreadId, { threadId: blocked.id });
    const interruptedResult = yield* control.wait(parentThreadId, {
      threadId: interrupted.id,
    });

    assert.equal(blockedResult.status, "blocked");
    assert.equal(interruptedResult.status, "interrupted");
  }),
);

it.effect("fails with a stable timeout when a working chat does not settle", () =>
  Effect.gen(function* () {
    const targetId = ThreadId.make("thread-wait-timeout");
    const running: OrchestrationThreadShell = {
      ...sourceThread,
      id: targetId,
      latestTurn: {
        turnId: TurnId.make("turn-wait-timeout"),
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const control = yield* makeControl({
      commands: [],
      threads: [running],
      domainEvents: Stream.never,
    });
    const pending = yield* Effect.flip(
      control.wait(parentThreadId, { threadId: targetId, timeoutSeconds: 5 }),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust("5 seconds");
    const error = yield* Fiber.join(pending);

    assert.equal(error.reason, "timeout");
    assert.equal(error.threadId, targetId);
    assert.equal(error.message, `Timed out waiting for thread '${targetId}'.`);
  }),
);

it.effect("returns a stable dispatch_failed error when orchestration rejects a command", () =>
  Effect.gen(function* () {
    const control = yield* makeControl({
      commands: [],
      bootstrapDispatch: () =>
        Effect.fail(
          new OrchestrationDispatchCommandError({
            message: "orchestration queue unavailable",
          }),
        ),
    });

    const error = yield* Effect.flip(
      control.send(parentThreadId, {
        threadId: parentThreadId,
        prompt: "Try the command",
      }),
    );

    assert.equal(error.reason, "dispatch_failed");
    assert.equal(error.threadId, parentThreadId);
    assert.include(error.message, "orchestration queue unavailable");
  }),
);
