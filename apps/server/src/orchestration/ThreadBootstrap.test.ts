import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ThreadBootstrap from "./ThreadBootstrap.ts";

const threadId = ThreadId.make("thread-bootstrap-cleanup");
const projectId = ProjectId.make("project-bootstrap-cleanup");
const createdAt = "2026-08-21T00:00:00.000Z";

const turnStart = {
  type: "thread.turn.start",
  commandId: CommandId.make("command-bootstrap-cleanup"),
  threadId,
  message: {
    messageId: MessageId.make("message-bootstrap-cleanup"),
    role: "user",
    text: "Start the child",
    attachments: [],
  },
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId,
      spawnedByThreadId: ThreadId.make("thread-bootstrap-parent"),
      title: "Child",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt,
    },
    prepareWorktree: {
      projectCwd: "/tmp/bootstrap-project",
      baseBranch: "main",
      branch: "agent/child",
    },
    runSetupScript: false,
  },
  createdAt,
} satisfies OrchestrationCommand;

it.effect("removes a newly-created worktree when the bootstrapped turn cannot start", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const removeWorktree = vi.fn(
      (_: { readonly cwd: string; readonly path: string; readonly force?: boolean | undefined }) =>
        Effect.void,
    );
    const bootstrap = yield* ThreadBootstrap.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            dispatch: (command) => {
              commands.push(command);
              return command.type === "thread.turn.start"
                ? Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "provider turn could not start",
                    }),
                  )
                : Effect.succeed({ sequence: commands.length });
            },
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            createWorktree: () =>
              Effect.succeed({
                worktree: { refName: "agent/child", path: "/tmp/bootstrap-child" },
              }),
            removeWorktree,
          }),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: () => Effect.succeed({ status: "no-script" as const }),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: false,
                isDefaultRef: false,
                refName: "agent/child",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );

    const result = yield* bootstrap.dispatch(turnStart).pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    assert.deepEqual(removeWorktree.mock.calls[0]?.[0], {
      cwd: "/tmp/bootstrap-project",
      path: "/tmp/bootstrap-child",
      force: true,
    });
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.create", "thread.meta.update", "thread.turn.start", "thread.delete"],
    );
  }),
);

it.effect("attempts cleanup when thread creation reports a post-commit failure", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const bootstrap = yield* ThreadBootstrap.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            dispatch: (command) => {
              commands.push(command);
              return command.type === "thread.create"
                ? Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "projected create but listener failed",
                    }),
                  )
                : Effect.succeed({ sequence: commands.length });
            },
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
          NodeServices.layer,
        ),
      ),
    );
    const sharedCheckoutTurn = {
      ...turnStart,
      bootstrap: {
        createThread: turnStart.bootstrap.createThread,
      },
    } satisfies OrchestrationCommand;

    const result = yield* bootstrap.dispatch(sharedCheckoutTurn).pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.create", "thread.delete"],
    );
  }),
);
