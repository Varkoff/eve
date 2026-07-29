import {
  addRegistryItems,
  getRegistryItems,
  searchRegistries,
  type RegistryConfig,
  type RegistrySearchItem,
} from "#compiled/shadcn-registry/index.js";
import semver from "#compiled/semver/index.js";
import { z } from "#compiled/zod/index.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { applyPackageManagerWorkspaceConfiguration } from "#setup/scaffold/workspace-root.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { runRegistrySetupCommand } from "./registry-setup-command.js";
import { addRegistryMappings, readRegistryConfig } from "./registry-project.js";

export interface RegistryCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface AddCommandOptions {
  overwrite?: boolean;
  /** Suppresses the registry SDK's terminal-native progress output. */
  silent?: boolean;
  /** Temporarily hands the terminal to the registry SDK and its package manager. */
  withInheritedStdio?<T>(task: () => Promise<T>): Promise<T>;
  /** Arguments forwarded to a trusted setup command after installation. */
  setupArgs?: string[];
}

export interface AddCommandDependencies {
  loadSetupCommandRunner(): Promise<typeof runRegistrySetupCommand>;
}

/** One discoverable item from an eve-compatible registry catalog. */
export interface RegistryCatalogItem {
  address: string;
  name: string;
  type?: string;
  description?: string;
  source: string;
}

/** Catalog items plus non-fatal failures from the registry sources queried. */
export interface RegistryCatalogResult {
  items: RegistryCatalogItem[];
  total: number;
  errors: Array<{ message: string; registry: string }>;
}

const defaultAddCommandDependencies: AddCommandDependencies = {
  loadSetupCommandRunner: async () =>
    (await import("./registry-setup-command.js")).runRegistrySetupCommand,
};

const OFFICIAL_REGISTRY = "https://eve.dev/r";
const OFFICIAL_CATALOG = `${OFFICIAL_REGISTRY}/registry.json`;

function isRegistryAddress(value: string): boolean {
  return value.startsWith("@") || /^https?:\/\//.test(value);
}

function itemAddress(item: string): string {
  return isRegistryAddress(item) ? item : `${OFFICIAL_REGISTRY}/${item}.json`;
}

/** Installs an official registry item without running its declared setup command. */
export async function installOfficialRegistryItem(
  appRoot: string,
  item: string,
  options: AddCommandOptions = {},
): Promise<void> {
  await prepareOfficialItemInstall(appRoot, item);
  const config = await readRegistryConfig(appRoot);
  await addRegistryItems([itemAddress(item)], { ...options, config, cwd: appRoot });
}

const EveRegistryItemMetadataSchema = z.object({
  name: z.string().optional(),
  meta: z
    .object({
      eve: z
        .object({
          requires: z.string().optional(),
          setup: z
            .object({
              command: z.literal("eve"),
              args: z.union([
                z.tuple([z.literal("integration"), z.literal("setup"), z.string().min(1)]),
                z.tuple([
                  z.literal("integration"),
                  z.literal("connect"),
                  z.string().min(1),
                  z.string().min(1),
                ]),
                z.tuple([
                  z.literal("integration"),
                  z.literal("connect"),
                  z.string().min(1),
                  z.string().min(1),
                  z.string().min(1),
                ]),
              ]),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

function officialItemFromRegistryItem(item: unknown) {
  return EveRegistryItemMetadataSchema.parse(item);
}

async function prepareOfficialItemInstall(appRoot: string, itemName: string | undefined) {
  if (itemName !== "channel/web") return;
  const packageManager = await detectPackageManager(appRoot);
  await applyPackageManagerWorkspaceConfiguration({
    packageManager: packageManager.kind,
    projectRoot: appRoot,
  });
}

function assertCompatibleEveVersion(requiredVersion: string | undefined): void {
  if (requiredVersion === undefined) return;
  const installedVersion = resolveInstalledPackageInfo().version;
  if (semver.validRange(requiredVersion) === null) {
    throw new Error(`Registry item has an invalid eve version requirement: ${requiredVersion}.`);
  }
  if (semver.subset(installedVersion, requiredVersion)) return;
  throw new Error(
    `This registry item requires eve ${requiredVersion}, but this project is using eve ${installedVersion}. Upgrade eve and run the command again.`,
  );
}

function isOfficialItemAddress(address: string): boolean {
  return address.startsWith(`${OFFICIAL_REGISTRY}/`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runRegistryAction(
  logger: RegistryCommandLogger,
  appRoot: string,
  action: () => Promise<void>,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  try {
    await action();
  } catch (error) {
    logger.error(errorMessage(error));
    process.exitCode = 1;
  }
}

function configuredRegistrySources(config: RegistryConfig): string[] {
  return Object.keys(config.registries ?? {});
}

function validateRegistrySource(source: string | undefined): void {
  if (source !== undefined && !isRegistryAddress(source)) {
    throw new Error(`Registry sources must be a namespace or URL: ${source}`);
  }
}

function printSearchResults(
  logger: RegistryCommandLogger,
  result: Awaited<ReturnType<typeof searchRegistries>>,
  options: { query: string | undefined; sources: string[] },
): void {
  if (result.items.length === 0) {
    logger.log("No registry items found.");
    return;
  }

  const count = `${result.pagination.total} item${result.pagination.total === 1 ? "" : "s"}`;
  const query = options.query === undefined ? "" : ` matching "${options.query}"`;
  const registries = `${options.sources.length} registr${options.sources.length === 1 ? "y" : "ies"}`;
  logger.log(`Found ${count}${query} in ${registries}`);
  logger.log("");

  for (const item of result.items) {
    const address = item.registry === OFFICIAL_CATALOG ? item.name : item.addCommandArgument;
    const description =
      options.query === undefined && item.description ? ` — ${item.description}` : "";
    logger.log(`${address}${description}`);
  }
}

async function searchRegistryCatalog(
  appRoot: string,
  options: { query?: string; source?: string },
) {
  validateRegistrySource(options.source);
  const config = await readRegistryConfig(appRoot);
  const sources = options.source
    ? [options.source]
    : [OFFICIAL_CATALOG, ...configuredRegistrySources(config)];
  const result = await searchRegistries(sources, {
    config,
    continueOnError: sources.length > 1,
    query: options.query,
  });
  return { result, sources };
}

/** Browses all configured catalogs, or one namespace or URL source. */
export async function browseRegistryCatalog(
  appRoot: string,
  options: { query?: string; source?: string } = {},
): Promise<RegistryCatalogResult> {
  const { result } = await searchRegistryCatalog(appRoot, options);
  return {
    items: result.items.map((item: RegistrySearchItem) => {
      const catalogItem: RegistryCatalogItem = {
        address: item.registry === OFFICIAL_CATALOG ? item.name : item.addCommandArgument,
        name: item.name,
        source: item.registry === OFFICIAL_CATALOG ? "Vercel" : item.registry,
      };
      if (item.type !== undefined) catalogItem.type = item.type;
      if (item.description !== undefined) catalogItem.description = item.description;
      return catalogItem;
    }),
    total: result.pagination.total,
    errors: result.errors ?? [],
  };
}

async function browseRegistryItems(
  logger: RegistryCommandLogger,
  appRoot: string,
  query: string | undefined,
  source: string | undefined,
): Promise<void> {
  const { result, sources } = await searchRegistryCatalog(appRoot, { query, source });
  const errors = result.errors ?? [];
  if (errors.length < sources.length) {
    printSearchResults(logger, result, { query, sources });
  }
  for (const error of errors) {
    logger.error(`${error.registry}: ${error.message}`);
  }
  if (errors.length > 0) process.exitCode = 1;
}

/** Resolves one official, configured, or URL-addressed item manifest. */
export async function getRegistryItemManifest(appRoot: string, item: string): Promise<unknown> {
  const config = await readRegistryConfig(appRoot);
  const items = await getRegistryItems([itemAddress(item)], { config });
  return items.length === 1 ? items[0] : items;
}

/** Installs one official, configured, or URL-addressed registry item. */
export async function installRegistryItem(
  appRoot: string,
  item: string,
  options: AddCommandOptions = {},
  dependencies: AddCommandDependencies = defaultAddCommandDependencies,
): Promise<void> {
  const config = await readRegistryConfig(appRoot);
  const address = itemAddress(item);
  const [registryItem] = await getRegistryItems([address], { config });
  const officialItem = isOfficialItemAddress(address)
    ? officialItemFromRegistryItem(registryItem)
    : undefined;
  const eveMetadata = officialItem?.meta?.eve;
  assertCompatibleEveVersion(eveMetadata?.requires);
  await prepareOfficialItemInstall(appRoot, officialItem?.name);

  const installOptions = {
    config,
    cwd: appRoot,
    overwrite: options.overwrite,
    silent: options.silent,
  };
  const addItems = () => addRegistryItems([address], installOptions);
  await (options.withInheritedStdio?.(addItems) ?? addItems());

  if (eveMetadata?.setup !== undefined) {
    const runSetupCommand = await dependencies.loadSetupCommandRunner();
    await runSetupCommand(appRoot, {
      ...eveMetadata.setup,
      args: [...eveMetadata.setup.args, ...(options.setupArgs ?? [])],
    });
  }
}

/** Installs an official, configured, or URL-addressed registry item. */
export async function runAddCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
  options: AddCommandOptions,
  dependencies: AddCommandDependencies = defaultAddCommandDependencies,
): Promise<void> {
  await runRegistryAction(logger, appRoot, () =>
    installRegistryItem(appRoot, item, options, dependencies),
  );
}

/** Adds registry namespace mappings to the project's package.json. */
export async function runRegistryAddCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  mappings: readonly string[],
): Promise<void> {
  await runRegistryAction(logger, appRoot, async () => {
    const result = await addRegistryMappings(appRoot, mappings);
    for (const namespace of result.skippedBuiltIn) {
      logger.log(`Skipped ${namespace} because it is built in.`);
    }
    for (const namespace of result.skippedExisting) {
      logger.log(`Skipped ${namespace} because it is already configured.`);
    }
    if (result.added.length > 0) {
      logger.log(`Added ${result.added.join(", ")} to package.json.`);
    }
  });
}

/** Lists registry items from every configured source or one selected source. */
export async function runRegistryListCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  source?: string,
): Promise<void> {
  await runRegistryAction(logger, appRoot, () =>
    browseRegistryItems(logger, appRoot, undefined, source),
  );
}

/** Searches registry items across every configured source or one selected source. */
export async function runRegistrySearchCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  query: string,
  source?: string,
): Promise<void> {
  await runRegistryAction(logger, appRoot, () =>
    browseRegistryItems(logger, appRoot, query, source),
  );
}

/** Prints one official, configured, or URL-addressed registry item as JSON. */
export async function runRegistryViewCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  item: string,
): Promise<void> {
  await runRegistryAction(logger, appRoot, async () => {
    logger.log(JSON.stringify(await getRegistryItemManifest(appRoot, item), null, 2));
  });
}
