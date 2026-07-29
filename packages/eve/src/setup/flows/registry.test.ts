import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { runRegistryFlow, type RegistryFlowDeps } from "./registry.js";

const APP_ROOT = "/tmp/agent";

function deps(overrides: Partial<RegistryFlowDeps> = {}): RegistryFlowDeps {
  return {
    browseRegistryCatalog: vi.fn(async () => ({
      items: [
        {
          address: "extension/agent-browser",
          name: "extension/agent-browser",
          type: "registry:item",
          description: "Browser automation",
          source: "Vercel",
        },
      ],
      total: 1,
      errors: [],
    })),
    getRegistryItemManifest: vi.fn(async () => ({
      name: "extension/agent-browser",
      title: "agent-browser",
      description: "Browser automation",
      dependencies: ["@agent-browser/eve"],
      envVars: { AGENT_BROWSER_TOKEN: "" },
      files: [{ target: "agent/extensions/browser.ts" }],
    })),
    installRegistryItem: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runRegistryFlow", () => {
  it("browses a category, shows an item's manifest details, and exits after installing", async () => {
    const answers = ["category:extension", "item:0", "add"];
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        return answers.shift()!;
      },
    });
    const flowDeps = deps();

    await expect(
      runRegistryFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps: flowDeps }),
    ).resolves.toEqual({ kind: "done", addedItems: ["extension/agent-browser"] });
    expect(flowDeps.installRegistryItem).toHaveBeenCalledWith(
      APP_ROOT,
      "extension/agent-browser",
      { silent: false, withInheritedStdio: undefined },
      expect.objectContaining({ loadSetupCommandRunner: expect.any(Function) }),
    );
    expect(prompts[0]).toMatchObject({
      message: "What would you like to add?",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "category:channel", label: "Add a way to chat" }),
        expect.objectContaining({
          value: "category:connection",
          label: "Connect tools and data",
        }),
        expect.objectContaining({ value: "category:extension", label: "Add capabilities" }),
        expect.objectContaining({
          value: "category:instrumentation",
          label: "Add observability",
        }),
        expect.objectContaining({ value: "action:done", label: "Start chatting" }),
      ]),
    });
    expect(prompts[1]).toMatchObject({
      message: "Browse registry integrations",
      options: [
        expect.objectContaining({
          label: "Agent Browser · Vercel",
          hint: "Browser automation",
        }),
        expect.objectContaining({ value: "action:back", label: "Back" }),
      ],
    });
    expect(prompts[2]).toMatchObject({
      message: "agent-browser",
      description: "Browser automation",
      metadata: [
        { label: "Source", value: "Vercel" },
        { label: "Packages", value: "@agent-browser/eve" },
        { label: "Environment", value: "AGENT_BROWSER_TOKEN" },
        { label: "Files", value: "agent/extensions/browser.ts" },
      ],
      options: [
        { value: "add", label: "Add to project" },
        { value: "back", label: "Back" },
      ],
    });
  });

  it("summarizes long package, environment, and file lists", async () => {
    const answers = ["category:channel", "item:0", "add"];
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        return answers.shift()!;
      },
    });
    const flowDeps = deps({
      browseRegistryCatalog: vi.fn(async () => ({
        items: [
          {
            address: "channel/web",
            name: "channel/web",
            source: "Vercel",
          },
        ],
        total: 1,
        errors: [],
      })),
      getRegistryItemManifest: vi.fn(async () => ({
        dependencies: ["next", "react", "react-dom", "streamdown", "tailwindcss"],
        envVars: { FIRST: "", SECOND: "", THIRD: "", FOURTH: "" },
        files: ["one", "two", "three", "four", "five"].map((target) => ({ target })),
      })),
    });

    await runRegistryFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps: flowDeps });

    expect(prompts[2]).toMatchObject({
      metadata: [
        { label: "Source", value: "Vercel" },
        { label: "Packages", value: "next, react, react-dom … (+2 more)" },
        { label: "Environment", value: "FIRST, SECOND, THIRD … (+1 more)" },
        { label: "Files", value: "one, two, three … (+2 more)" },
      ],
    });
  });

  it("identifies external registry sources on their rows", async () => {
    const answers = ["category:extension", "action:back", "action:done"];
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        return answers.shift()!;
      },
    });
    const flowDeps = deps({
      browseRegistryCatalog: vi.fn(async () => ({
        items: [
          {
            address: "@acme/analytics",
            name: "extension/analytics",
            description: "Product analytics",
            source: "@acme",
          },
        ],
        total: 1,
        errors: [],
      })),
    });

    await runRegistryFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps: flowDeps });

    expect(prompts[1]).toMatchObject({
      options: [
        expect.objectContaining({
          label: "Analytics · @acme",
          hint: "Product analytics",
        }),
        expect.objectContaining({ value: "action:back" }),
      ],
    });
  });

  it("resolves a direct address before offering installation", async () => {
    const answers = ["category:all", "address:@acme/analytics", "add"];
    const prompts: unknown[] = [];
    const fake = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        return answers.shift()!;
      },
    });
    const flowDeps = deps({
      getRegistryItemManifest: vi.fn(async () => ({
        name: "analytics",
        description: "Analytics integration",
      })),
    });

    await runRegistryFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps: flowDeps });

    expect(prompts[1]).toMatchObject({
      placeholder: "Search or enter an item address",
      searchAction: { label: expect.any(Function), value: expect.any(Function) },
    });
    const searchAction = (prompts[1] as { searchAction: { label(query: string): string } })
      .searchAction;
    expect(searchAction.label("@acme/analytics")).toBe("Add “@acme/analytics”");
    expect(flowDeps.getRegistryItemManifest).toHaveBeenCalledWith(APP_ROOT, "@acme/analytics");
    expect(flowDeps.installRegistryItem).toHaveBeenCalledWith(
      APP_ROOT,
      "@acme/analytics",
      { silent: false, withInheritedStdio: undefined },
      expect.objectContaining({ loadSetupCommandRunner: expect.any(Function) }),
    );
  });

  it("returns to the category hub from a registry list", async () => {
    const answers = ["category:channel", "action:back", "action:done"];
    const fake = createFakePrompter({ single: () => answers.shift()! });

    await expect(
      runRegistryFlow({ appRoot: APP_ROOT, prompter: fake.prompter, deps: deps() }),
    ).resolves.toEqual({ kind: "done", addedItems: [] });

    expect(fake.selectMessages).toEqual([
      "What would you like to add?",
      "Browse registry integrations",
      "What would you like to add?",
    ]);
  });
});
