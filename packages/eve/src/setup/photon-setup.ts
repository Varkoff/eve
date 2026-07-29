import { join } from "node:path";

import { text } from "./ask.js";
import { appendEnv } from "./append-env.js";
import type { PhotonSetupIntegration } from "./photon-setup-integration.js";
import { provisionPhotonConnector } from "./photon-connect.js";
import {
  provisionPhotonProject,
  registerPhotonWebhook,
  usePhotonProject,
  validatePhotonPhoneNumber,
  type PhotonManagedProject,
} from "./photon-management.js";
import { readProjectLink } from "./project-resolution.js";
import { openUrl } from "./primitives/open-url.js";
import { deriveSlackConnectorSlug } from "./scaffold/index.js";
import { writeTextFile } from "./scaffold/files.js";
import { WizardCancelledError } from "./step.js";
import { linkProject, pickProject, pickTeam } from "./vercel-project.js";
import { createPromptCommandOutput } from "./cli/index.js";

interface PhotonSetupPlan {
  credentials: "vercel-connect" | "environment";
  photonProject: "create" | { projectId: string; projectSecret: string };
  photonProjectName?: string;
  webhookBaseUrl?: string;
}

export interface PhotonSetupDeps {
  appendEnv: typeof appendEnv;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  linkProject: typeof linkProject;
  openUrl: typeof openUrl;
  pickProject: typeof pickProject;
  pickTeam: typeof pickTeam;
  provisionConnector: typeof provisionPhotonConnector;
  provisionProject: typeof provisionPhotonProject;
  readProjectLink: typeof readProjectLink;
  registerWebhook: typeof registerPhotonWebhook;
  useProject: typeof usePhotonProject;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: PhotonSetupDeps = {
  appendEnv,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  linkProject,
  openUrl,
  pickProject,
  pickTeam,
  provisionConnector: provisionPhotonConnector,
  provisionProject: provisionPhotonProject,
  readProjectLink,
  registerWebhook: registerPhotonWebhook,
  useProject: usePhotonProject,
  writeTextFile,
};

function connectTemplate(connectorUid: string): string {
  return `import { connectPhotonCredentials } from "@vercel/connect/eve";
import { photonChannel } from "eve/channels/photon";

export default photonChannel({
  credentials: connectPhotonCredentials(${JSON.stringify(connectorUid)}),
});
`;
}

const PORTABLE_TEMPLATE = `import { photonChannel } from "eve/channels/photon";

async function photonCredentials() {
  const projectId = process.env.IMESSAGE_PROJECT_ID;
  const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;
  if (!projectId || !projectSecret) throw new Error("Photon project credentials are required.");
  return { projectId, projectSecret };
}

export default photonChannel({
  credentials: photonCredentials,
  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
});
`;

async function choosePhotonProject(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
): Promise<Pick<PhotonSetupPlan, "photonProject" | "photonProjectName">> {
  const defaultName = `eve · ${context.state.agentName || "agent"}`;
  const options = [
    {
      value: "create" as const,
      label: "Create a new Photon project",
      hint: `Name: ${defaultName}`,
    },
    {
      value: "existing" as const,
      label: "Use an existing Photon project",
      hint: "Enter its project credentials",
    },
  ];
  const editable = context.ui.prompter.selectEditable
    ? await context.ui.prompter.selectEditable<"create" | "existing">({
        message: "Photon project",
        options,
        initialValue: "create",
        editable: {
          value: "create",
          defaultValue: defaultName,
          formatHint: (value) => `Name: ${value}`,
          validate: (value) =>
            value.trim().length === 0 ? "Project name cannot be empty." : undefined,
        },
      })
    : undefined;
  const source =
    editable?.value ??
    (await context.ui.prompter.select<"create" | "existing">({
      message: "Photon project",
      options,
      initialValue: "create",
    }));
  if (source === "existing") {
    const projectId = await context.ui.asker.ask(
      text({ key: "photon-project-id", message: "Photon project ID", required: true }),
    );
    const projectSecret = await context.ui.asker.ask(
      text({
        key: "photon-project-secret",
        message: "Photon project secret",
        required: true,
        sensitive: true,
      }),
    );
    return { photonProject: { projectId: projectId.trim(), projectSecret: projectSecret.trim() } };
  }

  return {
    photonProject: "create",
    photonProjectName: editable?.kind === "edited" ? editable.text.trim() : defaultName,
  };
}

async function chooseSetupPlan(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
): Promise<PhotonSetupPlan | "cancelled"> {
  try {
    const photon = await choosePhotonProject(context);
    if (context.environment.vercel.kind === "available") {
      return { credentials: "vercel-connect", ...photon };
    }
    const destination = await context.ui.prompter.select<"vercel" | "portable">({
      message: "Where will this iMessage agent run?",
      options: [
        { value: "vercel", label: "Vercel", hint: "Set up Vercel Connect and deploy" },
        {
          value: "portable",
          label: "Another host",
          hint: "Use environment variables and your public URL",
        },
      ],
    });
    if (destination === "vercel") return { credentials: "vercel-connect", ...photon };

    const webhookBaseUrl = await context.ui.asker.ask(
      text({
        key: "photon-webhook-base-url",
        message: "Public HTTPS URL for your deployed agent",
        placeholder: "https://agent.example.com",
        required: true,
        validate(value) {
          try {
            const url = new URL(value.trim());
            return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash
              ? null
              : "Enter an HTTPS origin without a path, for example https://agent.example.com";
          } catch {
            return "Enter an HTTPS origin, for example https://agent.example.com";
          }
        },
      }),
    );
    return {
      credentials: "environment",
      webhookBaseUrl: webhookBaseUrl.trim().replace(/\/$/, ""),
      ...photon,
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) return "cancelled";
    throw error;
  }
}

async function resolvePhotonProject(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
  plan: PhotonSetupPlan,
  phoneNumber: string,
  deps: PhotonSetupDeps,
): Promise<PhotonManagedProject> {
  if (plan.photonProject !== "create") {
    return deps.useProject({ ...plan.photonProject, phoneNumber });
  }
  return deps.provisionProject({
    projectName: plan.photonProjectName ?? `eve · ${context.state.agentName || "agent"}`,
    phoneNumber,
    signal: context.signal,
    onAuthorization(authorization) {
      context.ui.prompter.log.message(`Authorize Photon: ${authorization.verificationUrl}`);
      context.ui.prompter.log.message(`Photon code: ${authorization.userCode}`);
      deps.openUrl(authorization.verificationUrl);
    },
  });
}

async function ensureVercelProject(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
  projectRoot: string,
  slug: string,
  deps: PhotonSetupDeps,
) {
  const existing = await deps.readProjectLink(projectRoot);
  if (existing !== undefined) return existing;
  const team = await deps.pickTeam(context.ui.prompter, projectRoot, undefined, {
    signal: context.signal,
  });
  const spec = await deps.pickProject(context.ui.prompter, projectRoot, team, {
    allowCreateWhenEmpty: true,
    suggestedName: slug,
    signal: context.signal,
  });
  await deps.linkProject(
    context.ui.prompter,
    projectRoot,
    spec,
    createPromptCommandOutput(context.ui.prompter.log),
    { signal: context.signal },
  );
  const linked = await deps.readProjectLink(projectRoot);
  if (linked === undefined) throw new Error("Vercel project linking failed. Photon setup stopped.");
  return linked;
}

async function setupPhoton(
  context: Parameters<PhotonSetupIntegration["setup"]>[0],
  plan: PhotonSetupPlan,
  deps: PhotonSetupDeps,
): Promise<"created" | "cancelled"> {
  const phoneNumber = await context.ui.asker.ask(
    text({
      key: "photon-phone-number",
      message: "Your iMessage phone number",
      placeholder: "+15551234567",
      required: true,
      validate: validatePhotonPhoneNumber,
    }),
  );
  const projectRoot = context.state.projectPath;
  const managedProject = await resolvePhotonProject(context, plan, phoneNumber, deps);
  try {
    const channelPath = join(projectRoot, "agent/channels/photon.ts");
    if (plan.credentials === "vercel-connect") {
      const slug = await deps.deriveConnectorSlug(projectRoot, context.state.agentName);
      const project = await ensureVercelProject(context, projectRoot, slug, deps);
      const connector = await deps.provisionConnector({
        credentials: managedProject,
        log: context.ui.prompter.log,
        project,
        projectRoot,
        slug,
        signal: context.signal,
      });
      await deps.writeTextFile(channelPath, connectTemplate(connector.uid), {
        force: context.force,
      });
    } else {
      const webhookUrl = `${plan.webhookBaseUrl}/eve/v1/photon`;
      const webhookSecret = await deps.registerWebhook({
        projectId: managedProject.projectId,
        projectSecret: managedProject.projectSecret,
        webhookUrl,
      });
      await deps.appendEnv(join(projectRoot, ".env.local"), {
        IMESSAGE_PROJECT_ID: managedProject.projectId,
        IMESSAGE_PROJECT_SECRET: managedProject.projectSecret,
        IMESSAGE_WEBHOOK_SECRET: webhookSecret,
      });
      await deps.writeTextFile(channelPath, PORTABLE_TEMPLATE, { force: context.force });
      context.ui.nextSteps([
        "Copy IMESSAGE_PROJECT_ID, IMESSAGE_PROJECT_SECRET, and IMESSAGE_WEBHOOK_SECRET from .env.local into your host's encrypted environment variables.",
        "Deploy the agent at the public URL you provided. Photon is already configured to send signed webhooks to /eve/v1/photon.",
      ]);
    }
    context.ui.prompter.log.success("Scaffolded channel: photon");
    if (managedProject.assignedPhoneNumber !== undefined) {
      context.ui.prompter.note(managedProject.assignedPhoneNumber, "Text your agent", {
        tone: "success",
      });
    }
    context.ui.prompter.note(
      `https://app.photon.codes/dashboard/${managedProject.projectId}`,
      "Photon project",
      { tone: "success" },
    );
    return "created";
  } catch (error) {
    await managedProject.cleanup().catch(() => {});
    throw error;
  }
}

/** Photon-managed project provisioning and channel scaffolding. */
export const PHOTON_CHANNEL_SETUP: PhotonSetupIntegration = {
  kind: "photon",
  label: "Photon",
  hint: "Messages through Photon",
  async setup(context) {
    try {
      const plan = await chooseSetupPlan(context);
      if (plan === "cancelled") return { kind: "cancelled" };
      await setupPhoton(context, plan, context.photonDeps ?? defaultDeps);
      return {
        kind: "done",
        state: context.state,
      };
    } catch (error) {
      if (error instanceof WizardCancelledError) return { kind: "cancelled" };
      throw error;
    }
  },
};
