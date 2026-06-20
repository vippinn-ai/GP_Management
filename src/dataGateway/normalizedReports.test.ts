import { describe, expect, it } from "vitest";
import { buildNormalizedReportData, getLocalDateRange, getReportPaymentQueryRange, mapNormalizedExpense } from "./normalizedReports";

describe("normalized report ranges", () => {
  it("uses the earliest comparison date and latest report date for payment reads", () => {
    const range = getReportPaymentQueryRange({
      fromDate: "2026-06-20",
      toDate: "2026-06-20",
      previousFromDate: "2026-06-19",
      previousToDate: "2026-06-19"
    });

    expect(range).toEqual({
      fromIso: new Date("2026-06-19T07:00:00").toISOString(),
      toIsoExclusive: new Date("2026-06-21T07:00:00").toISOString()
    });
  });

  it("builds an inclusive local-date expense window", () => {
    expect(getLocalDateRange("2026-06-20", "2026-06-21")).toEqual({
      fromIso: new Date("2026-06-20T00:00:00").toISOString(),
      toIsoExclusive: new Date("2026-06-22T00:00:00").toISOString()
    });
  });
});

describe("normalized report row mapping", () => {
  it("maps split one-time expense rows", () => {
    expect(
      mapNormalizedExpense({
        id: "expense-1",
        title: "Milk",
        category: "Kitchen",
        amount: "300",
        payment_mode: "split",
        cash_amount: "100",
        upi_amount: "200",
        spent_at: "2026-06-20T00:00:00.000Z",
        notes: "Morning purchase",
        created_by_user_id: "user-1",
        raw_data: null
      })
    ).toEqual({
      id: "expense-1",
      title: "Milk",
      category: "Kitchen",
      amount: 300,
      paymentMode: "split",
      cashAmount: 100,
      upiAmount: 200,
      spentAt: "2026-06-20T00:00:00.000Z",
      notes: "Morning purchase",
      createdByUserId: "user-1"
    });
  });

  it("builds report bills, payments, expenses, and session business dates", () => {
    const result = buildNormalizedReportData({
      billRows: [
        {
          id: "bill-1",
          bill_number: "BILL-1",
          status: "issued",
          created_at_source: "2026-06-20T08:00:00.000Z",
          issued_at: "2026-06-20T10:00:00.000Z",
          issued_by_user_id: "user-1",
          customer_id: "customer-1",
          customer_name: "Vipin",
          customer_phone: "8800",
          payment_mode: "cash",
          station_id: "station-1",
          session_id: "session-1",
          amount_paid: "500",
          amount_due: "0",
          subtotal: "500",
          total_discount_amount: "0",
          bill_discount_amount: "0",
          round_off_enabled: false,
          round_off_amount: "0",
          total: "500",
          receipt_type: "digital",
          replacement_of_bill_id: null,
          replaced_by_bill_id: null,
          replaced_at: null,
          replaced_by_user_id: null,
          replace_reason: null,
          voided_at: null,
          voided_by_user_id: null,
          void_reason: null,
          settled_at: null,
          settled_by_user_id: null,
          raw_data: null
        }
      ],
      paymentRows: [
        {
          id: "payment-1",
          bill_id: "bill-1",
          mode: "cash",
          amount: "500",
          paid_at: "2026-06-20T10:01:00.000Z",
          received_by_user_id: "user-1",
          settlement_group_id: null,
          related_checkout_bill_id: null,
          raw_data: null
        }
      ],
      billLineRows: [
        {
          bill_id: "bill-1",
          id: "line-1",
          type: "session_charge",
          description: "Pool session",
          quantity: "1",
          unit_price: "500",
          subtotal: "500",
          discount_amount: "0",
          total: "500",
          linked_session_id: "session-1",
          inventory_item_id: null,
          sold_as_pack_of: null,
          sale_variant_id: null,
          stock_units_per_sale: null,
          combo_application_id: null,
          combo_id: null,
          raw_data: null
        }
      ],
      billDiscountRows: [],
      billLineDiscountRows: [],
      sessionRows: [{ id: "session-1", started_at: "2026-06-20T06:30:00", closed_bill_id: "bill-1" }],
      customerTabRows: [],
      expenseRows: []
    });

    expect(result.bills[0]).toMatchObject({
      id: "bill-1",
      billNumber: "BILL-1",
      lines: [{ id: "line-1", total: 500 }]
    });
    expect(result.payments).toEqual([
      {
        id: "payment-1",
        billId: "bill-1",
        mode: "cash",
        amount: 500,
        createdAt: "2026-06-20T10:01:00.000Z",
        receivedByUserId: "user-1",
        settlementGroupId: undefined,
        relatedCheckoutBillId: undefined
      }
    ]);
    expect(result.billBusinessDates["bill-1"]).toBe("2026-06-19");
  });
});
