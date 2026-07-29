/**
 * Starts every pending runtime action for the parked parent session.
 *
 * Each child run starts in task mode, emits a parent `subagent.called`
 * control-plane event, and then runs independently on its own child
 * stream. Records each child's continuation token on the parent
 * session and returns the updated snapshot-bearing state.
 */

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
} from "#context/keys.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  AGENT_MISMATCH,
  AGENT_UNKNOWN,
  AGENT_UNREACHABLE,
  getAgentHandleStore,
  removeAgentHandle,
  type AgentHandle,
} from "#harness/agent-handles.js";
import {
  getPendingRuntimeActionBatch,
  recordPendingSubagentChild,
} from "#harness/runtime-actions.js";
import {
  createSubagentCalledEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import {
  continueRemoteAgentSession,
  isRetryableRemoteAgentContinueError,
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { hydrateDurableSession } from "#execution/session.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { normalizeRequestedOutputSchema } from "#execution/subagent-invocation.js";
import { createWorkflowRuntime, workflowEntryReference } from "#execution/workflow-runtime.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import { createLogger, logError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";

const log = createLogger("execution.dispatch-runtime-actions");

type RuntimeAgentHandleAction =
  | RuntimeRemoteAgentCallActionRequest
  | RuntimeSubagentCallActionRequest;

type RuntimeSession = ReturnType<typeof hydrateDurableSession>;

type AgentHandleDispatchOutcome =
  | {
      readonly childSessionId: string;
      readonly kind: "called";
      readonly name: string;
      readonly remote?: { readonly url: string };
      readonly session: RuntimeSession;
      readonly toolName: string;
    }
  | {
      readonly kind: "error";
      readonly result: RuntimeSubagentResultActionResult;
      readonly session: RuntimeSession;
    };

export async function dispatchRuntimeActionsStep(input: {
  readonly callbackBaseUrl?: string;
  /** Internal hook that receives child completion and HITL payloads. */
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly results: readonly RuntimeSubagentResultActionResult[];
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const batch = getPendingRuntimeActionBatch(durableSession.state);

  if (batch === undefined || batch.actions.length === 0) {
    return { results: [], sessionState: input.sessionState };
  }

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const adapter = ctx.require(ChannelKey);
  const auth = ctx.get(AuthKey) ?? null;
  const capabilities = ctx.get(CapabilitiesKey);
  const channelMetadata = ctx.get(ChannelInstrumentationKey);
  const initiatorAuth = ctx.get(InitiatorAuthKey) ?? null;
  const writer = input.parentWritable.getWriter();

  const adapterCtx = buildAdapterContext(adapter, ctx);
  const subagentDepth = resolveSubagentDepth(session);
  // Split the parent's remaining token quota across the batch's local
  // subagent calls, the children that actually receive an enforced cap.
  // Remote agents run on their own deployment under their own limits and
  // do not dilute the local shares.
  const fanoutSize = batch.actions.filter((action) => action.kind === "subagent-call").length;

  let nextSession = session;
  const results: RuntimeSubagentResultActionResult[] = [];

  try {
    for (const action of batch.actions) {
      const agentId = typeof action.input.agentId === "string" ? action.input.agentId : undefined;
      if (agentId !== undefined && isAgentHandleAction(action)) {
        const handle = getAgentHandleStore(durableSession.state)?.handles.find(
          (candidate) => candidate.id === agentId,
        );
        const outcome = await dispatchToAgentHandle({
          action,
          agentId,
          bundle,
          currentSession: nextSession,
          handle,
          parentToken: input.parentContinuationToken ?? session.continuationToken,
        });
        nextSession = outcome.session;

        if (outcome.kind === "error") {
          results.push(outcome.result);
          continue;
        }

        const parentEvent = await callAdapterEventHandler(
          adapter,
          createSubagentCalledEvent({
            callId: action.callId,
            childSessionId: outcome.childSessionId,
            name: outcome.name,
            remote: outcome.remote,
            sequence: batch.event.sequence,
            sessionId: session.sessionId,
            toolName: outcome.toolName,
            turnId: batch.event.turnId,
            workflowId: workflowEntryReference.workflowId,
          }),
          adapterCtx,
        );
        await writer.write(
          encodeMessageStreamEvent(timestampHandleMessageStreamEvent(parentEvent)),
        );
        continue;
      }

      if (
        isRecursiveAgentAction(action, bundle.subagentRegistry.subagentsByNodeId) &&
        (session.rootSessionId !== undefined || subagentDepth.currentDepth > 0)
      ) {
        log.warn("recursive agent call blocked outside the root session", {
          callId: action.callId,
          currentDepth: subagentDepth.currentDepth,
          nodeId: action.nodeId,
          subagentName: action.subagentName,
        });
        results.push(createRecursiveAgentRootOnlyResult(action));
        continue;
      }

      let childSessionId: string;
      let name: string;
      let remote: { readonly url: string } | undefined;
      let toolName: string;

      switch (action.kind) {
        case "subagent-call": {
          const registered = bundle.subagentRegistry.subagentsByNodeId.get(action.nodeId);
          const source: SubagentInputSource =
            registered?.definition.kind === "subagent"
              ? { description: registered.definition.description, type: "local" }
              : { type: "runtime" };
          const childRuntime = createWorkflowRuntime({
            compiledArtifactsSource: bundle.compiledArtifactsSource,
            nodeId: action.nodeId,
          });
          const { childContinuationToken, runInput } = buildSubagentRunInput({
            action,
            auth,
            batchEvent: batch.event,
            capabilities,
            channelMetadata,
            fanoutSize,
            initiatorAuth,
            parentContinuationToken: input.parentContinuationToken,
            session,
            source,
          });
          try {
            const handle = await childRuntime.run(runInput);
            childSessionId = handle.sessionId;
          } catch (error) {
            logError(log, "local subagent start failed", error, {
              callId: action.callId,
              nodeId: action.nodeId,
              subagentName: action.subagentName,
            });
            results.push({
              callId: action.callId,
              isError: true,
              kind: "subagent-result",
              output: {
                code: "SUBAGENT_START_FAILED",
                message: toErrorMessage(error),
              },
              subagentName: action.subagentName,
            });
            continue;
          }

          nextSession = recordPendingSubagentChild({
            callId: action.callId,
            child: {
              continuationToken: childContinuationToken,
              kind: source.type,
              sessionId: childSessionId,
            },
            session: nextSession,
          });
          name = action.name;
          toolName = action.subagentName;
          break;
        }
        case "remote-agent-call": {
          let resolvedRemote;
          try {
            const callbackBaseUrl = input.callbackBaseUrl;
            if (callbackBaseUrl === undefined) {
              throw new Error("Cannot dispatch remote agent without a callback base URL.");
            }
            resolvedRemote = resolveRemoteAgentForAction({
              nodeId: action.nodeId,
              remoteAgentName: action.remoteAgentName,
              registry: bundle.subagentRegistry.subagentsByNodeId,
            });
            const child = await startRemoteAgentSession({
              action,
              auth,
              callbackBaseUrl,
              callbackToken: input.parentContinuationToken,
              initiatorAuth,
              remote: resolvedRemote,
              session,
            });
            childSessionId = child.sessionId;
            nextSession = recordPendingSubagentChild({
              callId: action.callId,
              child: {
                callbackBaseUrl,
                continuationToken: child.continuationToken,
                kind: "remote",
                sessionId: child.sessionId,
                url: resolvedRemote.url,
              },
              session: nextSession,
            });
          } catch (error) {
            logError(log, "remote agent start failed", error, {
              remoteAgentName: action.remoteAgentName,
              nodeId: action.nodeId,
              callId: action.callId,
            });
            results.push(createRemoteAgentStartFailureResult({ action, error }));
            continue;
          }
          name = action.name;
          remote = { url: resolvedRemote.url };
          toolName = action.remoteAgentName;
          break;
        }
        default:
          throw new Error(`Unsupported runtime action kind "${action.kind}" in workflow runtime.`);
      }

      const parentEvent = await callAdapterEventHandler(
        adapter,
        createSubagentCalledEvent({
          callId: action.callId,
          childSessionId,
          name,
          remote,
          sequence: batch.event.sequence,
          sessionId: session.sessionId,
          toolName,
          turnId: batch.event.turnId,
          workflowId: workflowEntryReference.workflowId,
        }),
        adapterCtx,
      );
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(parentEvent)));
    }
  } finally {
    writer.releaseLock();
  }

  const nextState =
    nextSession === session
      ? input.sessionState
      : createDurableSessionState({ session: nextSession });

  return { results, sessionState: nextState };
}

async function dispatchToAgentHandle(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string;
  readonly bundle: CompiledBundle;
  readonly currentSession: RuntimeSession;
  readonly handle: AgentHandle | undefined;
  readonly parentToken: string;
}): Promise<AgentHandleDispatchOutcome> {
  const { action, agentId, bundle, handle } = input;
  const invokedName =
    action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;

  if (handle === undefined) {
    return {
      kind: "error",
      result: createAgentErrorResult({
        action,
        code: AGENT_UNKNOWN,
        message: `No agent from the <agents> list found for id "${agentId}".`,
      }),
      session: input.currentSession,
    };
  }
  if (handle.name !== invokedName) {
    return {
      kind: "error",
      result: createAgentErrorResult({
        action,
        code: AGENT_MISMATCH,
        message: `Agent "${agentId}" from the <agents> list belongs to "${handle.name}", not "${invokedName}".`,
      }),
      session: input.currentSession,
    };
  }

  try {
    if (handle.kind === "agent/remote") {
      const callbackBaseUrl = requireHandleCallbackBaseUrl(handle);
      const resolvedRemote = resolveRemoteAgentForAction({
        nodeId: handle.nodeId,
        remoteAgentName: handle.name,
        registry: bundle.subagentRegistry.subagentsByNodeId,
      });
      await continueRemoteAgentSession({
        callback: {
          callId: action.callId,
          subagentName: handle.name,
          token: input.parentToken,
          url: createWorkflowCallbackUrl(
            callbackBaseUrl,
            createEveCallbackRoutePath(input.parentToken),
          ),
        },
        continuationToken: handle.continuationToken,
        message: readSubagentMessage(action),
        outputSchema: normalizeRequestedOutputSchema(action.input.outputSchema),
        remote: { ...resolvedRemote, url: handle.url },
        sessionId: handle.sessionId,
      });
    } else {
      const childRuntime = createWorkflowRuntime({
        compiledArtifactsSource: bundle.compiledArtifactsSource,
        nodeId: handle.nodeId,
      });
      await childRuntime.deliver({
        caller: {
          callId: action.callId,
          replyTo: { kind: "hook", token: input.parentToken },
          subagentName: handle.name,
        },
        continuationToken: handle.continuationToken,
        payload: {
          message: readSubagentMessage(action),
          outputSchema: normalizeRequestedOutputSchema(action.input.outputSchema),
        },
      });
    }
  } catch (error) {
    // Only permanent failures forfeit the handle (and the child's accumulated
    // conversation). Transient remote failures rethrow so the durable step
    // retries the delivery.
    const isPermanentFailure =
      handle.kind === "agent/remote"
        ? !isRetryableRemoteAgentContinueError(error)
        : isRuntimeNoActiveSessionError(error);
    if (!isPermanentFailure) {
      throw error;
    }
    logError(log, "agent delivery failed", error, {
      agentId,
      callId: action.callId,
      nodeId: handle.nodeId,
      subagentName: handle.name,
    });
    return {
      kind: "error",
      result: createAgentErrorResult({
        action,
        code: AGENT_UNREACHABLE,
        message: `Agent "${handle.name}" with id "${agentId}" is no longer reachable.`,
      }),
      session: removeAgentHandle(input.currentSession, agentId),
    };
  }

  return {
    childSessionId: handle.sessionId,
    kind: "called",
    name: action.name,
    remote: handle.kind === "agent/remote" ? { url: handle.url } : undefined,
    session: recordPendingSubagentChild({
      callId: action.callId,
      child: pendingChildFromHandle(handle),
      session: input.currentSession,
    }),
    toolName: handle.name,
  };
}

function pendingChildFromHandle(handle: AgentHandle):
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
    } {
  if (handle.kind === "agent/remote") {
    return {
      callbackBaseUrl: requireHandleCallbackBaseUrl(handle),
      continuationToken: handle.continuationToken,
      kind: "remote",
      sessionId: handle.sessionId,
      url: handle.url,
    };
  }
  return {
    continuationToken: handle.continuationToken,
    kind: handle.kind === "agent/runtime" ? "runtime" : "local",
    sessionId: handle.sessionId,
  };
}

/**
 * Remote handles record their callback base URL when the child is adopted
 * (`startRemoteAgentSession` rejects dispatch without one), so a missing stub
 * means a corrupt or pre-stub handle.
 */
function requireHandleCallbackBaseUrl(handle: AgentHandle): string {
  if (handle.callbackBaseUrl === undefined) {
    throw new Error(`Agent handle "${handle.id}" has no callback base URL recorded from dispatch.`);
  }
  return handle.callbackBaseUrl;
}

function createAgentErrorResult(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;
  readonly code: string;
  readonly message: string;
}): RuntimeSubagentResultActionResult {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: input.code,
      message: input.message,
    },
    subagentName:
      input.action.kind === "remote-agent-call"
        ? input.action.remoteAgentName
        : input.action.subagentName,
  };
}

function readSubagentMessage(
  action: RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest,
): string {
  return typeof action.input.message === "string" ? action.input.message : "";
}

function isAgentHandleAction(action: RuntimeActionRequest): action is RuntimeAgentHandleAction {
  return action.kind === "subagent-call" || action.kind === "remote-agent-call";
}

function createRemoteAgentStartFailureResult(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly error: unknown;
}): RuntimeSubagentResultActionResult {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "REMOTE_AGENT_START_FAILED",
      message: toErrorMessage(input.error),
    },
    subagentName: input.action.remoteAgentName,
  };
}

function createRecursiveAgentRootOnlyResult(
  action: RuntimeSubagentCallActionRequest,
): RuntimeSubagentResultActionResult {
  return {
    callId: action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "RECURSIVE_AGENT_ROOT_ONLY",
      message: 'The built-in "agent" tool is only available to the root session.',
    },
    subagentName: action.subagentName,
  };
}

function isRecursiveAgentAction(
  action: RuntimeActionRequest,
  subagentsByNodeId: ReadonlyMap<string, unknown>,
): action is RuntimeSubagentCallActionRequest {
  return (
    action.kind === "subagent-call" &&
    action.subagentName === "agent" &&
    !subagentsByNodeId.has(action.nodeId)
  );
}
