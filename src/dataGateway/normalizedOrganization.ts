import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";

const ORGANIZATION_READ_TIMEOUT_MS = 15_000;

interface OrganizationIdRow {
  id: string;
}

interface NormalizedQueryResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
}

let cachedOrganizationId: string | undefined;
let pendingOrganizationId: Promise<string> | undefined;

async function withOrganizationReadTimeout<T>(request: PromiseLike<T>, action: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach normalized organization data while ${action}.`));
    }, ORGANIZATION_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function rememberNormalizedOrganizationId(organizationId: string | null | undefined): void {
  const normalizedId = organizationId?.trim();
  if (normalizedId) {
    cachedOrganizationId = normalizedId;
  }
}

export function clearCachedNormalizedOrganizationIdForTests(): void {
  cachedOrganizationId = undefined;
  pendingOrganizationId = undefined;
}

export async function resolveNormalizedOrganizationId(client: SupabaseClient = getSupabaseClient()): Promise<string> {
  if (cachedOrganizationId) {
    return cachedOrganizationId;
  }
  if (pendingOrganizationId) {
    return pendingOrganizationId;
  }

  pendingOrganizationId = withOrganizationReadTimeout(
    client
      .from("organizations")
      .select("id")
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle() as unknown as PromiseLike<NormalizedQueryResult<OrganizationIdRow>>,
    "resolving the active organization"
  )
    .then((result) => {
      if (result.error) {
        throw result.error instanceof Error ? result.error : new Error(result.error.message);
      }
      if (!result.data?.id) {
        throw new Error("Normalized organization data was unavailable while resolving the active organization.");
      }
      rememberNormalizedOrganizationId(result.data.id);
      return result.data.id;
    })
    .finally(() => {
      pendingOrganizationId = undefined;
    });

  return pendingOrganizationId;
}
