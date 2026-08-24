import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";

export interface ThreadBootstrapDispatchResult {
  readonly sequence: number;
  readonly worktreePath?: string | null;
}

export interface ThreadBootstrapShape {
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<ThreadBootstrapDispatchResult, OrchestrationDispatchCommandError>;
}

export class ThreadBootstrap extends Context.Service<ThreadBootstrap, ThreadBootstrapShape>()(
  "t3/orchestration/ThreadBootstrap",
) {}

const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function setupFailureDetail(error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      if (
        typeof error.cause === "object" &&
        error.cause !== null &&
        "message" in error.cause &&
        typeof error.cause.message === "string"
      ) {
        return error.cause.message;
      }
      return String(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
  }
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  const toDispatchError = (cause: unknown, fallbackMessage: string) =>
    isDispatchError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });
  const randomUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      toDispatchError(cause, "Failed to generate orchestration command identifier."),
    ),
  );
  const commandId = (tag: string) =>
    randomUuid.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const eventId = randomUuid.pipe(Effect.map(EventId.make));
  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.all({
      commandId: commandId("setup-script-activity"),
      activityId: eventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const dispatchBootstrap = Effect.fn("ThreadBootstrap.dispatchBootstrap")(function* (
    command: Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>,
  ) {
    const bootstrap = command.bootstrap;
    const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
    let createdThread = false;
    let targetProjectId = bootstrap?.createThread?.projectId;
    let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
    let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;
    let createdWorktreePath: string | null = null;

    const cleanupCreatedThread = () =>
      createdThread
        ? commandId("bootstrap-thread-delete").pipe(
            Effect.flatMap((cleanupCommandId) =>
              orchestrationEngine.dispatch({
                type: "thread.delete",
                commandId: cleanupCommandId,
                threadId: command.threadId,
              }),
            ),
            Effect.ignoreCause({ log: true }),
          )
        : Effect.void;

    const cleanupCreatedWorktree = () =>
      createdWorktreePath && targetProjectCwd
        ? gitWorkflow
            .removeWorktree({
              cwd: targetProjectCwd,
              path: createdWorktreePath,
              force: true,
            })
            .pipe(Effect.ignoreCause({ log: true }))
        : Effect.void;

    const recordSetupScriptLaunchFailure = (input: {
      readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
      readonly requestedAt: string;
      readonly worktreePath: string;
    }) => {
      const detail = setupFailureDetail(input.error);
      return appendSetupScriptActivity({
        threadId: command.threadId,
        kind: "setup-script.failed",
        summary: "Setup script failed to start",
        createdAt: input.requestedAt,
        payload: { detail, worktreePath: input.worktreePath },
        tone: "error",
      }).pipe(
        Effect.ignoreCause({ log: false }),
        Effect.flatMap(() =>
          Effect.logWarning("bootstrap turn start failed to launch setup script", {
            threadId: command.threadId,
            worktreePath: input.worktreePath,
            detail,
          }),
        ),
      );
    };

    const recordSetupScriptStarted = (input: {
      readonly requestedAt: string;
      readonly worktreePath: string;
      readonly scriptId: string;
      readonly scriptName: string;
      readonly terminalId: string;
    }) =>
      Effect.gen(function* () {
        const startedAt = yield* nowIso;
        const payload = {
          scriptId: input.scriptId,
          scriptName: input.scriptName,
          terminalId: input.terminalId,
          worktreePath: input.worktreePath,
        };
        yield* Effect.all([
          appendSetupScriptActivity({
            threadId: command.threadId,
            kind: "setup-script.requested",
            summary: "Starting setup script",
            createdAt: input.requestedAt,
            payload,
            tone: "info",
          }),
          appendSetupScriptActivity({
            threadId: command.threadId,
            kind: "setup-script.started",
            summary: "Setup script started",
            createdAt: startedAt,
            payload,
            tone: "info",
          }),
        ]).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning(
              "bootstrap turn start launched setup script but failed to record setup activity",
              {
                threadId: command.threadId,
                worktreePath: input.worktreePath,
                scriptId: input.scriptId,
                terminalId: input.terminalId,
                detail: error.message,
              },
            ),
          ),
        );
      });

    const runSetupProgram = () =>
      Effect.gen(function* () {
        if (!bootstrap?.runSetupScript || !targetWorktreePath) return;
        const worktreePath = targetWorktreePath;
        const requestedAt = yield* nowIso;
        yield* projectSetupScriptRunner
          .runForThread({
            threadId: command.threadId,
            ...(targetProjectId ? { projectId: targetProjectId } : {}),
            ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
            worktreePath,
          })
          .pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                recordSetupScriptLaunchFailure({ error, requestedAt, worktreePath }),
              onSuccess: (setupResult) =>
                setupResult.status === "started"
                  ? recordSetupScriptStarted({
                      requestedAt,
                      worktreePath,
                      scriptId: setupResult.scriptId,
                      scriptName: setupResult.scriptName,
                      terminalId: setupResult.terminalId,
                    })
                  : Effect.void,
            }),
          );
      });

    const bootstrapProgram = Effect.gen(function* () {
      if (bootstrap?.createThread) {
        // Dispatch can report a post-commit listener failure after the create
        // event is already durable. Cleanup is therefore safe to attempt as
        // soon as creation begins; a pre-commit failure makes delete a no-op.
        createdThread = true;
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: yield* commandId("bootstrap-thread-create"),
          threadId: command.threadId,
          projectId: bootstrap.createThread.projectId,
          ...(bootstrap.createThread.spawnedByThreadId === undefined
            ? {}
            : { spawnedByThreadId: bootstrap.createThread.spawnedByThreadId }),
          title: bootstrap.createThread.title,
          modelSelection: bootstrap.createThread.modelSelection,
          runtimeMode: bootstrap.createThread.runtimeMode,
          interactionMode: bootstrap.createThread.interactionMode,
          branch: bootstrap.createThread.branch,
          worktreePath: bootstrap.createThread.worktreePath,
          createdAt: bootstrap.createThread.createdAt,
        });
      }

      if (bootstrap?.prepareWorktree) {
        let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
        const startFromOrigin =
          bootstrap.prepareWorktree.startFromOrigin === true &&
          (yield* gitWorkflow.remoteExists({
            cwd: bootstrap.prepareWorktree.projectCwd,
            remoteName: "origin",
          }));
        if (startFromOrigin) {
          yield* gitWorkflow.fetchRemote({
            cwd: bootstrap.prepareWorktree.projectCwd,
            remoteName: "origin",
          });
          const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: bootstrap.prepareWorktree.baseBranch,
            fallbackRemoteName: "origin",
          });
          worktreeBaseRef = resolvedRemoteBase.commitSha;
        }
        const worktree = yield* gitWorkflow.createWorktree({
          cwd: bootstrap.prepareWorktree.projectCwd,
          refName: worktreeBaseRef,
          newRefName: bootstrap.prepareWorktree.branch,
          baseRefName: bootstrap.prepareWorktree.baseBranch,
          path: null,
        });
        targetWorktreePath = worktree.worktree.path;
        createdWorktreePath = targetWorktreePath;
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("bootstrap-thread-meta-update"),
          threadId: command.threadId,
          branch: worktree.worktree.refName,
          worktreePath: targetWorktreePath,
        });
        yield* refreshGitStatus(targetWorktreePath);
      }

      yield* runSetupProgram();
      const result = yield* orchestrationEngine.dispatch(finalTurnStartCommand);
      return { ...result, worktreePath: targetWorktreePath };
    });

    return yield* bootstrapProgram.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        const dispatchError = toDispatchError(error, "Failed to bootstrap thread turn start.");
        if (Cause.hasInterruptsOnly(cause)) return Effect.fail(dispatchError);
        return cleanupCreatedWorktree().pipe(
          Effect.andThen(cleanupCreatedThread()),
          Effect.flatMap(() => Effect.fail(dispatchError)),
        );
      }),
    );
  });

  const dispatch: ThreadBootstrapShape["dispatch"] = (command) =>
    command.type === "thread.turn.start" && command.bootstrap
      ? dispatchBootstrap(command)
      : orchestrationEngine
          .dispatch(command)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchError(cause, "Failed to dispatch orchestration command"),
            ),
          );

  return ThreadBootstrap.of({ dispatch });
});

export const layer = Layer.effect(ThreadBootstrap, make);
