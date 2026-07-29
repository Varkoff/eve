import { afterEach, describe, expect, it, vi } from "vitest";

import { runIntegrationSetupCommand } from "./integration-setup.js";
import type { RegistryCommandLogger } from "./registry.js";

const { isEveProject } = vi.hoisted(() => ({ isEveProject: vi.fn(async () => true) }));

vi.mock("#setup/scaffold/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/scaffold/index.js")>()),
  isEveProject,
}));

function logger(): RegistryCommandLogger & { errors: string[] } {
  const errors: string[] = [];
  return { errors, error: (message) => errors.push(message), log: () => {} };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runIntegrationSetupCommand", () => {
  it("rejects setup kinds outside Photon", async () => {
    const output = logger();

    await runIntegrationSetupCommand(output, "/project", "web");

    expect(output.errors).toEqual([
      'Integration setup "web" is not available in this version of eve. Upgrade eve and try again.',
    ]);
  });
});
