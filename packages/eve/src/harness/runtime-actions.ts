import type { ModelMessage, ToolSet, TypedToolCall } from "ai";

import { createActionResultEvent, type HandleMessageStreamEvent } from "#protocol/message.js";
import { getRuntimeActionRequestKey, getRuntimeActionResultKey } from "#runtime/actions/keys.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import {
  deriveAgentId,
  getAgentHandleStore,
  removeAgentHandle,
  renderAgentsSnippet,
  upsertAgentHandle,
  type AgentHandle,
  type AgentHandleKind,
} from "#harness/agent-handles.js";
import { clearProxyInputRequestsForChild } from "#harness/proxy-input-requests.js";
import {
  accumulateSessionUsage,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import type {
  HarnessEmitFn,
  HarnessSession,
  HarnessToolMap,
  SessionStateMap,
  StepInput,
} from "#harness/types.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";

const PENDING_RUNTIME_ACTION_BATCH_KEY = "eve.runtime.pendingActionBatch";
type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/**
 * Serializable event coordinates for one pending runtime-action batch.
 *
 * Runtime action results are projected back onto the parent stream using the
 * same turn and step identity as the originating `actions.requested` batch.
 */
interface PendingRuntimeActionEventMetadata {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * Serializable pending runtime-action batch stored on `session.state`.
 *
 * `childContinuationTokens`, `childSessionIds`, `childKinds`, `childUrls`, and
 * `childCallbackBaseUrls` preserve the delivery coordinates needed to continue
 * via agentId or cancel every successfully adopted child after the batch
 * resolves.
 */
export interface PendingRuntimeActionBatch {
  readonly actions: readonly RuntimeActionRequest[];
  readonly childCallbackBaseUrls?: Readonly<Record<string, string>>;
  readonly childContinuationTokens?: Readonly<Record<string, string>>;
  readonly childKinds?: Readonly<Record<string, AgentHandleKind>>;
  readonly childSessionIds?: Readonly<Record<string, string>>;
  readonly childUrls?: Readonly<Record<string, string>>;
  readonly event: PendingRuntimeActionEventMetadata;
  readonly responseMessages: readonly ModelMessage[];
}

/**
 * Outcome of resolving a pending runtime-action batch.
 */
interface ResolvePendingRuntimeActionsResult {
  readonly messages: ModelMessage[];
  readonly outcome: "continue" | "resolved" | "unresolved";
  readonly session: HarnessSession;
}

/** Returns the pending runtime-action batch stored on the session, if any. */
export function getPendingRuntimeActionBatch(
  state: SessionStateMap | undefined,
): PendingRuntimeActionBatch | undefined {
  const value = state?.[PENDING_RUNTIME_ACTION_BATCH_KEY];

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const batch = value as PendingRuntimeActionBatch;

  if (
    !Array.isArray(batch.actions) ||
    !Array.isArray(batch.responseMessages) ||
    typeof batch.event !== "object" ||
    batch.event === null
  ) {
    return undefined;
  }

  return batch;
}

/**
 * Returns true when the session is parked on a pending runtime-action batch.
 */
export function hasPendingRuntimeActionBatch(state: SessionStateMap | undefined): boolean {
  return getPendingRuntimeActionBatch(state) !== undefined;
}

export function clearPendingRuntimeActionBatch(session: HarnessSession): HarnessSession {
  if (session.state?.[PENDING_RUNTIME_ACTION_BATCH_KEY] === undefined) {
    return session;
  }
  const state = { ...session.state };
  delete state[PENDING_RUNTIME_ACTION_BATCH_KEY];
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

/**
 * Stores one pending runtime-action batch on the session.
 */
export function setPendingRuntimeActionBatch(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly event: PendingRuntimeActionEventMetadata;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  const state = { ...input.session.state };
  state[PENDING_RUNTIME_ACTION_BATCH_KEY] = {
    actions: [...input.actions],
    event: input.event,
    responseMessages: [...input.responseMessages],
  } satisfies PendingRuntimeActionBatch;

  return { ...input.session, state };
}

type PendingSubagentChildIdentity =
  | {
      readonly continuationToken: string;
      readonly kind: "local" | "runtime";
      readonly sessionId: string;
    }
  | {
      readonly callbackBaseUrl: string;
      readonly continuationToken: string;
      readonly kind: "remote";
      readonly sessionId: string;
      readonly url: string;
    };

/** Records one successfully dispatched child's durable identities. */
export function recordPendingSubagentChild(input: {
  readonly callId: string;
  readonly child: PendingSubagentChildIdentity;
  readonly session: HarnessSession;
}): HarnessSession {
  const batch = getPendingRuntimeActionBatch(input.session.state);

  if (batch === undefined) {
    return input.session;
  }

  const state = { ...input.session.state };
  state[PENDING_RUNTIME_ACTION_BATCH_KEY] = {
    ...batch,
    childContinuationTokens: {
      ...batch.childContinuationTokens,
      [input.callId]: input.child.continuationToken,
    },
    childKinds: {
      ...batch.childKinds,
      [input.callId]: `agent/${input.child.kind}`,
    },
    childSessionIds: {
      ...batch.childSessionIds,
      [input.callId]: input.child.sessionId,
    },
    ...(input.child.kind === "remote"
      ? {
          childCallbackBaseUrls: {
            ...batch.childCallbackBaseUrls,
            [input.callId]: input.child.callbackBaseUrl,
          },
          childUrls: {
            ...batch.childUrls,
            [input.callId]: input.child.url,
          },
        }
      : {}),
  } satisfies PendingRuntimeActionBatch;

  return { ...input.session, state };
}

/**
 * Returns the stable ordered runtime-action results for the current pending
 * batch when every action has a matching result. Unknown and duplicate results
 * are ignored.
 */
function resolveReadyRuntimeActionResults(input: {
  readonly results: readonly RuntimeActionResult[];
  readonly session: HarnessSession;
}): RuntimeActionResult[] | undefined {
  const batch = getPendingRuntimeActionBatch(input.session.state);

  if (batch === undefined) {
    return undefined;
  }

  return resolveRuntimeActionResultsForBatch({ batch, results: input.results });
}

function resolveRuntimeActionResultsForBatch(input: {
  readonly batch: PendingRuntimeActionBatch;
  readonly results: readonly RuntimeActionResult[];
}): RuntimeActionResult[] | undefined {
  return resolveRuntimeActionResultsForKeys({
    pendingKeys: input.batch.actions.map((action) => getRuntimeActionRequestKey(action)),
    results: input.results,
  });
}

/** Returns results in pending-key order once every requested action has completed. */
export function resolveRuntimeActionResultsForKeys(input: {
  readonly pendingKeys: readonly string[];
  readonly results: readonly RuntimeActionResult[];
}): RuntimeActionResult[] | undefined {
  const pendingKeySet = new Set(input.pendingKeys);
  const resultsByKey = new Map<string, RuntimeActionResult>();

  for (const result of input.results) {
    const key = getRuntimeActionResultKey(result);

    if (!pendingKeySet.has(key)) {
      continue;
    }

    resultsByKey.set(key, result);
  }

  const orderedResults: RuntimeActionResult[] = [];

  for (const key of input.pendingKeys) {
    const result = resultsByKey.get(key);

    if (result === undefined) {
      return undefined;
    }

    orderedResults.push(result);
  }

  return orderedResults;
}

/**
 * Resolves one pending runtime-action batch back into model history.
 *
 * When all expected runtime action results are present, this appends the
 * stored assistant tool-call messages plus synthesized tool-result messages to
 * history, clears the pending batch, and emits `subagent.completed` and
 * `action.result` events back onto the parent stream.
 */
export async function resolvePendingRuntimeActions(input: {
  readonly emit?: HarnessEmitFn;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): Promise<ResolvePendingRuntimeActionsResult> {
  const batch = getPendingRuntimeActionBatch(input.session.state);

  if (batch === undefined) {
    return {
      messages: [...input.session.history],
      outcome: "continue",
      session: input.session,
    };
  }

  const readyResults = resolveReadyRuntimeActionResults({
    results: input.stepInput?.runtimeActionResults ?? [],
    session: input.session,
  });

  if (readyResults === undefined) {
    return {
      messages: [...input.session.history],
      outcome: "unresolved",
      session: input.session,
    };
  }

  if (input.emit !== undefined) {
    for (const result of readyResults) {
      if (result.kind === "subagent-result" && result.isError !== true) {
        await input.emit({
          data: {
            callId: result.callId,
            output:
              typeof result.output === "string" ? result.output : JSON.stringify(result.output),
            subagentName: result.subagentName,
          },
          type: "subagent.completed",
        } satisfies Extract<HandleMessageStreamEvent, { type: "subagent.completed" }>);
      }

      await input.emit(
        createActionResultEvent({
          result,
          sequence: batch.event.sequence,
          stepIndex: batch.event.stepIndex,
          turnId: batch.event.turnId,
        }),
      );
    }
  }

  const handleUpdate = updateAgentHandles({
    batch,
    results: readyResults,
    session: input.session,
  });
  const state = { ...handleUpdate.session.state };
  delete state[PENDING_RUNTIME_ACTION_BATCH_KEY];

  let nextSession: HarnessSession = {
    ...handleUpdate.session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };

  // Clear proxy-input entries for completed children so future
  // deliveries don't route responses to a dead child.
  const childTokens = batch.childContinuationTokens;
  if (childTokens !== undefined) {
    for (const result of readyResults) {
      if (result.kind !== "subagent-result") {
        continue;
      }

      const childToken = childTokens[result.callId];
      if (childToken !== undefined) {
        nextSession = clearProxyInputRequestsForChild(nextSession, childToken);
      }
    }
  }

  // Draw completed child spend down against the parent's session totals so
  // the session token limits and the remaining-quota budget granted to later
  // delegations account for what the tree has already spent.
  for (const result of readyResults) {
    if (result.kind !== "subagent-result" || result.usage === undefined) {
      continue;
    }
    nextSession = setTurnUsageState(
      nextSession,
      accumulateSessionUsage({
        previous: getTurnUsageState(nextSession.state),
        usage: result.usage,
      }),
    );
  }

  const toolResults = readyResults.map((result) => {
    switch (result.kind) {
      case "load-skill-result":
        return {
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: "load_skill",
          type: "tool-result" as const,
        };
      case "subagent-result":
        return {
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: result.subagentName,
          type: "tool-result" as const,
        };
      case "tool-result":
        return {
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: result.toolName,
          type: "tool-result" as const,
        };
    }

    throw new Error(`Unsupported runtime action result kind "${String(result)}".`);
  });

  const messages = [...nextSession.history, ...batch.responseMessages];

  if (toolResults.length > 0) {
    messages.push({
      content: toolResults,
      role: "tool",
    });
  }
  if (handleUpdate.changed) {
    const store = getAgentHandleStore(nextSession.state);
    if (store !== undefined) {
      messages.push({
        content: renderAgentsSnippet(store),
        role: "system",
      });
    }
  }

  return {
    messages,
    outcome: "resolved",
    session: nextSession,
  };
}

function updateAgentHandles(input: {
  readonly batch: PendingRuntimeActionBatch;
  readonly results: readonly RuntimeActionResult[];
  readonly session: HarnessSession;
}): { readonly changed: boolean; readonly session: HarnessSession } {
  let changed = false;
  let session = input.session;

  for (const result of input.results) {
    if (result.kind !== "subagent-result") {
      continue;
    }

    const action = input.batch.actions.find((candidate) => candidate.callId === result.callId);
    if (
      action === undefined ||
      (action.kind !== "subagent-call" && action.kind !== "remote-agent-call")
    ) {
      continue;
    }

    // Dispatch-time capture is authoritative: the pending batch persists at the
    // dispatch step boundary, strictly before any result can be consumed.
    const sessionId = input.batch.childSessionIds?.[result.callId];
    const continuationToken = input.batch.childContinuationTokens?.[result.callId];
    if (sessionId === undefined || continuationToken === undefined) {
      continue;
    }

    const name = action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
    const id = deriveAgentId(name, sessionId);
    if (hasTerminalSubagentErrorCode(result)) {
      const nextSession = removeAgentHandle(session, id);
      changed =
        changed ||
        nextSession !== session ||
        (typeof action.input.agentId === "string" && action.input.agentId === id);
      session = nextSession;
      continue;
    }

    const callbackBaseUrl = input.batch.childCallbackBaseUrls?.[result.callId];
    const description =
      typeof action.input.description === "string" ? action.input.description : undefined;
    const baseHandle = {
      continuationToken,
      id,
      kind:
        input.batch.childKinds?.[result.callId] ??
        (action.kind === "remote-agent-call"
          ? "agent/remote"
          : action.nodeId === ROOT_RUNTIME_AGENT_NODE_ID
            ? "agent/runtime"
            : "agent/local"),
      lastStatus: renderAgentStatus(result.output),
      name,
      nodeId: action.nodeId,
      relationship: "child",
      sessionId,
      updatedAt: new Date().toISOString(),
      url: input.batch.childUrls?.[result.callId] ?? "",
    } as const satisfies Partial<AgentHandle>;
    const withCallbackBaseUrl =
      callbackBaseUrl === undefined ? baseHandle : { ...baseHandle, callbackBaseUrl };
    session = upsertAgentHandle(
      session,
      description === undefined ? withCallbackBaseUrl : { ...withCallbackBaseUrl, description },
    );
    changed = true;
  }

  return { changed, session };
}

function hasTerminalSubagentErrorCode(
  result: Extract<RuntimeActionResult, { kind: "subagent-result" }>,
): boolean {
  if (result.isError !== true || result.output === null || typeof result.output !== "object") {
    return false;
  }
  const code = Reflect.get(result.output, "code");
  return (
    code === "SESSION_FAILED" ||
    code === "SUBAGENT_START_FAILED" ||
    code === "AGENT_UNREACHABLE" ||
    (typeof code === "string" && code.startsWith("REMOTE_AGENT_"))
  );
}

function renderAgentStatus(output: RuntimeSubagentResultActionResult["output"]): string {
  const rendered = typeof output === "string" ? output : JSON.stringify(output);
  return rendered.replace(/\s+/gu, " ").trim().slice(0, 120);
}

/**
 * Projects one AI SDK tool call into the eve runtime-action contract.
 */
export function createRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
  readonly tools: HarnessToolMap;
}): RuntimeActionRequest {
  const definition = input.tools.get(input.toolCall.toolName);

  if (definition?.runtimeAction?.kind === "subagent-call") {
    return {
      callId: input.toolCall.toolCallId,
      description: definition.description,
      input: resolveToolCallInputObject(input.toolCall.input, {
        callId: input.toolCall.toolCallId,
        toolName: input.toolCall.toolName,
      }),
      kind: "subagent-call",
      name: definition.name,
      nodeId: definition.runtimeAction.nodeId,
      subagentName: definition.runtimeAction.subagentName,
    };
  }

  if (definition?.runtimeAction?.kind === "remote-agent-call") {
    return {
      callId: input.toolCall.toolCallId,
      description: definition.description,
      input: resolveToolCallInputObject(input.toolCall.input, {
        callId: input.toolCall.toolCallId,
        toolName: input.toolCall.toolName,
      }),
      kind: "remote-agent-call",
      name: definition.name,
      nodeId: definition.runtimeAction.nodeId,
      remoteAgentName: definition.runtimeAction.remoteAgentName ?? definition.name,
    };
  }

  return {
    callId: input.toolCall.toolCallId,
    input: resolveToolCallInputObject(input.toolCall.input, {
      callId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
    }),
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
}

/**
 * Coerces an AI SDK tool-call `input` into the runtime-action `JsonObject`
 * contract, throwing a `TypeError` (with the original as `cause`) that names
 * the offending tool when the payload is not a JSON object.
 *
 * String inputs are parsed as JSON first: the model protocol carries tool
 * arguments as text, and provider-executed tool calls can surface that raw
 * string — or an empty string when the model sends no arguments.
 */
export function resolveToolCallInputObject(
  value: unknown,
  context: { readonly callId: string; readonly toolName: string },
): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === "string" && value.trim() === "") {
    return {};
  }

  try {
    return parseJsonObject(typeof value === "string" ? parseJsonStringInput(value) : value);
  } catch (error) {
    // This module is bundled into the workflow driver body, which cannot
    // import the logger, so enrich the error (and keep the original as
    // `cause`) for whatever catch site does the logging.
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `Failed to parse tool-call arguments for "${context.toolName}" (${context.callId}): ${detail}`,
      { cause: error },
    );
  }
}

function parseJsonStringInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Not JSON at all — return the raw string so parseJsonObject rejects it
    // with the canonical "Expected a JSON-serializable object." detail.
    return value;
  }
}

function toToolResultOutput(result: RuntimeActionResult): ToolResultPart["output"] {
  if (typeof result.output === "string") {
    if (result.isError === true) {
      return {
        type: "error-text",
        value: result.output,
      };
    }

    return {
      type: "text",
      value: result.output,
    };
  }

  if (result.isError === true) {
    return {
      type: "error-json",
      value: toMutableJsonValue(result.output),
    };
  }

  return {
    type: "json",
    value: toMutableJsonValue(result.output),
  };
}

function toMutableJsonValue(value: RuntimeActionResult["output"]): MutableJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toMutableJsonValue(item));
  }

  const next: Record<string, MutableJsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    next[key] = toMutableJsonValue(item);
  }

  return next;
}

type MutableJsonValue =
  | null
  | boolean
  | number
  | string
  | MutableJsonValue[]
  | { [key: string]: MutableJsonValue };
