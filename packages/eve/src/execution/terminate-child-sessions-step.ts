import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { getAgentHandleStore } from "#harness/agent-handles.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.terminate-child-sessions");

/** Terminates local children the parent holds handles to when the parent session ends. */
export async function terminateChildSessionsStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let session;
  try {
    session = await readDurableSession(input.sessionState);
  } catch (error) {
    logError(log, "failed to read child sessions for termination", error, {
      parentSessionId: input.sessionState.sessionId,
    });
    return;
  }

  const handles = (getAgentHandleStore(session.state)?.handles ?? []).filter(
    (handle) =>
      handle.relationship === "child" &&
      (handle.kind === "agent/local" || handle.kind === "agent/runtime"),
  );
  if (handles.length === 0) {
    return;
  }

  const runtime = createWorkflowRuntime({
    compiledArtifactsSource: { kind: "bundled" },
  });

  for (const handle of handles) {
    try {
      await runtime.terminateSession({
        reason: "Parent session ended",
        sessionId: handle.sessionId,
      });
    } catch (error) {
      logError(log, "failed to terminate child session", error, {
        agentId: handle.id,
        childSessionId: handle.sessionId,
        kind: handle.kind,
        parentSessionId: session.sessionId,
      });
    }
  }
}
