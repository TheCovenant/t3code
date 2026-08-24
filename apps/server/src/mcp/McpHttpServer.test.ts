import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ThreadControl from "./toolkits/threads/service.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const threadSummary = (targetThreadId: ThreadId) => ({
  threadId: targetThreadId,
  projectId: ProjectId.make("project-mcp-test"),
  spawnedByThreadId: threadId,
  title: `Controlled by ${threadId}`,
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  status: "done" as const,
  blockedReason: null,
  branch: "main",
  worktreePath: "/tmp/mcp-test",
  latestTurnId: "turn-mcp-test",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:01.000Z",
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it.effect("registers the thread-only toolkit and scopes calls to the invoking chat", () =>
  Effect.gen(function* () {
    const calls: Array<ThreadId> = [];
    const threadControlLayer = Layer.mock(ThreadControl.ThreadControl)({
      list: (parentThreadId) =>
        Effect.sync(() => {
          calls.push(parentThreadId);
          return { threads: [], nextCursor: null };
        }),
    });
    const toolkitLayer = McpHttpServer.ThreadToolkitRegistrationLive.pipe(
      Layer.provide(threadControlLayer),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    const context = {
      ...invocation,
      capabilities: new Set(["threads"] as const),
    };

    const server = yield* McpServer.McpServer.pipe(Effect.provide(toolkitLayer));
    const toolNames = server.tools.map(({ tool }) => tool.name).toSorted();
    expect(toolNames).toEqual([
      "thread_get",
      "thread_interrupt",
      "thread_list",
      "thread_read",
      "thread_send",
      "thread_skill",
      "thread_spawn",
      "thread_wait",
    ]);
    for (const { tool } of server.tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    expect(
      server.tools.find(({ tool }) => tool.name === "thread_spawn")?.tool.inputSchema,
    ).toMatchObject({
      properties: {
        modelSelection: {},
        runtimeMode: {},
        interactionMode: {},
      },
    });
    const annotations = Object.fromEntries(
      server.tools.map(({ tool }) => [tool.name, tool.annotations]),
    );
    expect(annotations.thread_list).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(annotations.thread_get).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(annotations.thread_read).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(annotations.thread_skill).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(annotations.thread_spawn).toMatchObject({
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(annotations.thread_send).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(annotations.thread_interrupt).toMatchObject({ destructiveHint: true });
    expect(annotations.thread_wait).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const result = yield* server
      .callTool({ name: "thread_list", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, context),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ threads: [], nextCursor: null });
    expect(calls).toEqual([threadId]);

    const skill = yield* server
      .callTool({ name: "thread_skill", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, context),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(skill.isError).toBe(false);
    expect(skill.structuredContent).toMatchObject({ name: "t3-thread-control" });
    expect(skill.structuredContent?.instructions).toContain("# T3 Thread Control");
    expect(skill.structuredContent?.instructions).toContain("modelSelection");
    for (const toolName of toolNames) {
      expect(skill.structuredContent?.instructions).toContain(`\`${toolName}\``);
    }
  }),
);

it.effect("routes every thread tool with the authenticated caller identity", () =>
  Effect.gen(function* () {
    const childId = ThreadId.make("thread-mcp-child");
    const targetId = ThreadId.make("thread-mcp-target");
    const threadControlLayer = Layer.mock(ThreadControl.ThreadControl)({
      spawn: (caller, input) =>
        Effect.succeed({
          thread: {
            ...threadSummary(childId),
            spawnedByThreadId: caller,
            title: input.title ?? input.prompt,
            modelSelection: input.modelSelection ?? threadSummary(childId).modelSelection,
            runtimeMode: input.runtimeMode ?? "full-access",
            interactionMode: input.interactionMode ?? "default",
          },
        }),
      list: (caller, input) =>
        Effect.succeed({
          threads: [
            {
              ...threadSummary(caller),
              title: `${input.scope ?? "environment"}:${String(input.limit ?? 100)}`,
            },
          ],
          nextCursor: input.cursor ?? null,
        }),
      get: (caller, input) =>
        Effect.succeed({
          ...threadSummary(input.threadId),
          title: `caller:${caller}`,
          latestAssistantMessage: { text: "latest", truncated: false },
        }),
      read: (caller, input) =>
        Effect.succeed({
          threadId: input.threadId,
          messages: [],
          activities: [],
          beforeCursor: `${caller}:${String(input.turnLimit ?? 20)}`,
          hasMore: true,
          snapshotSequence: 7,
        }),
      send: (caller, input) =>
        Effect.succeed({ threadId: input.threadId, sequence: caller === threadId ? 8 : 0 }),
      interrupt: (caller, input) =>
        Effect.succeed({ threadId: input.threadId, sequence: caller === threadId ? 9 : 0 }),
      wait: (caller, input) =>
        Effect.succeed({
          ...threadSummary(input.threadId),
          title: `${caller}:${String(input.timeoutSeconds ?? 120)}`,
          latestAssistantMessage: null,
        }),
    });
    const toolkitLayer = McpHttpServer.ThreadToolkitRegistrationLive.pipe(
      Layer.provide(threadControlLayer),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    const context = { ...invocation, capabilities: new Set(["threads"] as const) };
    const server = yield* McpServer.McpServer.pipe(Effect.provide(toolkitLayer));
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, context),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const spawned = yield* call("thread_spawn", {
      prompt: "child prompt",
      title: "Child",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-1" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    const listed = yield* call("thread_list", { scope: "project", limit: 2, cursor: "cursor" });
    const inspected = yield* call("thread_get", { threadId: targetId });
    const read = yield* call("thread_read", { threadId: targetId, turnLimit: 3 });
    const sent = yield* call("thread_send", { threadId: targetId, prompt: "continue" });
    const interrupted = yield* call("thread_interrupt", { threadId: targetId });
    const waited = yield* call("thread_wait", { threadId: targetId, timeoutSeconds: 6 });

    expect(spawned.structuredContent).toMatchObject({
      thread: {
        threadId: childId,
        spawnedByThreadId: threadId,
        title: "Child",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-1" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
      },
    });
    expect(listed.structuredContent).toMatchObject({
      threads: [{ threadId, title: "project:2" }],
      nextCursor: "cursor",
    });
    expect(inspected.structuredContent).toMatchObject({
      threadId: targetId,
      title: `caller:${threadId}`,
    });
    expect(read.structuredContent).toMatchObject({
      threadId: targetId,
      beforeCursor: `${threadId}:3`,
      snapshotSequence: 7,
    });
    expect(sent.structuredContent).toEqual({ threadId: targetId, sequence: 8 });
    expect(interrupted.structuredContent).toEqual({ threadId: targetId, sequence: 9 });
    expect(waited.structuredContent).toMatchObject({
      threadId: targetId,
      title: `${threadId}:6`,
    });
  }),
);

it.effect("rejects thread tools when the credential lacks thread capability", () =>
  Effect.gen(function* () {
    const threadControlLayer = Layer.mock(ThreadControl.ThreadControl)({
      list: () => Effect.die("thread service must not run without capability"),
    });
    const toolkitLayer = McpHttpServer.ThreadToolkitRegistrationLive.pipe(
      Layer.provide(threadControlLayer),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    const server = yield* McpServer.McpServer.pipe(Effect.provide(toolkitLayer));
    for (const name of ["thread_list", "thread_skill"]) {
      const result = yield* server.callTool({ name, arguments: {} }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set<McpInvocationContext.McpCapability>(),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toEqual([
        { type: "text", text: "This MCP credential does not grant thread control." },
      ]);
    }
  }),
);

it.effect("enforces bounded thread-tool inputs at the MCP protocol boundary", () =>
  Effect.gen(function* () {
    const threadControlLayer = Layer.mock(ThreadControl.ThreadControl)({});
    const toolkitLayer = McpHttpServer.ThreadToolkitRegistrationLive.pipe(
      Layer.provide(threadControlLayer),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    const server = yield* McpServer.McpServer.pipe(Effect.provide(toolkitLayer));
    const context = { ...invocation, capabilities: new Set(["threads"] as const) };
    const invalidCalls = [
      { name: "thread_spawn", arguments: { prompt: "" } },
      { name: "thread_spawn", arguments: { prompt: "x".repeat(200_001) } },
      { name: "thread_spawn", arguments: { prompt: "ok", title: "x".repeat(201) } },
      {
        name: "thread_spawn",
        arguments: {
          prompt: "ok",
          modelSelection: { instanceId: "not a provider", model: "model" },
        },
      },
      {
        name: "thread_spawn",
        arguments: {
          prompt: "ok",
          modelSelection: { instanceId: "codex", model: "" },
        },
      },
      { name: "thread_spawn", arguments: { prompt: "ok", runtimeMode: "unrestricted" } },
      { name: "thread_spawn", arguments: { prompt: "ok", interactionMode: "chat" } },
      {
        name: "thread_spawn",
        arguments: { prompt: "ok", worktree: { branch: "x".repeat(256) } },
      },
      { name: "thread_send", arguments: { threadId, prompt: "" } },
      { name: "thread_list", arguments: { limit: 0 } },
      { name: "thread_list", arguments: { limit: 101 } },
      { name: "thread_list", arguments: { cursor: "x".repeat(2_001) } },
      { name: "thread_read", arguments: { threadId, turnLimit: 0 } },
      { name: "thread_read", arguments: { threadId, turnLimit: 51 } },
      { name: "thread_read", arguments: { threadId, beforeCursor: "x".repeat(2_001) } },
      { name: "thread_wait", arguments: { threadId, timeoutSeconds: 0 } },
      { name: "thread_wait", arguments: { threadId, timeoutSeconds: 601 } },
    ];

    for (const invalidCall of invalidCalls) {
      const result = yield* Effect.result(
        server
          .callTool(invalidCall)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, context),
            Effect.provideService(McpSchema.McpServerClient, client),
          ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("InvalidParams");
      }
    }
  }),
);

it.effect("authenticates the thread-only HTTP transport and preserves caller scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const callers: ThreadId[] = [];
      const authenticatedInvocation = {
        ...invocation,
        capabilities: new Set(["threads"] as const),
      };
      const registryLayer = Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) =>
          Effect.succeed(token === "valid-thread-token" ? authenticatedInvocation : undefined),
      });
      const threadControlLayer = Layer.mock(ThreadControl.ThreadControl)({
        list: (caller) =>
          Effect.sync(() => {
            callers.push(caller);
            return { threads: [], nextCursor: null };
          }),
      });
      const appLayer = McpHttpServer.layer.pipe(
        Layer.provide(registryLayer),
        Layer.provide(threadControlLayer),
        Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
      );
      yield* HttpRouter.serve(appLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const initializeBody = HttpBody.text(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-auth-test","version":"1.0.0"}}}`,
        "application/json",
      );

      const missing = yield* httpClient.post("/mcp/threads", {
        headers: { accept: "application/json, text/event-stream" },
        body: initializeBody,
      });
      expect(missing.status).toBe(401);
      expect(missing.headers["cache-control"]).toBe("no-store");
      expect(missing.headers["www-authenticate"]).toBe("Bearer");

      const invalid = yield* httpClient.post("/mcp/threads", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer invalid-thread-token",
        },
        body: initializeBody,
      });
      expect(invalid.status).toBe(401);

      const initialized = yield* httpClient.post("/mcp/threads", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-thread-token",
        },
        body: initializeBody,
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers["mcp-session-id"];
      expect(sessionId).toBeDefined();

      const listed = yield* httpClient.post("/mcp/threads", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-thread-token",
          "mcp-session-id": sessionId!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"thread_list","arguments":{}}}`,
          "application/json",
        ),
      });
      const listedBody = yield* listed.text;
      expect(listed.status, listedBody).toBe(200);
      expect(callers).toEqual([threadId]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);
