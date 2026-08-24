---
name: t3-thread-control
description: "Control T3 Code chats and isolated worktrees through its thread tools. Use only when the user explicitly mentions T3 thread or agent orchestration, or asks to use T3 to spawn, delegate to, inspect, read, message, interrupt, or wait on another chat. Do not use merely because a task could benefit from delegation or parallel work. Requires the T3 thread_* tools."
---

# T3 Thread Control

T3 Code exposes active chats in the current environment through authenticated `thread_*` tools. A chat is a durable T3 thread with its own transcript and checkpoints. Spawned chats record the caller as their parent and can either share the caller's checkout or use a new Git worktree.

This skill is delivered by T3's thread MCP toolkit, so it is available wherever those tools are attached. If the `thread_*` tools are absent, say that this T3 session does not provide thread control and stop. Do not reconstruct the MCP URL or credential, query T3's database, or call its private HTTP endpoints.

## Learn the current tools

The installed tool schemas and descriptions are the authority for inputs, limits, and return values. The toolkit currently provides:

- `thread_spawn`: create a chat and start its first turn
- `thread_list`: list active chats with status and checkout metadata
- `thread_get`: inspect one chat and its latest completed assistant message
- `thread_read`: read transcript pages and optional activity records
- `thread_send`: send a follow-up or steer a running turn
- `thread_interrupt`: interrupt a running turn
- `thread_wait`: wait for a chat to finish or require attention
- `thread_skill`: load this guide

Treat every returned `threadId` and pagination cursor as an opaque string. Read them from tool results rather than predicting or constructing them.

## Scope and status

The T3 environment is the control boundary. A chat may inspect and control any active chat in that environment, including siblings, grandchildren, and chats in other projects. Parentage is durable lineage, not an authorization boundary.

Use `thread_list` with the narrowest useful scope:

- `environment` is the default and lists active chats across the T3 environment
- `project` lists chats in the caller's project
- `children` lists chats directly spawned by the caller

Follow `nextCursor` until it is `null` when the full result set matters.

Statuses mean:

- `idle`: no completed or active turn is available
- `working`: the provider session or latest turn is running
- `blocked`: the chat is waiting for user input or approval; inspect `blockedReason`
- `done`: the latest turn completed
- `interrupted`: the latest turn was interrupted
- `error`: the provider session or latest turn failed

## Spawn chats

Use `thread_spawn` with a complete initial prompt. Give the child enough context to work independently, including the requested output, relevant paths, constraints, and whether it may edit files. Use `title` when a short label will make parallel work easier to track.

A spawned chat always inherits the caller's project. By default it also inherits the caller's provider instance, model, runtime mode, and interaction mode. Override those defaults when the delegated task needs a different worker:

```json
{
  "prompt": "Review the implementation independently.",
  "modelSelection": {
    "instanceId": "claudeAgent",
    "model": "claude-sonnet-4-6"
  },
  "runtimeMode": "full-access",
  "interactionMode": "default"
}
```

`modelSelection.instanceId` is the configured T3 provider-instance ID, not merely a provider family name. The model must belong to that instance. Omit any override that should inherit from the caller. Read the effective selection back from the returned thread summary, `thread_get`, or `thread_list`.

By default, the child shares the caller's checkout. Prefer that for read-only investigation or tightly coordinated sequential work. Concurrent editors in one checkout can overwrite or confuse one another, so split write tasks by non-overlapping files or request an isolated worktree:

```json
{
  "prompt": "Implement the parser change and run its focused tests.",
  "title": "parser implementation",
  "worktree": {
    "baseBranch": "main",
    "branch": "feat/parser-change",
    "startFromOrigin": true
  }
}
```

All worktree fields are optional once `worktree` is present. T3 defaults the base to the caller's branch, generates a branch name when needed, creates the checkout, and runs the project's worktree setup script before the child's first turn. Read the actual `branch` and `worktreePath` from the result.

Do not create a worktree merely because a child chat exists. Use one when the user requests isolation or when independent edits make a shared checkout unsafe.

## Inspect, wait, and read

Inspect before waiting:

1. Call `thread_get` for the current status and latest assistant result.
2. If the chat is still `working`, call `thread_wait` rather than polling.
3. After `thread_wait` returns, use its status and latest assistant message to decide whether a transcript read or follow-up is needed.

`thread_wait` returns immediately for `blocked`, `done`, `interrupted`, or `error`, and otherwise uses event delivery. A timeout is not proof of failure. Call `thread_get` after a timeout before deciding what to do.

Use `thread_read` when the latest assistant message is insufficient or the task requires the full history. Transcript pages are bounded. Follow `beforeCursor` while `hasMore` is true. Set `includeActivities` to `false` unless tool and activity records are relevant; this keeps websocket and model payloads small.

## Send follow-ups and interrupt

Use `thread_send` for corrections, additional work, or answers to a blocked child. When the target is working, the provider's steering semantics apply. Otherwise, the prompt starts the target's next turn.

Do not assume that a successful send means the work is complete. Inspect or wait again using the returned thread ID.

Use `thread_interrupt` only when the user asked to stop the turn or continuing would be harmful or wasted work. Interrupting a turn does not archive the chat, delete its transcript, or remove its worktree.

## Coordinate parallel work

When spawning more than one chat:

- give each child one concrete, bounded responsibility
- avoid overlapping write ownership, or isolate writers in separate worktrees
- record each returned thread ID with its task and checkout
- inspect children before waiting so already-finished work is not delayed
- wait on active children, then read and integrate their results
- send follow-ups to the same thread so it retains its context

T3 thread control operates on chats, not arbitrary terminals. It cannot run a standalone shell command in another pane, choose an executable for a new chat, archive chats, or delete worktrees. Use the normal repository tools for local commands and the T3 client for lifecycle operations that the toolkit does not expose.

Managed Codex, Claude, Cursor, Grok, and OpenCode sessions receive T3's MCP configuration when supported by their adapters. `thread_spawn` can select across those configured provider instances. A configured external OpenCode server is intentionally excluded because T3 does not publish a provider credential into a shared external server.
