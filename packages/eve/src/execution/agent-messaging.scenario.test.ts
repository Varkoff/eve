import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { Client } from "#client/client.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";
import { EVE_SESSION_ID_HEADER, type HandleMessageStreamEvent } from "#protocol/message.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const EVENT_TIMEOUT_MS = 30_000;
const CODEWORD = "LANTERN-COMET-7319";
const PARENT_RESULT = `PARENT_RECALLED=${CODEWORD}`;

const AGENT_MESSAGING_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const CODEWORD = ${JSON.stringify(CODEWORD)};
const AGENT_ID_PATTERN = /<agent id="([^"]+)" name="memory-child">/u;

const model = mockModel((request) => {
  const childResults = request.toolResults.filter((result) => result.name === "memory-child");

  if (childResults.length === 0) {
    return {
      toolCalls: [
        {
          id: "memory-exchange-1",
          input: {
            description: "Store a codeword",
            message: \`Remember the codeword \${CODEWORD}. Confirm that you stored it.\`,
          },
          name: "memory-child",
        },
      ],
    };
  }

  if (childResults.length === 1) {
    const agentsSnippet = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.text)
      .join("\\n");
    const agentId = AGENT_ID_PATTERN.exec(agentsSnippet)?.[1];
    if (agentId === undefined) {
      throw new Error("Parent model did not receive a memory-child agent id.");
    }

    return {
      toolCalls: [
        {
          id: "memory-exchange-2",
          input: {
            agentId,
            description: "Recall the codeword",
            message: "What codeword did I ask you to remember? Reply with the codeword.",
          },
          name: "memory-child",
        },
      ],
    };
  }

  if (childResults.length === 2) {
    const recalled = childResults[1]?.output;
    if (typeof recalled !== "string") {
      throw new Error("Second child result was not text.");
    }
    return \`PARENT_RECALLED=\${recalled}\`;
  }

  throw new Error("Parent model received an unexpected number of child results.");
});

export default defineAgent({
  model,
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/eve.ts": `import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({ auth: none() });
`,
    "agent/instructions.md": "Run the scripted memory-child exchanges.\n",
    "agent/subagents/memory-child/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const CODEWORD = ${JSON.stringify(CODEWORD)};

const model = mockModel((request) => {
  if (request.userMessageCount === 1) {
    return request.lastUserMessage?.includes(CODEWORD) === true
      ? \`STORED=\${CODEWORD}\`
      : "FIRST_EXCHANGE_MISSING_CODEWORD";
  }

  if (request.userMessageCount === 2) {
    const retainedFirstExchange = request.userMessages[0]?.includes(CODEWORD) === true;
    const asksForCodeword = request.lastUserMessage?.includes("What codeword") === true;
    return retainedFirstExchange && asksForCodeword ? CODEWORD : "CONTEXT_LOST";
  }

  throw new Error("Child model received an unexpected conversation length.");
});

export default defineAgent({
  description: "Remember a fact and recall it in a later agent exchange.",
  model,
  modelContextWindowTokens: 32_000,
});
`,
    "agent/subagents/memory-child/instructions.md":
      "Remember facts from earlier turns and answer follow-up questions from that history.\n",
  },
  installDependencies: true,
  name: "agent-messaging",
};

describe("agent messaging", () => {
  it(
    "continues one parked child with its retained conversation and terminates it with the parent",
    async () => {
      const app = await scenarioApp(AGENT_MESSAGING_DESCRIPTOR);
      const server = await startScriptedEveDev(app.appRoot);

      try {
        const createResponse = await fetch(new URL("eve/v1/session", server.url), {
          body: JSON.stringify({
            message: "Run both scripted memory-child exchanges.",
            mode: "task",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(createResponse.status).toBe(202);

        const parentSessionId = createResponse.headers.get(EVE_SESSION_ID_HEADER);
        if (parentSessionId === null) {
          throw new Error("Parent session response did not include a session id.");
        }

        const client = new Client({ host: server.url });
        const parentEvents = await collectStreamToEnd({
          label: "parent task completion",
          stream: client.session({ sessionId: parentSessionId, streamIndex: 0 }).stream(),
        });
        const calls = filterEventsByType(parentEvents, "subagent.called");

        if (calls.length !== 2) {
          throw new Error(
            `Expected two subagent calls. Parent events: ${JSON.stringify(parentEvents)}`,
          );
        }
        expect(calls[0]?.data.childSessionId).toBeDefined();
        expect(calls[1]?.data.childSessionId).toBe(calls[0]?.data.childSessionId);
        expect(parentEvents.at(-1)?.type).toBe("session.completed");
        expect(
          filterEventsByType(parentEvents, "message.completed").some(
            (event) => event.data.message === PARENT_RESULT,
          ),
        ).toBe(true);

        const childSessionId = calls[0]?.data.childSessionId;
        if (childSessionId === undefined) {
          throw new Error("First subagent.called event did not include a child session id.");
        }

        const childEvents = await collectStreamToEnd({
          label: "persisted child events",
          stream: client
            .session({ sessionId: childSessionId, streamIndex: 0 })
            .stream({ follow: false }),
        });
        const childTurnStarts = indexesOf(childEvents, "turn.started");
        const childWaits = indexesOf(childEvents, "session.waiting");

        expect(childTurnStarts).toHaveLength(2);
        expect(childWaits).toHaveLength(2);
        expect(childWaits[0]).toBeLessThan(childTurnStarts[1] ?? -1);
        expect(filterEventsByType(childEvents, "session.completed")).toHaveLength(0);
        expect(filterEventsByType(childEvents, "session.failed")).toHaveLength(0);
        expect(
          filterEventsByType(childEvents, "message.completed").some(
            (event) => event.data.message === CODEWORD,
          ),
        ).toBe(true);
        expect(await readWorkflowRunStatus(app.appRoot, childSessionId)).toBe("cancelled");
      } catch (error) {
        throw new Error(
          [`stdout:\n${server.stdout()}`, `stderr:\n${server.stderr()}`].join("\n\n"),
          { cause: error },
        );
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function collectStreamToEnd(input: {
  readonly label: string;
  readonly stream: AsyncIterable<HandleMessageStreamEvent>;
}): Promise<readonly HandleMessageStreamEvent[]> {
  const events: HandleMessageStreamEvent[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      (async () => {
        for await (const event of input.stream) {
          events.push(event);
        }
        return events;
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${input.label}.`)),
          EVENT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function indexesOf(
  events: readonly HandleMessageStreamEvent[],
  type: HandleMessageStreamEvent["type"],
): readonly number[] {
  return events.flatMap((event, index) => (event.type === type ? [index] : []));
}

async function readWorkflowRunStatus(appRoot: string, sessionId: string): Promise<string> {
  const runPath = join(appRoot, ".eve", ".workflow-data", "runs", `${sessionId}.json`);
  const run: unknown = JSON.parse(await readFile(runPath, "utf8"));

  if (typeof run !== "object" || run === null) {
    throw new Error(`Workflow run ${sessionId} was not an object.`);
  }

  const status = Reflect.get(run, "status");
  if (typeof status !== "string") {
    throw new Error(`Workflow run ${sessionId} did not contain a string status.`);
  }

  return status;
}

interface RunningScriptedEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

async function startScriptedEveDev(appRoot: string): Promise<RunningScriptedEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        EVE_MOCK_AUTHORED_MODELS: "",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let url: string;
  try {
    url = await waitForServerUrl(child, () => ({ stderr, stdout }));
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChild(child);
    },
    url,
  };
}

async function waitForServerUrl(
  child: ChildProcessByStdio<null, Readable, Readable>,
  output: () => { readonly stderr: string; readonly stdout: string },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      const current = output();
      reject(
        new Error(
          `Timed out waiting for eve dev.\n\nstdout:\n${current.stdout}\n\nstderr:\n${current.stderr}`,
        ),
      );
    }, EVENT_TIMEOUT_MS);

    function inspect() {
      const match = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(output().stdout);
      if (match?.[1] === undefined) {
        return;
      }
      cleanup();
      resolve(match[1]);
    }

    function exited(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      const current = output();
      reject(
        new Error(
          [
            `eve dev exited before startup (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${current.stdout}`,
            `stderr:\n${current.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("exit", exited);
    }

    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", exited);
    inspect();
  });
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
