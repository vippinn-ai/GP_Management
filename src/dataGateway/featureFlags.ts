export interface BackendFeatureFlags {
  normalizedConfigReads: boolean;
  normalizedCatalogReads: boolean;
  normalizedBillHistoryReads: boolean;
  normalizedRealtime: boolean;
  rpcOperationalWrites: boolean;
  rpcFinancialWrites: boolean;
}

export const DEFAULT_BACKEND_FEATURE_FLAGS: BackendFeatureFlags = Object.freeze({
  normalizedConfigReads: false,
  normalizedCatalogReads: false,
  normalizedBillHistoryReads: false,
  normalizedRealtime: false,
  rpcOperationalWrites: false,
  rpcFinancialWrites: false
});

type BackendFeatureFlagKey = keyof BackendFeatureFlags;

const ENV_FLAG_NAMES: Record<BackendFeatureFlagKey, keyof ImportMetaEnv> = {
  normalizedConfigReads: "VITE_BACKEND_NORMALIZED_CONFIG_READS",
  normalizedCatalogReads: "VITE_BACKEND_NORMALIZED_CATALOG_READS",
  normalizedBillHistoryReads: "VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS",
  normalizedRealtime: "VITE_BACKEND_NORMALIZED_REALTIME",
  rpcOperationalWrites: "VITE_BACKEND_RPC_OPERATIONAL_WRITES",
  rpcFinancialWrites: "VITE_BACKEND_RPC_FINANCIAL_WRITES"
};

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolveBackendFeatureFlags(
  overrides: Partial<BackendFeatureFlags> = {},
  env: Partial<Record<keyof ImportMetaEnv, string | undefined>> = import.meta.env
): BackendFeatureFlags {
  const resolved = { ...DEFAULT_BACKEND_FEATURE_FLAGS };
  (Object.keys(ENV_FLAG_NAMES) as BackendFeatureFlagKey[]).forEach((key) => {
    resolved[key] = parseBooleanFlag(env[ENV_FLAG_NAMES[key]]);
  });
  return {
    ...resolved,
    ...overrides
  };
}

export function hasNormalizedGatewayFlag(flags: BackendFeatureFlags): boolean {
  return (
    flags.normalizedConfigReads ||
    flags.normalizedCatalogReads ||
    flags.normalizedBillHistoryReads ||
    flags.normalizedRealtime
  );
}

export function hasRpcGatewayFlag(flags: BackendFeatureFlags): boolean {
  return flags.rpcOperationalWrites || flags.rpcFinancialWrites;
}
