import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import {
  getPendingRuntimeActionBatch,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import {
  deriveAgentId,
  getAgentHandleStore,
  upsertAgentHandle,
  type AgentHandle,
} from "#harness/agent-handles.js";
import type { HarnessSession } from "#harness/types.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const mocks = vi.hoisted(() => ({
  continueRemoteAgentSession: vi.fn(),
  createDurableSessionState: vi.fn(),
  deliver: vi.fn(),
  deserializeContext: vi.fn(),
  hydrateDurableSession: vi.fn(),
  readDurableSession: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: mocks.deserializeContext,
}));

vi.mock("#execution/durable-session-store.js", () => ({
  createDurableSessionState: mocks.createDurableSessionState,
  readDurableSession: mocks.readDurableSession,
}));

vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: mocks.hydrateDurableSession,
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: () => ({
    deliver: mocks.deliver,
  }),
  workflowEntryReference: { workflowId: "workflow//eve//workflowEntry" },
}));

vi.mock("#execution/remote-agent-dispatch.js", () => ({
  continueRemoteAgentSession: mocks.continueRemoteAgentSession,
  isRetryableRemoteAgentContinueError: (error: unknown) =>
    (error as { retryable?: boolean } | null)?.retryable !== false,
  resolveRemoteAgentForAction: ({
    nodeId,
    registry,
  }: {
    nodeId: string;
    registry: ReadonlyMap<string, { definition: unknown }>;
  }) => registry.get(nodeId)?.definition,
  startRemoteAgentSession: vi.fn(),
}));

const ADAPTER: ChannelAdapter = { kind: "channel:test" };
const BASE_STATE: DurableSessionState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1,
};

const LOCAL_HANDLE: AgentHandle = {
  continuationToken: "subagent:parent:child",
  id: deriveAgentId("research", "child-session-123456789012"),
  kind: "agent/local",
  lastStatus: "initial result",
  name: "research",
  nodeId: "subagents/research",
  relationship: "child",
  sessionId: "child-session-123456789012",
  updatedAt: "2026-07-28T00:00:00.000Z",
  url: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deliver.mockResolvedValue({ sessionId: LOCAL_HANDLE.sessionId });
  mocks.continueRemoteAgentSession.mockResolvedValue(undefined);
  mocks.hydrateDurableSession.mockImplementation(({ durable }) => durable);
  mocks.createDurableSessionState.mockImplementation(({ session }) => ({
    ...BASE_STATE,
    snapshot: { session, version: 1 },
  }));
});

describe("dispatchRuntimeActionsStep agent delivery", () => {
  it("delivers the raw message to a stored local handle and records its identity", async () => {
    const session = createPendingSession({
      handle: LOCAL_HANDLE,
      agentId: LOCAL_HANDLE.id,
    });
    installContext(session);
    const writes: Uint8Array[] = [];

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(writes),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([]);
    expect(mocks.deliver).toHaveBeenCalledWith({
      caller: {
        callId: "call-1",
        replyTo: { kind: "hook", token: "turn-inbox" },
        subagentName: "research",
      },
      continuationToken: LOCAL_HANDLE.continuationToken,
      payload: {
        message: "continue with raw input",
        outputSchema: undefined,
      },
    });
    expect(getPendingRuntimeActionBatch(result.sessionState.snapshot?.session.state)).toMatchObject(
      {
        childContinuationTokens: { "call-1": LOCAL_HANDLE.continuationToken },
        childKinds: { "call-1": "agent/local" },
        childSessionIds: { "call-1": LOCAL_HANDLE.sessionId },
      },
    );
    expect(writes).toHaveLength(1);
  });

  it.each([
    {
      handle: undefined,
      agentId: "ag_research:missing",
      code: "AGENT_UNKNOWN",
      title: "unknown",
    },
    {
      handle: { ...LOCAL_HANDLE, name: "writer" },
      agentId: LOCAL_HANDLE.id,
      code: "AGENT_MISMATCH",
      title: "mismatched",
    },
  ])("returns $code for a $title agent", async ({ handle, agentId, code }) => {
    const session = createPendingSession({ handle, agentId });
    installContext(session);

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: expect.objectContaining({ code }),
      }),
    ]);
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.continueRemoteAgentSession).not.toHaveBeenCalled();
  });

  it("returns AGENT_UNREACHABLE and removes a stale local handle", async () => {
    const session = createPendingSession({
      handle: LOCAL_HANDLE,
      agentId: LOCAL_HANDLE.id,
    });
    installContext(session);
    mocks.deliver.mockRejectedValue(
      new RuntimeNoActiveSessionError(LOCAL_HANDLE.continuationToken),
    );

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "AGENT_UNREACHABLE" },
    });
    expect(getAgentHandleStore(result.sessionState.snapshot?.session.state)).toEqual({
      handles: [],
    });
  });

  it("continues a stored remote handle and maps a permanent failure to AGENT_UNREACHABLE", async () => {
    const remoteHandle: AgentHandle = {
      ...LOCAL_HANDLE,
      callbackBaseUrl: "https://caller.example.com",
      continuationToken: "remote-token",
      id: deriveAgentId("research", "remote-session-123456789012"),
      kind: "agent/remote",
      nodeId: "remote/research",
      sessionId: "remote-session-123456789012",
      url: "https://remote.example.com",
    };
    const session = createPendingSession({
      handle: remoteHandle,
      agentId: remoteHandle.id,
    });
    installContext(session, {
      definition: {
        description: "Remote research",
        kind: "remote",
        name: "research",
        nodeId: remoteHandle.nodeId,
        path: "/eve/v1/session",
        url: "https://registry.example.com",
      },
      nodeId: remoteHandle.nodeId,
    });
    mocks.continueRemoteAgentSession.mockRejectedValue(
      Object.assign(new Error("HTTP 404 session not resumable"), { retryable: false }),
    );

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(mocks.continueRemoteAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        continuationToken: remoteHandle.continuationToken,
        message: "continue with raw input",
        remote: expect.objectContaining({
          nodeId: remoteHandle.nodeId,
          url: remoteHandle.url,
        }),
        sessionId: remoteHandle.sessionId,
      }),
    );
    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "AGENT_UNREACHABLE" },
    });
    expect(getAgentHandleStore(result.sessionState.snapshot?.session.state)).toEqual({
      handles: [],
    });
  });

  it("rethrows a transient remote continue failure so the durable step retries", async () => {
    const remoteHandle: AgentHandle = {
      ...LOCAL_HANDLE,
      callbackBaseUrl: "https://caller.example.com",
      continuationToken: "remote-token",
      id: deriveAgentId("research", "remote-session-123456789012"),
      kind: "agent/remote",
      nodeId: "remote/research",
      sessionId: "remote-session-123456789012",
      url: "https://remote.example.com",
    };
    const session = createPendingSession({
      handle: remoteHandle,
      agentId: remoteHandle.id,
    });
    installContext(session, {
      definition: {
        description: "Remote research",
        kind: "remote",
        name: "research",
        nodeId: remoteHandle.nodeId,
        path: "/eve/v1/session",
        url: "https://registry.example.com",
      },
      nodeId: remoteHandle.nodeId,
    });
    mocks.continueRemoteAgentSession.mockRejectedValue(new Error("HTTP 503"));

    await expect(
      dispatchRuntimeActionsStep({
        parentContinuationToken: "turn-inbox",
        parentWritable: createWritable(),
        serializedContext: {},
        sessionState: BASE_STATE,
      }),
    ).rejects.toThrow("HTTP 503");
  });
});

function createPendingSession(input: {
  readonly handle?: AgentHandle;
  readonly agentId: string;
}): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
  };
  const withHandle = input.handle === undefined ? base : upsertAgentHandle(base, input.handle);
  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-1",
        description: "Research",
        input: { agentId: input.agentId, message: "continue with raw input" },
        kind: "subagent-call",
        name: "research",
        nodeId: "subagents/research",
        subagentName: "research",
      },
    ],
    event: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
    responseMessages: [],
    session: withHandle,
  });
}

function installContext(
  session: HarnessSession,
  remote?: { readonly definition: unknown; readonly nodeId: string },
): void {
  const subagentsByNodeId = new Map<string, { definition: unknown }>();
  if (remote !== undefined) {
    subagentsByNodeId.set(remote.nodeId, { definition: remote.definition });
  }
  const bundle = {
    compiledArtifactsSource: {},
    resolvedAgent: { config: {} },
    subagentRegistry: { subagentsByNodeId },
    turnAgent: {
      id: "test-agent",
      instructions: [],
      model: { id: "test-model" },
      skills: [],
      tools: [],
      workspaceSpec: {},
    },
  };
  const values = new Map<unknown, unknown>([
    [AuthKey, null],
    [BundleKey, bundle],
    [CapabilitiesKey, undefined],
    [ChannelInstrumentationKey, undefined],
    [ChannelKey, ADAPTER],
    [InitiatorAuthKey, null],
  ]);
  mocks.deserializeContext.mockResolvedValue({
    get: (key: unknown) => values.get(key),
    require: (key: unknown) => {
      if (!values.has(key)) throw new Error("missing context key");
      return values.get(key);
    },
  });
  mocks.readDurableSession.mockResolvedValue(session);
}

function createWritable(writes: Uint8Array[] = []): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      writes.push(chunk);
    },
  });
}
