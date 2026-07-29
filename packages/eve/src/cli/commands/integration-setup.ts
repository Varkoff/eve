import { interactiveAsker } from "#setup/ask.js";
import type { PhotonSetupDeps } from "#setup/photon-setup.js";
import {
  photonSetupEnvironment,
  describePhotonSetupEnvironment,
} from "#setup/photon-setup-environment.js";
import { createPhotonSetupUi, photonSetupIntegration } from "#setup/photon-setup-integrations.js";
import { detectDeployment, projectResolutionFromDeployment } from "#setup/project-resolution.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { RegistryCommandLogger } from "./registry.js";

export interface IntegrationSetupDependencies {
  createPrompter?: () => Prompter;
  detectDeployment: typeof detectDeployment;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  photonDeps?: PhotonSetupDeps;
}

const defaultIntegrationSetupDependencies: IntegrationSetupDependencies = {
  detectDeployment,
  getVercelAuthStatus,
};

/** Runs a built-in integration setup after its registry payload is installed. */
export async function runIntegrationSetupCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  kind: string,
  dependencies: IntegrationSetupDependencies = defaultIntegrationSetupDependencies,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  try {
    if (kind !== "photon") {
      throw new Error(
        `Integration setup "${kind}" is not available in this version of eve. Upgrade eve and try again.`,
      );
    }
    const prompter = dependencies.createPrompter?.() ?? createPrompter();
    const integration = photonSetupIntegration();
    prompter.intro(`Set up ${integration.label}`);
    prompter.log.message("Checking Vercel setup...");
    const [deployment, authStatus] = await Promise.all([
      dependencies.detectDeployment(appRoot),
      dependencies.getVercelAuthStatus(appRoot),
    ]);
    const project = projectResolutionFromDeployment(deployment);
    const environment = photonSetupEnvironment(authStatus, project);
    prompter.log.info(describePhotonSetupEnvironment(environment));
    const result = await integration.setup({
      environment,
      state: { agentName: "", project, projectPath: appRoot },
      ui: createPhotonSetupUi({ asker: interactiveAsker(prompter), prompter }),
      photonDeps: dependencies.photonDeps,
    });
    if (result.kind === "cancelled") return;
    prompter.outro("Integration set up.");
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
