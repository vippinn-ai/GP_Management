import type { RealtimePostgresChangesPayload, SupabaseClient } from "@supabase/supabase-js";
import type { BackendFeatureFlags } from "./featureFlags";
import { loadNormalizedBillsByIds } from "./normalizedBillRegister";
import { loadNormalizedCustomersByIds } from "./normalizedCustomerSearch";
import { resolveNormalizedOrganizationId } from "./normalizedOrganization";
import {
  loadNormalizedAppDataOverlay,
  loadNormalizedAuditLogsByIds,
  loadNormalizedLiveDataByIds,
  loadNormalizedStockMovementsByIds
} from "./normalizedReads";
import type { AppData } from "../types";

export interface OperationalEventRow {
  organization_id: string;
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  entity_version?: number | null;
  created_by?: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface NormalizedRealtimeOverlay {
  appData: Partial<AppData>;
  refreshedSlices: string[];
  appStateVersion?: number;
  sourceMutationId?: string;
  requiresFullRefresh: boolean;
}

const LIVE_COLLECTIONS = new Set([
  "sessions",
  "session_pause_logs",
  "session_items",
  "session_combo_applications",
  "customer_tabs",
  "customer_tab_items",
  "customer_tab_combo_applications"
]);

const CATALOG_COLLECTIONS = new Set(["inventory_items", "sale_variants"]);
const COMBO_COLLECTIONS = new Set([
  "combos",
  "combo_station_targets",
  "combo_fixed_items",
  "combo_choice_groups",
  "combo_choice_options"
]);
const CONFIG_COLLECTIONS = new Set(["organizations", "inventory_categories", "stations", "pricing_rules"]);
const BILL_COLLECTIONS = new Set([
  "bills",
  "bill_lines",
  "bill_line_discounts",
  "bill_discounts",
  "payments"
]);

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
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

export function getOperationalEventMetadata(event: OperationalEventRow): Record<string, unknown> {
  return toRecord(event.metadata);
}

export function getOperationalEventChangedRows(event: OperationalEventRow): Record<string, unknown> {
  return toRecord(getOperationalEventMetadata(event).changed_rows);
}

function changedRowsHasAny(changedRows: Record<string, unknown>, collections: Set<string>): boolean {
  return Object.keys(changedRows).some((key) => collections.has(key));
}

function changedRowIds(changedRows: Record<string, unknown>, key: string): string[] {
  return toStringArray(changedRows[key]);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function needsLiveRefresh(event: OperationalEventRow, changedRows: Record<string, unknown>): boolean {
  if (event.entity_type === "session" || event.entity_type === "customer_tab") {
    return true;
  }
  return changedRowsHasAny(changedRows, LIVE_COLLECTIONS);
}

function getBillIdsForEvent(event: OperationalEventRow, changedRows: Record<string, unknown>): string[] {
  const metadata = getOperationalEventMetadata(event);
  return uniqueStrings([
    ...changedRowIds(changedRows, "bills"),
    toOptionalString(metadata.bill_id),
    event.entity_type === "bill" ? event.entity_id : undefined
  ]);
}

export function getNormalizedRealtimeRefreshPlan(event: OperationalEventRow): {
  requiresFullRefresh: boolean;
  normalizedConfigReads: boolean;
  normalizedCatalogReads: boolean;
  normalizedComboReads: boolean;
  normalizedLiveReads: boolean;
  changedSessionIds: string[];
  changedCustomerTabIds: string[];
  billIds: string[];
  paymentIds: string[];
  customerIds: string[];
  stockMovementIds: string[];
  auditLogIds: string[];
} {
  const metadata = getOperationalEventMetadata(event);
  const changedRows = getOperationalEventChangedRows(event);
  const hasBillChanges =
    changedRowsHasAny(changedRows, BILL_COLLECTIONS) ||
    event.event_type.startsWith("financial_") ||
    event.entity_type === "bill";
  const changedSessionIds = uniqueStrings([
    ...changedRowIds(changedRows, "sessions"),
    event.entity_type === "session" ? event.entity_id : undefined
  ]);
  const changedCustomerTabIds = uniqueStrings([
    ...changedRowIds(changedRows, "customer_tabs"),
    event.entity_type === "customer_tab" ? event.entity_id : undefined
  ]);
  const hasLiveChanges = needsLiveRefresh(event, changedRows);
  const canPatchChangedLiveRows = changedSessionIds.length > 0 || changedCustomerTabIds.length > 0;
  const requiresFullRefresh =
    metadata.requires_full_refresh === true ||
    event.entity_type === "app_state" ||
    changedRowsHasAny(changedRows, CONFIG_COLLECTIONS);

  return {
    requiresFullRefresh,
    normalizedConfigReads: false,
    normalizedCatalogReads: changedRowsHasAny(changedRows, CATALOG_COLLECTIONS),
    normalizedComboReads: changedRowsHasAny(changedRows, COMBO_COLLECTIONS),
    normalizedLiveReads: hasLiveChanges && !canPatchChangedLiveRows,
    changedSessionIds,
    changedCustomerTabIds,
    billIds: hasBillChanges ? getBillIdsForEvent(event, changedRows) : [],
    paymentIds: hasBillChanges ? changedRowIds(changedRows, "payments") : [],
    customerIds: changedRowIds(changedRows, "customers"),
    stockMovementIds: changedRowIds(changedRows, "stock_movements"),
    auditLogIds: changedRowIds(changedRows, "audit_logs")
  };
}

function mergeById<T extends { id: string }>(base: T[] | undefined, overlay: T[]): T[] {
  if (overlay.length === 0) {
    return base ?? [];
  }
  const overlayById = new Map(overlay.map((entry) => [entry.id, entry]));
  const merged = (base ?? []).map((entry) => overlayById.get(entry.id) ?? entry);
  const baseIds = new Set((base ?? []).map((entry) => entry.id));
  return [...overlay.filter((entry) => !baseIds.has(entry.id)), ...merged];
}

export async function loadNormalizedRealtimeOverlay(
  event: OperationalEventRow,
  _flags: BackendFeatureFlags,
  client: SupabaseClient
): Promise<NormalizedRealtimeOverlay> {
  const metadata = getOperationalEventMetadata(event);
  const plan = getNormalizedRealtimeRefreshPlan(event);
  const appStateVersion = toOptionalNumber(metadata.app_state_version);
  const sourceMutationId = toOptionalString(metadata.mutation_id);
  const refreshedSlices: string[] = [];
  const appData: Partial<AppData> = {};

  if (plan.requiresFullRefresh) {
    return {
      appData,
      refreshedSlices: ["full_app_state"],
      appStateVersion,
      sourceMutationId,
      requiresFullRefresh: true
    };
  }

  if (plan.normalizedConfigReads || plan.normalizedCatalogReads || plan.normalizedComboReads || plan.normalizedLiveReads) {
    const overlay = await loadNormalizedAppDataOverlay({
      normalizedConfigReads: plan.normalizedConfigReads,
      normalizedCatalogReads: plan.normalizedCatalogReads,
      normalizedComboReads: plan.normalizedComboReads,
      normalizedLiveReads: plan.normalizedLiveReads,
      client
    });
    Object.assign(appData, overlay.appData);
    if (plan.normalizedCatalogReads) refreshedSlices.push("catalog");
    if (plan.normalizedComboReads) refreshedSlices.push("combos");
    if (plan.normalizedLiveReads) refreshedSlices.push("live");
  }

  if (plan.changedSessionIds.length > 0 || plan.changedCustomerTabIds.length > 0) {
    const livePatch = await loadNormalizedLiveDataByIds(
      event.organization_id,
      {
        sessionIds: plan.changedSessionIds,
        customerTabIds: plan.changedCustomerTabIds
      },
      client
    );
    appData.sessions = mergeById(appData.sessions, livePatch.sessions);
    appData.sessionPauseLogs = mergeById(appData.sessionPauseLogs, livePatch.sessionPauseLogs);
    appData.customerTabs = mergeById(appData.customerTabs, livePatch.customerTabs);
    refreshedSlices.push("changed_live_rows");
  }

  if (plan.billIds.length > 0 || plan.paymentIds.length > 0) {
    const billPatch = await loadNormalizedBillsByIds(
      {
        organizationId: event.organization_id,
        billIds: plan.billIds,
        paymentIds: plan.paymentIds
      },
      client
    );
    appData.bills = billPatch.bills;
    appData.payments = billPatch.payments;
    refreshedSlices.push("bills");
  }

  const [customers, stockMovements, auditLogs] = await Promise.all([
    loadNormalizedCustomersByIds(event.organization_id, plan.customerIds, client),
    loadNormalizedStockMovementsByIds(event.organization_id, plan.stockMovementIds, client),
    loadNormalizedAuditLogsByIds(event.organization_id, plan.auditLogIds, client)
  ]);
  if (customers.length > 0) {
    appData.customers = customers;
    refreshedSlices.push("customers");
  }
  if (stockMovements.length > 0) {
    appData.stockMovements = stockMovements;
    refreshedSlices.push("stock_movements");
  }
  if (auditLogs.length > 0) {
    appData.auditLogs = auditLogs;
    refreshedSlices.push("audit_logs");
  }

  return {
    appData,
    refreshedSlices,
    appStateVersion,
    sourceMutationId,
    requiresFullRefresh: false
  };
}

export function subscribeToOperationalEvents(
  client: SupabaseClient,
  onEvent: (event: OperationalEventRow) => void | Promise<void>
): () => void {
  const channel = client
    .channel("operational-events-sync")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "operational_events"
      },
      (payload: RealtimePostgresChangesPayload<OperationalEventRow>) => {
        void onEvent(payload.new as OperationalEventRow);
      }
    )
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}

export async function emitGenericAppStateSaveEvent(params: {
  client: SupabaseClient;
  activeUserId: string;
  appStateVersion: number;
  actionLabel?: string;
}): Promise<void> {
  const organizationId = await resolveNormalizedOrganizationId(params.client);
  await params.client.from("operational_events").insert({
    organization_id: organizationId,
    event_type: "app_state_saved",
    entity_type: "app_state",
    entity_id: "primary",
    created_by: params.activeUserId,
    metadata: {
      app_state_version: params.appStateVersion,
      action_label: params.actionLabel,
      requires_full_refresh: true,
      changed_rows: {
        app_state: ["primary"]
      }
    }
  });
}
