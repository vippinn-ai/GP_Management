import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import { resolveNormalizedOrganizationId } from "./normalizedOrganization";
import type {
  FinancialAdjustmentCommitResult,
  FinancialAdjustmentPatch,
  FinancialCheckoutCommitResult,
  FinancialCheckoutPatch
} from "./types";

const FINANCIAL_RPC_TIMEOUT_MS = 15_000;
const CHECKOUT_BILL_RPC_NAME = "commit_checkout_bill";
const FINANCIAL_ADJUSTMENT_RPC_NAME = "commit_financial_adjustment";
const CHECKOUT_BILL_V2_RPC_NAME = "commit_checkout_bill_v2";
const FINANCIAL_ADJUSTMENT_V2_RPC_NAME = "commit_financial_adjustment_v2";
const FINANCIAL_MUTATION_STATUS_RPC_NAME = "get_financial_mutation_result";

interface RpcResult<T> {
  data: T | null;
  error: {
    code?: string;
    message: string;
    details?: string;
    hint?: string;
  } | null;
}

interface RpcErrorResponse {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
}

export interface FinancialCheckoutRpcPayloadEnvelope {
  organization_id: string;
  mutation_id: string;
  mutation_kind: "commitCheckoutBill";
  entity_type: FinancialCheckoutPatch["entityType"];
  entity_id: string;
  user_id: string;
  client_created_at: string;
  base_app_state_version: number;
  payload: {
    mode: FinancialCheckoutPatch["mode"];
    bill: FinancialCheckoutPatch["bill"];
    bills: FinancialCheckoutPatch["bills"];
    payments: FinancialCheckoutPatch["payments"];
    stockMovements: FinancialCheckoutPatch["stockMovements"];
    auditLogs: FinancialCheckoutPatch["auditLogs"];
    customers: FinancialCheckoutPatch["customers"];
    sessions: FinancialCheckoutPatch["sessions"];
    customerTabs: FinancialCheckoutPatch["customerTabs"];
    inventoryItems: FinancialCheckoutPatch["inventoryItems"];
  };
}

export interface FinancialAdjustmentRpcPayloadEnvelope {
  organization_id: string;
  mutation_id: string;
  mutation_kind: FinancialAdjustmentPatch["kind"];
  entity_type: FinancialAdjustmentPatch["entityType"];
  entity_id: string;
  user_id: string;
  client_created_at: string;
  base_app_state_version: number;
  payload: {
    bills: FinancialAdjustmentPatch["bills"];
    payments: FinancialAdjustmentPatch["payments"];
    stockMovements: FinancialAdjustmentPatch["stockMovements"];
    auditLogs: FinancialAdjustmentPatch["auditLogs"];
    inventoryItems: FinancialAdjustmentPatch["inventoryItems"];
  };
}

export interface FinancialCheckoutV2RpcPayloadEnvelope {
  organization_id: string;
  mutation_id: string;
  mutation_kind: "commitCheckoutBill";
  entity_type: FinancialCheckoutPatch["entityType"];
  entity_id: string;
  client_created_at: string;
  payload: {
    mode: FinancialCheckoutPatch["mode"];
    primary_bill: Record<string, unknown>;
    bill_updates: Record<string, unknown>[];
    payments: Record<string, unknown>[];
    stock_movements: Record<string, unknown>[];
    audit_logs: Record<string, unknown>[];
    customers: FinancialCheckoutPatch["customers"];
    session_updates: FinancialCheckoutPatch["sessions"];
    customer_tab_updates: FinancialCheckoutPatch["customerTabs"];
    inventory_updates: FinancialCheckoutPatch["inventoryItems"];
    source_session_ids: string[];
    source_customer_tab_ids: string[];
    settlement_expectations: NonNullable<FinancialCheckoutPatch["settlementExpectations"]>;
    inventory_expectations: NonNullable<FinancialCheckoutPatch["inventoryExpectations"]>;
  };
}

export interface FinancialAdjustmentV2RpcPayloadEnvelope {
  organization_id: string;
  mutation_id: string;
  mutation_kind: FinancialAdjustmentPatch["kind"];
  entity_type: FinancialAdjustmentPatch["entityType"];
  entity_id: string;
  client_created_at: string;
  payload: {
    bill_updates: Record<string, unknown>[];
    payments: Record<string, unknown>[];
    stock_movements: Record<string, unknown>[];
    audit_logs: Record<string, unknown>[];
    inventory_updates: FinancialAdjustmentPatch["inventoryItems"];
    bill_expectations: NonNullable<FinancialAdjustmentPatch["billExpectations"]>;
    inventory_expectations: NonNullable<FinancialAdjustmentPatch["inventoryExpectations"]>;
  };
}

export class FinancialCheckoutRpcError extends Error {
  readonly code?: string;
  readonly rpcName: string;
  readonly mutationId: string;
  readonly details?: string;

  constructor(params: { message: string; code?: string; rpcName: string; mutationId: string; details?: string }) {
    super(params.message);
    this.name = "FinancialCheckoutRpcError";
    this.code = params.code;
    this.rpcName = params.rpcName;
    this.mutationId = params.mutationId;
    this.details = params.details;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    return toRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function stringifyDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function withoutKeys(value: unknown, keys: string[]): Record<string, unknown> {
  const record = { ...toRecord(value) };
  keys.forEach((key) => delete record[key]);
  return record;
}

function withoutBillActorFields(value: unknown): Record<string, unknown> {
  const bill = withoutKeys(value, [
    "issuedByUserId",
    "replacedByUserId",
    "voidedByUserId",
    "settledByUserId"
  ]);
  if (Array.isArray(bill.lineDiscounts)) {
    bill.lineDiscounts = bill.lineDiscounts.map((discount) => withoutKeys(discount, ["appliedByUserId"]));
  }
  if (bill.billDiscount) {
    bill.billDiscount = withoutKeys(bill.billDiscount, ["appliedByUserId"]);
  }
  return bill;
}

function withoutPaymentActorFields(value: unknown): Record<string, unknown> {
  return withoutKeys(value, ["receivedByUserId"]);
}

function withoutStockActorFields(value: unknown): Record<string, unknown> {
  return withoutKeys(value, ["userId"]);
}

function withoutAuditActorFields(value: unknown): Record<string, unknown> {
  return withoutKeys(value, ["userId"]);
}

async function withFinancialRpcTimeout<T>(request: PromiseLike<T>, rpcName: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach the server while running ${rpcName}.`));
    }, FINANCIAL_RPC_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function createFinancialRpcError(params: {
  error: RpcErrorResponse | Error;
  rpcName: string;
  mutationId: string;
}) {
  if (params.error instanceof Error) {
    return new FinancialCheckoutRpcError({
      message: params.error.message,
      rpcName: params.rpcName,
      mutationId: params.mutationId
    });
  }
  const parsedDetails = parseJsonRecord(params.error.details);
  const parsedNestedDetails = parsedDetails.details;
  const rawMessage = toOptionalString(parsedDetails.message) ?? params.error.message;
  const message = rawMessage || "The server rejected this checkout.";
  return new FinancialCheckoutRpcError({
    message,
    code: toOptionalString(parsedDetails.code) ?? params.error.code,
    details: stringifyDetail(parsedNestedDetails) ?? params.error.details ?? params.error.hint,
    rpcName: params.rpcName,
    mutationId: params.mutationId
  });
}

export function buildFinancialCheckoutRpcPayload(
  patch: FinancialCheckoutPatch,
  organizationId: string
): FinancialCheckoutRpcPayloadEnvelope {
  return {
    organization_id: organizationId,
    mutation_id: patch.mutationId,
    mutation_kind: "commitCheckoutBill",
    entity_type: patch.entityType,
    entity_id: patch.entityId,
    user_id: patch.userId,
    client_created_at: patch.createdAt,
    base_app_state_version: patch.baseAppStateVersion,
    payload: {
      mode: patch.mode,
      bill: patch.bill,
      bills: patch.bills,
      payments: patch.payments,
      stockMovements: patch.stockMovements,
      auditLogs: patch.auditLogs,
      customers: patch.customers,
      sessions: patch.sessions,
      customerTabs: patch.customerTabs,
      inventoryItems: patch.inventoryItems
    }
  };
}

export function buildFinancialCheckoutV2RpcPayload(
  patch: FinancialCheckoutPatch,
  organizationId: string
): FinancialCheckoutV2RpcPayloadEnvelope {
  return {
    organization_id: organizationId,
    mutation_id: patch.mutationId,
    mutation_kind: "commitCheckoutBill",
    entity_type: patch.entityType,
    entity_id: patch.entityId,
    client_created_at: patch.createdAt,
    payload: {
      mode: patch.mode,
      primary_bill: withoutBillActorFields(patch.bill),
      bill_updates: patch.bills.map(withoutBillActorFields),
      payments: patch.payments.map(withoutPaymentActorFields),
      stock_movements: patch.stockMovements.map(withoutStockActorFields),
      audit_logs: patch.auditLogs.map(withoutAuditActorFields),
      customers: patch.customers,
      session_updates: patch.sessions,
      customer_tab_updates: patch.customerTabs,
      inventory_updates: patch.inventoryItems,
      source_session_ids: patch.sourceSessionIds ?? patch.sessions.map((session) => session.id).sort(),
      source_customer_tab_ids: patch.sourceCustomerTabIds ?? patch.customerTabs.map((tab) => tab.id).sort(),
      settlement_expectations: patch.settlementExpectations ?? [],
      inventory_expectations: patch.inventoryExpectations ?? []
    }
  };
}

export function mapFinancialCheckoutRpcResult(params: {
  data: unknown;
  patch: FinancialCheckoutPatch;
  organizationId: string;
  rpcName?: string;
}): FinancialCheckoutCommitResult {
  const row = toRecord(params.data);
  const canonicalBill = toRecord(row.canonicalBill ?? row.canonical_bill);
  const canonicalPayments = row.canonicalPayments ?? row.canonical_payments;
  return {
    mutationId: toOptionalString(row.mutationId) ?? toOptionalString(row.mutation_id) ?? params.patch.mutationId,
    rpcName: params.rpcName ?? CHECKOUT_BILL_RPC_NAME,
    organizationId:
      toOptionalString(row.organizationId) ?? toOptionalString(row.organization_id) ?? params.organizationId,
    entityType:
      (toOptionalString(row.entityType) ?? toOptionalString(row.entity_type) ?? params.patch.entityType) as FinancialCheckoutPatch["entityType"],
    entityId: toOptionalString(row.entityId) ?? toOptionalString(row.entity_id) ?? params.patch.entityId,
    billId: toOptionalString(row.billId) ?? toOptionalString(row.bill_id) ?? params.patch.bill.id,
    billNumber: toOptionalString(row.billNumber) ?? toOptionalString(row.bill_number) ?? params.patch.bill.billNumber,
    appStateVersion: toOptionalNumber(row.appStateVersion ?? row.app_state_version),
    eventId: toOptionalString(row.eventId) ?? toOptionalString(row.event_id),
    serverTime: toOptionalString(row.serverTime) ?? toOptionalString(row.server_time),
    serverDurationMs: toOptionalNumber(row.serverDurationMs ?? row.server_duration_ms),
    changedRows: toRecord(row.changedRows ?? row.changed_rows),
    canonicalBill: Object.keys(canonicalBill).length > 0 ? (canonicalBill as unknown as FinancialCheckoutPatch["bill"]) : undefined,
    canonicalPayments: Array.isArray(canonicalPayments) ? (canonicalPayments as FinancialCheckoutPatch["payments"]) : undefined,
    raw: params.data
  };
}

export function buildFinancialAdjustmentRpcPayload(
  patch: FinancialAdjustmentPatch,
  organizationId: string
): FinancialAdjustmentRpcPayloadEnvelope {
  return {
    organization_id: organizationId,
    mutation_id: patch.mutationId,
    mutation_kind: patch.kind,
    entity_type: patch.entityType,
    entity_id: patch.entityId,
    user_id: patch.userId,
    client_created_at: patch.createdAt,
    base_app_state_version: patch.baseAppStateVersion,
    payload: {
      bills: patch.bills,
      payments: patch.payments,
      stockMovements: patch.stockMovements,
      auditLogs: patch.auditLogs,
      inventoryItems: patch.inventoryItems
    }
  };
}

export function buildFinancialAdjustmentV2RpcPayload(
  patch: FinancialAdjustmentPatch,
  organizationId: string
): FinancialAdjustmentV2RpcPayloadEnvelope {
  return {
    organization_id: organizationId,
    mutation_id: patch.mutationId,
    mutation_kind: patch.kind,
    entity_type: patch.entityType,
    entity_id: patch.entityId,
    client_created_at: patch.createdAt,
    payload: {
      bill_updates: patch.bills.map(withoutBillActorFields),
      payments: patch.payments.map(withoutPaymentActorFields),
      stock_movements: patch.stockMovements.map(withoutStockActorFields),
      audit_logs: patch.auditLogs.map(withoutAuditActorFields),
      inventory_updates: patch.inventoryItems,
      bill_expectations: patch.billExpectations ?? [],
      inventory_expectations: patch.inventoryExpectations ?? []
    }
  };
}

export function mapFinancialAdjustmentRpcResult(params: {
  data: unknown;
  patch: FinancialAdjustmentPatch;
  organizationId: string;
  rpcName?: string;
}): FinancialAdjustmentCommitResult {
  const row = toRecord(params.data);
  return {
    mutationId: toOptionalString(row.mutationId) ?? toOptionalString(row.mutation_id) ?? params.patch.mutationId,
    rpcName: params.rpcName ?? FINANCIAL_ADJUSTMENT_RPC_NAME,
    organizationId:
      toOptionalString(row.organizationId) ?? toOptionalString(row.organization_id) ?? params.organizationId,
    kind:
      (toOptionalString(row.mutationKind) ??
        toOptionalString(row.mutation_kind) ??
        params.patch.kind) as FinancialAdjustmentPatch["kind"],
    entityType:
      (toOptionalString(row.entityType) ??
        toOptionalString(row.entity_type) ??
        params.patch.entityType) as FinancialAdjustmentPatch["entityType"],
    entityId: toOptionalString(row.entityId) ?? toOptionalString(row.entity_id) ?? params.patch.entityId,
    appStateVersion: toOptionalNumber(row.appStateVersion ?? row.app_state_version),
    eventId: toOptionalString(row.eventId) ?? toOptionalString(row.event_id),
    serverTime: toOptionalString(row.serverTime) ?? toOptionalString(row.server_time),
    serverDurationMs: toOptionalNumber(row.serverDurationMs ?? row.server_duration_ms),
    changedRows: toRecord(row.changedRows ?? row.changed_rows),
    raw: params.data
  };
}

async function lookupFinancialMutationResult(params: {
  client: SupabaseClient;
  organizationId: string;
  mutationId: string;
  mutationKind: string;
}): Promise<unknown | null> {
  const result = await withFinancialRpcTimeout(
    params.client.rpc(FINANCIAL_MUTATION_STATUS_RPC_NAME, {
      payload: {
        organization_id: params.organizationId,
        mutation_id: params.mutationId,
        mutation_kind: params.mutationKind
      }
    }) as unknown as PromiseLike<RpcResult<unknown>>,
    FINANCIAL_MUTATION_STATUS_RPC_NAME
  );
  if (result.error || result.data === null) {
    return null;
  }
  const row = toRecord(result.data);
  return row.canonical_result ?? row.canonicalResult ?? result.data;
}

export async function invokeFinancialCheckoutRpc(
  patch: FinancialCheckoutPatch,
  options: {
    organizationId?: string;
    client?: SupabaseClient;
    useV2?: boolean;
  } = {}
): Promise<FinancialCheckoutCommitResult> {
  const client = options.client ?? getSupabaseClient();
  const organizationId = options.organizationId ?? (await resolveNormalizedOrganizationId(client));
  const rpcName = options.useV2 ? CHECKOUT_BILL_V2_RPC_NAME : CHECKOUT_BILL_RPC_NAME;
  const payload = options.useV2
    ? buildFinancialCheckoutV2RpcPayload(patch, organizationId)
    : buildFinancialCheckoutRpcPayload(patch, organizationId);

  let result: RpcResult<unknown>;
  try {
    result = await withFinancialRpcTimeout(
      client.rpc(rpcName, { payload }) as unknown as PromiseLike<RpcResult<unknown>>,
      rpcName
    );
  } catch (error) {
    if (options.useV2) {
      try {
        const recovered = await lookupFinancialMutationResult({
          client,
          organizationId,
          mutationId: patch.mutationId,
          mutationKind: "commitCheckoutBill"
        });
        if (recovered !== null) {
          return mapFinancialCheckoutRpcResult({ data: recovered, patch, organizationId, rpcName });
        }
      } catch {
        // Preserve the original ambiguous transport error when status reconciliation is unavailable.
      }
    }
    throw createFinancialRpcError({
      error: error instanceof Error ? error : new Error("Unable to commit this checkout."),
      rpcName,
      mutationId: patch.mutationId
    });
  }

  if (result.error) {
    if (options.useV2) {
      try {
        const recovered = await lookupFinancialMutationResult({
          client,
          organizationId,
          mutationId: patch.mutationId,
          mutationKind: "commitCheckoutBill"
        });
        if (recovered !== null) {
          return mapFinancialCheckoutRpcResult({ data: recovered, patch, organizationId, rpcName });
        }
      } catch {
        // Fall through to the deterministic RPC error when status reconciliation is unavailable.
      }
    }
    throw createFinancialRpcError({ error: result.error, rpcName, mutationId: patch.mutationId });
  }

  return mapFinancialCheckoutRpcResult({
    data: result.data,
    patch,
    organizationId,
    rpcName
  });
}

export async function invokeFinancialAdjustmentRpc(
  patch: FinancialAdjustmentPatch,
  options: {
    organizationId?: string;
    client?: SupabaseClient;
    useV2?: boolean;
  } = {}
): Promise<FinancialAdjustmentCommitResult> {
  const client = options.client ?? getSupabaseClient();
  const organizationId = options.organizationId ?? (await resolveNormalizedOrganizationId(client));
  const rpcName = options.useV2 ? FINANCIAL_ADJUSTMENT_V2_RPC_NAME : FINANCIAL_ADJUSTMENT_RPC_NAME;
  const payload = options.useV2
    ? buildFinancialAdjustmentV2RpcPayload(patch, organizationId)
    : buildFinancialAdjustmentRpcPayload(patch, organizationId);

  let result: RpcResult<unknown>;
  try {
    result = await withFinancialRpcTimeout(
      client.rpc(rpcName, { payload }) as unknown as PromiseLike<RpcResult<unknown>>,
      rpcName
    );
  } catch (error) {
    if (options.useV2) {
      try {
        const recovered = await lookupFinancialMutationResult({
          client,
          organizationId,
          mutationId: patch.mutationId,
          mutationKind: patch.kind
        });
        if (recovered !== null) {
          return mapFinancialAdjustmentRpcResult({ data: recovered, patch, organizationId, rpcName });
        }
      } catch {
        // Preserve the original ambiguous transport error when status reconciliation is unavailable.
      }
    }
    throw createFinancialRpcError({
      error: error instanceof Error ? error : new Error("Unable to commit this financial adjustment."),
      rpcName,
      mutationId: patch.mutationId
    });
  }

  if (result.error) {
    if (options.useV2) {
      try {
        const recovered = await lookupFinancialMutationResult({
          client,
          organizationId,
          mutationId: patch.mutationId,
          mutationKind: patch.kind
        });
        if (recovered !== null) {
          return mapFinancialAdjustmentRpcResult({ data: recovered, patch, organizationId, rpcName });
        }
      } catch {
        // Fall through to the deterministic RPC error when status reconciliation is unavailable.
      }
    }
    throw createFinancialRpcError({ error: result.error, rpcName, mutationId: patch.mutationId });
  }

  return mapFinancialAdjustmentRpcResult({
    data: result.data,
    patch,
    organizationId,
    rpcName
  });
}
