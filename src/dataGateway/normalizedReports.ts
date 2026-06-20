import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import { addDays, toBusinessDayKey } from "../utils";
import type { AppliedDiscount, Bill, BillLine, Expense, ExpensePaymentMode, Payment } from "../types";
import { getBusinessDayIssuedAtRange, mapNormalizedBill, mapNormalizedBillDiscount, mapNormalizedBillLine, mapNormalizedPayment } from "./normalizedBillRegister";
import { loadNormalizedActiveOrganization } from "./normalizedReads";

const REPORT_READ_TIMEOUT_MS = 20_000;

const BILL_SELECT_COLUMNS =
  "id, bill_number, status, created_at_source, issued_at, issued_by_user_id, customer_id, customer_name, customer_phone, payment_mode, station_id, session_id, amount_paid, amount_due, subtotal, total_discount_amount, bill_discount_amount, round_off_enabled, round_off_amount, total, receipt_type, replacement_of_bill_id, replaced_by_bill_id, replaced_at, replaced_by_user_id, replace_reason, voided_at, voided_by_user_id, void_reason, settled_at, settled_by_user_id, raw_data";

const BILL_LINE_SELECT_COLUMNS =
  "bill_id, id, type, description, quantity, unit_price, subtotal, discount_amount, total, linked_session_id, inventory_item_id, sold_as_pack_of, sale_variant_id, stock_units_per_sale, combo_application_id, combo_id, raw_data";

const BILL_DISCOUNT_SELECT_COLUMNS =
  "bill_id, id, discount_type, value, amount, reason, applied_by_user_id, applied_at, raw_data";

const BILL_LINE_DISCOUNT_SELECT_COLUMNS =
  "bill_id, id, target_id, discount_type, value, amount, reason, applied_by_user_id, applied_at, raw_data";

const PAYMENT_SELECT_COLUMNS =
  "id, bill_id, mode, amount, paid_at, received_by_user_id, settlement_group_id, related_checkout_bill_id, raw_data";

const EXPENSE_SELECT_COLUMNS =
  "id, title, category, amount, payment_mode, cash_amount, upi_amount, spent_at, notes, created_by_user_id, raw_data";

interface NormalizedQueryResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
}

interface BillRow {
  id: string;
  bill_number: string;
  status: string;
  created_at_source: string | null;
  issued_at: string | null;
  issued_by_user_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  payment_mode: string | null;
  station_id: string | null;
  session_id: string | null;
  amount_paid: number | string;
  amount_due: number | string;
  subtotal: number | string;
  total_discount_amount: number | string;
  bill_discount_amount: number | string;
  round_off_enabled: boolean;
  round_off_amount: number | string;
  total: number | string;
  receipt_type: string | null;
  replacement_of_bill_id: string | null;
  replaced_by_bill_id: string | null;
  replaced_at: string | null;
  replaced_by_user_id: string | null;
  replace_reason: string | null;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  settled_at: string | null;
  settled_by_user_id: string | null;
  raw_data: Record<string, unknown> | null;
}

interface BillLineRow {
  bill_id: string;
  id: string;
  type: string;
  description: string;
  quantity: number | string;
  unit_price: number | string;
  subtotal: number | string;
  discount_amount: number | string;
  total: number | string;
  linked_session_id: string | null;
  inventory_item_id: string | null;
  sold_as_pack_of: number | string | null;
  sale_variant_id: string | null;
  stock_units_per_sale: number | string | null;
  combo_application_id: string | null;
  combo_id: string | null;
  raw_data: Record<string, unknown> | null;
}

interface BillDiscountRow {
  bill_id: string;
  id: string;
  discount_type: string | null;
  value: number | string;
  amount: number | string;
  reason: string | null;
  applied_by_user_id: string | null;
  applied_at: string | null;
  raw_data: Record<string, unknown> | null;
}

interface BillLineDiscountRow extends BillDiscountRow {
  target_id: string | null;
}

interface PaymentRow {
  id: string;
  bill_id: string | null;
  mode: string;
  amount: number | string;
  paid_at: string | null;
  received_by_user_id: string | null;
  settlement_group_id: string | null;
  related_checkout_bill_id: string | null;
  raw_data: Record<string, unknown> | null;
}

interface SessionActivityRow {
  id: string;
  started_at: string | null;
  closed_bill_id: string | null;
}

interface CustomerTabActivityRow {
  id: string;
  opened_at: string | null;
  closed_bill_id: string | null;
}

interface ExpenseRow {
  id: string;
  title: string;
  category: string | null;
  amount: number | string;
  payment_mode: string | null;
  cash_amount: number | string | null;
  upi_amount: number | string | null;
  spent_at: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  raw_data: Record<string, unknown> | null;
}

export interface NormalizedReportQuery {
  organizationId?: string;
  fromDate: string;
  toDate: string;
  previousFromDate?: string;
  previousToDate?: string;
}

export interface NormalizedReportData {
  bills: Bill[];
  payments: Payment[];
  expenses: Expense[];
  billBusinessDates: Record<string, string>;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toStringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function toNumberValue(value: unknown, fallback: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof fallback === "number" && Number.isFinite(fallback)) {
    return fallback;
  }
  if (typeof fallback === "string" && fallback.trim()) {
    const parsed = Number(fallback);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function uniqueValues(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

async function withReportReadTimeout<T>(request: PromiseLike<T>, action: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach normalized report data while ${action}.`));
    }, REPORT_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function readMany<T>(request: PromiseLike<NormalizedQueryResult<T[]>>, action: string): Promise<T[]> {
  const result = await withReportReadTimeout(request, action);
  if (result.error) {
    throw result.error;
  }
  return result.data ?? [];
}

export function getLocalDateRange(from: string, to: string): { fromIso: string; toIsoExclusive: string } {
  const start = new Date(`${from}T00:00:00`);
  const end = addDays(new Date(`${to}T00:00:00`), 1);
  return {
    fromIso: start.toISOString(),
    toIsoExclusive: end.toISOString()
  };
}

export function getReportPaymentQueryRange(query: NormalizedReportQuery): { fromIso?: string; toIsoExclusive?: string } {
  const from = query.previousFromDate && query.previousFromDate < query.fromDate ? query.previousFromDate : query.fromDate;
  const to = query.previousToDate && query.previousToDate > query.toDate ? query.previousToDate : query.toDate;
  return getBusinessDayIssuedAtRange(from, to);
}

export function mapNormalizedExpense(row: ExpenseRow): Expense {
  const raw = toRecord(row.raw_data);
  const paymentMode = toOptionalString(raw.paymentMode) ?? toOptionalString(row.payment_mode);
  return {
    id: row.id,
    title: toStringValue(row.title, toStringValue(raw.title, "Expense")),
    category: toStringValue(row.category, toStringValue(raw.category, "Miscellaneous")),
    amount: toNumberValue(raw.amount, row.amount),
    paymentMode:
      paymentMode === "cash" || paymentMode === "upi" || paymentMode === "split"
        ? (paymentMode as ExpensePaymentMode)
        : undefined,
    cashAmount:
      raw.cashAmount !== undefined || row.cash_amount !== null
        ? toNumberValue(raw.cashAmount, row.cash_amount)
        : undefined,
    upiAmount:
      raw.upiAmount !== undefined || row.upi_amount !== null
        ? toNumberValue(raw.upiAmount, row.upi_amount)
        : undefined,
    spentAt: toStringValue(raw.spentAt, row.spent_at ?? ""),
    notes: toOptionalString(raw.notes) ?? toOptionalString(row.notes),
    createdByUserId: toStringValue(raw.createdByUserId, row.created_by_user_id ?? "")
  };
}

export function buildNormalizedReportData(params: {
  billRows: BillRow[];
  paymentRows: PaymentRow[];
  billLineRows: BillLineRow[];
  billDiscountRows: BillDiscountRow[];
  billLineDiscountRows: BillLineDiscountRow[];
  sessionRows: SessionActivityRow[];
  customerTabRows: CustomerTabActivityRow[];
  expenseRows: ExpenseRow[];
}): NormalizedReportData {
  const linesByBillId = new Map<string, BillLine[]>();
  params.billLineRows.forEach((row) => {
    const lines = linesByBillId.get(row.bill_id) ?? [];
    lines.push(mapNormalizedBillLine(row));
    linesByBillId.set(row.bill_id, lines);
  });
  const lineDiscountsByBillId = new Map<string, AppliedDiscount[]>();
  params.billLineDiscountRows.forEach((row) => {
    const discounts = lineDiscountsByBillId.get(row.bill_id) ?? [];
    discounts.push(mapNormalizedBillDiscount(row, "line"));
    lineDiscountsByBillId.set(row.bill_id, discounts);
  });
  const billDiscountByBillId = new Map(
    params.billDiscountRows.map((row) => [row.bill_id, mapNormalizedBillDiscount(row, "bill") as AppliedDiscount])
  );
  const sessionStartedById = new Map(params.sessionRows.map((row) => [row.id, row.started_at]));
  const sessionStartedByBillId = new Map(
    params.sessionRows
      .filter((row) => row.closed_bill_id)
      .map((row) => [row.closed_bill_id!, row.started_at])
  );
  const tabOpenedByBillId = new Map(
    params.customerTabRows
      .filter((row) => row.closed_bill_id)
      .map((row) => [row.closed_bill_id!, row.opened_at])
  );

  const billBusinessDates: Record<string, string> = {};
  const bills = params.billRows.map((row) => {
    const bill = mapNormalizedBill(row, {
      lines: linesByBillId.get(row.id) ?? [],
      lineDiscounts: lineDiscountsByBillId.get(row.id) ?? [],
      billDiscount: billDiscountByBillId.get(row.id)
    });
    const sourceDate =
      (bill.sessionId ? sessionStartedById.get(bill.sessionId) : undefined) ??
      sessionStartedByBillId.get(bill.id) ??
      tabOpenedByBillId.get(bill.id) ??
      bill.issuedAt;
    billBusinessDates[bill.id] = toBusinessDayKey(sourceDate);
    return bill;
  });

  return {
    bills,
    payments: params.paymentRows.map(mapNormalizedPayment).filter((payment) => payment.billId),
    expenses: params.expenseRows.map(mapNormalizedExpense),
    billBusinessDates
  };
}

async function loadRowsByIds<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  organizationId: string,
  ids: string[],
  action: string
): Promise<T[]> {
  if (ids.length === 0) {
    return [];
  }
  const request = client
    .from(table)
    .select(columns)
    .eq("organization_id", organizationId)
    .in("id", ids) as unknown as PromiseLike<NormalizedQueryResult<T[]>>;
  return readMany<T>(
    request,
    action
  );
}

export async function loadNormalizedReportData(
  query: NormalizedReportQuery,
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedReportData> {
  const organizationId = query.organizationId ?? (await loadNormalizedActiveOrganization(client)).id;
  const reportRange = getBusinessDayIssuedAtRange(query.fromDate, query.toDate);
  const paymentRange = getReportPaymentQueryRange(query);
  const expenseRange = getLocalDateRange(query.fromDate, query.toDate);

  const [issuedBillRows, paymentRows, sessionActivityRows, customerTabActivityRows, expenseRows] = await Promise.all([
    readMany<BillRow>(
      client
        .from("bills")
        .select(BILL_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .gte("issued_at", reportRange.fromIso ?? "")
        .lt("issued_at", reportRange.toIsoExclusive ?? "")
        .order("issued_at", { ascending: false })
        .order("id", { ascending: false }),
      "loading normalized report bills"
    ),
    readMany<PaymentRow>(
      client
        .from("payments")
        .select(PAYMENT_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .gte("paid_at", paymentRange.fromIso ?? "")
        .lt("paid_at", paymentRange.toIsoExclusive ?? "")
        .order("paid_at", { ascending: false })
        .order("id", { ascending: false }),
      "loading normalized report payments"
    ),
    readMany<SessionActivityRow>(
      client
        .from("sessions")
        .select("id, started_at, closed_bill_id")
        .eq("organization_id", organizationId)
        .not("closed_bill_id", "is", null)
        .gte("started_at", reportRange.fromIso ?? "")
        .lt("started_at", reportRange.toIsoExclusive ?? ""),
      "loading normalized report session activity"
    ),
    readMany<CustomerTabActivityRow>(
      client
        .from("customer_tabs")
        .select("id, opened_at, closed_bill_id")
        .eq("organization_id", organizationId)
        .not("closed_bill_id", "is", null)
        .gte("opened_at", reportRange.fromIso ?? "")
        .lt("opened_at", reportRange.toIsoExclusive ?? ""),
      "loading normalized report customer tab activity"
    ),
    readMany<ExpenseRow>(
      client
        .from("expenses")
        .select(EXPENSE_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .gte("spent_at", expenseRange.fromIso)
        .lt("spent_at", expenseRange.toIsoExclusive)
        .order("spent_at", { ascending: false })
        .order("id", { ascending: false }),
      "loading normalized report expenses"
    )
  ]);

  const billIds = uniqueValues([
    ...issuedBillRows.map((row) => row.id),
    ...paymentRows.map((row) => row.bill_id),
    ...sessionActivityRows.map((row) => row.closed_bill_id),
    ...customerTabActivityRows.map((row) => row.closed_bill_id)
  ]);

  const billRows =
    billIds.length > 0
      ? await readMany<BillRow>(
          client
            .from("bills")
            .select(BILL_SELECT_COLUMNS)
            .eq("organization_id", organizationId)
            .in("id", billIds),
          "loading normalized report bill details"
        )
      : [];
  const sessionIds = uniqueValues(billRows.map((row) => row.session_id));

  const [billLineRows, billDiscountRows, billLineDiscountRows, billSessionRows, billCustomerTabRows] = await Promise.all([
    billIds.length > 0
      ? readMany<BillLineRow>(
          client
            .from("bill_lines")
            .select(BILL_LINE_SELECT_COLUMNS)
            .eq("organization_id", organizationId)
            .in("bill_id", billIds),
          "loading normalized report bill lines"
        )
      : Promise.resolve([]),
    billIds.length > 0
      ? readMany<BillDiscountRow>(
          client
            .from("bill_discounts")
            .select(BILL_DISCOUNT_SELECT_COLUMNS)
            .eq("organization_id", organizationId)
            .in("bill_id", billIds),
          "loading normalized report bill discounts"
        )
      : Promise.resolve([]),
    billIds.length > 0
      ? readMany<BillLineDiscountRow>(
          client
            .from("bill_line_discounts")
            .select(BILL_LINE_DISCOUNT_SELECT_COLUMNS)
            .eq("organization_id", organizationId)
            .in("bill_id", billIds),
          "loading normalized report line discounts"
        )
      : Promise.resolve([]),
    loadRowsByIds<SessionActivityRow>(
      client,
      "sessions",
      "id, started_at, closed_bill_id",
      organizationId,
      sessionIds,
      "loading normalized report linked sessions"
    ),
    billIds.length > 0
      ? readMany<CustomerTabActivityRow>(
          client
            .from("customer_tabs")
            .select("id, opened_at, closed_bill_id")
            .eq("organization_id", organizationId)
            .in("closed_bill_id", billIds),
          "loading normalized report linked customer tabs"
        )
      : Promise.resolve([])
  ]);

  return buildNormalizedReportData({
    billRows,
    paymentRows,
    billLineRows,
    billDiscountRows,
    billLineDiscountRows,
    sessionRows: [...sessionActivityRows, ...billSessionRows],
    customerTabRows: [...customerTabActivityRows, ...billCustomerTabRows],
    expenseRows
  });
}
