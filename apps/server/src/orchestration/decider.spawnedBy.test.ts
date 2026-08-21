import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-08-19T00:00:00.000Z";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const parentThreadId = ThreadId.make("thread-parent");

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6",
};

const readModel: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [
    {
      id: projectA,
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: projectB,
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: parentThreadId,
      projectId: projectA,
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/tmp/project-a",
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: now,
};

const makeCreateCommand = (projectId: ProjectId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create-${projectId}`),
  threadId: ThreadId.make(`child-${projectId}`),
  projectId,
  spawnedByThreadId: parentThreadId,
  title: "Child",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: "main",
  worktreePath: "/tmp/project-a",
  createdAt: now,
});

it.layer(NodeServices.layer)("spawned thread invariants", (it) => {
  it.effect("records a same-project parent on thread.created", () =>
    Effect.gen(function* () {
      const planned = yield* decideOrchestrationCommand({
        command: makeCreateCommand(projectA),
        readModel,
      });
      const event = Array.isArray(planned) ? planned[0] : planned;

      expect(event?.type).toBe("thread.created");
      if (event?.type === "thread.created") {
        expect(event.payload.spawnedByThreadId).toBe(parentThreadId);
      }
    }),
  );

  it.effect("rejects a parent from another project", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: makeCreateCommand(projectB),
        readModel,
      }).pipe(Effect.flip);

      expect(error.message).toContain("belongs to a different project");
    }),
  );

  it.effect("rejects lineage that points to a missing parent thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: makeCreateCommand(projectA),
        readModel: { ...readModel, threads: [] },
      }).pipe(Effect.flip);

      expect(error.message).toContain(`Thread '${parentThreadId}' does not exist`);
    }),
  );
});
