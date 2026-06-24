import { cloneValue } from "./utils";
import type { AppData } from "./types";

const STORAGE_KEY = "game-parlour-management-system/v1";
let fullAppDataCacheEnabled = true;

const emptyAppData: AppData = {
  users: [],
  businessProfile: { name: "", logoText: "", address: "", primaryPhone: "", secondaryPhone: "", receiptFooter: "" },
  inventoryCategories: [],
  stations: [],
  pricingRules: [],
  sessions: [],
  sessionPauseLogs: [],
  customers: [],
  customerTabs: [],
  inventoryItems: [],
  combos: [],
  stockMovements: [],
  bills: [],
  payments: [],
  auditLogs: [],
  expenses: [],
  expenseTemplates: [],
  expenseTemplateOverrides: []
};

export function setFullAppDataCacheEnabled(enabled: boolean): void {
  fullAppDataCacheEnabled = enabled;
}

export function clearStoredAppData(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort cache cleanup only.
  }
}

export function loadAppData(options: { useStoredCache?: boolean } = {}): AppData {
  if (options.useStoredCache === false) {
    return cloneValue(emptyAppData);
  }
  const storedValue = window.localStorage.getItem(STORAGE_KEY);
  if (!storedValue) {
    return cloneValue(emptyAppData);
  }

  try {
    const parsed = JSON.parse(storedValue) as Partial<AppData>;
    return hydrateAppData(parsed);
  } catch {
    return cloneValue(emptyAppData);
  }
}

export function saveAppData(value: AppData): void {
  if (!fullAppDataCacheEnabled) {
    clearStoredAppData();
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (error) {
    console.warn("Unable to cache app data locally.", error);
  }
}

export function hasStoredAppData(options: { useStoredCache?: boolean } = {}): boolean {
  if (options.useStoredCache === false) {
    return false;
  }
  return window.localStorage.getItem(STORAGE_KEY) !== null;
}

export function hydrateAppData(parsed: Partial<AppData>): AppData {
  return {
    ...cloneValue(emptyAppData),
    ...parsed,
    businessProfile: {
      ...cloneValue(emptyAppData.businessProfile),
      ...parsed.businessProfile
    },
    inventoryCategories: Array.from(
      new Set([
        ...cloneValue(emptyAppData.inventoryCategories),
        ...(parsed.inventoryCategories ?? []),
        ...((parsed.inventoryItems ?? []).map((item) => item.category).filter(Boolean) as string[])
      ])
    ),
    users: (parsed.users ?? cloneValue(emptyAppData.users)).map((user) => ({
      ...user,
      password: user.password ?? undefined,
      tabPermissions: user.tabPermissions ?? undefined
    })),
    stations: (parsed.stations ?? cloneValue(emptyAppData.stations)).map((station) => ({
      ...station,
      ltpEnabled: station.ltpEnabled ?? false
    })),
    sessions: (parsed.sessions ?? cloneValue(emptyAppData.sessions)).map((session) => ({
      ...session,
      playMode: session.playMode ?? "group",
      ltpEligible: session.ltpEligible ?? false,
      comboApplications: session.comboApplications ?? [],
      continuedFromSessionIds: session.continuedFromSessionIds ?? undefined,
      closeDisposition: session.closeDisposition ?? (session.closedBillId ? "billed" : undefined),
      closeReason: session.closeReason ?? undefined
    })),
    bills: (parsed.bills ?? cloneValue(emptyAppData.bills)).map((bill) => ({
      ...bill,
      roundOffEnabled: bill.roundOffEnabled ?? false,
      roundOffAmount: bill.roundOffAmount ?? 0,
      replacementOfBillId: bill.replacementOfBillId ?? undefined,
      replacedByBillId: bill.replacedByBillId ?? undefined,
      replacedAt: bill.replacedAt ?? undefined,
      replacedByUserId: bill.replacedByUserId ?? undefined,
      replaceReason: bill.replaceReason ?? undefined,
      // Old bills pre-dating this feature are assumed fully paid
      amountPaid: bill.amountPaid ?? bill.total ?? 0,
      amountDue: bill.amountDue ?? 0
    })),
    customerTabs: (parsed.customerTabs ?? cloneValue(emptyAppData.customerTabs)).map((tab) => ({
      ...tab,
      comboApplications: tab.comboApplications ?? [],
      continuedFromSessionIds: tab.continuedFromSessionIds ?? undefined,
      closeDisposition: tab.closeDisposition ?? (tab.closedBillId ? "billed" : undefined),
      closeReason: tab.closeReason ?? undefined
    })),
    inventoryItems: (parsed.inventoryItems ?? cloneValue(emptyAppData.inventoryItems)).map((item) => {
      const active = item.active ?? true;
      return {
        ...item,
        active,
        archivedAt: active ? undefined : item.archivedAt,
        archivedByUserId: active ? undefined : item.archivedByUserId,
        archiveReason: active ? undefined : item.archiveReason?.trim() || undefined,
        lowStockThreshold: item.lowStockThreshold ?? 5,
        unit: "piece",
        isReusable: item.isReusable ?? false,
        sellBaseItem: item.sellBaseItem ?? true,
        saleVariants: (item.saleVariants ?? []).map((variant, index) => ({
          ...variant,
          id: variant.id ?? `${item.id}-variant-${index + 1}`,
          name: variant.name ?? "",
          price: variant.price ?? 0,
          stockUnitsPerSale: Math.max(1, Math.trunc(variant.stockUnitsPerSale ?? 1)),
          barcode: variant.barcode?.trim() || undefined,
          active: variant.active ?? true
        }))
      };
    }),
    combos: (parsed.combos ?? cloneValue(emptyAppData.combos)).map((combo) => ({
      ...combo,
      type: combo.type ?? "game",
      active: combo.active ?? true,
      stationIds: combo.type === "consumables" ? [] : combo.stationIds ?? [],
      price: combo.price ?? 0,
      includedMinutes: (combo.type ?? "game") === "consumables"
        ? 0
        : Math.max(1, Math.trunc(combo.includedMinutes ?? 60)),
      fixedItems: combo.fixedItems ?? [],
      choiceGroups: (combo.choiceGroups ?? []).map((group) => ({
        ...group,
        requiredQuantity: Math.max(1, Math.trunc(group.requiredQuantity ?? 1)),
        optionIds: group.optionIds ?? []
      })),
      createdAt: combo.createdAt ?? new Date().toISOString(),
      updatedAt: combo.updatedAt ?? combo.createdAt ?? new Date().toISOString()
    })),
    expenses: (parsed.expenses ?? cloneValue(emptyAppData.expenses)).map((expense) => ({
      ...expense,
      paymentMode: expense.paymentMode === "cash" || expense.paymentMode === "upi" || expense.paymentMode === "split" ? expense.paymentMode : undefined,
      cashAmount: typeof expense.cashAmount === "number" && Number.isFinite(expense.cashAmount) ? expense.cashAmount : undefined,
      upiAmount: typeof expense.upiAmount === "number" && Number.isFinite(expense.upiAmount) ? expense.upiAmount : undefined
    })),
    expenseTemplates: parsed.expenseTemplates ?? cloneValue(emptyAppData.expenseTemplates),
    expenseTemplateOverrides: parsed.expenseTemplateOverrides ?? cloneValue(emptyAppData.expenseTemplateOverrides)
  };
}
