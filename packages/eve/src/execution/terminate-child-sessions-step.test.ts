import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentHandle } from "#harness/agent-handles.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/agent-handles.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";

const { terminateSessionMock } = vi.hoisted(() => ({
  terminateSessionMock: vi.fn(),
}));

vi.mock("./workflow-runtime.js", () => ({
  createWorkflowRuntime: vi.fn(() => ({
    terminateSession: terminateSessionMock,
  })),
}));

describe("terminateChildSessionsStep", () => {
  beforeEach(() => {
    terminateSessionMock.mockReset();
    terminateSessionMock.mockResolvedValue({ status: "terminated" });
  });

  it("terminates local and runtime children but skips remote agents and parents", async () => {
    const handles = [
      makeHandle({ id: "local-child", kind: "agent/local", sessionId: "session-local" }),
      makeHandle({ id: "runtime-child", kind: "agent/runtime", sessionId: "session-runtime" }),
      makeHandle({ id: "remote-child", kind: "agent/remote", sessionId: "session-remote" }),
      makeHandle({
        id: "local-parent",
        kind: "agent/local",
        relationship: "parent",
        sessionId: "session-parent",
      }),
    ];

    await terminateChildSessionsStep({
      sessionState: makeSessionState(handles),
    });

    expect(terminateSessionMock).toHaveBeenCalledTimes(2);
    expect(terminateSessionMock).toHaveBeenNthCalledWith(1, {
      reason: "Parent session ended",
      sessionId: "session-local",
    });
    expect(terminateSessionMock).toHaveBeenNthCalledWith(2, {
      reason: "Parent session ended",
      sessionId: "session-runtime",
    });
  });

  it("continues terminating children after one termination fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    terminateSessionMock
      .mockRejectedValueOnce(new Error("termination unavailable"))
      .mockResolvedValueOnce({ status: "terminated" });

    try {
      await expect(
        terminateChildSessionsStep({
          sessionState: makeSessionState([
            makeHandle({ id: "child-1", kind: "agent/local", sessionId: "session-1" }),
            makeHandle({ id: "child-2", kind: "agent/runtime", sessionId: "session-2" }),
          ]),
        }),
      ).resolves.toBeUndefined();

      expect(terminateSessionMock).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        "[eve:execution.terminate-child-sessions] failed to terminate child session",
        expect.objectContaining({
          agentId: "child-1",
          childSessionId: "session-1",
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

function makeHandle(
  overrides: Pick<AgentHandle, "id" | "kind" | "sessionId"> &
    Partial<Pick<AgentHandle, "relationship">>,
): AgentHandle {
  return {
    continuationToken: `${overrides.sessionId}:token`,
    id: overrides.id,
    kind: overrides.kind,
    name: "research",
    nodeId: "subagents/research",
    relationship: overrides.relationship ?? "child",
    sessionId: overrides.sessionId,
    updatedAt: "2026-07-28T12:00:00.000Z",
    url: "",
  };
}

function makeSessionState(handles: readonly AgentHandle[]): DurableSessionState {
  return {
    continuationToken: "parent-token",
    emissionState: {
      sequence: 0,
      sessionStarted: true,
      stepIndex: 0,
      turnId: "turn-1",
    },
    hasProxyInputRequests: false,
    sessionId: "parent-session",
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent-session",
        state: {
          [AGENT_HANDLES_STATE_KEY]: { handles },
        },
      },
      version: 1,
    },
    version: 1,
  };
}
