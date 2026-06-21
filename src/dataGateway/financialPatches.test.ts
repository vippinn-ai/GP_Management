import { describe, expect, it } from "vitest";
import { buildCheckoutPaymentResult, computeReceivableSettlement } from "../billing";
import type { AppData, AuditLog, Bill, Customer, InventoryItem, Payment, Session, StockMovement } from "../types";
import { buildBillPreview } from "../utils";
import {
  buildFinancialAdjustmentPatch,
  buildFinancialCheckoutPatch,
  ensurePatchRecord,
  getChangedRecords,
  getNewRecords
} from "./financialPatches";

function createAppData(overrides: Partial<AppData> = {}): AppData {
  return {
    users: [],
    businessProfile: {
      name: "BreakPerfect",
      logoText: "",
      address: "",
      primaryPhone: "",
      receiptFooter: ""
    },
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
    expenseTemplateOverrides: [],
    ...overrides
  };
}

function createBill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: "bill-1",
    billNumber: "BILL-20260620-001",
    status: "issued",
    createdAt: "2026-06-20T12:00:00.000Z",
    issuedAt: "2026-06-20T12:00:00.000Z",
    issuedByUserId: "user-1",
    paymentMode: "cash",
    amountPaid: 500,
    amountDue: 0,
    subtotal: 500,
    totalDiscountAmount: 0,
    billDiscountAmount: 0,
    roundOffEnabled: false,
    roundOffAmount: 0,
    total: 500,
    lineDiscounts: [],
    lines: [],
    receiptType: "digital",
    ...overrides
  };
}

function createCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "customer-1",
    name: "Test Customer",
    phone: "9999999999",
    createdAt: "2026-06-20T10:00:00.000Z",
    lastVisitAt: "2026-06-20T10:00:00.000Z",
    ...overrides
  };
}

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    stationId: "station-1",
    stationNameSnapshot: "8 Ball Pool",
    mode: "timed",
    startedAt: "2026-06-20T10:00:00.000Z",
    status: "active",
    playMode: "group",
    ltpEligible: false,
    pricingSnapshot: [],
    items: [],
    pauseLogIds: [],
    ...overrides
  };
}

function createInventoryItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "item-1",
    name: "Momo",
    category: "Food",
    price: 80,
    stockQty: 100,
    lowStockThreshold: 10,
    unit: "piece",
    isReusable: false,
    active: true,
    ...overrides
  };
}

function createPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "payment-1",
    billId: "bill-1",
    mode: "cash",
    amount: 500,
    createdAt: "2026-06-20T12:00:00.000Z",
    receivedByUserId: "user-1",
    ...overrides
  };
}

function createStockMovement(overrides: Partial<StockMovement> = {}): StockMovement {
  return {
    id: "stock-1",
    itemId: "item-1",
    type: "sale",
    quantity: 8,
    reason: "Sold Momo Plate",
    createdAt: "2026-06-20T12:00:00.000Z",
    userId: "user-1",
    relatedBillId: "bill-1",
    ...overrides
  };
}

function createAuditLog(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: "audit-1",
    action: "bill_issued",
    entityType: "bill",
    entityId: "bill-1",
    message: "Issued BILL-20260620-001.",
    createdAt: "2026-06-20T12:00:00.000Z",
    userId: "user-1",
    ...overrides
  };
}

describe("financial patch helpers", () => {
  it("classifies changed records, new records, and required records deterministically", () => {
    const before = [{ id: "a", value: 1 }, { id: "b", value: 2 }];
    const after = [{ id: "a", value: 3 }, { id: "b", value: 2 }, { id: "c", value: 4 }];

    expect(getChangedRecords(before, after)).toEqual([{ id: "a", value: 3 }, { id: "c", value: 4 }]);
    expect(getNewRecords(before, after)).toEqual([{ id: "c", value: 4 }]);
    expect(ensurePatchRecord([{ id: "a", value: 3 }], { id: "b", value: 2 })).toEqual([
      { id: "b", value: 2 },
      { id: "a", value: 3 }
    ]);
  });

  it("builds checkout patches from the same bill preview and payment output used by checkout", () => {
    const baseCustomer = createCustomer();
    const closedCustomer = createCustomer({ lastVisitAt: "2026-06-20T12:00:00.000Z" });
    const baseSession = createSession();
    const closedSession = createSession({
      endedAt: "2026-06-20T12:00:00.000Z",
      status: "closed",
      closedBillId: "bill-1",
      closeDisposition: "billed"
    });
    const baseItem = createInventoryItem({ stockQty: 100 });
    const soldItem = createInventoryItem({ stockQty: 92 });
    const preview = buildBillPreview(
      [
        {
          id: "line-1",
          type: "session_charge",
          description: "8 Ball Pool",
          quantity: 1,
          unitPrice: 400
        },
        {
          id: "line-2",
          type: "inventory_item",
          description: "Momo Plate",
          quantity: 1,
          unitPrice: 100,
          inventoryItemId: "item-1",
          stockUnitsPerSale: 8
        }
      ],
      {}
    );
    const paymentResult = buildCheckoutPaymentResult("split", 300, 200, 0, "cash", preview.total);
    const bill = createBill({
      paymentMode: "split",
      amountPaid: paymentResult.amountPaid,
      amountDue: paymentResult.amountDue,
      status: paymentResult.status,
      subtotal: preview.subtotal,
      totalDiscountAmount: preview.lineDiscountAmount + preview.billDiscountAmount,
      billDiscountAmount: preview.billDiscountAmount,
      roundOffAmount: preview.roundOffAmount,
      total: preview.total,
      lines: preview.processedLines
    });
    const payments = paymentResult.paymentRecords.map((record, index) =>
      createPayment({
        id: `payment-${index + 1}`,
        mode: record.mode,
        amount: record.amount
      })
    );
    const stockMovement = createStockMovement({ quantity: 8 });
    const auditLog = createAuditLog();

    const baseAppData = createAppData({
      customers: [baseCustomer],
      sessions: [baseSession],
      inventoryItems: [baseItem]
    });
    const nextAppData = createAppData({
      customers: [closedCustomer],
      sessions: [closedSession],
      inventoryItems: [soldItem],
      bills: [bill],
      payments,
      stockMovements: [stockMovement],
      auditLogs: [auditLog]
    });

    const patch = buildFinancialCheckoutPatch({
      baseAppData,
      nextAppData,
      mode: "session",
      entityId: "session-1",
      bill,
      baseVersion: 42,
      createdAt: bill.issuedAt,
      userId: "user-1",
      mutationId: "financial-1"
    });

    expect(patch).toMatchObject({
      mutationId: "financial-1",
      mode: "session",
      entityType: "session",
      entityId: "session-1",
      userId: "user-1",
      baseAppStateVersion: 42,
      bill: {
        id: "bill-1",
        total: 500,
        amountPaid: 500,
        amountDue: 0,
        paymentMode: "split"
      }
    });
    expect(patch.bills.map((entry) => entry.id)).toEqual(["bill-1"]);
    expect(patch.payments.map((entry) => [entry.mode, entry.amount])).toEqual([
      ["cash", 300],
      ["upi", 200]
    ]);
    expect(patch.stockMovements.map((entry) => [entry.type, entry.quantity])).toEqual([["sale", 8]]);
    expect(patch.auditLogs.map((entry) => entry.action)).toEqual(["bill_issued"]);
    expect(patch.customers.map((entry) => entry.id)).toEqual(["customer-1"]);
    expect(patch.sessions.map((entry) => [entry.id, entry.status, entry.closedBillId])).toEqual([
      ["session-1", "closed", "bill-1"]
    ]);
    expect(patch.customerTabs).toEqual([]);
    expect(patch.inventoryItems.map((entry) => [entry.id, entry.stockQty])).toEqual([["item-1", 92]]);
  });

  it("builds replacement checkout patches with original bill updates and stock deltas", () => {
    const originalBill = createBill({
      id: "bill-original",
      billNumber: "BILL-20260620-010",
      lines: [
        {
          id: "line-original",
          type: "inventory_item",
          description: "Momo",
          quantity: 1,
          unitPrice: 80,
          subtotal: 80,
          discountAmount: 0,
          total: 80,
          inventoryItemId: "item-1",
          stockUnitsPerSale: 1
        }
      ],
      subtotal: 80,
      total: 80,
      amountPaid: 80
    });
    const replacedOriginalBill = {
      ...originalBill,
      status: "replaced" as const,
      replacedByBillId: "bill-replacement",
      replacedAt: "2026-06-20T12:30:00.000Z",
      replacedByUserId: "user-1",
      replaceReason: "Corrected quantity"
    };
    const replacementBill = createBill({
      id: "bill-replacement",
      billNumber: "BILL-20260620-011",
      createdAt: "2026-06-20T12:30:00.000Z",
      issuedAt: "2026-06-20T12:30:00.000Z",
      replacementOfBillId: "bill-original",
      replaceReason: "Corrected quantity",
      lines: [
        {
          id: "line-replacement",
          type: "inventory_item",
          description: "Momo",
          quantity: 2,
          unitPrice: 80,
          subtotal: 160,
          discountAmount: 0,
          total: 160,
          inventoryItemId: "item-1",
          stockUnitsPerSale: 1
        }
      ],
      subtotal: 160,
      total: 160,
      amountPaid: 160
    });
    const payment = createPayment({
      id: "payment-replacement",
      billId: "bill-replacement",
      amount: 160,
      createdAt: "2026-06-20T12:30:00.000Z"
    });
    const stockDelta = createStockMovement({
      id: "stock-replacement",
      itemId: "item-1",
      type: "sale",
      quantity: -1,
      reason: "Replacement adjustment from BILL-20260620-010 to BILL-20260620-011",
      relatedBillId: "bill-replacement",
      createdAt: "2026-06-20T12:30:00.000Z"
    });
    const baseItem = createInventoryItem({ stockQty: 9 });
    const replacementItem = createInventoryItem({ stockQty: 8 });

    const patch = buildFinancialCheckoutPatch({
      baseAppData: createAppData({
        bills: [originalBill],
        inventoryItems: [baseItem]
      }),
      nextAppData: createAppData({
        bills: [replacementBill, replacedOriginalBill],
        payments: [payment],
        stockMovements: [stockDelta],
        auditLogs: [createAuditLog({ id: "audit-replacement", action: "bill_replaced", entityId: "bill-replacement" })],
        inventoryItems: [replacementItem]
      }),
      mode: "bill_replacement",
      entityId: "bill-original",
      bill: replacementBill,
      baseVersion: 60,
      createdAt: replacementBill.issuedAt,
      userId: "user-1",
      mutationId: "financial-replacement-1"
    });

    expect(patch).toMatchObject({
      mutationId: "financial-replacement-1",
      mode: "bill_replacement",
      entityType: "bill",
      entityId: "bill-original",
      baseAppStateVersion: 60,
      bill: {
        id: "bill-replacement",
        replacementOfBillId: "bill-original",
        replaceReason: "Corrected quantity"
      }
    });
    expect(patch.bills.map((entry) => [entry.id, entry.status, entry.replacedByBillId, entry.replacementOfBillId])).toEqual([
      ["bill-replacement", "issued", undefined, "bill-original"],
      ["bill-original", "replaced", "bill-replacement", undefined]
    ]);
    expect(patch.payments.map((entry) => [entry.id, entry.billId, entry.amount])).toEqual([
      ["payment-replacement", "bill-replacement", 160]
    ]);
    expect(patch.stockMovements.map((entry) => [entry.id, entry.type, entry.quantity, entry.relatedBillId])).toEqual([
      ["stock-replacement", "sale", -1, "bill-replacement"]
    ]);
    expect(patch.inventoryItems.map((entry) => [entry.id, entry.stockQty])).toEqual([["item-1", 8]]);
    expect(patch.auditLogs.map((entry) => entry.action)).toEqual(["bill_replaced"]);
    expect(patch.sessions).toEqual([]);
    expect(patch.customerTabs).toEqual([]);
  });

  it("builds pending settlement adjustment patches from receivable settlement allocations", () => {
    const pendingBill = createBill({
      id: "pending-1",
      billNumber: "BILL-20260620-020",
      status: "pending",
      paymentMode: "deferred",
      amountPaid: 100,
      amountDue: 400,
      total: 500
    });
    const settlement = computeReceivableSettlement(
      [pendingBill],
      {
        billId: "pending-1",
        billIds: ["pending-1"],
        paymentMode: "split",
        cashAmount: 250,
        upiAmount: 150
      },
      { "pending-1": "2026-06-20" }
    );
    expect(settlement.error).toBeNull();
    const allocation = settlement.allocations[0];
    const settledBill = {
      ...pendingBill,
      status: allocation.newStatus,
      amountPaid: allocation.newAmountPaid,
      amountDue: allocation.newAmountDue,
      settledAt: "2026-06-20T12:30:00.000Z",
      settledByUserId: "user-1"
    };
    const payments = allocation.paymentRecords.map((record, index) =>
      createPayment({
        id: `settlement-payment-${index + 1}`,
        billId: "pending-1",
        mode: record.mode,
        amount: record.amount,
        settlementGroupId: undefined
      })
    );

    const patch = buildFinancialAdjustmentPatch({
      baseAppData: createAppData({ bills: [pendingBill] }),
      nextAppData: createAppData({
        bills: [settledBill],
        payments,
        auditLogs: [createAuditLog({ id: "audit-settlement", action: "bill_settled", entityId: "pending-1" })]
      }),
      kind: "settlePendingBills",
      entityType: "bill",
      entityId: "pending-1",
      baseVersion: 50,
      createdAt: "2026-06-20T12:30:00.000Z",
      userId: "user-1",
      mutationId: "financial-adjustment-1"
    });

    expect(patch.kind).toBe("settlePendingBills");
    expect(patch.bills).toHaveLength(1);
    expect(patch.bills[0]).toMatchObject({
      id: "pending-1",
      status: "issued",
      amountPaid: 500,
      amountDue: 0
    });
    expect(patch.payments.map((entry) => [entry.mode, entry.amount])).toEqual([
      ["cash", 250],
      ["upi", 150]
    ]);
    expect(patch.auditLogs.map((entry) => entry.action)).toEqual(["bill_settled"]);
    expect(patch.stockMovements).toEqual([]);
    expect(patch.inventoryItems).toEqual([]);
  });

  it("builds void/refund adjustment patches with reversal stock rows and restored inventory", () => {
    const baseBill = createBill({
      lines: [
        {
          id: "line-1",
          type: "inventory_item",
          description: "Momo Plate",
          quantity: 2,
          unitPrice: 80,
          subtotal: 160,
          discountAmount: 0,
          total: 160,
          inventoryItemId: "item-1",
          stockUnitsPerSale: 8
        }
      ],
      total: 160,
      subtotal: 160,
      amountPaid: 160
    });
    const refundedBill = {
      ...baseBill,
      status: "refunded" as const,
      voidReason: "Customer refund",
      voidedAt: "2026-06-20T13:00:00.000Z",
      voidedByUserId: "user-1"
    };
    const soldItem = createInventoryItem({ stockQty: 84 });
    const restoredItem = createInventoryItem({ stockQty: 100 });
    const reversal = createStockMovement({
      type: "void_refund_reversal",
      quantity: 16,
      reason: "Customer refund",
      createdAt: "2026-06-20T13:00:00.000Z"
    });

    const patch = buildFinancialAdjustmentPatch({
      baseAppData: createAppData({
        bills: [baseBill],
        inventoryItems: [soldItem]
      }),
      nextAppData: createAppData({
        bills: [refundedBill],
        inventoryItems: [restoredItem],
        stockMovements: [reversal],
        auditLogs: [createAuditLog({ id: "audit-refund", action: "bill_refunded" })]
      }),
      kind: "refundBill",
      entityType: "bill",
      entityId: "bill-1",
      baseVersion: 51,
      createdAt: "2026-06-20T13:00:00.000Z",
      userId: "user-1",
      mutationId: "financial-adjustment-2"
    });

    expect(patch.kind).toBe("refundBill");
    expect(patch.bills).toHaveLength(1);
    expect(patch.bills[0]).toMatchObject({
      id: "bill-1",
      status: "refunded",
      voidReason: "Customer refund"
    });
    expect(patch.stockMovements.map((entry) => [entry.type, entry.quantity])).toEqual([
      ["void_refund_reversal", 16]
    ]);
    expect(patch.inventoryItems.map((entry) => [entry.id, entry.stockQty])).toEqual([["item-1", 100]]);
    expect(patch.payments).toEqual([]);
    expect(patch.auditLogs.map((entry) => entry.action)).toEqual(["bill_refunded"]);
  });
});
