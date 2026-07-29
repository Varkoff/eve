import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { runIntegrationConnect } from "./integration-connect.js";
import { parseIntegrationSetupInvocation, runIntegrationSetup } from "./integration-setup.js";
import { runRegistrySetupCommandWithPrompter } from "./registry-setup-command.js";

vi.mock("./integration-connect.js", () => ({ runIntegrationConnect: vi.fn() }));
vi.mock("./integration-setup.js", () => ({
  parseIntegrationSetupInvocation: vi.fn(),
  runIntegrationSetup: vi.fn(),
}));

describe("runRegistrySetupCommandWithPrompter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adapts a trusted invocation to integration setup", async () => {
    const fake = createFakePrompter();
    const signal = new AbortController().signal;
    vi.mocked(parseIntegrationSetupInvocation).mockReturnValue({
      kind: "channel",
      channel: "web",
      yes: false,
    });

    await runRegistrySetupCommandWithPrompter(
      "/project",
      { command: "eve", args: ["integration", "setup", "web"] },
      fake.prompter,
      signal,
    );

    expect(runIntegrationSetup).toHaveBeenCalledWith({
      appRoot: "/project",
      kind: "web",
      options: { yes: false, signal },
      dependencies: { createPrompter: expect.any(Function) },
    });
    const dependencies = vi.mocked(runIntegrationSetup).mock.calls[0]![0].dependencies;
    expect(dependencies?.createPrompter?.()).toBe(fake.prompter);
  });

  it("adapts a connection invocation to connector setup", async () => {
    const fake = createFakePrompter();
    vi.mocked(parseIntegrationSetupInvocation).mockReturnValue({
      kind: "connection",
      slug: "linear",
      service: "mcp.linear.app",
    });

    await runRegistrySetupCommandWithPrompter(
      "/project",
      { command: "eve", args: ["integration", "connect", "linear", "mcp.linear.app"] },
      fake.prompter,
    );

    expect(runIntegrationConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot: "/project",
        slug: "linear",
        service: "mcp.linear.app",
      }),
    );
  });

  it("rejects setup commands outside eve's trusted integration grammar", async () => {
    const fake = createFakePrompter();
    vi.mocked(parseIntegrationSetupInvocation).mockReturnValue(undefined);

    await expect(
      runRegistrySetupCommandWithPrompter(
        "/project",
        { command: "sh", args: ["-c", "echo nope"] },
        fake.prompter,
      ),
    ).rejects.toThrow("unsupported setup command");
    expect(runIntegrationSetup).not.toHaveBeenCalled();
  });
});
