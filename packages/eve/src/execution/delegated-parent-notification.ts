/**
 * Sends delegated task results to their parent and conversation results to
 * the caller of each turn.
 */

import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import type { TurnCaller } from "#channel/types.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { isSubagentAdapterState, SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";

const log = createLogger("execution.delegated-parent-notification");

/**
 * Resumes the parent driver's hook with a delegated subagent result.
 * No-op for root sessions.
 *
 * `usage` — the completed child's session-total token spend — is
 * attached to success results so the caller can attribute the
 * subagent's tokens. Error results never carry usage.
 */
export async function notifyDelegatedParentStep(input: {
  readonly result: RuntimeSubagentResultActionResult | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.result === undefined) {
    return;
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.get(ChannelKey);

  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND) {
    return;
  }

  const parentContinuationToken = String(adapter.state?.parentContinuationToken ?? "");
  if (parentContinuationToken === "") {
    return;
  }

  const result =
    input.usage === undefined || input.result.isError === true
      ? input.result
      : { ...input.result, usage: input.usage };

  await resumeHook(parentContinuationToken, {
    kind: "runtime-action-result",
    results: [result],
  });
}

/**
 * Sends a settled conversation turn to the caller that started it.
 */
export async function notifyTurnCallerStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly settled: {
    readonly output: unknown;
    readonly isError?: boolean;
    readonly usage?: TokenUsage;
  };
}): Promise<void> {
  "use step";

  if (input.caller === undefined) {
    return;
  }

  const result = createSettledTurnResult({
    caller: input.caller,
    settled: input.settled,
  });

  if (input.caller.replyTo.kind === "callback") {
    await postSettledTurnCallback({
      result,
      sessionId: readSessionId(input.serializedContext),
      url: input.caller.replyTo.url,
    });
    return;
  }

  await resumeSettledTurnHook(input.caller.replyTo.token, result);
}

function createSettledTurnResult(input: {
  readonly caller: TurnCaller;
  readonly settled: {
    readonly output: unknown;
    readonly isError?: boolean;
    readonly usage?: TokenUsage;
  };
}): RuntimeSubagentResultActionResult {
  if (input.settled.isError === true) {
    return {
      callId: input.caller.callId,
      isError: true,
      kind: "subagent-result",
      output: {
        code: "SUBAGENT_EXECUTION_FAILED",
        message: toErrorMessage(input.settled.output),
      },
      subagentName: input.caller.subagentName,
    };
  }

  const result: RuntimeSubagentResultActionResult = {
    callId: input.caller.callId,
    kind: "subagent-result",
    output: parseJsonValue(input.settled.output),
    subagentName: input.caller.subagentName,
  };
  return input.settled.usage === undefined ? result : { ...result, usage: input.settled.usage };
}

/** Resolves the caller that created a delegated conversation session. */
export async function resolveInitialTurnCallerStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<TurnCaller | undefined> {
  "use step";

  const callbackValue = input.serializedContext[SessionCallbackKey.name];
  if (callbackValue !== undefined) {
    const parsed = parseSessionCallback(callbackValue);
    if (!parsed.ok) {
      throw new Error("Serialized session callback is invalid.", {
        cause: parsed.cause,
      });
    }
    return {
      callId: parsed.callback.callId,
      replyTo: { kind: "callback", url: parsed.callback.url },
      subagentName: parsed.callback.subagentName,
    };
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.get(ChannelKey);
  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND || !isSubagentAdapterState(adapter.state)) {
    return undefined;
  }

  return {
    callId: adapter.state.callId,
    replyTo: { kind: "hook", token: adapter.state.parentContinuationToken },
    subagentName: adapter.state.subagentName,
  };
}

async function postSettledTurnCallback(input: {
  readonly result: RuntimeSubagentResultActionResult;
  readonly sessionId: string;
  readonly url: string;
}): Promise<void> {
  if (input.result.isError === true) {
    await postCallbackPayload({
      payload: {
        callId: input.result.callId,
        error: input.result.output,
        kind: "turn.failed",
        sessionId: input.sessionId,
        subagentName: input.result.subagentName,
      },
      url: input.url,
    });
    return;
  }

  const payload: {
    callId: string;
    kind: "turn.completed";
    output: unknown;
    sessionId: string;
    subagentName: string;
    usage?: TokenUsage;
  } = {
    callId: input.result.callId,
    kind: "turn.completed",
    output: input.result.output,
    sessionId: input.sessionId,
    subagentName: input.result.subagentName,
  };
  if (input.result.usage !== undefined) {
    payload.usage = input.result.usage;
  }
  await postCallbackPayload({ payload, url: input.url });
}

async function postCallbackPayload(input: {
  readonly payload: unknown;
  readonly url: string;
}): Promise<void> {
  const response = await postSessionCallbackRequest({
    body: input.payload,
    url: input.url,
  });

  if (!response.ok) {
    throw new Error(`Turn callback failed with HTTP ${response.status}.`);
  }
}

function readSessionId(serializedContext: Record<string, unknown>): string {
  const sessionId = serializedContext[SessionIdKey.name];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Cannot send a settled turn callback without a session id.");
  }
  return sessionId;
}

async function resumeSettledTurnHook(
  token: string,
  result: RuntimeSubagentResultActionResult,
): Promise<void> {
  try {
    await resumeHook(token, {
      kind: "runtime-action-result",
      results: [result],
    });
  } catch (error) {
    if (!HookNotFoundError.is(error)) {
      throw error;
    }

    log.warn("turn caller hook no longer exists", {
      callId: result.callId,
      callerToken: token,
    });
  }
}
