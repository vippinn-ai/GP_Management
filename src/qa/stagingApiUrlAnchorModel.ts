export const STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh";
export const STAGING_API_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;

export type StagingIdentityRow = {
  environment: string;
  projectRef: string;
};

export type StagingApiUrlAnchorState = {
  database: string;
  organizationActive: boolean;
  apiUrl: string | null;
  identities: StagingIdentityRow[];
};

export type StagingApiUrlAnchorDecision =
  | { allowed: true; apiUrlAfter: typeof STAGING_API_URL; idempotentRerun: boolean }
  | { allowed: false; reason: "database" | "organization" | "api_url" | "environment_identity" };

/**
 * Executable model of the fail-closed guards in
 * operational-v2-staging-api-url-anchor.sql. The SQL contract test binds each
 * guard to its corresponding statement so semantic scenario coverage cannot
 * silently diverge from the deployment artifact.
 */
export function evaluateStagingApiUrlAnchor(state: StagingApiUrlAnchorState): StagingApiUrlAnchorDecision {
  if (state.database !== "postgres") return { allowed: false, reason: "database" };
  if (!state.organizationActive) return { allowed: false, reason: "organization" };
  if (state.apiUrl !== null && state.apiUrl !== STAGING_API_URL) return { allowed: false, reason: "api_url" };
  if (state.identities.some((entry) => entry.environment !== "staging" || entry.projectRef !== STAGING_PROJECT_REF)) {
    return { allowed: false, reason: "environment_identity" };
  }
  return { allowed: true, apiUrlAfter: STAGING_API_URL, idempotentRerun: state.apiUrl === STAGING_API_URL };
}
