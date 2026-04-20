import type {
  AppData,
  BillLine,
  Customer,
  CustomerTabItem,
  DraftBillLine,
  DraftDiscountInput,
  DraftLineDiscountMap,
  ExpenseTemplate,
  ExpenseTemplateOverride,
  ReportFilterState,
  Session,
  SessionChargeSummary
} from "./types";

export function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function currency(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(value);
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatMinutes(minutes: number): string {
  const safeMinutes = Math.max(0, minutes);
  const wholeHours = Math.floor(safeMinutes / 60);
  const remainingMinutes = Math.round(safeMinutes % 60);

  if (wholeHours === 0) {
    return `${remainingMinutes} min`;
  }

  if (remainingMinutes === 0) {
    return `${wholeHours} hr`;
  }

  return `${wholeHours} hr ${remainingMinutes} min`;
}

export function clampNumber(value: number, min = 0): number {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.max(min, value);
}

export function toMinuteOfDay(timeValue: string): number {
  const [hoursText, minutesText] = timeValue.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  return hours * 60 + minutes;
}

export function minuteToTimeLabel(value: number): string {
  const normalized = ((value % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor(normalized % 60)
    .toString()
    .padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function sumBy<T>(values: T[], getter: (value: T) => number): number {
  return values.reduce((total, value) => total + getter(value), 0);
}

/** Hour at which a new business day starts (7 = 7:00 AM). */
export const BUSINESS_DAY_START_HOUR = 7;

/**
 * Returns the business-day date key (YYYY-MM-DD) for a timestamp.
 * Events before 7:00 AM belong to the previous calendar day's business day.
 * e.g. 3:00 AM Apr 20 → "2025-04-19"
 */
export function toBusinessDayKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const adjusted = date.getHours() < BUSINESS_DAY_START_HOUR
    ? addDays(date, -1)
    : date;
  return toLocalDateKey(adjusted);
}

export function isToday(value: string): boolean {
  return toBusinessDayKey(value) === toBusinessDayKey(new Date());
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getDiscountAmount(subtotal: number, discount?: DraftDiscountInput): number {
  if (!discount || discount.value <= 0) {
    return 0;
  }
  if (discount.type === "amount") {
    return Math.min(subtotal, discount.value);
  }
  return Math.min(subtotal, (subtotal * discount.value) / 100);
}

export function getSessionCheckoutLines(session: Session, chargeSummary: SessionChargeSummary): DraftBillLine[] {
  const lines: DraftBillLine[] = [];
  if (session.mode === "timed") {
    lines.push({
      id: `line-session-${session.id}`,
      type: "session_charge",
      description: `${session.stationNameSnapshot} session (${formatMinutes(chargeSummary.billedMinutes)})`,
      quantity: 1,
      unitPrice: chargeSummary.subtotal,
      linkedSessionId: session.id
    });
  }
  for (const item of session.items) {
    lines.push({
      id: `line-item-${item.id}`,
      type: "inventory_item",
      description: item.soldAsPackOf ? `${item.name} (Pack of ${item.soldAsPackOf})` : item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      inventoryItemId: item.inventoryItemId,
      soldAsPackOf: item.soldAsPackOf
    });
  }
  return lines;
}

export function getCustomerTabCheckoutLines(items: CustomerTabItem[]): DraftBillLine[] {
  return items.map((item) => ({
    id: item.id,
    type: "inventory_item",
    description: item.soldAsPackOf ? `${item.name} (Pack of ${item.soldAsPackOf})` : item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    inventoryItemId: item.inventoryItemId,
    soldAsPackOf: item.soldAsPackOf
  }));
}

export function cloneBillLinesForReplacement(bill: AppData["bills"][number]): DraftBillLine[] {
  return bill.lines.map((line) => ({
    id: line.id,
    type: line.type,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    linkedSessionId: line.linkedSessionId,
    inventoryItemId: line.inventoryItemId,
    soldAsPackOf: line.soldAsPackOf
  }));
}

export function getInventoryQuantityMap(lines: Array<{ inventoryItemId?: string; quantity: number }>) {
  return lines.reduce<Record<string, number>>((totals, line) => {
    if (!line.inventoryItemId) {
      return totals;
    }
    totals[line.inventoryItemId] = (totals[line.inventoryItemId] ?? 0) + line.quantity;
    return totals;
  }, {});
}

export function buildBillPreview(
  lines: DraftBillLine[],
  lineDiscounts: DraftLineDiscountMap,
  billDiscount?: DraftDiscountInput,
  roundOffEnabled = false
) {
  const processedLines = lines.map((line) => {
    const subtotal = line.quantity * line.unitPrice;
    const discountAmount = getDiscountAmount(subtotal, lineDiscounts[line.id]);
    return {
      id: line.id,
      type: line.type,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      subtotal,
      discountAmount,
      total: subtotal - discountAmount,
      linkedSessionId: line.linkedSessionId,
      inventoryItemId: line.inventoryItemId,
      soldAsPackOf: line.soldAsPackOf
    } satisfies BillLine;
  });
  const subtotal = sumBy(processedLines, (line) => line.subtotal);
  const lineDiscountAmount = sumBy(processedLines, (line) => line.discountAmount);
  const billDiscountAmount = getDiscountAmount(subtotal - lineDiscountAmount, billDiscount);
  const netTotal = subtotal - lineDiscountAmount - billDiscountAmount;
  const roundedTotal = roundOffEnabled ? Math.round(netTotal) : netTotal;
  return {
    processedLines,
    subtotal,
    lineDiscountAmount,
    billDiscountAmount,
    roundOffAmount: roundedTotal - netTotal,
    total: roundedTotal
  };
}

export function toLocalDateKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateTimeInputValue(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function parseDateTimeInputValue(value: string) {
  if (!value.trim()) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString();
}

export function formatAuditValue(value?: string) {
  return value?.trim() ? value.trim() : "blank";
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function getReportRange(filter: ReportFilterState, nowValue: string) {
  const now = new Date(nowValue);
  // Anchor all presets on the current business day, not the calendar day.
  // At 3 AM the business day is still "yesterday" (before the 7 AM cutoff).
  const todayKey = toBusinessDayKey(now);
  const todayDate = new Date(`${todayKey}T12:00:00`);
  const thisMonthStart = toLocalDateKey(startOfMonth(todayDate));
  const thisMonthEnd = toLocalDateKey(endOfMonth(todayDate));
  switch (filter.preset) {
    case "today":
      return { from: todayKey, to: todayKey, label: "Today" };
    case "yesterday": {
      const yesterday = toLocalDateKey(addDays(todayDate, -1));
      return { from: yesterday, to: yesterday, label: "Yesterday" };
    }
    case "last_7_days":
      return { from: toLocalDateKey(addDays(todayDate, -6)), to: todayKey, label: "Last 7 Days" };
    case "this_month":
      return { from: thisMonthStart, to: thisMonthEnd, label: "This Month" };
    case "last_month": {
      const lastMonthAnchor = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1);
      return {
        from: toLocalDateKey(startOfMonth(lastMonthAnchor)),
        to: toLocalDateKey(endOfMonth(lastMonthAnchor)),
        label: "Last Month"
      };
    }
    case "this_year":
      return { from: `${todayDate.getFullYear()}-01-01`, to: `${todayDate.getFullYear()}-12-31`, label: "This Year" };
    case "custom":
    default:
      return {
        from: filter.fromDate ?? todayKey,
        to: filter.toDate ?? filter.fromDate ?? todayKey,
        label:
          filter.fromDate && filter.toDate
            ? `${filter.fromDate} to ${filter.toDate}`
            : "Custom Range"
      };
  }
}

export function getPreviousRange(from: string, to: string) {
  const fromDate = new Date(`${from}T12:00:00`);
  const toDate = new Date(`${to}T12:00:00`);
  const inclusiveDays = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1);
  const previousTo = addDays(fromDate, -1);
  const previousFrom = addDays(previousTo, -(inclusiveDays - 1));
  return {
    from: toLocalDateKey(previousFrom),
    to: toLocalDateKey(previousTo),
    label: inclusiveDays === 1 ? "previous day" : `previous ${inclusiveDays} days`
  };
}

export function getMonthKeysInRange(from: string, to: string) {
  const months: string[] = [];
  const cursor = new Date(`${from}T12:00:00`);
  cursor.setDate(1);
  const end = new Date(`${to}T12:00:00`);
  end.setDate(1);
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${`${cursor.getMonth() + 1}`.padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

export function getDaysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

export function prorateFactor(monthKey: string, from: string, to: string): { factor: number; daysInRange: number; daysInMonth: number } {
  const total = getDaysInMonth(monthKey);
  const [year, month] = monthKey.split("-").map(Number);
  const monthStart = `${monthKey}-01`;
  const monthEndDate = new Date(year, month, 0);
  const monthEnd = `${monthKey}-${String(monthEndDate.getDate()).padStart(2, "0")}`;
  const overlapFrom = from > monthStart ? from : monthStart;
  const overlapTo = to < monthEnd ? to : monthEnd;
  const overlapDays =
    Math.round((new Date(`${overlapTo}T12:00:00`).getTime() - new Date(`${overlapFrom}T12:00:00`).getTime()) / 86400000) + 1;
  const clampedDays = Math.max(0, Math.min(overlapDays, total));
  return { factor: clampedDays / total, daysInRange: clampedDays, daysInMonth: total };
}

export function formatMonthLabel(monthKey: string) {
  return new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" }).format(
    new Date(`${monthKey}-01T12:00:00`)
  );
}

export function resolveEffectiveAmount(
  template: ExpenseTemplate,
  monthKey: string,
  overrides: ExpenseTemplateOverride[]
): number | null {
  if (!template.active) return null;
  if (monthKey < template.startMonth) return null;
  const override = overrides.find((o) => o.templateId === template.id && o.monthKey === monthKey);
  if (override) return override.amount;
  return template.amount;
}

export function getMonthKeysForYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

export function formatBillNumber(appData: AppData, issuedAt: string): string {
  const businessDate = toBusinessDayKey(issuedAt);
  const dayKey = businessDate.replace(/-/g, "");
  const sequence = appData.bills.filter((bill) => bill.billNumber.startsWith(`BILL-${dayKey}`)).length + 1;
  return `BILL-${dayKey}-${`${sequence}`.padStart(3, "0")}`;
}

export function addAuditLog(
  appData: AppData,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  message: string
) {
  appData.auditLogs.unshift({
    id: createId("audit"),
    action,
    entityType,
    entityId,
    message,
    createdAt: new Date().toISOString(),
    userId
  });
}

export function normalizeCustomerName(value?: string) {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

export function normalizeCustomerPhone(value?: string) {
  const digits = value?.replace(/[^\d+]/g, "").trim() ?? "";
  return digits.replace(/(?!^)\+/g, "");
}

export function getCustomerDisplayName(name?: string, phone?: string) {
  return name?.trim() || phone?.trim() || "Walk-in";
}

export function findCustomerProfileMatch(appData: AppData, customerName?: string, customerPhone?: string) {
  const normalizedPhone = normalizeCustomerPhone(customerPhone);
  const normalizedName = normalizeCustomerName(customerName);
  if (normalizedPhone) {
    return appData.customers.find((customer) => normalizeCustomerPhone(customer.phone) === normalizedPhone);
  }
  if (!normalizedName) {
    return undefined;
  }
  return appData.customers.find(
    (customer) =>
      !normalizeCustomerPhone(customer.phone) &&
      normalizeCustomerName(customer.name) === normalizedName
  );
}

export function resolveCustomerProfile(
  appData: AppData,
  customerName?: string,
  customerPhone?: string,
  visitAt = new Date().toISOString()
) {
  const trimmedName = customerName?.trim() ?? "";
  const trimmedPhone = customerPhone?.trim() ?? "";
  if (!trimmedName && !trimmedPhone) {
    return undefined;
  }
  const existing = findCustomerProfileMatch(appData, trimmedName, trimmedPhone);
  if (existing) {
    existing.name = getCustomerDisplayName(trimmedName, trimmedPhone);
    existing.phone = trimmedPhone || existing.phone;
    existing.createdAt = existing.createdAt || existing.lastVisitAt || visitAt;
    existing.lastVisitAt = visitAt;
    return existing.id;
  }
  const customerId = createId("customer");
  appData.customers.unshift({
    id: customerId,
    name: getCustomerDisplayName(trimmedName, trimmedPhone),
    phone: trimmedPhone || undefined,
    createdAt: visitAt,
    lastVisitAt: visitAt
  });
  return customerId;
}

export function normalizeAppDataCustomers(source: AppData) {
  const appData = cloneValue(source);
  const normalizedCustomers: Customer[] = [];
  const customerIdMap = new Map<string, string>();

  function upsertNormalizedCustomer(rawCustomer: Customer) {
    const createdAt = rawCustomer.createdAt || rawCustomer.lastVisitAt || new Date().toISOString();
    const lastVisitAt = rawCustomer.lastVisitAt || createdAt;
    const name = getCustomerDisplayName(rawCustomer.name, rawCustomer.phone);
    const match = findCustomerProfileMatch(
      { ...appData, customers: normalizedCustomers },
      name,
      rawCustomer.phone
    );
    if (match) {
      match.name = getCustomerDisplayName(name, rawCustomer.phone);
      match.phone = rawCustomer.phone?.trim() || match.phone;
      if (new Date(lastVisitAt).getTime() > new Date(match.lastVisitAt).getTime()) {
        match.lastVisitAt = lastVisitAt;
      }
      if (!match.createdAt || new Date(createdAt).getTime() < new Date(match.createdAt).getTime()) {
        match.createdAt = createdAt;
      }
      customerIdMap.set(rawCustomer.id, match.id);
      return match.id;
    }
    const normalizedCustomer: Customer = {
      id: rawCustomer.id || createId("customer"),
      name,
      phone: rawCustomer.phone?.trim() || undefined,
      createdAt,
      lastVisitAt,
      notes: rawCustomer.notes
    };
    normalizedCustomers.push(normalizedCustomer);
    customerIdMap.set(rawCustomer.id, normalizedCustomer.id);
    return normalizedCustomer.id;
  }

  for (const customer of appData.customers) {
    upsertNormalizedCustomer(customer);
  }

  function resolveHistoricalCustomer(customerId: string | undefined, customerName?: string, customerPhone?: string, fallbackVisitAt?: string) {
    if (customerId && customerIdMap.has(customerId)) {
      return customerIdMap.get(customerId);
    }
    return resolveCustomerProfile(
      { ...appData, customers: normalizedCustomers },
      customerName,
      customerPhone,
      fallbackVisitAt ?? new Date().toISOString()
    );
  }

  appData.sessions = appData.sessions.map((session) => ({
    ...session,
    customerId: resolveHistoricalCustomer(session.customerId, session.customerName, session.customerPhone, session.startedAt)
  }));
  appData.customerTabs = appData.customerTabs.map((tab) => ({
    ...tab,
    customerId: resolveHistoricalCustomer(tab.customerId, tab.customerName, tab.customerPhone, tab.createdAt)
  }));
  appData.bills = appData.bills.map((bill) => ({
    ...bill,
    customerId: resolveHistoricalCustomer(bill.customerId, bill.customerName, bill.customerPhone, bill.issuedAt)
  }));
  appData.customers = normalizedCustomers.sort(
    (left, right) => new Date(right.lastVisitAt).getTime() - new Date(left.lastVisitAt).getTime()
  );
  return appData;
}
