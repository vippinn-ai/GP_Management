import { describe, expect, it } from "vitest";
import { mapInventoryReportSummaryData } from "./inventoryReportSummary";

describe("inventory report summary mapping", () => {
  it("maps compact inventory report payloads", () => {
    const result = mapInventoryReportSummaryData({
      summary: {
        added: "100",
        deducted: "16",
        manual_adjustments: "-2",
        reversals: "8",
        net_change: "90",
        reserved: "8",
        touched_items: "2"
      },
      rows: [
        {
          item_id: "item-1",
          item_name: "Paneer Momo",
          category: "Food",
          active: true,
          added: "100",
          deducted: "16",
          manual_adjustments: "-2",
          reversals: "8",
          net_change: "90",
          current_stock: "92",
          reserved: "8",
          movement_count: "4"
        }
      ],
      details: [
        {
          id: "movement-1",
          business_date: "2026-06-28",
          created_at: "2026-06-28T09:00:00.000Z",
          item_id: "item-1",
          item_name: "Paneer Momo",
          category: "Food",
          type: "sale",
          quantity: "-8",
          reason: "Issued BILL-001",
          related_bill_id: "bill-1",
          related_bill_number: "BILL-001"
        }
      ],
      detail_limit: "500",
      details_truncated: "true"
    });

    expect(result.summary).toEqual({
      added: 100,
      deducted: 16,
      manualAdjustments: -2,
      reversals: 8,
      netChange: 90,
      reserved: 8,
      touchedItems: 2
    });
    expect(result.rows[0]).toMatchObject({
      itemId: "item-1",
      itemName: "Paneer Momo",
      active: true,
      currentStock: 92,
      movementCount: 4
    });
    expect(result.details[0]).toMatchObject({
      id: "movement-1",
      type: "sale",
      quantity: -8,
      relatedBillNumber: "BILL-001"
    });
    expect(result.detailLimit).toBe(500);
    expect(result.detailsTruncated).toBe(true);
    expect(result.payloadBytes).toBeGreaterThan(0);
  });
});
