import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadControlService from "./service.ts";
import { ThreadControlError } from "./schema.ts";
import { ThreadToolkit } from "./tools.ts";

const withThreadControl = Effect.fn("ThreadToolkit.withThreadControl")(function* <A>(
  invoke: (
    service: ThreadControlService.ThreadControlShape,
    parentThreadId: import("@t3tools/contracts").ThreadId,
  ) => Effect.Effect<A, import("./schema.ts").ThreadControlError>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("threads")) {
    return yield* new ThreadControlError({
      reason: "capability_denied",
      message: "This MCP credential does not grant thread control.",
      threadId: scope.threadId,
    });
  }
  const service = yield* ThreadControlService.ThreadControl;
  return yield* invoke(service, scope.threadId);
});

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer({
  thread_spawn: (input) => withThreadControl((service, caller) => service.spawn(caller, input)),
  thread_list: (input) => withThreadControl((service, caller) => service.list(caller, input)),
  thread_get: (input) => withThreadControl((service, caller) => service.get(caller, input)),
  thread_read: (input) => withThreadControl((service, caller) => service.read(caller, input)),
  thread_send: (input) => withThreadControl((service, caller) => service.send(caller, input)),
  thread_interrupt: (input) =>
    withThreadControl((service, caller) => service.interrupt(caller, input)),
  thread_wait: (input) => withThreadControl((service, caller) => service.wait(caller, input)),
});
