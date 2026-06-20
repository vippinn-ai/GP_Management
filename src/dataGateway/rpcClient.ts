import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import type { OperationalMutation, OperationalMutationKind } from "../operationalSync";
import { resolveNormalizedBillRegisterOrganizationId } from "./normalizedBillRegister";
import type { OperationalRpcCommitResult } from "./types";

const OPERATIONAL_RPC_TIMEOUT_MS = 15_000;

export const OPERATIONAL_RPC_FUNCTION_NAMES: Record<OperationalMutationKind, string> = Object.freeze({
  startSession: "start_session",
  pauseSession: "pause_session",
  resumeSession: "resume_session",
  addSessionItem: "add_session_item",
  removeSessionItem: "remove_session_item",
  repeatSessionCombo: "repeat_session_combo",
  openCustomerTab: "open_customer_tab",
  applyCustomerTabCombo: "apply_customer_tab_combo",
  addCustomerTabItem: "add_customer_tab_item",
  updateCustomerTabItemQuantity: "update_customer_tab_item_quantity",
  removeCustomerTabItem: "remove_customer_tab_item",
  saveLiveSessionDetails: "save_live_session_details",
  saveLiveCustomerTabDetails: "save_live_customer_tab_details"
});

export interface OperationalRpcPayloadEnvelope {
  organization_id: string;
  mutation_id: string;
  mutation_kind: OperationalMutationKind;
  label: string;
  entity_type: OperationalMutation["entityType"];
  entity_id: string;
  user_id: string;
  client_created_at: string;
  base_app_state_version: number;
  payload: OperationalMutation["payload"];
}

interface RpcResult<T> {
  data: T | null;
  error: {
    code?: string;
    message: string;
    details?: string;
    hint?: string;
  } | null;
}

export class OperationalRpcError extends Error {
  readonly code?: string;
  readonly rpcName: string;
  readonly mutationId: string;
  readonly details?: string;

  constructor(params: {
    message: string;
    code?: string;
    rpcName: string;
    mutationId: string;
    details?: string;
  }) {
    super(params.message);
    this.name = "OperationalRpcError";
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

async function withOperationalRpcTimeout<T>(request: PromiseLike<T>, rpcName: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach the server while running ${rpcName}.`));
    }, OPERATIONAL_RPC_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function createOperationalRpcError(params: {
  error: { code?: string; message: string; details?: string; hint?: string } | Error;
  rpcName: string;
  mutationId: string;
}) {
  const message =
    params.error instanceof Error
      ? params.error.message
      : params.error.message || "The server rejected this operational change.";
  return new OperationalRpcError({
    message,
    code: params.error instanceof Error ? undefined : params.error.code,
    details: params.error instanceof Error ? undefined : params.error.details ?? params.error.hint,
    rpcName: params.rpcName,
    mutationId: params.mutationId
  });
}

export function getOperationalRpcFunctionName(kind: OperationalMutationKind): string {
  return OPERATIONAL_RPC_FUNCTION_NAMES[kind];
}

export function buildOperationalRpcPayload(
  mutation: OperationalMutation,
  organizationId: string
): OperationalRpcPayloadEnvelope {
  return {
    organization_id: organizationId,
    mutation_id: mutation.id,
    mutation_kind: mutation.kind,
    label: mutation.label,
    entity_type: mutation.entityType,
    entity_id: mutation.entityId,
    user_id: mutation.userId,
    client_created_at: mutation.createdAt,
    base_app_state_version: mutation.baseVersion,
    payload: mutation.payload
  };
}

export function mapOperationalRpcResult(params: {
  data: unknown;
  mutation: OperationalMutation;
  organizationId: string;
  rpcName: string;
}): OperationalRpcCommitResult {
  const row = toRecord(params.data);
  return {
    mutationId: toOptionalString(row.mutationId) ?? toOptionalString(row.mutation_id) ?? params.mutation.id,
    rpcName: params.rpcName,
    organizationId:
      toOptionalString(row.organizationId) ?? toOptionalString(row.organization_id) ?? params.organizationId,
    entityType:
      (toOptionalString(row.entityType) ?? toOptionalString(row.entity_type) ?? params.mutation.entityType) as OperationalMutation["entityType"],
    entityId: toOptionalString(row.entityId) ?? toOptionalString(row.entity_id) ?? params.mutation.entityId,
    eventId: toOptionalString(row.eventId) ?? toOptionalString(row.event_id),
    serverTime: toOptionalString(row.serverTime) ?? toOptionalString(row.server_time),
    changedRows: toRecord(row.changedRows ?? row.changed_rows),
    raw: params.data
  };
}

export async function invokeOperationalMutationRpc(
  mutation: OperationalMutation,
  options: {
    organizationId?: string;
    client?: SupabaseClient;
  } = {}
): Promise<OperationalRpcCommitResult> {
  const client = options.client ?? getSupabaseClient();
  const organizationId = options.organizationId ?? (await resolveNormalizedBillRegisterOrganizationId(client));
  const rpcName = getOperationalRpcFunctionName(mutation.kind);
  const payload = buildOperationalRpcPayload(mutation, organizationId);

  let result: RpcResult<unknown>;
  try {
    result = await withOperationalRpcTimeout(
      client.rpc(rpcName, { payload }) as unknown as PromiseLike<RpcResult<unknown>>,
      rpcName
    );
  } catch (error) {
    throw createOperationalRpcError({
      error: error instanceof Error ? error : new Error("Unable to run this operational change."),
      rpcName,
      mutationId: mutation.id
    });
  }

  if (result.error) {
    throw createOperationalRpcError({ error: result.error, rpcName, mutationId: mutation.id });
  }

  return mapOperationalRpcResult({
    data: result.data,
    mutation,
    organizationId,
    rpcName
  });
}
