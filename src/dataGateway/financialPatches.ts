import type { AppData, Bill } from "../types";
import type { FinancialAdjustmentKind, FinancialAdjustmentPatch, FinancialCheckoutPatch } from "./types";

export function getChangedRecords<T extends { id: string }>(before: T[], after: T[]): T[] {
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  return after.filter((entry) => JSON.stringify(beforeById.get(entry.id)) !== JSON.stringify(entry));
}

export function getNewRecords<T extends { id: string }>(before: T[], after: T[]): T[] {
  const beforeIds = new Set(before.map((entry) => entry.id));
  return after.filter((entry) => !beforeIds.has(entry.id));
}

export function ensurePatchRecord<T extends { id: string }>(records: T[], requiredRecord: T): T[] {
  return records.some((entry) => entry.id === requiredRecord.id) ? records : [requiredRecord, ...records];
}

export function buildFinancialCheckoutPatch(params: {
  baseAppData: AppData;
  nextAppData: AppData;
  mode: "session" | "customer_tab";
  entityId: string;
  bill: Bill;
  baseVersion: number;
  createdAt: string;
  userId: string;
  mutationId: string;
}): FinancialCheckoutPatch {
  const changedBills = ensurePatchRecord(getChangedRecords(params.baseAppData.bills, params.nextAppData.bills), params.bill);
  return {
    mutationId: params.mutationId,
    mode: params.mode,
    entityType: params.mode === "session" ? "session" : "customer_tab",
    entityId: params.entityId,
    userId: params.userId,
    createdAt: params.createdAt,
    baseAppStateVersion: params.baseVersion,
    bill: params.bill,
    bills: changedBills,
    payments: getNewRecords(params.baseAppData.payments, params.nextAppData.payments),
    stockMovements: getNewRecords(params.baseAppData.stockMovements, params.nextAppData.stockMovements),
    auditLogs: getNewRecords(params.baseAppData.auditLogs, params.nextAppData.auditLogs),
    customers: getChangedRecords(params.baseAppData.customers, params.nextAppData.customers),
    sessions: getChangedRecords(params.baseAppData.sessions, params.nextAppData.sessions),
    customerTabs: getChangedRecords(params.baseAppData.customerTabs, params.nextAppData.customerTabs),
    inventoryItems: getChangedRecords(params.baseAppData.inventoryItems, params.nextAppData.inventoryItems)
  };
}

export function buildFinancialAdjustmentPatch(params: {
  baseAppData: AppData;
  nextAppData: AppData;
  kind: FinancialAdjustmentKind;
  entityType: FinancialAdjustmentPatch["entityType"];
  entityId: string;
  baseVersion: number;
  createdAt: string;
  userId: string;
  mutationId: string;
}): FinancialAdjustmentPatch {
  return {
    mutationId: params.mutationId,
    kind: params.kind,
    entityType: params.entityType,
    entityId: params.entityId,
    userId: params.userId,
    createdAt: params.createdAt,
    baseAppStateVersion: params.baseVersion,
    bills: getChangedRecords(params.baseAppData.bills, params.nextAppData.bills),
    payments: getNewRecords(params.baseAppData.payments, params.nextAppData.payments),
    stockMovements: getNewRecords(params.baseAppData.stockMovements, params.nextAppData.stockMovements),
    auditLogs: getNewRecords(params.baseAppData.auditLogs, params.nextAppData.auditLogs),
    inventoryItems: getChangedRecords(params.baseAppData.inventoryItems, params.nextAppData.inventoryItems)
  };
}
