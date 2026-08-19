import { appStateRemoteDataGateway } from "./appStateGateway";
import {
  hasNormalizedGatewayFlag,
  hasRpcGatewayFlag,
  resolveBackendFeatureFlags,
  type BackendFeatureFlags
} from "./featureFlags";
import { createNormalizedRemoteDataGateway } from "./normalizedGateway";
import type { RemoteDataGateway } from "./types";

export {
  DEFAULT_BACKEND_FEATURE_FLAGS,
  hasNormalizedGatewayFlag,
  hasRpcGatewayFlag,
  resolveBackendFeatureFlags,
  type BackendFeatureFlags
} from "./featureFlags";
export { appStateRemoteDataGateway } from "./appStateGateway";
export { mergeNormalizedAppDataOverlay } from "./normalizedGateway";
export {
  adminDataChangePatchHasChanges,
  adminDataChangePatchHasUnsupportedChanges,
  buildAdminDataChangePatch
} from "./adminDataPatches";
export {
  AdminDataRpcError,
  buildAdminDataChangeRpcPayload,
  invokeAdminDataChangeRpc,
  mapAdminDataChangeRpcResult,
  type AdminDataChangeRpcPayloadEnvelope
} from "./adminDataRpcClient";
export {
  buildCustomerSearchFilter,
  buildNormalizedCustomerBillVisitAt,
  dedupeNormalizedCustomerHistoryPayments,
  loadNormalizedCustomerSearch,
  loadNormalizedCustomerDirectory,
  loadNormalizedCustomerHistoryData,
  mapNormalizedCustomer,
  type NormalizedCustomerHistoryData,
  type CustomerHistorySessionActivityRow,
  type CustomerHistoryTabActivityRow,
  type NormalizedCustomerSearchQuery
} from "./normalizedCustomerSearch";
export { clearCachedNormalizedOrganizationId } from "./normalizedOrganization";
export {
  loadNormalizedFinancialDelta,
  type NormalizedFinancialDelta,
  type NormalizedFinancialDeltaQuery
} from "./financialDelta";
export {
  loadAnalyticsSummaryData,
  mapAnalyticsSummaryData,
  type AnalyticsSummaryData,
  type AnalyticsSummaryMetrics,
  type AnalyticsSummaryQuery
} from "./analyticsSummary";
export {
  buildNormalizedReportData,
  getLocalDateRange,
  getReportPaymentQueryRange,
  loadNormalizedReportData,
  mapNormalizedExpense,
  type NormalizedReportData,
  type NormalizedReportQuery
} from "./normalizedReports";
export {
  INVENTORY_REPORT_DETAIL_LIMIT,
  loadInventoryReportSummaryData,
  mapInventoryReportSummaryData,
  type InventoryReportSummaryQuery
} from "./inventoryReportSummary";
export {
  buildBillRegisterCursorFilter,
  buildBillRegisterSearchFilter,
  buildNormalizedBillRegisterPage,
  getBusinessDayIssuedAtRange,
  loadNormalizedBillRegisterPage,
  loadNormalizedBillsByIds,
  loadNormalizedPendingBills,
  mapNormalizedBill,
  mapNormalizedBillLine,
  mapNormalizedPayment,
  resolveNormalizedBillRegisterOrganizationId,
  type NormalizedBillRegisterCursor,
  type NormalizedBillRegisterPage,
  type NormalizedBillPatchQuery,
  type NormalizedBillRegisterQuery,
  type NormalizedPendingBillsQuery
} from "./normalizedBillRegister";
export {
  getNormalizedRealtimeRefreshPlan,
  getOperationalEventChangedRows,
  getOperationalEventMetadata,
  loadNormalizedRealtimeOverlay,
  subscribeToOperationalEvents,
  type NormalizedRealtimeOverlay,
  type OperationalEventRow
} from "./normalizedRealtime";
export {
  buildFinancialAdjustmentPatch,
  buildFinancialCheckoutPatch,
  ensurePatchRecord,
  getChangedRecords,
  getNewRecords
} from "./financialPatches";
export {
  buildFinancialAdjustmentRpcPayload,
  buildFinancialCheckoutRpcPayload,
  FinancialCheckoutRpcError,
  invokeFinancialAdjustmentRpc,
  invokeFinancialCheckoutRpc,
  mapFinancialAdjustmentRpcResult,
  mapFinancialCheckoutRpcResult,
  type FinancialAdjustmentRpcPayloadEnvelope,
  type FinancialCheckoutRpcPayloadEnvelope
} from "./financialRpcClient";
export {
  buildOperationalRpcPayload,
  getOperationalRpcFunctionName,
  invokeOperationalMutationRpc,
  mapOperationalRpcResult,
  OPERATIONAL_RPC_FUNCTION_NAMES,
  OperationalRpcError,
  type OperationalRpcPayloadEnvelope
} from "./rpcClient";
export type {
  AdminDataChangeCommitResult,
  AdminDataChangePatch,
  FinancialAdjustmentCommitResult,
  FinancialAdjustmentKind,
  FinancialAdjustmentPatch,
  FinancialCheckoutCommitResult,
  FinancialCheckoutPatch,
  OperationalRpcCommitResult,
  RemoteDataGateway
} from "./types";

export function createRemoteDataGateway(flags: BackendFeatureFlags = resolveBackendFeatureFlags()): RemoteDataGateway {
  if (hasNormalizedGatewayFlag(flags) || hasRpcGatewayFlag(flags)) {
    return createNormalizedRemoteDataGateway(flags);
  }
  return appStateRemoteDataGateway;
}

export const defaultRemoteDataGateway = createRemoteDataGateway();
