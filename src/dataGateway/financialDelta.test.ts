import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(() => ({ id: "client" })),
  resolveNormalizedOrganizationId: vi.fn(),
  loadNormalizedBillsByIds: vi.fn(),
  loadNormalizedCustomersByIds: vi.fn(),
  loadNormalizedInventoryItemsByIds: vi.fn(),
  loadNormalizedLiveDataByIds: vi.fn(),
  loadNormalizedStockMovementsByIds: vi.fn(),
  loadNormalizedAuditLogsByIds: vi.fn()
}));

vi.mock("../backend", () => ({ getSupabaseClient: mocks.getSupabaseClient }));
vi.mock("./normalizedOrganization", () => ({
  resolveNormalizedOrganizationId: mocks.resolveNormalizedOrganizationId
}));
vi.mock("./normalizedBillRegister", () => ({
  loadNormalizedBillsByIds: mocks.loadNormalizedBillsByIds
}));
vi.mock("./normalizedCustomerSearch", () => ({
  loadNormalizedCustomersByIds: mocks.loadNormalizedCustomersByIds
}));
vi.mock("./normalizedReads", () => ({
  loadNormalizedInventoryItemsByIds: mocks.loadNormalizedInventoryItemsByIds,
  loadNormalizedLiveDataByIds: mocks.loadNormalizedLiveDataByIds,
  loadNormalizedStockMovementsByIds: mocks.loadNormalizedStockMovementsByIds,
  loadNormalizedAuditLogsByIds: mocks.loadNormalizedAuditLogsByIds
}));

import { loadNormalizedFinancialDelta } from "./financialDelta";

describe("loadNormalizedFinancialDelta", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSupabaseClient.mockReturnValue({ id: "client" });
    mocks.resolveNormalizedOrganizationId.mockResolvedValue("org-1");
    mocks.loadNormalizedBillsByIds.mockResolvedValue({ bills: [{ id: "bill-1" }], payments: [{ id: "pay-1" }] });
    mocks.loadNormalizedLiveDataByIds.mockResolvedValue({ sessions: [], sessionPauseLogs: [], customerTabs: [] });
    mocks.loadNormalizedInventoryItemsByIds.mockResolvedValue([{ id: "item-1" }]);
    mocks.loadNormalizedCustomersByIds.mockResolvedValue([{ id: "customer-1" }]);
    mocks.loadNormalizedStockMovementsByIds.mockResolvedValue([{ id: "stock-1" }]);
    mocks.loadNormalizedAuditLogsByIds.mockResolvedValue([{ id: "audit-1" }]);
  });

  it("hydrates every server-canonical collection changed by a financial mutation", async () => {
    const result = await loadNormalizedFinancialDelta({
      billIds: ["bill-1"], paymentIds: ["pay-1"], sessionIds: ["session-1"],
      customerTabIds: ["tab-1"], inventoryItemIds: ["item-1"], customerIds: ["customer-1"],
      stockMovementIds: ["stock-1"], auditLogIds: ["audit-1"]
    });

    expect(mocks.loadNormalizedCustomersByIds).toHaveBeenCalledWith("org-1", ["customer-1"], { id: "client" });
    expect(mocks.loadNormalizedStockMovementsByIds).toHaveBeenCalledWith("org-1", ["stock-1"], { id: "client" });
    expect(mocks.loadNormalizedAuditLogsByIds).toHaveBeenCalledWith("org-1", ["audit-1"], { id: "client" });
    expect(result).toMatchObject({
      bills: [{ id: "bill-1" }], payments: [{ id: "pay-1" }], inventoryItems: [{ id: "item-1" }],
      customers: [{ id: "customer-1" }], stockMovements: [{ id: "stock-1" }], auditLogs: [{ id: "audit-1" }]
    });
  });
});
