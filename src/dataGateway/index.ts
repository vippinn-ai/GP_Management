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
export {
  buildCustomerSearchFilter,
  loadNormalizedCustomerSearch,
  mapNormalizedCustomer,
  type NormalizedCustomerSearchQuery
} from "./normalizedCustomerSearch";
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
  buildBillRegisterCursorFilter,
  buildBillRegisterSearchFilter,
  buildNormalizedBillRegisterPage,
  getBusinessDayIssuedAtRange,
  loadNormalizedBillRegisterPage,
  mapNormalizedBill,
  mapNormalizedBillLine,
  mapNormalizedPayment,
  resolveNormalizedBillRegisterOrganizationId,
  type NormalizedBillRegisterCursor,
  type NormalizedBillRegisterPage,
  type NormalizedBillRegisterQuery
} from "./normalizedBillRegister";
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
  FinancialAdjustmentCommitResult,
  FinancialAdjustmentKind,
  FinancialAdjustmentPatch,
  FinancialCheckoutCommitResult,
  FinancialCheckoutPatch,
  RemoteDataGateway
} from "./types";

export function createRemoteDataGateway(flags: BackendFeatureFlags = resolveBackendFeatureFlags()): RemoteDataGateway {
  if (hasNormalizedGatewayFlag(flags) || hasRpcGatewayFlag(flags)) {
    return createNormalizedRemoteDataGateway(flags);
  }
  return appStateRemoteDataGateway;
}

export const defaultRemoteDataGateway = createRemoteDataGateway();
