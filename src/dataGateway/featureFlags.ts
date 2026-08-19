export interface BackendFeatureFlags {
  normalizedBootstrap: boolean;
  normalizedConfigReads: boolean;
  normalizedCatalogReads: boolean;
  normalizedComboReads: boolean;
  normalizedLiveReads: boolean;
  normalizedCustomerSearchReads: boolean;
  normalizedReportReads: boolean;
  analyticsSummaryReads: boolean;
  inventoryReportReads: boolean;
  normalizedBillHistoryReads: boolean;
  normalizedRealtime: boolean;
  rpcOperationalWrites: boolean;
  rpcFinancialWrites: boolean;
  financialRpcV2: boolean;
}

export const DEFAULT_BACKEND_FEATURE_FLAGS: BackendFeatureFlags = Object.freeze({
  normalizedBootstrap: false,
  normalizedConfigReads: false,
  normalizedCatalogReads: false,
  normalizedComboReads: false,
  normalizedLiveReads: false,
  normalizedCustomerSearchReads: false,
  normalizedReportReads: false,
  analyticsSummaryReads: false,
  inventoryReportReads: false,
  normalizedBillHistoryReads: false,
  normalizedRealtime: false,
  rpcOperationalWrites: false,
  rpcFinancialWrites: false,
  financialRpcV2: false
});

type BackendFeatureFlagKey = keyof BackendFeatureFlags;

const ENV_FLAG_NAMES: Record<BackendFeatureFlagKey, keyof ImportMetaEnv> = {
  normalizedBootstrap: "VITE_BACKEND_NORMALIZED_BOOTSTRAP",
  normalizedConfigReads: "VITE_BACKEND_NORMALIZED_CONFIG_READS",
  normalizedCatalogReads: "VITE_BACKEND_NORMALIZED_CATALOG_READS",
  normalizedComboReads: "VITE_BACKEND_NORMALIZED_COMBO_READS",
  normalizedLiveReads: "VITE_BACKEND_NORMALIZED_LIVE_READS",
  normalizedCustomerSearchReads: "VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS",
  normalizedReportReads: "VITE_BACKEND_NORMALIZED_REPORT_READS",
  analyticsSummaryReads: "VITE_BACKEND_ANALYTICS_SUMMARY_READS",
  inventoryReportReads: "VITE_BACKEND_INVENTORY_REPORT_READS",
  normalizedBillHistoryReads: "VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS",
  normalizedRealtime: "VITE_BACKEND_NORMALIZED_REALTIME",
  rpcOperationalWrites: "VITE_BACKEND_RPC_OPERATIONAL_WRITES",
  rpcFinancialWrites: "VITE_BACKEND_RPC_FINANCIAL_WRITES",
  financialRpcV2: "VITE_BACKEND_FINANCIAL_RPC_V2"
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
  const merged = {
    ...resolved,
    ...overrides
  };
  if (merged.financialRpcV2) {
    const requiredFlags: BackendFeatureFlagKey[] = [
      "normalizedBootstrap",
      "normalizedCustomerSearchReads",
      "normalizedReportReads",
      "inventoryReportReads",
      "normalizedBillHistoryReads",
      "normalizedRealtime",
      "rpcOperationalWrites",
      "rpcFinancialWrites"
    ];
    const missingFlags = requiredFlags.filter((key) => !merged[key]);
    if (missingFlags.length > 0) {
      throw new Error(
        `VITE_BACKEND_FINANCIAL_RPC_V2 requires the normalized source-of-truth rollout first. Missing flags: ${missingFlags.join(", ")}.`
      );
    }
  }
  return merged;
}

export function hasNormalizedGatewayFlag(flags: BackendFeatureFlags): boolean {
  return (
    flags.normalizedBootstrap ||
    flags.normalizedConfigReads ||
    flags.normalizedCatalogReads ||
    flags.normalizedComboReads ||
    flags.normalizedLiveReads ||
    flags.normalizedCustomerSearchReads ||
    flags.normalizedReportReads ||
    flags.analyticsSummaryReads ||
    flags.inventoryReportReads ||
    flags.normalizedBillHistoryReads ||
    flags.normalizedRealtime
  );
}

export function hasRpcGatewayFlag(flags: BackendFeatureFlags): boolean {
  return flags.rpcOperationalWrites || flags.rpcFinancialWrites || flags.financialRpcV2;
}
