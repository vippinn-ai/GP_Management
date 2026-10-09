import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFinancialCheckoutPatch } from "../dataGateway/financialPatches";
import type { AppData, Bill } from "../types";
import { normalizeAppDataCustomers } from "../utils";

function createLegacyNamedSessionData(): AppData {
  return {
    users: [],
    businessProfile: {
      name: "BreakPerfect",
      logoText: "",
      address: "",
      primaryPhone: "",
      receiptFooter: "",
    },
    inventoryCategories: [],
    stations: [],
    pricingRules: [],
    sessionPauseLogs: [],
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
    customers: [],
    sessions: [
      {
        id: "legacy-session",
        stationId: "station-1",
        stationNameSnapshot: "8 Ball Pool",
        mode: "timed",
        startedAt: "2026-10-09T10:00:00.000Z",
        status: "active",
        playMode: "group",
        ltpEligible: false,
        pricingSnapshot: [],
        items: [],
        pauseLogIds: [],
        customerName: "Legacy Named Customer",
      },
    ],
  };
}

describe("legacy named-session checkout characterization", () => {
  it("documents the current synthetic-customer omission and the server guard that rejects it", () => {
    const baseAppData = normalizeAppDataCustomers(createLegacyNamedSessionData());
    const syntheticCustomer = baseAppData.customers[0];

    expect(syntheticCustomer).toMatchObject({
      name: "Legacy Named Customer",
      createdAt: baseAppData.sessions[0].startedAt,
      lastVisitAt: baseAppData.sessions[0].startedAt,
    });
    expect(baseAppData.sessions[0].customerId).toBe(syntheticCustomer.id);

    const issuedAt = "2026-10-09T10:30:00.000Z";
    const bill: Bill = {
      id: "bill-legacy",
      billNumber: "BILL-LEGACY",
      status: "issued",
      createdAt: issuedAt,
      issuedAt,
      issuedByUserId: "actor",
      customerId: syntheticCustomer.id,
      customerName: syntheticCustomer.name,
      paymentMode: "cash",
      stationId: "station-1",
      sessionId: "legacy-session",
      amountPaid: 30,
      amountDue: 0,
      subtotal: 30,
      totalDiscountAmount: 0,
      billDiscountAmount: 0,
      roundOffEnabled: false,
      roundOffAmount: 0,
      total: 30,
      lineDiscounts: [],
      lines: [],
      receiptType: "digital",
    };
    const nextAppData = structuredClone(baseAppData);
    nextAppData.bills.unshift(bill);
    Object.assign(nextAppData.sessions[0], {
      status: "closed",
      endedAt: issuedAt,
      closedBillId: bill.id,
      closeDisposition: "billed",
      customerId: syntheticCustomer.id,
      customerName: syntheticCustomer.name,
    });

    const patch = buildFinancialCheckoutPatch({
      baseAppData,
      nextAppData,
      mode: "session",
      entityId: "legacy-session",
      bill,
      baseVersion: 1,
      createdAt: issuedAt,
      userId: "actor",
      mutationId: "mutation-legacy",
    });

    expect(patch.customers).toEqual([]);
    expect(patch.bill.customerId).toBe(syntheticCustomer.id);
    expect(patch.sessions).toEqual([
      expect.objectContaining({ id: "legacy-session", customerId: syntheticCustomer.id }),
    ]);

    // This source assertion documents the checked-in contract; it does not verify an installed function or execute a database RPC.
    const financialSql = readFileSync(
      join(process.cwd(), "supabase", "phase10-financial-v2-rpcs.sql"),
      "utf8",
    );
    expect(financialSql).toContain("jsonb_array_length(v_customers) = 0 and exists");
    expect(financialSql).toContain("from public.customers as current_customer");
    expect(financialSql).toContain("'invalid_customer_scope'");
  });
});
