import { cloneValue } from "./utils";
import type { AppData } from "./types";
import { seedAppData } from "./seed";

const STORAGE_KEY = "game-parlour-management-system/v1";

export function loadAppData(): AppData {
  const storedValue = window.localStorage.getItem(STORAGE_KEY);
  if (!storedValue) {
    return cloneValue(seedAppData);
  }

  try {
    const parsed = JSON.parse(storedValue) as Partial<AppData>;
    return hydrateAppData(parsed);
  } catch {
    return cloneValue(seedAppData);
  }
}

export function saveAppData(value: AppData): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function hydrateAppData(parsed: Partial<AppData>): AppData {
  return {
    ...cloneValue(seedAppData),
    ...parsed,
    businessProfile: {
      ...cloneValue(seedAppData.businessProfile),
      ...parsed.businessProfile
    },
    inventoryCategories: Array.from(
      new Set([
        ...cloneValue(seedAppData.inventoryCategories),
        ...(parsed.inventoryCategories ?? []),
        ...((parsed.inventoryItems ?? []).map((item) => item.category).filter(Boolean) as string[])
      ])
    ),
    users: (parsed.users ?? cloneValue(seedAppData.users)).map((user) => ({
      ...user,
      password: user.password ?? undefined
    })),
    stations: (parsed.stations ?? cloneValue(seedAppData.stations)).map((station) => ({
      ...station,
      ltpEnabled: station.ltpEnabled ?? false
    })),
    sessions: (parsed.sessions ?? cloneValue(seedAppData.sessions)).map((session) => ({
      ...session,
      playMode: session.playMode ?? "group",
      ltpEligible: session.ltpEligible ?? false,
      closeDisposition: session.closeDisposition ?? (session.closedBillId ? "billed" : undefined),
      closeReason: session.closeReason ?? undefined
    })),
    bills: (parsed.bills ?? cloneValue(seedAppData.bills)).map((bill) => ({
      ...bill,
      roundOffEnabled: bill.roundOffEnabled ?? false,
      roundOffAmount: bill.roundOffAmount ?? 0,
      replacementOfBillId: bill.replacementOfBillId ?? undefined,
      replacedByBillId: bill.replacedByBillId ?? undefined,
      replacedAt: bill.replacedAt ?? undefined,
      replacedByUserId: bill.replacedByUserId ?? undefined,
      replaceReason: bill.replaceReason ?? undefined
    })),
    customerTabs: (parsed.customerTabs ?? cloneValue(seedAppData.customerTabs)).map((tab) => ({
      ...tab,
      closeDisposition: tab.closeDisposition ?? (tab.closedBillId ? "billed" : undefined),
      closeReason: tab.closeReason ?? undefined
    })),
    inventoryItems: (parsed.inventoryItems ?? cloneValue(seedAppData.inventoryItems)).map((item) => ({
      ...item,
      lowStockThreshold: item.lowStockThreshold ?? 5,
      unit: "piece",
      isReusable: item.isReusable ?? false
    })),
    expenses: parsed.expenses ?? cloneValue(seedAppData.expenses),
    expenseTemplates: parsed.expenseTemplates ?? cloneValue(seedAppData.expenseTemplates)
  };
}
