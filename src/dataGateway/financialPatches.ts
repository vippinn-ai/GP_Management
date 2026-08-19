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

function getFinancialCheckoutEntityType(mode: FinancialCheckoutPatch["mode"]): FinancialCheckoutPatch["entityType"] {
  if (mode === "session") {
    return "session";
  }
  if (mode === "customer_tab") {
    return "customer_tab";
  }
  return "bill";
}

export function buildFinancialCheckoutPatch(params: {
  baseAppData: AppData;
  nextAppData: AppData;
  mode: FinancialCheckoutPatch["mode"];
  entityId: string;
  bill: Bill;
  baseVersion: number;
  createdAt: string;
  userId: string;
  mutationId: string;
}): FinancialCheckoutPatch {
  const changedBills = ensurePatchRecord(getChangedRecords(params.baseAppData.bills, params.nextAppData.bills), params.bill);
  const baseBillsById = new Map(params.baseAppData.bills.map((bill) => [bill.id, bill]));
  const baseInventoryById = new Map(params.baseAppData.inventoryItems.map((item) => [item.id, item]));
  const changedSessions = getChangedRecords(params.baseAppData.sessions, params.nextAppData.sessions);
  const changedCustomerTabs = getChangedRecords(params.baseAppData.customerTabs, params.nextAppData.customerTabs);
  const changedInventoryItems = getChangedRecords(params.baseAppData.inventoryItems, params.nextAppData.inventoryItems);
  return {
    mutationId: params.mutationId,
    mode: params.mode,
    entityType: getFinancialCheckoutEntityType(params.mode),
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
    sessions: changedSessions,
    customerTabs: changedCustomerTabs,
    inventoryItems: changedInventoryItems,
    sourceSessionIds: changedSessions.map((session) => session.id).sort(),
    sourceCustomerTabIds: changedCustomerTabs.map((tab) => tab.id).sort(),
    settlementExpectations: changedBills.flatMap((bill) => {
      const previous = baseBillsById.get(bill.id);
      if (!previous || previous.status !== "pending" || bill.id === params.bill.id) {
        return [];
      }
      return [
        {
          billId: bill.id,
          expectedStatus: previous.status,
          expectedAmountDue: previous.amountDue,
          intendedAmountDue: bill.amountDue,
          settlementAmount: bill.amountPaid - previous.amountPaid
        }
      ];
    }),
    inventoryExpectations: changedInventoryItems.flatMap((item) => {
      const previous = baseInventoryById.get(item.id);
      if (!previous) {
        return [];
      }
      return [
        {
          itemId: item.id,
          expectedStockQty: previous.stockQty,
          intendedStockQty: item.stockQty,
          delta: item.stockQty - previous.stockQty
        }
      ];
    })
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
  const changedBills = getChangedRecords(params.baseAppData.bills, params.nextAppData.bills);
  const changedInventoryItems = getChangedRecords(params.baseAppData.inventoryItems, params.nextAppData.inventoryItems);
  const baseBillsById = new Map(params.baseAppData.bills.map((bill) => [bill.id, bill]));
  const baseInventoryById = new Map(params.baseAppData.inventoryItems.map((item) => [item.id, item]));
  return {
    mutationId: params.mutationId,
    kind: params.kind,
    entityType: params.entityType,
    entityId: params.entityId,
    userId: params.userId,
    createdAt: params.createdAt,
    baseAppStateVersion: params.baseVersion,
    bills: changedBills,
    payments: getNewRecords(params.baseAppData.payments, params.nextAppData.payments),
    stockMovements: getNewRecords(params.baseAppData.stockMovements, params.nextAppData.stockMovements),
    auditLogs: getNewRecords(params.baseAppData.auditLogs, params.nextAppData.auditLogs),
    inventoryItems: changedInventoryItems,
    billExpectations: changedBills.flatMap((bill) => {
      const previous = baseBillsById.get(bill.id);
      return previous
        ? [{ billId: bill.id, expectedStatus: previous.status, expectedAmountPaid: previous.amountPaid, expectedAmountDue: previous.amountDue }]
        : [];
    }),
    inventoryExpectations: changedInventoryItems.flatMap((item) => {
      const previous = baseInventoryById.get(item.id);
      return previous
        ? [{ itemId: item.id, expectedStockQty: previous.stockQty, intendedStockQty: item.stockQty, delta: item.stockQty - previous.stockQty }]
        : [];
    })
  };
}
