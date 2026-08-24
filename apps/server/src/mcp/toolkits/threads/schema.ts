import {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Prompt = TrimmedNonEmptyString.check(Schema.isMaxLength(200_000));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const RefName = TrimmedNonEmptyString.check(Schema.isMaxLength(255));

export const ThreadSkillInput = Schema.Record(Schema.String, Schema.Never);
export type ThreadSkillInput = typeof ThreadSkillInput.Type;

export const ThreadSkillResult = Schema.Struct({
  name: Schema.Literal("t3-thread-control"),
  instructions: TrimmedNonEmptyString,
});
export type ThreadSkillResult = typeof ThreadSkillResult.Type;

export const ThreadSpawnInput = Schema.Struct({
  prompt: Prompt,
  title: Schema.optional(Title),
  worktree: Schema.optional(
    Schema.Struct({
      baseBranch: Schema.optional(RefName),
      branch: Schema.optional(RefName),
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type ThreadSpawnInput = typeof ThreadSpawnInput.Type;

export const ThreadListScope = Schema.Literals(["environment", "project", "children"]);
export type ThreadListScope = typeof ThreadListScope.Type;

export const ThreadListInput = Schema.Struct({
  scope: Schema.optional(ThreadListScope),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type ThreadListInput = typeof ThreadListInput.Type;

export const ThreadTargetInput = Schema.Struct({ threadId: ThreadId });
export type ThreadTargetInput = typeof ThreadTargetInput.Type;

export const ThreadSendInput = Schema.Struct({
  threadId: ThreadId,
  prompt: Prompt,
});
export type ThreadSendInput = typeof ThreadSendInput.Type;

export const ThreadWaitInput = Schema.Struct({
  threadId: ThreadId,
  timeoutSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 }))),
});
export type ThreadWaitInput = typeof ThreadWaitInput.Type;

export const ThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  turnLimit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  beforeCursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  includeActivities: Schema.optional(Schema.Boolean),
});
export type ThreadReadInput = typeof ThreadReadInput.Type;

export const ThreadControlStatus = Schema.Literals([
  "idle",
  "working",
  "blocked",
  "done",
  "interrupted",
  "error",
]);
export type ThreadControlStatus = typeof ThreadControlStatus.Type;

export const ThreadControlSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  spawnedByThreadId: Schema.NullOr(ThreadId),
  title: TrimmedNonEmptyString,
  status: ThreadControlStatus,
  blockedReason: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  latestTurnId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ThreadControlSummary = typeof ThreadControlSummary.Type;

export const ThreadControlDetail = Schema.Struct({
  ...ThreadControlSummary.fields,
  latestAssistantMessage: Schema.NullOr(
    Schema.Struct({
      text: Schema.String,
      truncated: Schema.Boolean,
    }),
  ),
});
export type ThreadControlDetail = typeof ThreadControlDetail.Type;

export const ThreadSpawnResult = Schema.Struct({ thread: ThreadControlSummary });
export type ThreadSpawnResult = typeof ThreadSpawnResult.Type;

export const ThreadListResult = Schema.Struct({
  threads: Schema.Array(ThreadControlSummary),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadListResult = typeof ThreadListResult.Type;

export const ThreadReadResult = Schema.Struct({
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ThreadReadResult = typeof ThreadReadResult.Type;

export const ThreadCommandResult = Schema.Struct({
  threadId: ThreadId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ThreadCommandResult = typeof ThreadCommandResult.Type;

export class ThreadControlError extends Schema.TaggedErrorClass<ThreadControlError>()(
  "ThreadControlError",
  {
    reason: Schema.Literals([
      "source_not_found",
      "target_not_found",
      "capability_denied",
      "invalid_worktree",
      "dispatch_failed",
      "read_failed",
      "timeout",
    ]),
    message: TrimmedNonEmptyString,
    threadId: Schema.optional(ThreadId),
  },
) {}
