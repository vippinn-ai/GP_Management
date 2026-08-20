import { getSupabaseClient } from "../backend";
import type { Bill, PendingReceivable } from "../types";
import { loadNormalizedActiveOrganization } from "./normalizedReads";

const ANALYTICS_SUMMARY_RPC_NAME = "load_analytics_summary";
const ANALYTICS_SUMMARY_TIMEOUT_MS = 15_000;

interface RpcResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
}

export interface AnalyticsSummaryQuery {
  organizationId?: string;
  fromDate: string;
  toDate: string;
  previousFromDate: string;
  previousToDate: string;
}

export interface AnalyticsSummaryMetrics {
  grossRevenue: number;
  paidBillCount: number;
  sessionRevenue: number;
  itemRevenue: number;
  totalDiscounts: number;
  pendingRevenue: number;
  deferredOutstanding: number;
  oneTimeExpenses: number;
  previousRangeRevenue: number;
  paymentModeTotals: { cash: number; upi: number };
  expensePaymentModeTotals: { cash: number; upi: number; unknown: number };
}

export interface AnalyticsSummaryData {
  summary: AnalyticsSummaryMetrics;
  topStation: [string, number] | null;
  expenseByCategory: [string, number][];
  pendingReceivables: PendingReceivable[];
  payloadBytes: number;
}

export interface AnalyticsSummaryReadState {
  data: AnalyticsSummaryData | null;
  error: string;
  loaded: boolean;
  dataQueryKey: string;
}

export function isAnalyticsSummaryDataReady(
  state: AnalyticsSummaryReadState,
  queryKey: string
): boolean {
  return state.loaded && !state.error && !!state.data && state.dataQueryKey === queryKey;
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

function estimatePayloadBytes(value: unknown): number {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

async function withAnalyticsSummaryTimeout<T>(request: PromiseLike<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Unable to reach normalized analytics summary data."));
    }, ANALYTICS_SUMMARY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function createPendingReceivableBill(row: Record<string, unknown>): Bill {
  const issuedAt = toStringValue(row.issued_at, new Date().toISOString());
  return {
    id: toStringValue(row.bill_id),
    billNumber: toStringValue(row.bill_number, "Pending Bill"),
    status: "pending",
    createdAt: issuedAt,
    issuedAt,
    issuedByUserId: "",
    customerId: toOptionalString(row.customer_id),
    customerName: toOptionalString(row.customer_name),
    customerPhone: toOptionalString(row.customer_phone),
    paymentMode: "deferred",
    stationId: toOptionalString(row.station_id),
    sessionId: toOptionalString(row.session_id),
    amountPaid: toNumberValue(row.amount_paid),
    amountDue: toNumberValue(row.amount_due),
    subtotal: toNumberValue(row.total),
    totalDiscountAmount: 0,
    billDiscountAmount: 0,
    roundOffEnabled: false,
    roundOffAmount: 0,
    total: toNumberValue(row.total),
    lineDiscounts: [],
    lines: [],
    receiptType: "digital"
  };
}

function mapPendingReceivable(rowValue: unknown): PendingReceivable {
  const row = toRecord(rowValue);
  return {
    bill: createPendingReceivableBill(row),
    businessDate: toStringValue(row.business_date),
    daysOverdue: toNumberValue(row.days_overdue)
  };
}

export function mapAnalyticsSummaryData(value: unknown): AnalyticsSummaryData {
  const root = toRecord(value);
  const summary = toRecord(root.summary);
  const paymentModeTotals = toRecord(summary.payment_mode_totals);
  const expensePaymentModeTotals = toRecord(summary.expense_payment_mode_totals);
  const topStation = toRecord(root.top_station);
  const topStationAmount = toNumberValue(topStation.amount);

  return {
    summary: {
      grossRevenue: toNumberValue(summary.gross_revenue),
      paidBillCount: toNumberValue(summary.paid_bill_count),
      sessionRevenue: toNumberValue(summary.session_revenue),
      itemRevenue: toNumberValue(summary.item_revenue),
      totalDiscounts: toNumberValue(summary.total_discounts),
      pendingRevenue: toNumberValue(summary.pending_revenue),
      deferredOutstanding: toNumberValue(summary.deferred_outstanding),
      oneTimeExpenses: toNumberValue(summary.one_time_expenses),
      previousRangeRevenue: toNumberValue(summary.previous_range_revenue),
      paymentModeTotals: {
        cash: toNumberValue(paymentModeTotals.cash),
        upi: toNumberValue(paymentModeTotals.upi)
      },
      expensePaymentModeTotals: {
        cash: toNumberValue(expensePaymentModeTotals.cash),
        upi: toNumberValue(expensePaymentModeTotals.upi),
        unknown: toNumberValue(expensePaymentModeTotals.unknown)
      }
    },
    topStation:
      toStringValue(topStation.label).trim() && topStationAmount > 0
        ? [toStringValue(topStation.label), topStationAmount]
        : null,
    expenseByCategory: toArray(root.expense_by_category)
      .map((entry) => {
        const row = toRecord(entry);
        return [toStringValue(row.category, "Uncategorized"), toNumberValue(row.amount)] as [string, number];
      })
      .filter(([, amount]) => amount > 0),
    pendingReceivables: toArray(root.pending_receivables).map(mapPendingReceivable),
    payloadBytes: estimatePayloadBytes(value)
  };
}

export async function loadAnalyticsSummaryData(
  query: AnalyticsSummaryQuery,
  client = getSupabaseClient()
): Promise<AnalyticsSummaryData> {
  const organizationId = query.organizationId ?? (await loadNormalizedActiveOrganization(client)).id;
  const result = await withAnalyticsSummaryTimeout(
    client.rpc(ANALYTICS_SUMMARY_RPC_NAME, {
      p_organization_id: organizationId,
      p_from_date: query.fromDate,
      p_to_date: query.toDate,
      p_previous_from_date: query.previousFromDate,
      p_previous_to_date: query.previousToDate
    }) as unknown as PromiseLike<RpcResult<unknown>>
  );

  if (result.error) {
    throw result.error;
  }
  return mapAnalyticsSummaryData(result.data ?? {});
}
