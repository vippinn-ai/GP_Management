import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import { resolveNormalizedBillRegisterOrganizationId } from "./normalizedBillRegister";
import type { FinancialCheckoutCommitResult, FinancialCheckoutPatch } from "./types";

const FINANCIAL_RPC_TIMEOUT_MS = 15_000;
const CHECKOUT_BILL_RPC_NAME = "commit_checkout_bill";

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

export function mapFinancialCheckoutRpcResult(params: {
  data: unknown;
  patch: FinancialCheckoutPatch;
  organizationId: string;
  rpcName?: string;
}): FinancialCheckoutCommitResult {
  const row = toRecord(params.data);
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
    raw: params.data
  };
}

export async function invokeFinancialCheckoutRpc(
  patch: FinancialCheckoutPatch,
  options: {
    organizationId?: string;
    client?: SupabaseClient;
  } = {}
): Promise<FinancialCheckoutCommitResult> {
  const client = options.client ?? getSupabaseClient();
  const organizationId = options.organizationId ?? (await resolveNormalizedBillRegisterOrganizationId(client));
  const payload = buildFinancialCheckoutRpcPayload(patch, organizationId);

  let result: RpcResult<unknown>;
  try {
    result = await withFinancialRpcTimeout(
      client.rpc(CHECKOUT_BILL_RPC_NAME, { payload }) as unknown as PromiseLike<RpcResult<unknown>>,
      CHECKOUT_BILL_RPC_NAME
    );
  } catch (error) {
    throw createFinancialRpcError({
      error: error instanceof Error ? error : new Error("Unable to commit this checkout."),
      rpcName: CHECKOUT_BILL_RPC_NAME,
      mutationId: patch.mutationId
    });
  }

  if (result.error) {
    throw createFinancialRpcError({ error: result.error, rpcName: CHECKOUT_BILL_RPC_NAME, mutationId: patch.mutationId });
  }

  return mapFinancialCheckoutRpcResult({
    data: result.data,
    patch,
    organizationId,
    rpcName: CHECKOUT_BILL_RPC_NAME
  });
}
