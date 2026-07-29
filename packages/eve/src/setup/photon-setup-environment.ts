import type { ProjectResolution } from "./project-resolution.js";
import type { VercelAuthStatus } from "./vercel-project.js";

/** Read-only hosting facts available to Photon-owned setup hooks. */
export interface PhotonSetupEnvironment {
  vercel:
    | { kind: "available"; project: ProjectResolution }
    | { kind: "unavailable"; reason: Exclude<VercelAuthStatus, "authenticated"> };
}

/** Describes the result of the read-only Vercel capability probe. */
export function describePhotonSetupEnvironment(environment: PhotonSetupEnvironment): string {
  if (environment.vercel.kind === "available") {
    switch (environment.vercel.project.kind) {
      case "deployed":
        return `Found an authenticated Vercel account and deployed project (${environment.vercel.project.productionUrl}).`;
      case "linked":
        return "Found an authenticated Vercel account and linked project.";
      case "unresolved":
        return "Found an authenticated Vercel account; this directory is not linked to a project.";
    }
  }
  switch (environment.vercel.reason) {
    case "logged-out":
      return "No authenticated Vercel account found; using portable Photon setup.";
    case "cli-missing":
      return "Vercel CLI not found; using portable Photon setup.";
    case "unavailable":
      return "Could not verify the Vercel account; using portable Photon setup.";
  }
}

/** Builds Photon setup facts from the independent Vercel probes. */
export function photonSetupEnvironment(
  authStatus: VercelAuthStatus,
  project: ProjectResolution,
): PhotonSetupEnvironment {
  return authStatus === "authenticated"
    ? { vercel: { kind: "available", project } }
    : { vercel: { kind: "unavailable", reason: authStatus } };
}
