import { defineEval } from "eve/evals";

const MEMORABLE_FACT = "The observatory locker code is ORBIT-CEDAR-7319.";

/** A second delegation via agentId resumes the first child's conversation. */
export default defineEval({
  description: "A parent re-messages one parked agent and receives a fact from its earlier turn.",
  async test(t) {
    await t.send(
      [
        "Call the built-in agent subagent exactly twice.",
        `In the first call, say: "Remember this exact fact: ${MEMORABLE_FACT} Reply only with READY."`,
        "After it returns, read that child's agentId from the latest <agents> block.",
        'Call the agent subagent again with that agentId and the message: "What exact fact did I ask you to remember? Reply with only the fact."',
        "Do not repeat the fact in the second call.",
        "After the second call returns, reply with its exact output and no other text.",
      ].join(" "),
    );

    t.succeeded();
    t.calledSubagent("agent", { count: 2 });
    t.calledSubagent("agent", { output: new RegExp(MEMORABLE_FACT), count: 1 });
    t.eventsSatisfy("both calls continue one child session", (events) => {
      const childSessionIds = events.flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "agent"
          ? [event.data.childSessionId]
          : [],
      );
      return (
        childSessionIds.length === 2 &&
        childSessionIds[0] !== undefined &&
        childSessionIds[0] === childSessionIds[1]
      );
    });
    t.messageIncludes(MEMORABLE_FACT);
    t.noFailedActions();
  },
});
