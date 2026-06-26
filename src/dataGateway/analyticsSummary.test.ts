import { describe, expect, it } from "vitest";
import { mapAnalyticsSummaryData } from "./analyticsSummary";

describe("analytics summary mapping", () => {
  it("maps compact summary payloads and pending receivables", () => {
    const result = mapAnalyticsSummaryData({
      summary: {
        gross_revenue: "1200",
        paid_bill_count: "3",
        session_revenue: "800",
        item_revenue: "400",
        total_discounts: "50",
        pending_revenue: "300",
        deferred_outstanding: "300",
        one_time_expenses: "100",
        previous_range_revenue: "900",
        payment_mode_totals: { cash: "500", upi: "700" },
        expense_payment_mode_totals: { cash: "25", upi: "75", unknown: "0" }
      },
      top_station: { label: "8 Ball Pool", amount: "700" },
      expense_by_category: [{ category: "Kitchen", amount: "100" }],
      pending_receivables: [
        {
          bill_id: "bill-1",
          bill_number: "BILL-1",
          business_date: "2026-06-20",
          days_overdue: 2,
          customer_name: "Vipin",
          customer_phone: "8800",
          amount_paid: "100",
          amount_due: "300",
          total: "400",
          issued_at: "2026-06-20T08:00:00.000Z"
        }
      ]
    });

    expect(result.summary).toMatchObject({
      grossRevenue: 1200,
      paidBillCount: 3,
      sessionRevenue: 800,
      itemRevenue: 400,
      totalDiscounts: 50,
      pendingRevenue: 300,
      oneTimeExpenses: 100,
      paymentModeTotals: { cash: 500, upi: 700 },
      expensePaymentModeTotals: { cash: 25, upi: 75, unknown: 0 }
    });
    expect(result.topStation).toEqual(["8 Ball Pool", 700]);
    expect(result.expenseByCategory).toEqual([["Kitchen", 100]]);
    expect(result.pendingReceivables[0]).toMatchObject({
      businessDate: "2026-06-20",
      daysOverdue: 2,
      bill: {
        id: "bill-1",
        billNumber: "BILL-1",
        status: "pending",
        customerName: "Vipin",
        amountPaid: 100,
        amountDue: 300,
        total: 400
      }
    });
    expect(result.payloadBytes).toBeGreaterThan(0);
  });
});
