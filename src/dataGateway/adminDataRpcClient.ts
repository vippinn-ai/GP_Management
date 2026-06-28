import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import { resolveNormalizedOrganizationId } from "./normalizedOrganization";
import type { AdminDataChangeCommitResult, AdminDataChangePatch } from "./types";

const ADMIN_DATA_RPC_TIMEOUT_MS = 15_000;
const ADMIN_DATA_RPC_NAME = "commit_admin_data_change";

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

export interface AdminDataChangeRpcPayloadEnvelope {
  organization_id: string;
  mutation_id: string;
  mutation_kind: "commitAdminDataChange";
  entity_type: AdminDataChangePatch["entityType"];
  entity_id: string;
  user_id: string;
  client_created_at: string;
  base_app_state_version: number;
  payload: Omit<
    AdminDataChangePatch,
    "mutationId" | "entityType" | "entityId" | "userId" | "createdAt" | "baseAppStateVersion"
  >;
}

export class AdminDataRpcError extends Error {
  readonly code?: string;
  readonly rpcName: string;
  readonly mutationId: string;
  readonly details?: string;

  constructor(params: { message: string; code?: string; rpcName: string; mutationId: string; details?: string }) {
    super(params.message);
    this.name = "AdminDataRpcError";
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

async function withAdminDataRpcTimeout<T>(request: PromiseLike<T>, rpcName: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach the server while running ${rpcName}.`));
    }, ADMIN_DATA_RPC_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function createAdminDataRpcError(params: {
  error: RpcErrorResponse | Error;
  rpcName: string;
  mutationId: string;
}) {
  if (params.error instanceof Error) {
    return new AdminDataRpcError({
      message: params.error.message,
      rpcName: params.rpcName,
      mutationId: params.mutationId
    });
  }
  const parsedDetails = parseJsonRecord(params.error.details);
  const parsedNestedDetails = parsedDetails.details;
  const rawMessage = toOptionalString(parsedDetails.message) ?? params.error.message;
  return new AdminDataRpcError({
    message: rawMessage || "The server rejected this admin change.",
    code: toOptionalString(parsedDetails.code) ?? params.error.code,
    details: stringifyDetail(parsedNestedDetails) ?? params.error.details ?? params.error.hint,
    rpcName: params.rpcName,
    mutationId: params.mutationId
  });
}

export function buildAdminDataChangeRpcPayload(
  patch: AdminDataChangePatch,
  organizationId: string
): AdminDataChangeRpcPayloadEnvelope {
  return {
    organization_id: organizationId,
    mutation_id: patch.mutationId,
    mutation_kind: "commitAdminDataChange",
    entity_type: patch.entityType,
    entity_id: patch.entityId,
    user_id: patch.userId,
    client_created_at: patch.createdAt,
    base_app_state_version: patch.baseAppStateVersion,
    payload: {
      inventoryCategories: patch.inventoryCategories,
      inventoryItems: patch.inventoryItems,
      inventoryItemIdsToDelete: patch.inventoryItemIdsToDelete,
      combos: patch.combos,
      comboIdsToDelete: patch.comboIdsToDelete,
      stockMovements: patch.stockMovements,
      auditLogs: patch.auditLogs,
      expenses: patch.expenses,
      expenseIdsToDelete: patch.expenseIdsToDelete,
      expenseTemplates: patch.expenseTemplates,
      expenseTemplateIdsToDelete: patch.expenseTemplateIdsToDelete,
      expenseTemplateOverrides: patch.expenseTemplateOverrides,
      expenseTemplateOverrideIdsToDelete: patch.expenseTemplateOverrideIdsToDelete,
      stations: patch.stations,
      stationIdsToDelete: patch.stationIdsToDelete,
      pricingRules: patch.pricingRules,
      pricingRuleIdsToDelete: patch.pricingRuleIdsToDelete,
      customers: patch.customers,
      customerIdsToDelete: patch.customerIdsToDelete,
      businessProfile: patch.businessProfile
    }
  };
}

export function mapAdminDataChangeRpcResult(params: {
  data: unknown;
  patch: AdminDataChangePatch;
  organizationId: string;
  rpcName?: string;
}): AdminDataChangeCommitResult {
  const row = toRecord(params.data);
  return {
    mutationId: toOptionalString(row.mutationId) ?? toOptionalString(row.mutation_id) ?? params.patch.mutationId,
    rpcName: params.rpcName ?? ADMIN_DATA_RPC_NAME,
    organizationId:
      toOptionalString(row.organizationId) ?? toOptionalString(row.organization_id) ?? params.organizationId,
    entityType:
      (toOptionalString(row.entityType) ??
        toOptionalString(row.entity_type) ??
        params.patch.entityType) as AdminDataChangePatch["entityType"],
    entityId: toOptionalString(row.entityId) ?? toOptionalString(row.entity_id) ?? params.patch.entityId,
    appStateVersion: toOptionalNumber(row.appStateVersion ?? row.app_state_version),
    eventId: toOptionalString(row.eventId) ?? toOptionalString(row.event_id),
    serverTime: toOptionalString(row.serverTime) ?? toOptionalString(row.server_time),
    serverDurationMs: toOptionalNumber(row.serverDurationMs ?? row.server_duration_ms),
    changedRows: toRecord(row.changedRows ?? row.changed_rows),
    raw: params.data
  };
}

export async function invokeAdminDataChangeRpc(
  patch: AdminDataChangePatch,
  options: {
    organizationId?: string;
    client?: SupabaseClient;
  } = {}
): Promise<AdminDataChangeCommitResult> {
  const client = options.client ?? getSupabaseClient();
  const organizationId = options.organizationId ?? (await resolveNormalizedOrganizationId(client));
  const payload = buildAdminDataChangeRpcPayload(patch, organizationId);

  let result: RpcResult<unknown>;
  try {
    result = await withAdminDataRpcTimeout(
      client.rpc(ADMIN_DATA_RPC_NAME, { payload }) as unknown as PromiseLike<RpcResult<unknown>>,
      ADMIN_DATA_RPC_NAME
    );
  } catch (error) {
    throw createAdminDataRpcError({
      error: error instanceof Error ? error : new Error("Unable to commit this admin change."),
      rpcName: ADMIN_DATA_RPC_NAME,
      mutationId: patch.mutationId
    });
  }

  if (result.error) {
    throw createAdminDataRpcError({ error: result.error, rpcName: ADMIN_DATA_RPC_NAME, mutationId: patch.mutationId });
  }

  return mapAdminDataChangeRpcResult({
    data: result.data,
    patch,
    organizationId,
    rpcName: ADMIN_DATA_RPC_NAME
  });
}
