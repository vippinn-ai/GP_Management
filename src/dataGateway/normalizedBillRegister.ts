import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import { addDays, getPendingBillsForCustomer } from "../utils";
import type {
  AppliedDiscount,
  Bill,
  BillLine,
  BillPaymentMode,
  BillStatus,
  DiscountType,
  LineType,
  Payment,
  PaymentMode
} from "../types";

const BILL_REGISTER_READ_TIMEOUT_MS = 15_000;
const DEFAULT_BILL_REGISTER_PAGE_SIZE = 50;
const MAX_BILL_REGISTER_PAGE_SIZE = 200;
const PENDING_BILLS_PAGE_SIZE = 1_000;

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

interface NormalizedQueryResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
}

export interface NormalizedBillRegisterCursor {
  issuedAt: string;
  id: string;
}

export interface NormalizedBillRegisterQuery {
  organizationId?: string;
  limit?: number;
  cursor?: NormalizedBillRegisterCursor;
  status?: BillStatus;
  paymentMode?: BillPaymentMode;
  stationId?: string;
  customerTabOnly?: boolean;
  search?: string;
  businessDateFrom?: string;
  businessDateTo?: string;
}

export interface NormalizedBillRegisterPage {
  bills: Bill[];
  payments: Payment[];
  nextCursor?: NormalizedBillRegisterCursor;
  hasMore: boolean;
}

export interface NormalizedBillPatchQuery {
  organizationId?: string;
  billIds?: string[];
  paymentIds?: string[];
}

export interface NormalizedPendingBillsQuery {
  organizationId?: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
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

interface OrganizationIdRow {
  id: string;
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

function toBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return fallback;
}

function clampPageSize(value?: number): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_BILL_REGISTER_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_BILL_REGISTER_PAGE_SIZE, Math.floor(value)));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

async function withBillRegisterReadTimeout<T>(request: PromiseLike<T>, action: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Unable to reach normalized bill register data while ${action}.`));
    }, BILL_REGISTER_READ_TIMEOUT_MS);
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
  const result = await withBillRegisterReadTimeout(request, action);
  if (result.error) {
    throw result.error;
  }
  return result.data ?? [];
}

async function readSingle<T>(request: PromiseLike<NormalizedQueryResult<T>>, action: string): Promise<T> {
  const result = await withBillRegisterReadTimeout(request, action);
  if (result.error) {
    throw result.error;
  }
  if (result.data === null) {
    throw new Error(`Normalized bill register data was unavailable while ${action}.`);
  }
  return result.data;
}

export async function resolveNormalizedBillRegisterOrganizationId(client: SupabaseClient = getSupabaseClient()): Promise<string> {
  const row = await readSingle<OrganizationIdRow>(
    client
      .from("organizations")
      .select("id")
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    "resolving the active organization"
  );
  return row.id;
}

function groupBy<T>(values: T[], getKey: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  values.forEach((value) => {
    const key = getKey(value);
    const existing = grouped.get(key) ?? [];
    existing.push(value);
    grouped.set(key, existing);
  });
  return grouped;
}

export function buildBillRegisterSearchFilter(search?: string): string | undefined {
  const normalized = search?.trim().replace(/[,%()]/g, " ").replace(/\s+/g, "%");
  if (!normalized) {
    return undefined;
  }
  return [
    `bill_number.ilike.%${normalized}%`,
    `customer_name.ilike.%${normalized}%`,
    `customer_phone.ilike.%${normalized}%`
  ].join(",");
}

export function buildBillRegisterCursorFilter(cursor?: NormalizedBillRegisterCursor): string | undefined {
  if (!cursor) {
    return undefined;
  }
  return `issued_at.lt.${cursor.issuedAt},and(issued_at.eq.${cursor.issuedAt},id.lt.${cursor.id})`;
}

export function getBusinessDayIssuedAtRange(from?: string, to?: string): { fromIso?: string; toIsoExclusive?: string } {
  if (!from && !to) {
    return {};
  }
  const fromKey = from || to;
  const toKey = to || from;
  if (!fromKey || !toKey) {
    return {};
  }
  const start = new Date(`${fromKey}T07:00:00`);
  const endAnchor = addDays(new Date(`${toKey}T07:00:00`), 1);
  return {
    fromIso: start.toISOString(),
    toIsoExclusive: endAnchor.toISOString()
  };
}

export function mapNormalizedBillLine(row: BillLineRow): BillLine {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    type: toStringValue(raw.type, row.type) as LineType,
    description: row.description,
    quantity: toNumberValue(raw.quantity, row.quantity),
    unitPrice: toNumberValue(raw.unitPrice, row.unit_price),
    subtotal: toNumberValue(raw.subtotal, row.subtotal),
    discountAmount: toNumberValue(raw.discountAmount, row.discount_amount),
    total: toNumberValue(raw.total, row.total),
    linkedSessionId: toOptionalString(raw.linkedSessionId) ?? toOptionalString(row.linked_session_id),
    inventoryItemId: toOptionalString(raw.inventoryItemId) ?? toOptionalString(row.inventory_item_id),
    soldAsPackOf:
      raw.soldAsPackOf !== undefined || row.sold_as_pack_of !== null
        ? toNumberValue(raw.soldAsPackOf, row.sold_as_pack_of)
        : undefined,
    saleVariantId: toOptionalString(raw.saleVariantId) ?? toOptionalString(row.sale_variant_id),
    stockUnitsPerSale:
      raw.stockUnitsPerSale !== undefined || row.stock_units_per_sale !== null
        ? toNumberValue(raw.stockUnitsPerSale, row.stock_units_per_sale)
        : undefined,
    comboApplicationId: toOptionalString(raw.comboApplicationId) ?? toOptionalString(row.combo_application_id),
    comboId: toOptionalString(raw.comboId) ?? toOptionalString(row.combo_id)
  };
}

export function mapNormalizedBillDiscount(row: BillDiscountRow, scope: "bill"): AppliedDiscount;
export function mapNormalizedBillDiscount(row: BillLineDiscountRow, scope: "line"): AppliedDiscount;
export function mapNormalizedBillDiscount(row: BillDiscountRow | BillLineDiscountRow, scope: "bill" | "line"): AppliedDiscount {
  const raw = toRecord(row.raw_data);
  const targetId = scope === "bill" ? row.bill_id : ((row as BillLineDiscountRow).target_id ?? "");
  return {
    id: row.id,
    scope,
    targetId: toStringValue(raw.targetId, targetId),
    type: toStringValue(raw.type, row.discount_type ?? "amount") as DiscountType,
    value: toNumberValue(raw.value, row.value),
    amount: toNumberValue(raw.amount, row.amount),
    reason: toStringValue(raw.reason, row.reason ?? ""),
    appliedByUserId: toStringValue(raw.appliedByUserId, row.applied_by_user_id ?? ""),
    appliedAt: toStringValue(raw.appliedAt, row.applied_at ?? "")
  };
}

export function mapNormalizedBill(row: BillRow, params: {
  lines?: BillLine[];
  lineDiscounts?: AppliedDiscount[];
  billDiscount?: AppliedDiscount;
} = {}): Bill {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    billNumber: row.bill_number,
    status: toStringValue(raw.status, row.status) as BillStatus,
    createdAt: toStringValue(raw.createdAt, row.created_at_source ?? row.issued_at ?? ""),
    issuedAt: toStringValue(raw.issuedAt, row.issued_at ?? row.created_at_source ?? ""),
    issuedByUserId: toStringValue(raw.issuedByUserId, row.issued_by_user_id ?? ""),
    customerId: toOptionalString(raw.customerId) ?? toOptionalString(row.customer_id),
    customerName: toOptionalString(raw.customerName) ?? toOptionalString(row.customer_name),
    customerPhone: toOptionalString(raw.customerPhone) ?? toOptionalString(row.customer_phone),
    paymentMode: toStringValue(raw.paymentMode, row.payment_mode ?? "cash") as BillPaymentMode,
    stationId: toOptionalString(raw.stationId) ?? toOptionalString(row.station_id),
    sessionId: toOptionalString(raw.sessionId) ?? toOptionalString(row.session_id),
    amountPaid: toNumberValue(raw.amountPaid, row.amount_paid),
    amountDue: toNumberValue(raw.amountDue, row.amount_due),
    subtotal: toNumberValue(raw.subtotal, row.subtotal),
    totalDiscountAmount: toNumberValue(raw.totalDiscountAmount, row.total_discount_amount),
    billDiscountAmount: toNumberValue(raw.billDiscountAmount, row.bill_discount_amount),
    roundOffEnabled: toBooleanValue(raw.roundOffEnabled, row.round_off_enabled),
    roundOffAmount: toNumberValue(raw.roundOffAmount, row.round_off_amount),
    total: toNumberValue(raw.total, row.total),
    lineDiscounts: params.lineDiscounts ?? [],
    billDiscount: params.billDiscount,
    lines: params.lines ?? [],
    receiptType: "digital",
    replacementOfBillId: toOptionalString(raw.replacementOfBillId) ?? toOptionalString(row.replacement_of_bill_id),
    replacedByBillId: toOptionalString(raw.replacedByBillId) ?? toOptionalString(row.replaced_by_bill_id),
    replacedAt: toOptionalString(raw.replacedAt) ?? toOptionalString(row.replaced_at),
    replacedByUserId: toOptionalString(raw.replacedByUserId) ?? toOptionalString(row.replaced_by_user_id),
    replaceReason: toOptionalString(raw.replaceReason) ?? toOptionalString(row.replace_reason),
    voidedAt: toOptionalString(raw.voidedAt) ?? toOptionalString(row.voided_at),
    voidedByUserId: toOptionalString(raw.voidedByUserId) ?? toOptionalString(row.voided_by_user_id),
    voidReason: toOptionalString(raw.voidReason) ?? toOptionalString(row.void_reason),
    settledAt: toOptionalString(raw.settledAt) ?? toOptionalString(row.settled_at),
    settledByUserId: toOptionalString(raw.settledByUserId) ?? toOptionalString(row.settled_by_user_id)
  };
}

export function mapNormalizedPayment(row: PaymentRow): Payment {
  const raw = toRecord(row.raw_data);
  return {
    id: row.id,
    billId: toStringValue(raw.billId, row.bill_id ?? ""),
    mode: toStringValue(raw.mode, row.mode) as PaymentMode,
    amount: toNumberValue(raw.amount, row.amount),
    createdAt: toStringValue(raw.createdAt, row.paid_at ?? ""),
    receivedByUserId: toStringValue(raw.receivedByUserId, row.received_by_user_id ?? ""),
    settlementGroupId: toOptionalString(raw.settlementGroupId) ?? toOptionalString(row.settlement_group_id),
    relatedCheckoutBillId: toOptionalString(raw.relatedCheckoutBillId) ?? toOptionalString(row.related_checkout_bill_id)
  };
}

export function buildNormalizedBillRegisterPage(params: {
  billRows: BillRow[];
  lineRows?: BillLineRow[];
  billDiscountRows?: BillDiscountRow[];
  lineDiscountRows?: BillLineDiscountRow[];
  paymentRows?: PaymentRow[];
  pageSize: number;
}): NormalizedBillRegisterPage {
  const pageRows = params.billRows.slice(0, params.pageSize);
  const hasMore = params.billRows.length > params.pageSize;
  const lineRowsByBillId = groupBy(params.lineRows ?? [], (row) => row.bill_id);
  const lineDiscountRowsByBillId = groupBy(params.lineDiscountRows ?? [], (row) => row.bill_id);
  const billDiscountRowsByBillId = groupBy(params.billDiscountRows ?? [], (row) => row.bill_id);
  const payments = (params.paymentRows ?? []).map(mapNormalizedPayment);
  const bills = pageRows.map((row) =>
    mapNormalizedBill(row, {
      lines: (lineRowsByBillId.get(row.id) ?? []).map(mapNormalizedBillLine),
      lineDiscounts: (lineDiscountRowsByBillId.get(row.id) ?? []).map((discountRow) =>
        mapNormalizedBillDiscount(discountRow, "line")
      ),
      billDiscount: billDiscountRowsByBillId.get(row.id)?.[0]
        ? mapNormalizedBillDiscount(billDiscountRowsByBillId.get(row.id)![0], "bill")
        : undefined
    })
  );
  const lastRow = pageRows[pageRows.length - 1];

  return {
    bills,
    payments,
    hasMore,
    nextCursor:
      hasMore && lastRow?.issued_at
        ? {
            issuedAt: lastRow.issued_at,
            id: lastRow.id
          }
        : undefined
  };
}

export async function loadNormalizedBillRegisterPage(
  query: NormalizedBillRegisterQuery,
  client: SupabaseClient = getSupabaseClient()
): Promise<NormalizedBillRegisterPage> {
  const organizationId = query.organizationId ?? (await resolveNormalizedBillRegisterOrganizationId(client));
  const pageSize = clampPageSize(query.limit);
  const dateRange = getBusinessDayIssuedAtRange(query.businessDateFrom, query.businessDateTo);
  let billQuery = client
    .from("bills")
    .select(BILL_SELECT_COLUMNS)
    .eq("organization_id", organizationId)
    .not("issued_at", "is", null)
    .order("issued_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);

  if (query.status) {
    billQuery = billQuery.eq("status", query.status);
  }
  if (query.paymentMode) {
    billQuery = billQuery.eq("payment_mode", query.paymentMode);
  }
  if (query.customerTabOnly) {
    billQuery = billQuery.is("station_id", null);
  } else if (query.stationId) {
    billQuery = billQuery.eq("station_id", query.stationId);
  }
  if (dateRange.fromIso) {
    billQuery = billQuery.gte("issued_at", dateRange.fromIso);
  }
  if (dateRange.toIsoExclusive) {
    billQuery = billQuery.lt("issued_at", dateRange.toIsoExclusive);
  }

  const searchFilter = buildBillRegisterSearchFilter(query.search);
  if (searchFilter) {
    billQuery = billQuery.or(searchFilter);
  }
  const cursorFilter = buildBillRegisterCursorFilter(query.cursor);
  if (cursorFilter) {
    billQuery = billQuery.or(cursorFilter);
  }

  const billRows = await readMany<BillRow>(billQuery, "loading paginated bills");
  const pageRows = billRows.slice(0, pageSize);
  const billIds = pageRows.map((row) => row.id);

  if (billIds.length === 0) {
    return buildNormalizedBillRegisterPage({ billRows, pageSize });
  }

  const [lineRows, billDiscountRows, lineDiscountRows, paymentRows] = await Promise.all([
    readMany<BillLineRow>(
      client
        .from("bill_lines")
        .select(BILL_LINE_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("bill_id", billIds)
        .order("created_at", { ascending: true }),
      "loading bill lines"
    ),
    readMany<BillDiscountRow>(
      client
        .from("bill_discounts")
        .select(BILL_DISCOUNT_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("bill_id", billIds)
        .order("created_at", { ascending: true }),
      "loading bill discounts"
    ),
    readMany<BillLineDiscountRow>(
      client
        .from("bill_line_discounts")
        .select(BILL_LINE_DISCOUNT_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("bill_id", billIds)
        .order("created_at", { ascending: true }),
      "loading bill line discounts"
    ),
    readMany<PaymentRow>(
      client
        .from("payments")
        .select(PAYMENT_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("bill_id", billIds)
        .order("paid_at", { ascending: true }),
      "loading bill payments"
    )
  ]);

  return buildNormalizedBillRegisterPage({
    billRows,
    lineRows,
    billDiscountRows,
    lineDiscountRows,
    paymentRows,
    pageSize
  });
}

export async function loadNormalizedPendingBills(
  query: NormalizedPendingBillsQuery = {},
  client: SupabaseClient = getSupabaseClient()
): Promise<Bill[]> {
  const organizationId = query.organizationId ?? (await resolveNormalizedBillRegisterOrganizationId(client));
  let billRows: BillRow[] = [];
  let offset = 0;
  while (true) {
    const pageRows = await readMany<BillRow>(
      client
        .from("bills")
        .select(BILL_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .eq("status", "pending")
        .gt("amount_due", 0)
        .order("issued_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + PENDING_BILLS_PAGE_SIZE - 1),
      "loading pending bill summaries"
    );
    billRows = [...billRows, ...pageRows];
    if (pageRows.length < PENDING_BILLS_PAGE_SIZE) {
      break;
    }
    offset += PENDING_BILLS_PAGE_SIZE;
  }
  const pendingBills = billRows.map((row) => mapNormalizedBill(row));
  if (query.customerId || query.customerName || query.customerPhone) {
    return getPendingBillsForCustomer(pendingBills, query.customerId, query.customerName, query.customerPhone);
  }
  return pendingBills;
}

export async function loadNormalizedBillsByIds(
  query: NormalizedBillPatchQuery,
  client: SupabaseClient = getSupabaseClient()
): Promise<Pick<NormalizedBillRegisterPage, "bills" | "payments">> {
  const organizationId = query.organizationId ?? (await resolveNormalizedBillRegisterOrganizationId(client));
  const requestedBillIds = uniqueStrings(query.billIds ?? []);
  const requestedPaymentIds = uniqueStrings(query.paymentIds ?? []);

  const directPaymentRows =
    requestedPaymentIds.length > 0
      ? await readMany<PaymentRow>(
          client
            .from("payments")
            .select(PAYMENT_SELECT_COLUMNS)
            .eq("organization_id", organizationId)
            .in("id", requestedPaymentIds)
            .order("paid_at", { ascending: true }),
          "loading changed payments"
        )
      : [];
  const billIds = uniqueStrings([...requestedBillIds, ...directPaymentRows.map((payment) => payment.bill_id)]);

  if (billIds.length === 0) {
    return {
      bills: [],
      payments: directPaymentRows.map(mapNormalizedPayment)
    };
  }

  const [billRows, lineRows, billDiscountRows, lineDiscountRows, relatedPaymentRows] = await Promise.all([
    readMany<BillRow>(
      client
        .from("bills")
        .select(BILL_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("id", billIds)
        .order("issued_at", { ascending: false })
        .order("id", { ascending: false }),
      "loading changed bills"
    ),
    readMany<BillLineRow>(
      client
        .from("bill_lines")
        .select(BILL_LINE_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("bill_id", billIds)
        .order("created_at", { ascending: true }),
      "loading changed bill lines"
    ),
    readMany<BillDiscountRow>(
      client
        .from("bill_discounts")
        .select(BILL_DISCOUNT_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("bill_id", billIds)
        .order("created_at", { ascending: true }),
      "loading changed bill discounts"
    ),
    readMany<BillLineDiscountRow>(
      client
        .from("bill_line_discounts")
        .select(BILL_LINE_DISCOUNT_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("bill_id", billIds)
        .order("created_at", { ascending: true }),
      "loading changed bill line discounts"
    ),
    readMany<PaymentRow>(
      client
        .from("payments")
        .select(PAYMENT_SELECT_COLUMNS)
        .eq("organization_id", organizationId)
        .in("bill_id", billIds)
        .order("paid_at", { ascending: true }),
      "loading changed bill payments"
    )
  ]);

  const paymentRowsById = new Map<string, PaymentRow>();
  [...relatedPaymentRows, ...directPaymentRows].forEach((payment) => paymentRowsById.set(payment.id, payment));
  const page = buildNormalizedBillRegisterPage({
    billRows,
    lineRows,
    billDiscountRows,
    lineDiscountRows,
    paymentRows: Array.from(paymentRowsById.values()),
    pageSize: Math.max(1, billRows.length)
  });
  return {
    bills: page.bills,
    payments: page.payments
  };
}
