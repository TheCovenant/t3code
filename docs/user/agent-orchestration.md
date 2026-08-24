# Agent-managed chats

Agents running in T3 Code can split work into child chats and coordinate those chats without
leaving the current conversation. A child chat is a normal T3 Code thread: it appears in the app,
keeps its own transcript and checkpoints, and can be opened from web, desktop, or mobile.

An agent can:

- start a chat with an initial prompt and optionally choose its provider, model, permission mode,
  and interaction mode
- list active chats across the environment, or narrow the list to its project or direct children
- inspect status and read the full transcript of any active chat in bounded pages
- send follow-up instructions to another chat
- interrupt another chat's active turn
- wait for another chat to finish or require attention

T3 ships the thread-control guide with the server and exposes it as the read-only
`thread_skill` tool. It is available whenever thread control is available, independent of the
active project's skill folders.

Child chats always inherit the current project. Their provider, model, permission mode, and
interaction mode inherit by default, but the spawning agent can select different configured values
for the delegated task. Spawn, list, and inspection results show the effective selection. By default
children also use the current checkout. For isolated edits, the agent can explicitly create a new Git
worktree and branch; the project's worktree setup script runs before that child's first turn.

The T3 environment is the control boundary. Like panes in one Herdr session, active chats are
addressable by opaque ID even when they are siblings, grandchildren, or belong to different
projects in the environment. Parentage remains durable lineage for grouping and understanding who
started a chat; it is not an authorization boundary. Transcript reads are paginated so an agent can
walk the complete history without sending an unbounded payload over the connection.

Agent-managed chats are independent from agent browser access. Turning browser access off removes
the preview tools, but does not remove chat orchestration.

OpenCode sessions launched by T3 receive the same chat controls. A configured external OpenCode
server does not: T3 leaves that shared server's global MCP configuration unchanged rather than
publishing a provider credential into it.
