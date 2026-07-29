import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  notifyDelegatedParentStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#execution/delegated-parent-notification.js";
import { SUBAGENT_ADAPTER, SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";

vi.mock("../runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

const resumeHookMock = vi.mocked(resumeHook);
const fetchMock = vi.fn();

const USAGE = { cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 50 };

function createSuccessResult(): RuntimeSubagentResultActionResult {
  return {
    callId: "call-1",
    kind: "subagent-result",
    output: "done",
    subagentName: "research",
  };
}

function createSerializedContext(): Record<string, unknown> {
  const bundle = {
    adapterRegistry: {
      adaptersByKind: new Map([[SUBAGENT_ADAPTER_KIND, SUBAGENT_ADAPTER]]),
    },
    compiledArtifactsSource: { kind: "test" },
    nodeId: undefined,
  } as never;
  vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);

  const ctx = new ContextContainer();
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, {
    ...SUBAGENT_ADAPTER,
    state: {
      callId: "call-1",
      parentContinuationToken: "parent-tok",
      parentSessionId: "parent-session",
      subagentName: "research",
    },
  });
  return serializeContext(ctx);
}

describe("notifyDelegatedParentStep", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
    resumeHookMock.mockResolvedValue(undefined as never);
  });

  it("attaches usage to a success result", async () => {
    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext(),
      usage: USAGE,
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          output: "done",
          subagentName: "research",
          usage: USAGE,
        },
      ],
    });
  });

  it("omits usage when none is provided", async () => {
    await notifyDelegatedParentStep({
      result: createSuccessResult(),
      serializedContext: createSerializedContext(),
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [createSuccessResult()],
    });
  });

  it("never attaches usage to error results", async () => {
    const errorResult: RuntimeSubagentResultActionResult = {
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      output: { code: "SUBAGENT_EXECUTION_FAILED", message: "boom" },
      subagentName: "research",
    };

    await notifyDelegatedParentStep({
      result: errorResult,
      serializedContext: createSerializedContext(),
      usage: USAGE,
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [errorResult],
    });
  });
});

describe("turn caller notification", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
    resumeHookMock.mockResolvedValue(undefined as never);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op when the conversation has no turn caller", async () => {
    const serializedContext = { "eve.sessionId": "root-session" };
    const caller = await resolveInitialTurnCallerStep({ serializedContext });

    expect(caller).toBeUndefined();
    await expect(
      notifyTurnCallerStep({
        caller,
        serializedContext,
        settled: { output: "root answer" },
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("uses the adapter state for the child's first settled turn", async () => {
    const serializedContext = createSerializedContext();
    const caller = await resolveInitialTurnCallerStep({ serializedContext });
    await notifyTurnCallerStep({
      caller,
      serializedContext,
      settled: { output: "first answer", usage: USAGE },
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-tok", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          output: "first answer",
          subagentName: "research",
          usage: USAGE,
        },
      ],
    });
  });

  it("notifies the caller of a continued turn", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-2",
        replyTo: { kind: "hook", token: "parent-turn-2" },
        subagentName: "research",
      },
      serializedContext: createSerializedContext(),
      settled: { output: "follow-up answer" },
    });

    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith("parent-turn-2", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-2",
          kind: "subagent-result",
          output: "follow-up answer",
          subagentName: "research",
        },
      ],
    });
  });

  it("threads settled errors without usage", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-2",
        replyTo: { kind: "hook", token: "parent-turn-2" },
        subagentName: "research",
      },
      serializedContext: createSerializedContext(),
      settled: {
        isError: true,
        output: "The agent could not produce a result matching the requested schema.",
        usage: USAGE,
      },
    });

    expect(resumeHookMock).toHaveBeenCalledWith("parent-turn-2", {
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-2",
          isError: true,
          kind: "subagent-result",
          output: {
            code: "SUBAGENT_EXECUTION_FAILED",
            message: "The agent could not produce a result matching the requested schema.",
          },
          subagentName: "research",
        },
      ],
    });
  });

  it("posts a settled turn to the remote callback for the first exchange", async () => {
    const serializedContext = {
      "eve.sessionCallback": {
        callId: "call-remote",
        subagentName: "remote",
        token: "parent-turn",
        url: "https://caller.example/eve/v1/callback/parent-turn",
      },
      "eve.sessionId": "remote-session",
    };
    const caller = await resolveInitialTurnCallerStep({ serializedContext });
    await notifyTurnCallerStep({
      caller,
      serializedContext,
      settled: { output: "remote answer" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://caller.example/eve/v1/callback/parent-turn",
      expect.objectContaining({
        body: JSON.stringify({
          callId: "call-remote",
          kind: "turn.completed",
          output: "remote answer",
          sessionId: "remote-session",
          subagentName: "remote",
        }),
        method: "POST",
      }),
    );
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("posts a failed turn without usage to a remote callback", async () => {
    await notifyTurnCallerStep({
      caller: {
        callId: "call-remote",
        replyTo: {
          kind: "callback",
          url: "https://caller.example/eve/v1/callback/parent-turn",
        },
        subagentName: "remote",
      },
      serializedContext: {
        "eve.sessionId": "remote-session",
      },
      settled: { isError: true, output: new Error("remote failed"), usage: USAGE },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://caller.example/eve/v1/callback/parent-turn",
      expect.objectContaining({
        body: JSON.stringify({
          callId: "call-remote",
          error: {
            code: "SUBAGENT_EXECUTION_FAILED",
            message: "remote failed",
          },
          kind: "turn.failed",
          sessionId: "remote-session",
          subagentName: "remote",
        }),
      }),
    );
  });

  it("warns and returns when the caller hook no longer exists", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resumeHookMock.mockRejectedValue(new HookNotFoundError("parent-tok"));

    try {
      await expect(
        notifyTurnCallerStep({
          caller: {
            callId: "call-1",
            replyTo: { kind: "hook", token: "parent-tok" },
            subagentName: "research",
          },
          serializedContext: createSerializedContext(),
          settled: { output: "late answer" },
        }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        "[eve:execution.delegated-parent-notification] turn caller hook no longer exists",
        expect.objectContaining({
          callId: "call-1",
          callerToken: "parent-tok",
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
