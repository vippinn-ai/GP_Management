import type { AppData } from "../types";
import type { AdminDataChangePatch } from "./types";
import { getChangedRecords, getNewRecords } from "./financialPatches";

function getDeletedRecordIds<T extends { id: string }>(before: T[], after: T[]): string[] {
  const afterIds = new Set(after.map((entry) => entry.id));
  return before.map((entry) => entry.id).filter((id) => !afterIds.has(id));
}

function arraysEqual<T>(before: T[], after: T[]): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function recordChanged<T>(before: T, after: T): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function adminDataChangePatchHasChanges(patch: AdminDataChangePatch): boolean {
  return Boolean(
    patch.inventoryCategories ||
      patch.inventoryItems.length ||
      patch.inventoryItemIdsToDelete.length ||
      patch.combos.length ||
      patch.comboIdsToDelete.length ||
      patch.stockMovements.length ||
      patch.auditLogs.length ||
      patch.expenses.length ||
      patch.expenseIdsToDelete.length ||
      patch.expenseTemplates.length ||
      patch.expenseTemplateIdsToDelete.length ||
      patch.expenseTemplateOverrides.length ||
      patch.expenseTemplateOverrideIdsToDelete.length ||
      patch.stations.length ||
      patch.stationIdsToDelete.length ||
      patch.pricingRules.length ||
      patch.pricingRuleIdsToDelete.length ||
      patch.customers.length ||
      patch.customerIdsToDelete.length ||
      patch.businessProfile
  );
}

export function adminDataChangePatchHasUnsupportedChanges(baseAppData: AppData, nextAppData: AppData): boolean {
  return (
    !arraysEqual(baseAppData.users, nextAppData.users) ||
    !arraysEqual(baseAppData.sessions, nextAppData.sessions) ||
    !arraysEqual(baseAppData.sessionPauseLogs, nextAppData.sessionPauseLogs) ||
    !arraysEqual(baseAppData.customerTabs, nextAppData.customerTabs) ||
    !arraysEqual(baseAppData.bills, nextAppData.bills) ||
    !arraysEqual(baseAppData.payments, nextAppData.payments)
  );
}

export function buildAdminDataChangePatch(params: {
  baseAppData: AppData;
  nextAppData: AppData;
  baseVersion: number;
  createdAt: string;
  userId: string;
  mutationId: string;
  actionLabel: string;
}): AdminDataChangePatch {
  return {
    mutationId: params.mutationId,
    entityType: "admin_data",
    entityId: params.actionLabel,
    userId: params.userId,
    createdAt: params.createdAt,
    baseAppStateVersion: params.baseVersion,
    inventoryCategories: arraysEqual(params.baseAppData.inventoryCategories, params.nextAppData.inventoryCategories)
      ? undefined
      : params.nextAppData.inventoryCategories,
    inventoryItems: getChangedRecords(params.baseAppData.inventoryItems, params.nextAppData.inventoryItems),
    inventoryItemIdsToDelete: getDeletedRecordIds(params.baseAppData.inventoryItems, params.nextAppData.inventoryItems),
    combos: getChangedRecords(params.baseAppData.combos, params.nextAppData.combos),
    comboIdsToDelete: getDeletedRecordIds(params.baseAppData.combos, params.nextAppData.combos),
    stockMovements: getNewRecords(params.baseAppData.stockMovements, params.nextAppData.stockMovements),
    auditLogs: getNewRecords(params.baseAppData.auditLogs, params.nextAppData.auditLogs),
    expenses: getChangedRecords(params.baseAppData.expenses, params.nextAppData.expenses),
    expenseIdsToDelete: getDeletedRecordIds(params.baseAppData.expenses, params.nextAppData.expenses),
    expenseTemplates: getChangedRecords(params.baseAppData.expenseTemplates, params.nextAppData.expenseTemplates),
    expenseTemplateIdsToDelete: getDeletedRecordIds(params.baseAppData.expenseTemplates, params.nextAppData.expenseTemplates),
    expenseTemplateOverrides: getChangedRecords(
      params.baseAppData.expenseTemplateOverrides,
      params.nextAppData.expenseTemplateOverrides
    ),
    expenseTemplateOverrideIdsToDelete: getDeletedRecordIds(
      params.baseAppData.expenseTemplateOverrides,
      params.nextAppData.expenseTemplateOverrides
    ),
    stations: getChangedRecords(params.baseAppData.stations, params.nextAppData.stations),
    stationIdsToDelete: getDeletedRecordIds(params.baseAppData.stations, params.nextAppData.stations),
    pricingRules: getChangedRecords(params.baseAppData.pricingRules, params.nextAppData.pricingRules),
    pricingRuleIdsToDelete: getDeletedRecordIds(params.baseAppData.pricingRules, params.nextAppData.pricingRules),
    customers: getChangedRecords(params.baseAppData.customers, params.nextAppData.customers),
    customerIdsToDelete: getDeletedRecordIds(params.baseAppData.customers, params.nextAppData.customers),
    businessProfile: recordChanged(params.baseAppData.businessProfile, params.nextAppData.businessProfile)
      ? params.nextAppData.businessProfile
      : undefined
  };
}
