import { describe, expect, it } from "vitest";
import { buildNormalizedReportData, exhaustNormalizedReportPages, getLocalDateRange, getReportPaymentQueryRange, loadNormalizedReportData, mapNormalizedExpense } from "./normalizedReports";

describe("normalized report ranges", () => {
  it("loads every page instead of silently accepting the backend row cap", async () => {
    const source = Array.from({ length: 1_201 }, (_, index) => ({ id: `bill-${index + 1}` }));
    const requestedRanges: Array<[number, number]> = [];

    const rows = await exhaustNormalizedReportPages(
      async (cursor: number | undefined, limit) => {
        const from = cursor ?? 0;
        requestedRanges.push([from, from + limit - 1]);
        return { data: source.slice(from, from + limit), error: null };
      },
      "loading a large normalized report",
      (lastRow) => Number(lastRow.id.slice("bill-".length)),
      500
    );

    expect(requestedRanges).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(rows).toHaveLength(1_201);
    expect(rows.at(-1)).toEqual({ id: "bill-1201" });
  });

  it("paginates the complete report loader and retains a bill beyond the first backend page", async () => {
    const billRows = Array.from({ length: 501 }, (_, index) => {
      const id = `bill-${String(501 - index).padStart(4, "0")}`;
      return {
        id,
        bill_number: `BILL-${id.slice(5)}`,
        status: "issued",
        created_at_source: `2026-08-20T${String(15 - Math.floor(index / 60)).padStart(2, "0")}:${String(59 - (index % 60)).padStart(2, "0")}:00.000Z`,
        issued_at: `2026-08-20T${String(15 - Math.floor(index / 60)).padStart(2, "0")}:${String(59 - (index % 60)).padStart(2, "0")}:00.000Z`,
        issued_by_user_id: "user-1",
        customer_id: null,
        customer_name: "Walk-in",
        customer_phone: null,
        payment_mode: "cash",
        station_id: null,
        session_id: null,
        amount_paid: 10,
        amount_due: 0,
        subtotal: 10,
        total_discount_amount: 0,
        bill_discount_amount: 0,
        round_off_enabled: false,
        round_off_amount: 0,
        total: 10,
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
      };
    });
    const rowsById = new Map(billRows.map((row) => [row.id, row]));
    let primaryBillPage = 0;
    const primaryBillCursorFilters: string[] = [];

    const fakeClient = {
      from(table: string) {
        const state: { ids?: string[]; cursorFilter?: string; limit?: number } = {};
        const request: Record<string, unknown> = {};
        const chain = () => request;
        Object.assign(request, {
          select: chain,
          eq: chain,
          gte: chain,
          lt: chain,
          not: chain,
          order: chain,
          gt: chain,
          in: (column: string, ids: string[]) => {
            if (column === "id") state.ids = ids;
            return request;
          },
          or: (filter: string) => {
            state.cursorFilter = filter;
            return request;
          },
          limit: (limit: number) => {
            state.limit = limit;
            return request;
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
            let data: unknown[] = [];
            if (table === "bills" && state.ids) {
              data = state.ids.map((id) => rowsById.get(id)).filter(Boolean);
            } else if (table === "bills") {
              if (state.cursorFilter) primaryBillCursorFilters.push(state.cursorFilter);
              const from = primaryBillPage * (state.limit ?? 500);
              data = billRows.slice(from, from + (state.limit ?? 500));
              primaryBillPage += 1;
            }
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          }
        });
        return request;
      }
    };

    const report = await loadNormalizedReportData({
      organizationId: "org-1",
      fromDate: "2026-08-20",
      toDate: "2026-08-20"
    }, fakeClient as never);

    expect(report.bills).toHaveLength(501);
    expect(report.bills.at(-1)?.id).toBe("bill-0001");
    expect(primaryBillCursorFilters).toHaveLength(1);
    expect(primaryBillCursorFilters[0]).toContain("issued_at.lt.");
  });

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
