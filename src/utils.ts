import type {
  AppData,
  Bill,
  BillLine,
  Customer,
  CustomerTab,
  CustomerTabItem,
  DraftBillLine,
  DraftDiscountInput,
  DraftLineDiscountMap,
  ComboAppliedChoice,
  ComboInventorySelection,
  ComboPackage,
  Expense,
  ExpenseTemplate,
  ExpenseTemplateOverride,
  InventoryReportFilterState,
  InventoryReportModel,
  InventoryReportMovementDetail,
  InventoryReportRow,
  InventoryItem,
  Payment,
  PendingReceivableGroup,
  ReportFilterState,
  SellableInventoryOption,
  Session,
  SessionChargeSummary,
  StockMovement,
  StockMovementType
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

export function getStockUnitsPerSale(line: { soldAsPackOf?: number; stockUnitsPerSale?: number }) {
  return line.stockUnitsPerSale ?? line.soldAsPackOf ?? 1;
}

export function getLineStockQuantity(line: { quantity: number; soldAsPackOf?: number; stockUnitsPerSale?: number }) {
  return line.quantity * getStockUnitsPerSale(line);
}

export function getActiveInventoryItems(inventoryItems: InventoryItem[]): InventoryItem[] {
  return inventoryItems.filter((item) => item.active);
}

export function getArchivedInventoryItems(inventoryItems: InventoryItem[]): InventoryItem[] {
  return inventoryItems.filter((item) => !item.active);
}

export function getInventoryItemOpenUsage(
  itemId: string,
  sessions: Session[],
  customerTabs: CustomerTab[]
) {
  const sessionMatches = sessions
    .filter((session) => session.status !== "closed")
    .map((session) => ({
      label: session.stationNameSnapshot,
      quantity: sumBy(
        session.items.filter((item) => item.inventoryItemId === itemId),
        (item) => getLineStockQuantity(item)
      )
    }))
    .filter((entry) => entry.quantity > 0);
  const tabMatches = customerTabs
    .filter((tab) => tab.status === "open")
    .map((tab) => ({
      label: tab.customerName,
      quantity: sumBy(
        tab.items.filter((item) => item.inventoryItemId === itemId),
        (item) => getLineStockQuantity(item)
      )
    }))
    .filter((entry) => entry.quantity > 0);

  return {
    sessionMatches,
    tabMatches,
    totalQuantity: sumBy(sessionMatches, (entry) => entry.quantity) + sumBy(tabMatches, (entry) => entry.quantity)
  };
}

export function getInventoryReportRange(filter: InventoryReportFilterState, nowValue: string) {
  const todayKey = toBusinessDayKey(new Date(nowValue));
  const todayDate = new Date(`${todayKey}T12:00:00`);
  switch (filter.preset) {
    case "today":
      return { from: todayKey, to: todayKey, label: "Today" };
    case "yesterday": {
      const yesterday = toLocalDateKey(addDays(todayDate, -1));
      return { from: yesterday, to: yesterday, label: "Yesterday" };
    }
    case "last_7_days":
      return { from: toLocalDateKey(addDays(todayDate, -6)), to: todayKey, label: "Last 7 Days" };
    case "last_30_days":
      return { from: toLocalDateKey(addDays(todayDate, -29)), to: todayKey, label: "Last 1 Month" };
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

function createInventoryReportRow(item: InventoryItem): InventoryReportRow {
  return {
    itemId: item.id,
    itemName: item.name,
    category: item.category,
    active: item.active,
    added: 0,
    deducted: 0,
    manualAdjustments: 0,
    reversals: 0,
    netChange: 0,
    currentStock: item.stockQty,
    reserved: 0,
    movementCount: 0
  };
}

function addInventoryMovementToReportRow(
  row: InventoryReportRow,
  movement: Pick<StockMovement, "type" | "quantity">
) {
  const absoluteQuantity = Math.abs(movement.quantity);

  switch (movement.type) {
    case "restock":
      row.added += Math.max(0, movement.quantity);
      row.netChange += movement.quantity;
      break;
    case "sale":
      row.deducted += absoluteQuantity;
      row.netChange += movement.quantity;
      break;
    case "adjustment":
      row.manualAdjustments += movement.quantity;
      row.netChange += movement.quantity;
      break;
    case "void_refund_reversal":
      row.reversals += Math.max(0, movement.quantity);
      row.netChange += movement.quantity;
      break;
    case "session_reservation":
    case "session_reservation_void":
      break;
  }
}

function createInventoryReportRowFromExisting(row: InventoryReportRow): InventoryReportRow {
  return {
    itemId: row.itemId,
    itemName: row.itemName,
    category: row.category,
    active: row.active,
    added: 0,
    deducted: 0,
    manualAdjustments: 0,
    reversals: 0,
    netChange: 0,
    currentStock: row.currentStock,
    reserved: 0,
    movementCount: 0
  };
}

function getInventoryMovementTypeLabel(type: StockMovementType) {
  switch (type) {
    case "restock":
      return "Restock";
    case "sale":
      return "Sale";
    case "adjustment":
      return "Adjustment";
    case "void_refund_reversal":
      return "Void/Refund Restore";
    case "session_reservation":
      return "Session Reserved";
    case "session_reservation_void":
      return "Reservation Released";
  }
}

function inventoryReportTextMatches(values: Array<string | undefined>, query: string) {
  return values.some((value) => (value ?? "").toLowerCase().includes(query));
}

export function filterInventoryReportModel(
  report: InventoryReportModel,
  search: string
): InventoryReportModel {
  const query = search.trim().toLowerCase();
  if (!query) {
    return report;
  }

  const baseRowsByItemId = new Map(report.rows.map((row) => [row.itemId, row]));
  const filteredRowsByItemId = new Map<string, InventoryReportRow>();
  const itemMatchedIds = new Set<string>();

  for (const row of report.rows) {
    if (inventoryReportTextMatches([row.itemName, row.category, row.active ? "active" : "archived"], query)) {
      itemMatchedIds.add(row.itemId);
      filteredRowsByItemId.set(row.itemId, { ...row });
    }
  }

  const details = report.details.filter((detail) => {
    if (itemMatchedIds.has(detail.itemId)) {
      return true;
    }
    return inventoryReportTextMatches(
      [
        detail.itemName,
        detail.category,
        getInventoryMovementTypeLabel(detail.type),
        detail.type,
        detail.reason,
        detail.relatedBillNumber,
        detail.relatedBillId
      ],
      query
    );
  });

  for (const detail of details) {
    if (itemMatchedIds.has(detail.itemId)) {
      continue;
    }
    const baseRow = baseRowsByItemId.get(detail.itemId);
    if (!baseRow) {
      continue;
    }
    const row = filteredRowsByItemId.get(detail.itemId) ?? createInventoryReportRowFromExisting(baseRow);
    addInventoryMovementToReportRow(row, detail);
    row.movementCount += 1;
    filteredRowsByItemId.set(detail.itemId, row);
  }

  const rows = Array.from(filteredRowsByItemId.values()).sort((a, b) => {
    const movementDelta = b.movementCount - a.movementCount;
    if (movementDelta !== 0) return movementDelta;
    return a.itemName.localeCompare(b.itemName);
  });

  return {
    summary: {
      added: sumBy(rows, (row) => row.added),
      deducted: sumBy(rows, (row) => row.deducted),
      manualAdjustments: sumBy(rows, (row) => row.manualAdjustments),
      reversals: sumBy(rows, (row) => row.reversals),
      netChange: sumBy(rows, (row) => row.netChange),
      reserved: sumBy(rows, (row) => row.reserved),
      touchedItems: rows.filter((row) => row.movementCount > 0).length
    },
    rows,
    details,
    detailLimit: report.detailLimit,
    detailsTruncated: report.detailsTruncated,
    payloadBytes: report.payloadBytes
  };
}

export function buildInventoryReportModel(
  inventoryItems: InventoryItem[],
  stockMovements: AppData["stockMovements"],
  sessions: Session[],
  customerTabs: CustomerTab[],
  bills: Bill[],
  fromDate: string,
  toDate: string
): InventoryReportModel {
  const itemById = new Map(inventoryItems.map((item) => [item.id, item]));
  const billById = new Map(bills.map((bill) => [bill.id, bill]));
  const rowsByItemId = new Map<string, InventoryReportRow>();
  const details: InventoryReportMovementDetail[] = [];
  const sortedFromDate = fromDate <= toDate ? fromDate : toDate;
  const sortedToDate = fromDate <= toDate ? toDate : fromDate;

  for (const item of inventoryItems) {
    const usage = getInventoryItemOpenUsage(item.id, sessions, customerTabs);
    if (usage.totalQuantity <= 0) {
      continue;
    }
    const row = rowsByItemId.get(item.id) ?? createInventoryReportRow(item);
    row.reserved = usage.totalQuantity;
    rowsByItemId.set(item.id, row);
  }

  for (const movement of stockMovements) {
    const businessDate = toBusinessDayKey(movement.createdAt);
    if (businessDate < sortedFromDate || businessDate > sortedToDate) {
      continue;
    }
    const item = itemById.get(movement.itemId);
    if (!item) {
      continue;
    }
    const row = rowsByItemId.get(item.id) ?? createInventoryReportRow(item);
    addInventoryMovementToReportRow(row, movement);
    row.movementCount += 1;
    rowsByItemId.set(item.id, row);

    const relatedBill = movement.relatedBillId ? billById.get(movement.relatedBillId) : undefined;
    details.push({
      id: movement.id,
      businessDate,
      createdAt: movement.createdAt,
      itemId: item.id,
      itemName: item.name,
      category: item.category,
      type: movement.type,
      quantity: movement.quantity,
      reason: movement.reason,
      relatedBillId: movement.relatedBillId,
      relatedBillNumber: relatedBill?.billNumber
    });
  }

  const rows = Array.from(rowsByItemId.values())
    .filter((row) => row.movementCount > 0 || row.reserved > 0)
    .sort((a, b) => {
      const movementDelta = b.movementCount - a.movementCount;
      if (movementDelta !== 0) return movementDelta;
      return a.itemName.localeCompare(b.itemName);
    });

  return {
    summary: {
      added: sumBy(rows, (row) => row.added),
      deducted: sumBy(rows, (row) => row.deducted),
      manualAdjustments: sumBy(rows, (row) => row.manualAdjustments),
      reversals: sumBy(rows, (row) => row.reversals),
      netChange: sumBy(rows, (row) => row.netChange),
      reserved: sumBy(rows, (row) => row.reserved),
      touchedItems: rows.filter((row) => row.movementCount > 0).length
    },
    rows,
    details: details.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  };
}

export function getSellableInventoryOptions(inventoryItems: InventoryItem[]): SellableInventoryOption[] {
  return inventoryItems.flatMap((item) => {
    if (!item.active) {
      return [];
    }

    const options: SellableInventoryOption[] = [];
    if (item.sellBaseItem ?? true) {
      options.push({
        id: item.id,
        inventoryItemId: item.id,
        name: item.name,
        sourceName: item.name,
        category: item.category,
        price: item.price,
        barcode: item.barcode,
        sourceBarcode: item.barcode,
        isBaseItem: true,
        stockUnitsPerSale: 1,
        item
      });
    }

    if (!item.isReusable && item.category !== "Cigarettes") {
      for (const variant of item.saleVariants ?? []) {
        if (!variant.active) {
          continue;
        }
        options.push({
          id: `${item.id}::variant::${variant.id}`,
          inventoryItemId: item.id,
          saleVariantId: variant.id,
          name: variant.name,
          sourceName: item.name,
          category: item.category,
          price: variant.price,
          barcode: variant.barcode,
          sourceBarcode: item.barcode,
          isBaseItem: false,
          stockUnitsPerSale: variant.stockUnitsPerSale,
          item
        });
      }
    }

    return options;
  });
}

export function getCombosForStation(combos: ComboPackage[], stationId?: string): ComboPackage[] {
  if (!stationId) {
    return [];
  }
  return combos.filter((combo) => (combo.type ?? "game") === "game" && combo.active && combo.stationIds.includes(stationId));
}

export function getConsumablesCombos(combos: ComboPackage[]): ComboPackage[] {
  return combos.filter((combo) => combo.type === "consumables" && combo.active);
}

export function getComboIncludedMinutes(session: Session): number {
  return sumBy(session.comboApplications ?? [], (combo) => combo.includedMinutes);
}

export function getComboApplicationsTotal(session: Session): number {
  return sumBy(session.comboApplications ?? [], (combo) => combo.price);
}

export function resolveComboInventorySelection(
  sellableOptions: SellableInventoryOption[],
  sellableOptionId: string,
  quantity: number
): ComboInventorySelection | null {
  const option = sellableOptions.find((entry) => entry.id === sellableOptionId);
  if (!option) {
    return null;
  }
  return {
    inventoryItemId: option.inventoryItemId,
    saleVariantId: option.saleVariantId,
    name: option.name,
    sourceName: option.sourceName,
    quantity: Math.max(1, Math.trunc(quantity)),
    unitPrice: option.price,
    stockUnitsPerSale: option.stockUnitsPerSale
  };
}

export function resolveComboFixedSelections(
  combo: ComboPackage,
  sellableOptions: SellableInventoryOption[]
): ComboInventorySelection[] | null {
  const selections: ComboInventorySelection[] = [];
  for (const item of combo.fixedItems) {
    const selection = resolveComboInventorySelection(sellableOptions, item.sellableOptionId, item.quantity);
    if (!selection) {
      return null;
    }
    selections.push(selection);
  }
  return selections;
}

export function resolveComboChoiceSelections(
  combo: ComboPackage,
  sellableOptions: SellableInventoryOption[],
  choices: Record<string, string | string[]> = {}
): ComboAppliedChoice[] | null {
  const selections: ComboAppliedChoice[] = [];
  for (const group of combo.choiceGroups) {
    const requiredQuantity = Math.max(1, Math.trunc(group.requiredQuantity));
    const rawSelectedOptionIds = choices[group.id];
    const selectedOptionIds = Array.isArray(rawSelectedOptionIds)
      ? rawSelectedOptionIds
      : rawSelectedOptionIds
        ? [rawSelectedOptionIds]
        : [];
    if (selectedOptionIds.length < requiredQuantity) {
      return null;
    }
    const aggregatedSelections = new Map<string, ComboInventorySelection>();
    for (const selectedOptionId of selectedOptionIds.slice(0, requiredQuantity)) {
      if (!selectedOptionId || !group.optionIds.includes(selectedOptionId)) {
        return null;
      }
      const selection = resolveComboInventorySelection(sellableOptions, selectedOptionId, 1);
      if (!selection) {
        return null;
      }
      const key = [
        selection.inventoryItemId,
        selection.saleVariantId ?? "",
        selection.name,
        selection.stockUnitsPerSale
      ].join("::");
      const existing = aggregatedSelections.get(key);
      if (existing) {
        existing.quantity += selection.quantity;
      } else {
        aggregatedSelections.set(key, { ...selection });
      }
    }
    selections.push({
      groupId: group.id,
      groupLabel: group.label,
      selections: Array.from(aggregatedSelections.values())
    });
  }
  return selections;
}

export function getComboInventorySelections(combo: { fixedItems: ComboInventorySelection[]; choices: ComboAppliedChoice[] }) {
  return [
    ...combo.fixedItems,
    ...combo.choices.flatMap((choice) => choice.selections ?? (choice.selection ? [choice.selection] : []))
  ];
}

export function getSessionComboCheckoutLines(session: Session): DraftBillLine[] {
  return (session.comboApplications ?? []).flatMap((combo, index) => {
    const packageLine: DraftBillLine = {
      id: `line-combo-${combo.id}`,
      type: "combo_package",
      description: combo.comboName,
      quantity: 1,
      unitPrice: combo.price,
      linkedSessionId: session.id,
      comboApplicationId: combo.id,
      comboId: combo.comboId
    };
    const detailLines: DraftBillLine[] = [
      {
        id: `line-combo-${combo.id}-game`,
        type: "combo_detail",
        description: `${formatMinutes(combo.includedMinutes)} ${session.stationNameSnapshot} play included`,
        quantity: 1,
        unitPrice: 0,
        linkedSessionId: session.id,
        comboApplicationId: combo.id,
        comboId: combo.comboId
      },
      ...getComboInventorySelections(combo).map((item, itemIndex) => ({
        id: `line-combo-${combo.id}-item-${itemIndex}`,
        type: "inventory_item" as const,
        description: `${item.name} (included in ${combo.comboName})`,
        quantity: item.quantity,
        unitPrice: 0,
        linkedSessionId: session.id,
        inventoryItemId: item.inventoryItemId,
        saleVariantId: item.saleVariantId,
        stockUnitsPerSale: item.stockUnitsPerSale,
        comboApplicationId: combo.id,
        comboId: combo.comboId
      }))
    ];
    return index === 0 ? [packageLine, ...detailLines] : [packageLine, ...detailLines];
  });
}

export function getConsumablesComboCheckoutLines(comboApplications: Session["comboApplications"] = []): DraftBillLine[] {
  return comboApplications.flatMap((combo) => {
    const packageLine: DraftBillLine = {
      id: `line-combo-${combo.id}`,
      type: "combo_package",
      description: combo.comboName,
      quantity: 1,
      unitPrice: combo.price,
      comboApplicationId: combo.id,
      comboId: combo.comboId
    };
    const detailLines: DraftBillLine[] = getComboInventorySelections(combo).map((item, itemIndex) => ({
      id: `line-combo-${combo.id}-item-${itemIndex}`,
      type: "inventory_item" as const,
      description: `${item.name} (included in ${combo.comboName})`,
      quantity: item.quantity,
      unitPrice: 0,
      inventoryItemId: item.inventoryItemId,
      saleVariantId: item.saleVariantId,
      stockUnitsPerSale: item.stockUnitsPerSale,
      comboApplicationId: combo.id,
      comboId: combo.comboId
    }));
    return [packageLine, ...detailLines];
  });
}

export function resolveCustomerTabWorkspaceSelection(
  openTabs: CustomerTab[],
  selectedTabId: string | null
): CustomerTab | null {
  if (selectedTabId) {
    return openTabs.find((tab) => tab.id === selectedTabId) ?? null;
  }
  return openTabs.length === 1 ? openTabs[0] : null;
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
  const comboLines = getSessionComboCheckoutLines(session);
  const includedComboMinutes = getComboIncludedMinutes(session);
  const extraMinutes = Math.max(0, chargeSummary.billedMinutes - includedComboMinutes);
  const lines: DraftBillLine[] = [...comboLines];
  if (session.mode === "timed") {
    if (comboLines.length === 0 || extraMinutes > 0) {
      const hourlyRate = chargeSummary.segments[0]?.hourlyRate ?? 0;
      const subtotal = comboLines.length > 0 ? (extraMinutes / 60) * hourlyRate : chargeSummary.subtotal;
      lines.push({
        id: `line-session-${session.id}`,
        type: "session_charge",
        description: comboLines.length > 0
          ? `${session.stationNameSnapshot} extra time (${formatMinutes(extraMinutes)})`
          : `${session.stationNameSnapshot} session (${formatMinutes(chargeSummary.billedMinutes)})`,
        quantity: 1,
        unitPrice: subtotal,
        linkedSessionId: session.id
      });
    }
  }
  for (const item of session.items.filter((entry) => !entry.comboApplicationId)) {
    lines.push({
      id: `line-item-${item.id}`,
      type: "inventory_item",
      description: item.soldAsPackOf ? `${item.name} (Pack of ${item.soldAsPackOf})` : item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      inventoryItemId: item.inventoryItemId,
      soldAsPackOf: item.soldAsPackOf,
      saleVariantId: item.saleVariantId,
      stockUnitsPerSale: item.stockUnitsPerSale,
      comboApplicationId: item.comboApplicationId,
      comboId: item.comboId
    });
  }
  return lines;
}

export function getCustomerTabCheckoutLines(
  items: CustomerTabItem[],
  comboApplications: CustomerTab["comboApplications"] = []
): DraftBillLine[] {
  return [
    ...getConsumablesComboCheckoutLines(comboApplications),
    ...items.filter((item) => !item.comboApplicationId).map((item): DraftBillLine => ({
      id: item.id,
      type: "inventory_item",
      description: item.soldAsPackOf ? `${item.name} (Pack of ${item.soldAsPackOf})` : item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      inventoryItemId: item.inventoryItemId,
      soldAsPackOf: item.soldAsPackOf,
      saleVariantId: item.saleVariantId,
      stockUnitsPerSale: item.stockUnitsPerSale,
      comboApplicationId: item.comboApplicationId,
      comboId: item.comboId
    }))
  ];
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
    soldAsPackOf: line.soldAsPackOf,
    saleVariantId: line.saleVariantId,
    stockUnitsPerSale: line.stockUnitsPerSale,
    comboApplicationId: line.comboApplicationId,
    comboId: line.comboId
  }));
}

export function getInventoryQuantityMap(lines: Array<{ inventoryItemId?: string; quantity: number; soldAsPackOf?: number; stockUnitsPerSale?: number }>) {
  return lines.reduce<Record<string, number>>((totals, line) => {
    if (!line.inventoryItemId) {
      return totals;
    }
    totals[line.inventoryItemId] = (totals[line.inventoryItemId] ?? 0) + getLineStockQuantity(line);
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
      soldAsPackOf: line.soldAsPackOf,
      saleVariantId: line.saleVariantId,
      stockUnitsPerSale: line.stockUnitsPerSale,
      comboApplicationId: line.comboApplicationId,
      comboId: line.comboId
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
    total: roundedTotal,
    isZeroTotal: subtotal <= 0
  };
}

export function getMostRecentHoppedSession(sessions: Session[]): Session | null {
  return [...sessions]
    .filter((s) => s.closeDisposition === "hopped" && !s.closedBillId)
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))[0] ?? null;
}

export function getUnbilledHoppedSessionsForCustomer(
  sessions: Session[],
  name: string,
  phone: string
): Session[] {
  const nameLower = name.trim().toLowerCase();
  const phoneNorm = phone.trim();
  if (!nameLower && !phoneNorm) return [];
  return sessions.filter((session) => {
    if (session.closeDisposition !== "hopped" || session.closedBillId) return false;
    if (phoneNorm) return session.customerPhone?.trim() === phoneNorm;
    return nameLower !== "" && (session.customerName ?? "").trim().toLowerCase() === nameLower;
  });
}

export function getDirectlyLinkedHoppedSessions(
  sessions: Session[],
  continuedFromSessionIds?: string[],
  excludeSessionId?: string
): Session[] {
  if (!continuedFromSessionIds?.length) {
    return [];
  }
  const uniqueIds = Array.from(new Set(continuedFromSessionIds));
  return uniqueIds.flatMap((sessionId) => {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session || session.id === excludeSessionId || session.closeDisposition !== "hopped" || session.closedBillId) {
      return [];
    }
    return [session];
  });
}

export function computePaymentModeTotals(
  filteredBills: Bill[],
  allPayments: Payment[]
): { cash: number; upi: number } {
  const revenueCountedBillIds = new Set(
    filteredBills
      .filter((b) => b.status === "issued" || (b.status === "pending" && b.amountPaid > 0))
      .map((b) => b.id)
  );
  const revenueCountedPayments = allPayments.filter((p) => revenueCountedBillIds.has(p.billId));
  return {
    cash: sumBy(revenueCountedPayments.filter((p) => p.mode === "cash"), (p) => p.amount),
    upi: sumBy(revenueCountedPayments.filter((p) => p.mode === "upi"), (p) => p.amount)
  };
}

export function computeExpensePaymentModeTotals(expenses: Expense[]): { cash: number; upi: number; unknown: number } {
  return expenses.reduce(
    (totals, expense) => {
      if (expense.paymentMode === "cash") {
        totals.cash += expense.amount;
      } else if (expense.paymentMode === "upi") {
        totals.upi += expense.amount;
      } else if (expense.paymentMode === "split") {
        const splitCash = expense.cashAmount ?? 0;
        const splitUpi = expense.upiAmount ?? 0;
        if (splitCash > 0 || splitUpi > 0) {
          totals.cash += splitCash;
          totals.upi += splitUpi;
        } else {
          totals.unknown += expense.amount;
        }
      } else {
        totals.unknown += expense.amount;
      }
      return totals;
    },
    { cash: 0, upi: 0, unknown: 0 }
  );
}

export function isRevenueCountedBill(bill: Bill): boolean {
  return bill.status === "issued" || bill.status === "pending";
}

export function getRevenueCountedPayments(bills: Bill[], payments: Payment[]): Payment[] {
  const revenueCountedBillIds = new Set(bills.filter(isRevenueCountedBill).map((bill) => bill.id));
  return payments.filter((payment) => revenueCountedBillIds.has(payment.billId));
}

export function filterPaymentsByBusinessDate(
  payments: Payment[],
  fromDate: string,
  toDate: string
): Payment[] {
  return payments.filter((payment) => {
    const paymentDate = toBusinessDayKey(payment.createdAt);
    return paymentDate >= fromDate && paymentDate <= toDate;
  });
}

export interface PaymentRevenueAllocation {
  sessionRevenue: number;
  itemRevenue: number;
  totalDiscounts: number;
}

export function allocatePaymentRevenueToBill(bill: Bill, paymentAmount: number): PaymentRevenueAllocation {
  if (bill.total <= 0 || paymentAmount <= 0) {
    return { sessionRevenue: 0, itemRevenue: 0, totalDiscounts: 0 };
  }
  const ratio = paymentAmount / bill.total;
  return {
    sessionRevenue: sumBy(bill.lines.filter((line) => line.type === "session_charge" || line.type === "combo_package"), (line) => line.total * ratio),
    itemRevenue: sumBy(bill.lines.filter((line) => line.type === "inventory_item"), (line) => line.total * ratio),
    totalDiscounts: bill.totalDiscountAmount * ratio
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

export function getCustomerTabContinuationCandidates(
  customerTabs: CustomerTab[],
  customer: { customerId?: string; customerName?: string; customerPhone?: string }
) {
  const normalizedName = normalizeCustomerName(customer.customerName);
  const normalizedPhone = normalizeCustomerPhone(customer.customerPhone);

  return customerTabs.filter((tab) => {
    if (tab.status !== "open") {
      return false;
    }
    if (customer.customerId && tab.customerId === customer.customerId) {
      return true;
    }
    if (normalizedPhone && normalizeCustomerPhone(tab.customerPhone) === normalizedPhone) {
      return true;
    }
    return normalizedName !== "" && normalizeCustomerName(tab.customerName) === normalizedName;
  });
}

export function getCustomerDisplayName(name?: string, phone?: string) {
  return name?.trim() || phone?.trim() || "Walk-in";
}

export function getReceivableCustomerKey(bill: Bill): string {
  if (bill.customerId) return `customer:${bill.customerId}`;
  const phone = normalizeCustomerPhone(bill.customerPhone);
  if (phone) return `phone:${phone}`;
  const name = normalizeCustomerName(bill.customerName);
  if (name) return `name:${name}`;
  return `bill:${bill.id}`;
}

export function getPendingBillsForCustomer(bills: Bill[], customerId?: string, customerName?: string, customerPhone?: string): Bill[] {
  const normalizedPhone = normalizeCustomerPhone(customerPhone);
  const normalizedName = normalizeCustomerName(customerName);
  if (!customerId && !normalizedPhone && !normalizedName) return [];
  return bills.filter((bill) => {
    if (bill.status !== "pending" || bill.amountDue <= 0) return false;
    if (customerId && bill.customerId === customerId) return true;
    if (normalizedPhone && normalizeCustomerPhone(bill.customerPhone) === normalizedPhone) return true;
    if (normalizedName && normalizeCustomerName(bill.customerName) === normalizedName) return true;
    return false;
  });
}

export function getPendingReceivableGroups(
  bills: Bill[],
  billBusinessDates: Record<string, string>,
  todayBusinessDay: string
): PendingReceivableGroup[] {
  const todayMs = new Date(`${todayBusinessDay}T12:00:00`).getTime();
  const groups = new Map<string, PendingReceivableGroup>();

  for (const bill of bills) {
    if (bill.status !== "pending" || bill.amountDue <= 0) continue;
    const id = getReceivableCustomerKey(bill);
    const businessDate = billBusinessDates[bill.id] ?? toBusinessDayKey(bill.issuedAt);
    const daysOverdue = Math.max(0, Math.floor((todayMs - new Date(`${businessDate}T12:00:00`).getTime()) / 86400000));
    const existing = groups.get(id);
    if (existing) {
      existing.bills.push(bill);
      existing.totalDue += bill.amountDue;
      existing.totalPaid += bill.amountPaid;
      existing.totalBillValue += bill.total;
      if (businessDate < existing.oldestBusinessDate) existing.oldestBusinessDate = businessDate;
      existing.daysOverdue = Math.max(existing.daysOverdue, daysOverdue);
      if (!existing.customerName && bill.customerName) existing.customerName = bill.customerName;
      if (!existing.customerPhone && bill.customerPhone) existing.customerPhone = bill.customerPhone;
      existing.label = getCustomerDisplayName(existing.customerName, existing.customerPhone);
      continue;
    }

    const isUngrouped = id.startsWith("bill:");
    groups.set(id, {
      id,
      customerId: bill.customerId,
      customerName: bill.customerName,
      customerPhone: bill.customerPhone,
      label: isUngrouped ? `Ungrouped ${bill.billNumber}` : getCustomerDisplayName(bill.customerName, bill.customerPhone),
      isUngrouped,
      bills: [bill],
      totalDue: bill.amountDue,
      totalPaid: bill.amountPaid,
      totalBillValue: bill.total,
      oldestBusinessDate: businessDate,
      daysOverdue
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      bills: [...group.bills].sort((left, right) => {
        const leftDate = billBusinessDates[left.id] ?? toBusinessDayKey(left.issuedAt);
        const rightDate = billBusinessDates[right.id] ?? toBusinessDayKey(right.issuedAt);
        if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
        return left.issuedAt.localeCompare(right.issuedAt);
      })
    }))
    .sort((left, right) => {
      if (right.totalDue !== left.totalDue) return right.totalDue - left.totalDue;
      if (right.daysOverdue !== left.daysOverdue) return right.daysOverdue - left.daysOverdue;
      return left.label.localeCompare(right.label);
    });
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

export function findExactCustomerProfileMatch(customers: Customer[], customerName?: string, customerPhone?: string) {
  const normalizedPhone = normalizeCustomerPhone(customerPhone);
  if (normalizedPhone) {
    return customers.find((customer) => normalizeCustomerPhone(customer.phone) === normalizedPhone);
  }
  const normalizedName = normalizeCustomerName(customerName);
  if (!normalizedName) {
    return undefined;
  }
  const matches = customers.filter((customer) => normalizeCustomerName(customer.name) === normalizedName);
  return matches.length === 1 ? matches[0] : undefined;
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
