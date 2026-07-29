import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { Asker, Question } from "./ask.js";
import { photonSetupEnvironment } from "./photon-setup-environment.js";
import type { PhotonSetupDeps } from "./photon-setup.js";
import { PHOTON_CHANNEL_SETUP } from "./photon-setup.js";
import { createPhotonSetupUi } from "./photon-setup-ui.js";

function asker(answers: Record<string, string>): Asker {
  return {
    ask: async <T>(question: Question<T>) => answers[question.key] as T,
    askMany: async () => [],
  };
}

function deps(): PhotonSetupDeps {
  return {
    appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    linkProject: vi.fn(),
    openUrl: vi.fn(),
    pickProject: vi.fn(),
    pickTeam: vi.fn(),
    provisionConnector: vi.fn(),
    provisionProject: vi.fn(async () => ({
      projectId: "project-id",
      projectSecret: "project-secret",
      cleanup: vi.fn(async () => {}),
    })),
    readProjectLink: vi.fn(),
    registerWebhook: vi.fn(async () => "webhook-secret"),
    useProject: vi.fn(),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("Photon setup", () => {
  it("owns portable provisioning and scaffolding", async () => {
    const fake = createFakePrompter({ single: () => "portable" });
    const effects = deps();
    const state = {
      agentName: "agent",
      project: { kind: "unresolved" } as const,
      projectPath: "/project",
    };

    const result = await PHOTON_CHANNEL_SETUP.setup({
      environment: photonSetupEnvironment("cli-missing", { kind: "unresolved" }),
      state,
      ui: createPhotonSetupUi({
        asker: asker({
          "photon-phone-number": "+15551234567",
          "photon-webhook-base-url": "https://agent.example.com",
        }),
        prompter: fake.prompter,
      }),
      photonDeps: effects,
    });

    expect(result).toMatchObject({ kind: "done", state });
    expect(effects.provisionProject).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: "+15551234567" }),
    );
    expect(effects.registerWebhook).toHaveBeenCalledWith({
      projectId: "project-id",
      projectSecret: "project-secret",
      webhookUrl: "https://agent.example.com/eve/v1/photon",
    });
    expect(effects.appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      IMESSAGE_PROJECT_ID: "project-id",
      IMESSAGE_PROJECT_SECRET: "project-secret",
      IMESSAGE_WEBHOOK_SECRET: "webhook-secret",
    });
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/photon.ts",
      expect.stringContaining('from "eve/channels/photon"'),
      { force: undefined },
    );
  });
});
