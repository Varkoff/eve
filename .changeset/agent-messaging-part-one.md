---
"eve": patch
---

Add agent messaging: delegated children remain available after answering and can receive follow-up messages in the same session via the `agentId` tool parameter, discoverable from the `<agents>` context block. Breaking changes: conversation-mode children park instead of terminating, so their runs stay live until the parent completes; `POST /eve/v1/session/:sessionId` against a dead session now returns `404 SESSION_NOT_RESUMABLE` instead of silently starting a new session; delegated child terminal model failures now surface as error tool results; and remote delegation requires both deployments to run this eve version.
