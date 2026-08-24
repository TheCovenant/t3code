import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import * as GitWorkflowService from "../src/git/GitWorkflowService.ts";
import * as McpHttpServer from "../src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../src/mcp/McpInvocationContext.ts";
import * as ThreadControl from "../src/mcp/toolkits/threads/service.ts";
import * as OrchestrationEngine from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBootstrap from "../src/orchestration/ThreadBootstrap.ts";
import * as ProjectSetupScriptRunner from "../src/project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import * as VcsStatusBroadcaster from "../src/vcs/VcsStatusBroadcaster.ts";

const provider = ProviderDriverKind.make("codex");
const parentThreadId = ThreadId.make("thread-control-parent");
const projectId = ProjectId.make("project-thread-control");
const now = "2026-08-21T00:00:00.000Z";

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-control-integration", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

function response(text: string, suffix: string) {
  const base = (eventId: string, createdAt: string) => ({
    eventId: EventId.make(eventId),
    provider,
    createdAt,
    threadId: parentThreadId,
    turnId: "fixture-turn",
  });
  return {
    events: [
      { type: "turn.started", ...base(`event-${suffix}-started`, now) },
      {
        type: "message.delta",
        ...base(`event-${suffix}-message`, "2026-08-21T00:00:00.100Z"),
        delta: text,
      },
      {
        type: "turn.completed",
        ...base(`event-${suffix}-completed`, "2026-08-21T00:00:00.200Z"),
        status: "completed",
      },
    ],
  };
}

const seedParent = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const instanceId = defaultInstanceIdForDriver(provider);
    const model = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("thread-control:create-project"),
      projectId,
      title: "Thread control integration",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: { instanceId, model },
      createdAt: now,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("thread-control:create-parent"),
      threadId: parentThreadId,
      projectId,
      title: "Parent thread",
      modelSelection: { instanceId, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: harness.workspaceDir,
      createdAt: now,
    });
  });

const makeToolkit = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const engineLayer = Layer.succeed(
      OrchestrationEngine.OrchestrationEngineService,
      harness.engine,
    );
    const projectionLayer = Layer.succeed(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      harness.snapshotQuery,
    );
    const bootstrap = yield* ThreadBootstrap.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          engineLayer,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
          NodeServices.layer,
        ),
      ),
    );
    const control = yield* ThreadControl.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          engineLayer,
          projectionLayer,
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            enqueueCommand: (effect) => effect,
          }),
          Layer.succeed(ThreadBootstrap.ThreadBootstrap, bootstrap),
          NodeServices.layer,
        ),
      ),
    );
    return yield* McpServer.McpServer.pipe(
      Effect.provide(
        McpHttpServer.ThreadToolkitRegistrationLive.pipe(
          Layer.provide(Layer.succeed(ThreadControl.ThreadControl, control)),
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    );
  });

it.live("spawns, persists, reads, follows up, and waits through the MCP thread toolkit", () =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider }),
    (harness) =>
      Effect.gen(function* () {
        yield* seedParent(harness);
        yield* harness.adapterHarness!.queueTurnResponseForNextSession(
          response("SPAWNED", "spawn"),
        );
        const server = yield* makeToolkit(harness);
        const invocation = {
          environmentId: EnvironmentId.make("environment-thread-control"),
          threadId: parentThreadId,
          providerSessionId: "provider-session-thread-control",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["threads"] as const),
          issuedAt: 1,
        };
        const call = (name: string, args: Record<string, unknown>) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
            );

        const spawned = yield* call("thread_spawn", {
          prompt: "Create a persisted child",
          title: "Persisted child",
        });
        expect(spawned.isError).toBe(false);
        const childThreadId = ThreadId.make(
          (spawned.structuredContent as { thread: { threadId: string } }).thread.threadId,
        );

        const firstTurn = yield* harness.waitForThread(
          childThreadId,
          (thread) =>
            thread.spawnedByThreadId === parentThreadId &&
            thread.session?.status === "ready" &&
            thread.messages.some(
              (message) => message.role === "assistant" && message.text.includes("SPAWNED"),
            ),
        );
        expect(firstTurn.projectId).toBe(projectId);
        expect(firstTurn.worktreePath).toBe(harness.workspaceDir);

        const children = yield* call("thread_list", { scope: "children" });
        expect(children.structuredContent).toMatchObject({
          threads: [
            {
              threadId: childThreadId,
              spawnedByThreadId: parentThreadId,
            },
          ],
        });
        const inspected = yield* call("thread_get", { threadId: childThreadId });
        expect(inspected.structuredContent).toMatchObject({
          threadId: childThreadId,
          spawnedByThreadId: parentThreadId,
          latestAssistantMessage: { text: "SPAWNED", truncated: false },
        });
        const firstRead = yield* call("thread_read", { threadId: childThreadId });
        expect(firstRead.structuredContent).toMatchObject({
          threadId: childThreadId,
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "user", text: "Create a persisted child" }),
            expect.objectContaining({ role: "assistant", text: "SPAWNED" }),
          ]),
        });

        yield* harness.adapterHarness!.queueTurnResponse(
          childThreadId,
          response("FOLLOWUP", "followup"),
        );
        const sent = yield* call("thread_send", {
          threadId: childThreadId,
          prompt: "Continue in the child",
        });
        expect(sent.isError).toBe(false);
        const followedUp = yield* harness.waitForThread(childThreadId, (thread) =>
          thread.messages.some(
            (message) => message.role === "assistant" && message.text.includes("FOLLOWUP"),
          ),
        );
        expect(followedUp.spawnedByThreadId).toBe(parentThreadId);

        const waited = yield* call("thread_wait", { threadId: childThreadId });
        expect(waited.structuredContent).toMatchObject({
          threadId: childThreadId,
          status: "done",
          latestAssistantMessage: { text: "FOLLOWUP", truncated: false },
        });
        const secondRead = yield* call("thread_read", { threadId: childThreadId });
        expect(
          (secondRead.structuredContent as { messages: ReadonlyArray<{ text: string }> }).messages
            .map((message) => message.text)
            .filter((text) => text === "SPAWNED" || text === "FOLLOWUP"),
        ).toEqual(["SPAWNED", "FOLLOWUP"]);
      }),
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer)),
);
