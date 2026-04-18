import { cloneValue } from "./utils";
import type { AppData } from "./types";

const STORAGE_KEY = "game-parlour-management-system/v1";

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
  stockMovements: [],
  bills: [],
  payments: [],
  auditLogs: [],
  expenses: [],
  expenseTemplates: []
};

export function loadAppData(): AppData {
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
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
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
      closeDisposition: tab.closeDisposition ?? (tab.closedBillId ? "billed" : undefined),
      closeReason: tab.closeReason ?? undefined
    })),
    inventoryItems: (parsed.inventoryItems ?? cloneValue(emptyAppData.inventoryItems)).map((item) => ({
      ...item,
      lowStockThreshold: item.lowStockThreshold ?? 5,
      unit: "piece",
      isReusable: item.isReusable ?? false
    })),
    expenses: parsed.expenses ?? cloneValue(emptyAppData.expenses),
    expenseTemplates: parsed.expenseTemplates ?? cloneValue(emptyAppData.expenseTemplates)
  };
}
