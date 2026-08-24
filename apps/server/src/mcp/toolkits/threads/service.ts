import {
  CommandId,
  MessageId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBootstrap from "../../../orchestration/ThreadBootstrap.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import {
  ThreadControlError,
  type ThreadCommandResult,
  type ThreadControlDetail,
  type ThreadControlStatus,
  type ThreadControlSummary,
  type ThreadListResult,
  type ThreadListInput,
  type ThreadListScope,
  type ThreadReadInput,
  type ThreadReadResult,
  type ThreadSendInput,
  type ThreadSpawnInput,
  type ThreadSpawnResult,
  type ThreadTargetInput,
  type ThreadWaitInput,
} from "./schema.ts";

const MAX_ASSISTANT_MESSAGE_CHARS = 64_000;

export interface ThreadControlShape {
  readonly spawn: (
    parentThreadId: ThreadId,
    input: ThreadSpawnInput,
  ) => Effect.Effect<ThreadSpawnResult, ThreadControlError>;
  readonly list: (
    callerThreadId: ThreadId,
    input: ThreadListInput,
  ) => Effect.Effect<ThreadListResult, ThreadControlError>;
  readonly get: (
    callerThreadId: ThreadId,
    input: ThreadTargetInput,
  ) => Effect.Effect<ThreadControlDetail, ThreadControlError>;
  readonly read: (
    callerThreadId: ThreadId,
    input: ThreadReadInput,
  ) => Effect.Effect<ThreadReadResult, ThreadControlError>;
  readonly send: (
    callerThreadId: ThreadId,
    input: ThreadSendInput,
  ) => Effect.Effect<ThreadCommandResult, ThreadControlError>;
  readonly interrupt: (
    callerThreadId: ThreadId,
    input: ThreadTargetInput,
  ) => Effect.Effect<ThreadCommandResult, ThreadControlError>;
  readonly wait: (
    callerThreadId: ThreadId,
    input: ThreadWaitInput,
  ) => Effect.Effect<ThreadControlDetail, ThreadControlError>;
}

export class ThreadControl extends Context.Service<ThreadControl, ThreadControlShape>()(
  "t3/mcp/toolkits/threads/service/ThreadControl",
) {}

function deriveTitle(prompt: string): string {
  const compact = prompt.trim().replaceAll(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

function statusForThread(thread: OrchestrationThreadShell): {
  readonly status: ThreadControlStatus;
  readonly blockedReason: string | null;
} {
  if (thread.hasPendingUserInput) {
    return { status: "blocked", blockedReason: "The thread is waiting for user input." };
  }
  if (thread.hasPendingApprovals) {
    return { status: "blocked", blockedReason: "The thread is waiting for approval." };
  }
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness === "working"
  ) {
    return { status: "working", blockedReason: null };
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return { status: "error", blockedReason: thread.session?.lastError ?? null };
  }
  if (thread.session?.status === "interrupted" || thread.latestTurn?.state === "interrupted") {
    return { status: "interrupted", blockedReason: null };
  }
  if (thread.latestTurn?.state === "completed") {
    return { status: "done", blockedReason: null };
  }
  return { status: "idle", blockedReason: null };
}

function summarize(thread: OrchestrationThreadShell): ThreadControlSummary {
  const state = statusForThread(thread);
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    spawnedByThreadId: thread.spawnedByThreadId ?? null,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    ...state,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurnId: thread.latestTurn?.turnId ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

interface ThreadListCursor {
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly scope: ThreadListScope;
  readonly scopeId: string | null;
}

function encodeThreadListCursor(cursor: ThreadListCursor): string {
  return Buffer.from(
    JSON.stringify({
      c: cursor.createdAt,
      t: cursor.threadId,
      s: cursor.scope,
      i: cursor.scopeId,
    }),
  ).toString("base64url");
}

function decodeThreadListCursor(encoded: string): ThreadListCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.c !== "string" ||
    typeof record.t !== "string" ||
    (record.s !== "environment" && record.s !== "project" && record.s !== "children") ||
    (record.i !== null && typeof record.i !== "string")
  ) {
    return null;
  }
  return {
    createdAt: record.c,
    threadId: ThreadId.make(record.t),
    scope: record.s,
    scopeId: record.i,
  };
}

function isAfterThreadListCursor(
  thread: OrchestrationThreadShell,
  cursor: ThreadListCursor,
): boolean {
  const createdAtOrder = thread.createdAt.localeCompare(cursor.createdAt);
  return (
    createdAtOrder > 0 || (createdAtOrder === 0 && thread.id.localeCompare(cursor.threadId) > 0)
  );
}

function latestAssistantMessage(thread: OrchestrationThread) {
  const message = thread.messages.findLast(
    (candidate) => candidate.role === "assistant" && !candidate.streaming,
  );
  if (!message) return null;
  const truncated = message.text.length > MAX_ASSISTANT_MESSAGE_CHARS;
  return {
    text: truncated ? message.text.slice(0, MAX_ASSISTANT_MESSAGE_CHARS) : message.text,
    truncated,
  };
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const bootstrap = yield* ThreadBootstrap.ThreadBootstrap;

  const readFailure = (message: string, threadId?: ThreadId) =>
    new ThreadControlError({
      reason: "read_failed",
      message,
      ...(threadId === undefined ? {} : { threadId }),
    });
  const dispatchFailure = (message: string, threadId: ThreadId) =>
    new ThreadControlError({ reason: "dispatch_failed", message, threadId });
  const randomUuid = (operation: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.mapError(
        () =>
          new ThreadControlError({
            reason: "dispatch_failed",
            message: `Could not generate an identifier for ${operation}.`,
          }),
      ),
    );

  const getSource = Effect.fn("ThreadControl.getSource")(function* (parentThreadId: ThreadId) {
    const source = yield* projection
      .getThreadShellById(parentThreadId)
      .pipe(
        Effect.mapError(() => readFailure("Could not read the source thread.", parentThreadId)),
      );
    if (Option.isNone(source)) {
      return yield* new ThreadControlError({
        reason: "source_not_found",
        message: `Source thread '${parentThreadId}' was not found.`,
        threadId: parentThreadId,
      });
    }
    return source.value;
  });

  const getTargetShell = Effect.fn("ThreadControl.getTargetShell")(function* (
    targetThreadId: ThreadId,
  ) {
    const target = yield* projection
      .getThreadShellById(targetThreadId)
      .pipe(
        Effect.mapError(() => readFailure("Could not read the target thread.", targetThreadId)),
      );
    if (Option.isNone(target)) {
      return yield* new ThreadControlError({
        reason: "target_not_found",
        message: `Target thread '${targetThreadId}' was not found.`,
        threadId: targetThreadId,
      });
    }
    return target.value;
  });

  const getTargetDetail = Effect.fn("ThreadControl.getTargetDetail")(function* (
    targetThreadId: ThreadId,
  ) {
    const shell = yield* getTargetShell(targetThreadId);
    const snapshot = yield* projection
      .getThreadDetailSnapshot(targetThreadId, { turnLimit: 1 })
      .pipe(
        Effect.mapError(() => readFailure("Could not read the target transcript.", targetThreadId)),
      );
    if (Option.isNone(snapshot)) {
      return yield* new ThreadControlError({
        reason: "target_not_found",
        message: `Target thread '${targetThreadId}' was not found.`,
        threadId: targetThreadId,
      });
    }
    return {
      ...summarize(shell),
      latestAssistantMessage: latestAssistantMessage(snapshot.value.thread),
    } satisfies ThreadControlDetail;
  });

  const enqueue = <A, E>(effect: Effect.Effect<A, E>, threadId: ThreadId) =>
    startup
      .enqueueCommand(effect)
      .pipe(
        Effect.mapError((error) =>
          dispatchFailure(
            error instanceof Error ? error.message : "Thread command failed.",
            threadId,
          ),
        ),
      );

  const spawn: ThreadControlShape["spawn"] = Effect.fn("ThreadControl.spawn")(
    function* (parentThreadId, input) {
      const source = yield* getSource(parentThreadId);
      const project = yield* projection
        .getProjectShellById(source.projectId)
        .pipe(
          Effect.mapError(() => readFailure("Could not read the source project.", parentThreadId)),
        );
      if (Option.isNone(project)) {
        return yield* new ThreadControlError({
          reason: "source_not_found",
          message: `Project for source thread '${parentThreadId}' was not found.`,
          threadId: parentThreadId,
        });
      }

      const [threadUuid, commandUuid, messageUuid, branchUuid] = yield* Effect.all([
        randomUuid("child thread"),
        randomUuid("spawn command"),
        randomUuid("initial message"),
        randomUuid("worktree branch"),
      ]);
      const childThreadId = ThreadId.make(threadUuid);
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const title = input.title ?? deriveTitle(input.prompt);
      const modelSelection = input.modelSelection ?? source.modelSelection;
      const runtimeMode = input.runtimeMode ?? source.runtimeMode;
      const interactionMode = input.interactionMode ?? source.interactionMode;
      const wantsWorktree = input.worktree !== undefined;
      const baseBranch = input.worktree?.baseBranch ?? source.branch;
      if (wantsWorktree && !baseBranch) {
        return yield* new ThreadControlError({
          reason: "invalid_worktree",
          message: "A base branch is required to create a child worktree.",
          threadId: childThreadId,
        });
      }
      const childBranch = wantsWorktree
        ? (input.worktree?.branch ?? buildTemporaryWorktreeBranchName(() => branchUuid))
        : source.branch;

      const result = yield* enqueue(
        bootstrap.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`mcp:thread-spawn:${commandUuid}`),
          threadId: childThreadId,
          message: {
            messageId: MessageId.make(messageUuid),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          bootstrap: {
            createThread: {
              projectId: source.projectId,
              spawnedByThreadId: parentThreadId,
              title,
              modelSelection,
              runtimeMode,
              interactionMode,
              branch: wantsWorktree ? baseBranch : source.branch,
              worktreePath: wantsWorktree ? null : source.worktreePath,
              createdAt,
            },
            ...(wantsWorktree
              ? {
                  prepareWorktree: {
                    projectCwd: project.value.workspaceRoot,
                    baseBranch: baseBranch!,
                    branch: childBranch!,
                    ...(input.worktree?.startFromOrigin === true ? { startFromOrigin: true } : {}),
                  },
                  runSetupScript: true,
                }
              : {}),
          },
          createdAt,
        }),
        childThreadId,
      );

      return {
        thread: {
          threadId: childThreadId,
          projectId: source.projectId,
          spawnedByThreadId: parentThreadId,
          title,
          modelSelection,
          runtimeMode,
          interactionMode,
          status: "working",
          blockedReason: null,
          branch: childBranch,
          worktreePath: result.worktreePath ?? (wantsWorktree ? null : source.worktreePath),
          latestTurnId: null,
          createdAt,
          updatedAt: createdAt,
        },
      };
    },
  );

  const list: ThreadControlShape["list"] = Effect.fn("ThreadControl.list")(
    function* (callerThreadId, input) {
      const source = yield* getSource(callerThreadId);
      const snapshot = yield* projection
        .getShellSnapshot()
        .pipe(Effect.mapError(() => readFailure("Could not list environment threads.")));
      const scope = input.scope ?? "environment";
      const scopeId =
        scope === "environment" ? null : scope === "project" ? source.projectId : callerThreadId;
      const scoped = snapshot.threads.filter((thread) => {
        switch (scope) {
          case "environment":
            return true;
          case "project":
            return thread.projectId === source.projectId;
          case "children":
            return thread.spawnedByThreadId === callerThreadId;
        }
      });
      const sorted = scoped.toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
      const cursor = input.cursor === undefined ? null : decodeThreadListCursor(input.cursor);
      if (input.cursor !== undefined && cursor === null) {
        return yield* readFailure("The thread list cursor is invalid.");
      }
      if (cursor !== null && (cursor.scope !== scope || cursor.scopeId !== scopeId)) {
        return yield* readFailure("The thread list cursor does not match the requested scope.");
      }
      const remaining =
        cursor === null
          ? sorted
          : sorted.filter((thread) => isAfterThreadListCursor(thread, cursor));
      const limit = input.limit ?? 100;
      const page = remaining.slice(0, limit);
      const last = page.at(-1);
      return {
        threads: page.map(summarize),
        nextCursor:
          remaining.length > page.length && last !== undefined
            ? encodeThreadListCursor({
                createdAt: last.createdAt,
                threadId: last.id,
                scope,
                scopeId,
              })
            : null,
      };
    },
  );

  const get: ThreadControlShape["get"] = Effect.fn("ThreadControl.get")(
    function* (callerThreadId, input) {
      yield* getSource(callerThreadId);
      return yield* getTargetDetail(input.threadId);
    },
  );

  const read: ThreadControlShape["read"] = Effect.fn("ThreadControl.read")(
    function* (callerThreadId, input) {
      yield* getSource(callerThreadId);
      yield* getTargetShell(input.threadId);
      const snapshot = yield* projection
        .getThreadDetailSnapshot(input.threadId, {
          turnLimit: input.turnLimit ?? 20,
          ...(input.beforeCursor === undefined ? {} : { beforeCursor: input.beforeCursor }),
        })
        .pipe(
          Effect.mapError(() =>
            readFailure("Could not read the target transcript.", input.threadId),
          ),
        );
      if (Option.isNone(snapshot)) {
        return yield* new ThreadControlError({
          reason: "target_not_found",
          message: `Target thread '${input.threadId}' was not found.`,
          threadId: input.threadId,
        });
      }
      return {
        threadId: input.threadId,
        messages: snapshot.value.thread.messages,
        activities: input.includeActivities === false ? [] : snapshot.value.thread.activities,
        beforeCursor: snapshot.value.page?.beforeCursor ?? null,
        hasMore: snapshot.value.page?.hasMore ?? false,
        snapshotSequence: snapshot.value.snapshotSequence,
      };
    },
  );

  const send: ThreadControlShape["send"] = Effect.fn("ThreadControl.send")(
    function* (callerThreadId, input) {
      yield* getSource(callerThreadId);
      const target = yield* getTargetShell(input.threadId);
      const [commandUuid, messageUuid] = yield* Effect.all([
        randomUuid("send command"),
        randomUuid("follow-up message"),
      ]);
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const result = yield* enqueue(
        bootstrap.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`mcp:thread-send:${commandUuid}`),
          threadId: target.id,
          message: {
            messageId: MessageId.make(messageUuid),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: target.modelSelection,
          titleSeed: deriveTitle(input.prompt),
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          createdAt,
        }),
        target.id,
      );
      return { threadId: target.id, sequence: result.sequence };
    },
  );

  const interrupt: ThreadControlShape["interrupt"] = Effect.fn("ThreadControl.interrupt")(
    function* (callerThreadId, input) {
      yield* getSource(callerThreadId);
      const target = yield* getTargetShell(input.threadId);
      const commandUuid = yield* randomUuid("interrupt command");
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const result = yield* enqueue(
        bootstrap.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`mcp:thread-interrupt:${commandUuid}`),
          threadId: target.id,
          ...(target.latestTurn?.state === "running" ? { turnId: target.latestTurn.turnId } : {}),
          createdAt,
        }),
        target.id,
      );
      return { threadId: target.id, sequence: result.sequence };
    },
  );

  const wait: ThreadControlShape["wait"] = Effect.fn("ThreadControl.wait")(
    function* (callerThreadId, input) {
      yield* getSource(callerThreadId);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<void>();
          yield* Effect.forkScoped(
            engine.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.aggregateKind === "thread" &&
                  event.aggregateId === input.threadId &&
                  (event.type === "thread.session-set" ||
                    event.type === "thread.turn-diff-completed" ||
                    event.type === "thread.activity-appended" ||
                    event.type === "thread.archived" ||
                    event.type === "thread.deleted"),
              ),
              Stream.runForEach(() => Queue.offer(events, undefined)),
            ),
            { startImmediately: true },
          );

          const current = yield* getTargetDetail(input.threadId);
          if (current.status !== "working") return current;

          const completed = Stream.fromQueue(events).pipe(
            Stream.mapEffect(() => getTargetDetail(input.threadId)),
            Stream.filter((detail) => detail.status !== "working"),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Thread status stream ended unexpectedly."),
                onSome: (detail) => Effect.succeed(detail),
              }),
            ),
          );
          return yield* completed.pipe(
            Effect.timeoutOrElse({
              duration: `${input.timeoutSeconds ?? 120} seconds`,
              orElse: () =>
                Effect.fail(
                  new ThreadControlError({
                    reason: "timeout",
                    message: `Timed out waiting for thread '${input.threadId}'.`,
                    threadId: input.threadId,
                  }),
                ),
            }),
          );
        }),
      );
    },
  );

  return ThreadControl.of({ spawn, list, get, read, send, interrupt, wait });
});

export const layer = Layer.effect(ThreadControl, make);
