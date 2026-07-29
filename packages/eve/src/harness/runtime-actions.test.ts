import { describe, expect, it } from "vitest";

import {
  getPendingRuntimeActionBatch,
  recordPendingSubagentChild,
  resolvePendingRuntimeActions,
  resolveToolCallInputObject,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { deriveAgentId, getAgentHandleStore, upsertAgentHandle } from "#harness/agent-handles.js";
import { AGENTS_SNIPPET_LABEL } from "#harness/compaction-prompt.js";
import { getSessionTokenUsage, setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

function createParkedSession(): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [{ content: "delegate this", role: "user" }],
    sessionId: "test-session",
  };

  const ownUsage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 1_000,
    outputTokens: 100,
    sawCost: false,
  };
  const withUsage = setTurnUsageState(base, {
    ...ownUsage,
    session: ownUsage,
    turnId: "turn_0",
  });

  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-1",
        description: "research subagent",
        input: { description: "Research the topic", message: "go" },
        kind: "subagent-call",
        name: "researcher",
        nodeId: "subagents/researcher",
        subagentName: "researcher",
      },
    ],
    event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    responseMessages: [],
    session: withUsage,
  });
}

describe("resolvePendingRuntimeActions", () => {
  it("captures the child handle before deleting the batch and appends one safe agents snippet", async () => {
    const continuationToken = "subagent:private-token";
    const remoteUrl = "https://private.example.com";
    const session = recordPendingSubagentChild({
      callId: "call-1",
      child: {
        continuationToken,
        kind: "local",
        sessionId: "local-child-123456789012",
      },
      session: createParkedSession(),
    });

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: `first line\n${"x".repeat(140)}`,
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(getPendingRuntimeActionBatch(resolved.session.state)).toBeUndefined();
    expect(getAgentHandleStore(resolved.session.state)).toEqual({
      handles: [
        expect.objectContaining({
          continuationToken,
          description: "Research the topic",
          id: "ag_researcher:123456789012",
          kind: "agent/local",
          lastStatus: expect.not.stringContaining("\n"),
          name: "researcher",
          sessionId: "local-child-123456789012",
          url: "",
        }),
      ],
    });
    expect(getAgentHandleStore(resolved.session.state)?.handles[0]?.lastStatus?.length).toBe(120);

    const snippets = resolved.messages.filter(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(AGENTS_SNIPPET_LABEL),
    );
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.content).not.toContain(continuationToken);
    expect(snippets[0]?.content).not.toContain(remoteUrl);
  });

  it("removes a terminal child handle and appends the updated agents snippet", async () => {
    const childSessionId = "local-child-123456789012";
    const id = deriveAgentId("researcher", childSessionId);
    let session = recordPendingSubagentChild({
      callId: "call-1",
      child: {
        continuationToken: "subagent:private-token",
        kind: "local",
        sessionId: childSessionId,
      },
      session: createParkedSession(),
    });
    session = upsertAgentHandle(session, {
      continuationToken: "subagent:private-token",
      id,
      kind: "agent/local",
      name: "researcher",
      nodeId: "subagents/researcher",
      relationship: "child",
      sessionId: childSessionId,
      updatedAt: "2026-07-28T00:00:00.000Z",
      url: "",
    });

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            isError: true,
            kind: "subagent-result",
            output: { code: "SESSION_FAILED", message: "child failed" },
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(getAgentHandleStore(resolved.session.state)).toEqual({ handles: [] });
    expect(
      resolved.messages.filter(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith(AGENTS_SNIPPET_LABEL),
      ),
    ).toHaveLength(1);
  });

  it("draws completed child usage down against the parent's session totals", async () => {
    const session = createParkedSession();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
            usage: {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              inputTokens: 4_000,
              outputTokens: 400,
            },
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 5_000,
      outputTokens: 500,
    });
  });

  it("leaves the parent's totals untouched when the child reports no usage", async () => {
    const session = createParkedSession();

    const resolved = await resolvePendingRuntimeActions({
      session,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            subagentName: "researcher",
          },
        ],
      },
    });

    expect(resolved.outcome).toBe("resolved");
    expect(getSessionTokenUsage(resolved.session)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
    });
  });
});

describe("pending subagent child adoption", () => {
  it("records child session ids without disturbing local continuation-token cleanup", () => {
    let session = createParkedSession();
    session = recordPendingSubagentChild({
      callId: "call-1",
      child: {
        continuationToken: "subagent:test-session:call-1",
        kind: "local",
        sessionId: "local-child",
      },
      session,
    });
    session = recordPendingSubagentChild({
      callId: "call-remote",
      child: {
        callbackBaseUrl: "https://parent.example.com",
        continuationToken: "remote-token",
        kind: "remote",
        sessionId: "remote-child",
        url: "https://remote.example.com",
      },
      session,
    });

    expect(getPendingRuntimeActionBatch(session.state)).toMatchObject({
      childContinuationTokens: {
        "call-1": "subagent:test-session:call-1",
        "call-remote": "remote-token",
      },
      childSessionIds: {
        "call-1": "local-child",
        "call-remote": "remote-child",
      },
    });
  });
});

describe("resolveToolCallInputObject", () => {
  const context = { callId: "call-1", toolName: "web_search" };

  it("passes plain objects through", () => {
    expect(resolveToolCallInputObject({ query: "eve" }, context)).toEqual({ query: "eve" });
  });

  it("treats undefined, null, and empty-string inputs as empty arguments", () => {
    expect(resolveToolCallInputObject(undefined, context)).toEqual({});
    expect(resolveToolCallInputObject(null, context)).toEqual({});
    expect(resolveToolCallInputObject("", context)).toEqual({});
    expect(resolveToolCallInputObject("  ", context)).toEqual({});
  });

  it("parses raw JSON-string inputs from provider-executed tool calls", () => {
    expect(resolveToolCallInputObject('{"query":"eve"}', context)).toEqual({ query: "eve" });
  });

  it("rejects strings that are not JSON objects, naming the tool and call", () => {
    expect(() => resolveToolCallInputObject('"query"', context)).toThrow(
      /web_search.*call-1.*Expected a JSON-serializable object/su,
    );
    expect(() => resolveToolCallInputObject("not json", context)).toThrow(/web_search.*call-1/su);
  });

  it("rejects non-object JSON values", () => {
    expect(() => resolveToolCallInputObject(42, context)).toThrow(
      /Expected a JSON-serializable object/u,
    );
    expect(() => resolveToolCallInputObject(["a"], context)).toThrow(
      /Expected a JSON-serializable object/u,
    );
  });
});
