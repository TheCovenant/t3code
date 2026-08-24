import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadControlService from "./service.ts";
import {
  ThreadCommandResult,
  ThreadControlDetail,
  ThreadControlError,
  ThreadListInput,
  ThreadListResult,
  ThreadReadInput,
  ThreadReadResult,
  ThreadSendInput,
  ThreadSkillInput,
  ThreadSkillResult,
  ThreadSpawnInput,
  ThreadSpawnResult,
  ThreadTargetInput,
  ThreadWaitInput,
} from "./schema.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadControlService.ThreadControl,
];

export const ThreadSkillTool = Tool.make("thread_skill", {
  description:
    "Load T3 Code's built-in thread-control skill. Use it when the user explicitly asks to orchestrate T3 chats or worktrees and you need the complete spawn, status, transcript, follow-up, wait, and safety workflow.",
  parameters: ThreadSkillInput,
  success: ThreadSkillResult,
  failure: ThreadControlError,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Load T3 thread-control skill")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSpawnTool = Tool.make("thread_spawn", {
  description:
    "Create and start a T3 chat. The new chat records this chat as its parent for lineage, inherits its project, provider, model, runtime, and interaction mode, and shares its checkout unless worktree is supplied. A worktree creates an isolated Git checkout from baseBranch (or this chat's branch). Returns the new threadId as an opaque handle.",
  parameters: ThreadSpawnInput,
  success: ThreadSpawnResult,
  failure: ThreadControlError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn T3 chat")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const ThreadListTool = Tool.make("thread_list", {
  description:
    "List active T3 chats with status and checkout. The default environment scope matches Herdr's session-wide pane list; project and children scopes narrow the result. Results are stable, bounded pages; pass nextCursor back as cursor until it is null.",
  parameters: ThreadListInput,
  success: ThreadListResult,
  failure: ThreadControlError,
  dependencies,
})
  .annotate(Tool.Title, "List T3 chats")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadGetTool = Tool.make("thread_get", {
  description:
    "Inspect any active T3 chat in this environment by threadId, including its status and latest completed assistant message. Use thread_read for pageable transcript history.",
  parameters: ThreadTargetInput,
  success: ThreadControlDetail,
  failure: ThreadControlError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect T3 chat")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadReadTool = Tool.make("thread_read", {
  description:
    "Read a pageable transcript from any active T3 chat in this environment. Pages contain complete messages for recent user-anchored turns and, by default, their tool/activity records. Follow beforeCursor until hasMore is false to read the entire transcript.",
  parameters: ThreadReadInput,
  success: ThreadReadResult,
  failure: ThreadControlError,
  dependencies,
})
  .annotate(Tool.Title, "Read T3 chat transcript")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSendTool = Tool.make("thread_send", {
  description:
    "Send a follow-up to any active T3 chat in this environment. If its current turn is still running, provider steering semantics apply; otherwise this starts its next turn.",
  parameters: ThreadSendInput,
  success: ThreadCommandResult,
  failure: ThreadControlError,
  dependencies,
})
  .annotate(Tool.Title, "Send to T3 chat")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadInterruptTool = Tool.make("thread_interrupt", {
  description:
    "Interrupt the active turn in any active T3 chat in this environment. This does not archive the chat or delete its worktree.",
  parameters: ThreadTargetInput,
  success: ThreadCommandResult,
  failure: ThreadControlError,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt T3 chat")
  .annotate(Tool.Destructive, true);

export const ThreadWaitTool = Tool.make("thread_wait", {
  description:
    "Wait until any active T3 chat in this environment finishes, blocks for input or approval, is interrupted, or errors. Returns immediately if it is already in one of those states. Uses event delivery rather than polling.",
  parameters: ThreadWaitInput,
  success: ThreadControlDetail,
  failure: ThreadControlError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for T3 chat")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ThreadToolkit = Toolkit.make(
  ThreadSkillTool,
  ThreadSpawnTool,
  ThreadListTool,
  ThreadGetTool,
  ThreadReadTool,
  ThreadSendTool,
  ThreadInterruptTool,
  ThreadWaitTool,
);
