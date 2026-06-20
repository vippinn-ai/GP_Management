import { describe, expect, it } from "vitest";
import { buildFinancialCheckoutRpcPayload, mapFinancialCheckoutRpcResult } from "./financialRpcClient";
import type { FinancialCheckoutPatch } from "./types";

function createPatch(): FinancialCheckoutPatch {
  return {
    mutationId: "financial-1",
    mode: "session",
    entityType: "session",
    entityId: "session-1",
    userId: "user-1",
    createdAt: "2026-06-20T12:00:00.000Z",
    baseAppStateVersion: 8,
    bill: {
      id: "bill-1",
      billNumber: "BILL-20260620-001",
      status: "issued",
      createdAt: "2026-06-20T12:00:00.000Z",
      issuedAt: "2026-06-20T12:00:00.000Z",
      issuedByUserId: "user-1",
      paymentMode: "cash",
      amountPaid: 300,
      amountDue: 0,
      subtotal: 300,
      totalDiscountAmount: 0,
      billDiscountAmount: 0,
      roundOffEnabled: false,
      roundOffAmount: 0,
      total: 300,
      lineDiscounts: [],
      lines: [],
      receiptType: "digital"
    },
    bills: [],
    payments: [],
    stockMovements: [],
    auditLogs: [],
    customers: [],
    sessions: [],
    customerTabs: [],
    inventoryItems: []
  };
}

describe("financial checkout RPC client", () => {
  it("builds the compact checkout RPC envelope", () => {
    const patch = createPatch();

    expect(buildFinancialCheckoutRpcPayload(patch, "org-primary")).toEqual({
      organization_id: "org-primary",
      mutation_id: "financial-1",
      mutation_kind: "commitCheckoutBill",
      entity_type: "session",
      entity_id: "session-1",
      user_id: "user-1",
      client_created_at: "2026-06-20T12:00:00.000Z",
      base_app_state_version: 8,
      payload: {
        mode: "session",
        bill: patch.bill,
        bills: [],
        payments: [],
        stockMovements: [],
        auditLogs: [],
        customers: [],
        sessions: [],
        customerTabs: [],
        inventoryItems: []
      }
    });
  });

  it("maps snake_case RPC result fields", () => {
    const patch = createPatch();

    expect(
      mapFinancialCheckoutRpcResult({
        patch,
        organizationId: "org-primary",
        data: {
          mutation_id: "financial-1",
          organization_id: "org-primary",
          entity_type: "session",
          entity_id: "session-1",
          bill_id: "bill-1",
          bill_number: "BILL-20260620-001",
          app_state_version: 9,
          event_id: "event-1",
          server_time: "2026-06-20T12:00:01.000Z",
          server_duration_ms: 842.5,
          changed_rows: { bills: ["bill-1"] }
        }
      })
    ).toMatchObject({
      mutationId: "financial-1",
      rpcName: "commit_checkout_bill",
      organizationId: "org-primary",
      entityType: "session",
      entityId: "session-1",
      billId: "bill-1",
      billNumber: "BILL-20260620-001",
      appStateVersion: 9,
      eventId: "event-1",
      serverTime: "2026-06-20T12:00:01.000Z",
      serverDurationMs: 842.5,
      changedRows: { bills: ["bill-1"] }
    });
  });
});
