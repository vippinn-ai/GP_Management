import { getSupabaseClient } from "../backend";
import type { InventoryReportModel, InventoryReportMovementDetail, InventoryReportRow, StockMovementType } from "../types";
import { loadNormalizedActiveOrganization } from "./normalizedReads";

const INVENTORY_REPORT_RPC_NAME = "load_inventory_report_summary";
const INVENTORY_REPORT_TIMEOUT_MS = 15_000;
export const INVENTORY_REPORT_DETAIL_LIMIT = 500;

interface RpcResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
}

export interface InventoryReportSummaryQuery {
  organizationId?: string;
  fromDate: string;
  toDate: string;
  searchQuery?: string;
  detailLimit?: number;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toOptionalString(value: unknown): string | undefined {
  const valueString = toStringValue(value);
  return valueString.trim() ? valueString : undefined;
}

function toNumberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBooleanValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

function toStockMovementType(value: unknown): StockMovementType {
  return value === "restock" ||
    value === "sale" ||
    value === "adjustment" ||
    value === "void_refund_reversal" ||
    value === "session_reservation" ||
    value === "session_reservation_void"
    ? value
    : "adjustment";
}

function estimatePayloadBytes(value: unknown): number {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

async function withInventoryReportTimeout<T>(request: PromiseLike<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Unable to reach normalized inventory report data."));
    }, INVENTORY_REPORT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function mapInventoryReportRow(value: unknown): InventoryReportRow {
  const row = toRecord(value);
  return {
    itemId: toStringValue(row.item_id),
    itemName: toStringValue(row.item_name, "Inventory item"),
    category: toStringValue(row.category, "Uncategorized"),
    active: toBooleanValue(row.active),
    added: toNumberValue(row.added),
    deducted: toNumberValue(row.deducted),
    manualAdjustments: toNumberValue(row.manual_adjustments),
    reversals: toNumberValue(row.reversals),
    netChange: toNumberValue(row.net_change),
    currentStock: toNumberValue(row.current_stock),
    reserved: toNumberValue(row.reserved),
    movementCount: toNumberValue(row.movement_count)
  };
}

function mapInventoryReportDetail(value: unknown): InventoryReportMovementDetail {
  const row = toRecord(value);
  return {
    id: toStringValue(row.id),
    businessDate: toStringValue(row.business_date),
    createdAt: toStringValue(row.created_at),
    itemId: toStringValue(row.item_id),
    itemName: toStringValue(row.item_name, "Inventory item"),
    category: toStringValue(row.category, "Uncategorized"),
    type: toStockMovementType(row.type),
    quantity: toNumberValue(row.quantity),
    reason: toStringValue(row.reason),
    relatedBillId: toOptionalString(row.related_bill_id),
    relatedBillNumber: toOptionalString(row.related_bill_number)
  };
}

export function mapInventoryReportSummaryData(value: unknown): InventoryReportModel {
  const root = toRecord(value);
  const summary = toRecord(root.summary);
  return {
    summary: {
      added: toNumberValue(summary.added),
      deducted: toNumberValue(summary.deducted),
      manualAdjustments: toNumberValue(summary.manual_adjustments),
      reversals: toNumberValue(summary.reversals),
      netChange: toNumberValue(summary.net_change),
      reserved: toNumberValue(summary.reserved),
      touchedItems: toNumberValue(summary.touched_items)
    },
    rows: toArray(root.rows).map(mapInventoryReportRow),
    details: toArray(root.details).map(mapInventoryReportDetail),
    detailLimit: toNumberValue(root.detail_limit) || INVENTORY_REPORT_DETAIL_LIMIT,
    detailsTruncated: toBooleanValue(root.details_truncated),
    payloadBytes: estimatePayloadBytes(value)
  };
}

export async function loadInventoryReportSummaryData(
  query: InventoryReportSummaryQuery,
  client = getSupabaseClient()
): Promise<InventoryReportModel> {
  const organizationId = query.organizationId ?? (await loadNormalizedActiveOrganization(client)).id;
  const detailLimit = Math.max(1, Math.min(2_000, Math.trunc(query.detailLimit ?? INVENTORY_REPORT_DETAIL_LIMIT)));
  const result = await withInventoryReportTimeout(
    client.rpc(INVENTORY_REPORT_RPC_NAME, {
      p_organization_id: organizationId,
      p_from_date: query.fromDate,
      p_to_date: query.toDate,
      p_search_query: query.searchQuery?.trim() ?? "",
      p_detail_limit: detailLimit
    }) as unknown as PromiseLike<RpcResult<unknown>>
  );

  if (result.error) {
    throw result.error;
  }
  return mapInventoryReportSummaryData(result.data ?? {});
}
