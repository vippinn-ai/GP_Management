export const STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
export const STAGING_SYSTEM_IDENTIFIER = "7623125441096521075";

export type StagingIdentityRow = {
  environment: string;
  projectRef: string;
};

export type StagingEnvironmentState = {
  database: string;
  systemIdentifier: string;
  organizationActive: boolean;
  identities: StagingIdentityRow[];
};

export type StagingEnvironmentDecision =
  | { allowed: true; idempotentRerun: boolean }
  | { allowed: false; reason: "database" | "system_identifier" | "organization" | "environment_identity" };

/** Executable model of operational-v2-staging-environment-identity.sql. */
export function evaluateStagingEnvironmentIdentity(state: StagingEnvironmentState): StagingEnvironmentDecision {
  if (state.database !== "postgres") return { allowed: false, reason: "database" };
  if (state.systemIdentifier !== STAGING_SYSTEM_IDENTIFIER) return { allowed: false, reason: "system_identifier" };
  if (!state.organizationActive) return { allowed: false, reason: "organization" };
  if (state.identities.some((entry) => entry.environment !== "staging" || entry.projectRef !== STAGING_PROJECT_REF)) {
    return { allowed: false, reason: "environment_identity" };
  }
  return { allowed: true, idempotentRerun: state.identities.length === 1 };
}
