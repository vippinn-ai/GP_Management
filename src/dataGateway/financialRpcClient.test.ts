import { describe, expect, it, vi } from "vitest";
import {
  buildFinancialAdjustmentRpcPayload,
  buildFinancialAdjustmentV2RpcPayload,
  buildFinancialCheckoutRpcPayload,
  buildFinancialCheckoutV2RpcPayload,
  invokeFinancialCheckoutRpc,
  mapFinancialAdjustmentRpcResult,
  mapFinancialCheckoutRpcResult
} from "./financialRpcClient";
import type { FinancialAdjustmentPatch, FinancialCheckoutPatch } from "./types";

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

function createAdjustmentPatch(): FinancialAdjustmentPatch {
  return {
    mutationId: "financial-adjustment-1",
    kind: "settlePendingBills",
    entityType: "bill_group",
    entityId: "bill-1,bill-2",
    userId: "user-1",
    createdAt: "2026-06-20T12:05:00.000Z",
    baseAppStateVersion: 9,
    bills: [
      {
        ...createPatch().bill,
        id: "bill-1",
        billNumber: "BILL-20260620-001",
        status: "issued",
        amountPaid: 300,
        amountDue: 0
      }
    ],
    payments: [
      {
        id: "payment-1",
        billId: "bill-1",
        mode: "cash",
        amount: 300,
        createdAt: "2026-06-20T12:05:00.000Z",
        receivedByUserId: "user-1"
      }
    ],
    stockMovements: [],
    auditLogs: [],
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

  it("builds the compact replacement checkout RPC envelope", () => {
    const patch: FinancialCheckoutPatch = {
      ...createPatch(),
      mutationId: "financial-replacement-1",
      mode: "bill_replacement",
      entityType: "bill",
      entityId: "bill-original",
      bill: {
        ...createPatch().bill,
        id: "bill-replacement",
        billNumber: "BILL-20260620-011",
        replacementOfBillId: "bill-original",
        replaceReason: "Corrected quantity"
      },
      bills: [
        {
          ...createPatch().bill,
          id: "bill-replacement",
          billNumber: "BILL-20260620-011",
          replacementOfBillId: "bill-original",
          replaceReason: "Corrected quantity"
        },
        {
          ...createPatch().bill,
          id: "bill-original",
          billNumber: "BILL-20260620-010",
          status: "replaced",
          replacedByBillId: "bill-replacement"
        }
      ]
    };

    expect(buildFinancialCheckoutRpcPayload(patch, "org-primary")).toMatchObject({
      organization_id: "org-primary",
      mutation_id: "financial-replacement-1",
      mutation_kind: "commitCheckoutBill",
      entity_type: "bill",
      entity_id: "bill-original",
      payload: {
        mode: "bill_replacement",
        bill: {
          id: "bill-replacement",
          replacementOfBillId: "bill-original",
          replaceReason: "Corrected quantity"
        }
      }
    });
  });

  it("builds a v2 checkout command without client-trusted actor or app-state fields", () => {
    const patch: FinancialCheckoutPatch = {
      ...createPatch(),
      sourceSessionIds: ["session-1", "session-hop-1"],
      settlementExpectations: [
        {
          billId: "bill-pending",
          expectedStatus: "pending",
          expectedAmountDue: 50,
          intendedAmountDue: 0,
          settlementAmount: 50
        }
      ],
      inventoryExpectations: [
        { itemId: "item-1", expectedStockQty: 3, intendedStockQty: 2, delta: -1 }
      ],
      payments: [
        {
          id: "payment-1",
          billId: "bill-1",
          mode: "cash",
          amount: 300,
          createdAt: "2026-06-20T12:00:00.000Z",
          receivedByUserId: "spoofed-user"
        }
      ]
    };

    const payload = buildFinancialCheckoutV2RpcPayload(patch, "org-primary");

    expect(payload).not.toHaveProperty("user_id");
    expect(payload).not.toHaveProperty("base_app_state_version");
    expect(payload.payload.primary_bill).not.toHaveProperty("issuedByUserId");
    expect(payload.payload.payments[0]).not.toHaveProperty("receivedByUserId");
    expect(payload.payload.source_session_ids).toEqual(["session-1", "session-hop-1"]);
    expect(payload.payload.settlement_expectations).toEqual(patch.settlementExpectations);
    expect(payload.payload.inventory_expectations).toEqual(patch.inventoryExpectations);
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

  it("builds the compact financial adjustment RPC envelope", () => {
    const patch = createAdjustmentPatch();

    expect(buildFinancialAdjustmentRpcPayload(patch, "org-primary")).toEqual({
      organization_id: "org-primary",
      mutation_id: "financial-adjustment-1",
      mutation_kind: "settlePendingBills",
      entity_type: "bill_group",
      entity_id: "bill-1,bill-2",
      user_id: "user-1",
      client_created_at: "2026-06-20T12:05:00.000Z",
      base_app_state_version: 9,
      payload: {
        bills: patch.bills,
        payments: patch.payments,
        stockMovements: [],
        auditLogs: [],
        inventoryItems: []
      }
    });
  });

  it("maps financial adjustment RPC result fields", () => {
    const patch = createAdjustmentPatch();

    expect(
      mapFinancialAdjustmentRpcResult({
        patch,
        organizationId: "org-primary",
        data: {
          mutation_id: "financial-adjustment-1",
          mutation_kind: "settlePendingBills",
          organization_id: "org-primary",
          entity_type: "bill_group",
          entity_id: "bill-1,bill-2",
          app_state_version: 10,
          event_id: "event-2",
          server_time: "2026-06-20T12:05:01.000Z",
          server_duration_ms: 91.25,
          changed_rows: { bills: ["bill-1"], payments: ["payment-1"] }
        }
      })
    ).toMatchObject({
      mutationId: "financial-adjustment-1",
      rpcName: "commit_financial_adjustment",
      organizationId: "org-primary",
      kind: "settlePendingBills",
      entityType: "bill_group",
      entityId: "bill-1,bill-2",
      appStateVersion: 10,
      eventId: "event-2",
      serverTime: "2026-06-20T12:05:01.000Z",
      serverDurationMs: 91.25,
      changedRows: { bills: ["bill-1"], payments: ["payment-1"] }
    });
  });

  it("builds a v2 adjustment command without client-trusted actors", () => {
    const patch = createAdjustmentPatch();
    const payload = buildFinancialAdjustmentV2RpcPayload(patch, "org-primary");

    expect(payload).not.toHaveProperty("user_id");
    expect(payload).not.toHaveProperty("base_app_state_version");
    expect(payload.payload.bill_updates[0]).not.toHaveProperty("issuedByUserId");
    expect(payload.payload.payments[0]).not.toHaveProperty("receivedByUserId");
  });

  it("reconciles a lost v2 response by the same mutation ID instead of issuing again", async () => {
    const patch = createPatch();
    const rpc = vi
      .fn()
      .mockReturnValueOnce(Promise.reject(new Error("connection closed after commit")))
      .mockResolvedValueOnce({
        data: {
          mutation_id: patch.mutationId,
          organization_id: "org-primary",
          entity_type: patch.entityType,
          entity_id: patch.entityId,
          bill_id: patch.bill.id,
          bill_number: patch.bill.billNumber,
          event_id: "event-recovered"
        },
        error: null
      });

    await expect(
      invokeFinancialCheckoutRpc(patch, {
        organizationId: "org-primary",
        client: { rpc } as never,
        useV2: true
      })
    ).resolves.toMatchObject({
      mutationId: patch.mutationId,
      rpcName: "commit_checkout_bill_v2",
      eventId: "event-recovered"
    });

    expect(rpc).toHaveBeenNthCalledWith(1, "commit_checkout_bill_v2", { payload: expect.any(Object) });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_financial_mutation_result", {
      payload: {
        organization_id: "org-primary",
        mutation_id: patch.mutationId,
        mutation_kind: "commitCheckoutBill"
      }
    });
  });
});
