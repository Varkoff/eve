import { spawn } from "node:child_process";

import type { Prompter } from "#setup/prompter.js";

import { runIntegrationConnect } from "./integration-connect.js";
import { parseIntegrationSetupInvocation, runIntegrationSetup } from "./integration-setup.js";

export interface RegistrySetupCommand {
  command: string;
  args: string[];
}

/** Runs a trusted registry setup through the caller's interactive prompter. */
export async function runRegistrySetupCommandWithPrompter(
  appRoot: string,
  setup: RegistrySetupCommand,
  prompter: Prompter,
  signal?: AbortSignal,
): Promise<void> {
  const invocation = parseIntegrationSetupInvocation(setup);
  if (invocation === undefined) {
    throw new Error("Registry item declares an unsupported setup command.");
  }
  if (invocation.kind === "connection") {
    await runIntegrationConnect({
      appRoot,
      slug: invocation.slug,
      service: invocation.service,
      canonicalConnectorName: invocation.canonicalConnectorName,
      options: { signal },
      dependencies: { createPrompter: () => prompter },
    });
    return;
  }
  await runIntegrationSetup({
    appRoot,
    kind: invocation.channel,
    options: { yes: invocation.yes, signal },
    dependencies: { createPrompter: () => prompter },
  });
}

/** Executes a trusted registry setup command in the consuming project. */
export function runRegistrySetupCommand(
  appRoot: string,
  setup: RegistrySetupCommand,
): Promise<void> {
  const command = setup.command;
  const args = setup.args;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: appRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `Setup command exited with code ${code ?? "unknown"}.`
            : `Setup command was terminated by ${signal}.`,
        ),
      );
    });
  });
}
