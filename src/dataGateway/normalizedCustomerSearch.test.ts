import { describe, expect, it } from "vitest";
import {
  buildCustomerSearchFilter,
  buildNormalizedCustomerBillVisitAt,
  dedupeNormalizedCustomerHistoryPayments,
  mapNormalizedCustomer
} from "./normalizedCustomerSearch";

describe("normalized customer search filters", () => {
  it("builds a sanitized name and phone search filter", () => {
    expect(buildCustomerSearchFilter(" Vipin, 8800 ")).toBe("name.ilike.%Vipin%8800%,phone.ilike.%8800%");
  });

  it("returns no filter for blank or unsupported search text", () => {
    expect(buildCustomerSearchFilter(" ,,, ")).toBe("");
  });
});

describe("normalized customer search row mapping", () => {
  it("maps normalized customer rows into the current customer model", () => {
    expect(
      mapNormalizedCustomer({
        id: "customer-1",
        name: "Vipin",
        phone: "8800",
        first_seen_at: "2026-06-01T07:00:00.000Z",
        last_visit_at: "2026-06-20T10:00:00.000Z",
        notes: "Regular",
        raw_data: null,
        created_at: "2026-06-01T07:00:00.000Z",
        updated_at: "2026-06-20T10:00:00.000Z"
      })
    ).toEqual({
      id: "customer-1",
      name: "Vipin",
      phone: "8800",
      createdAt: "2026-06-01T07:00:00.000Z",
      lastVisitAt: "2026-06-20T10:00:00.000Z",
      notes: "Regular"
    });
  });

  it("uses raw-data date fallbacks for legacy customer rows", () => {
    expect(
      mapNormalizedCustomer({
        id: "customer-legacy",
        name: "Walk-in customer",
        phone: null,
        first_seen_at: null,
        last_visit_at: null,
        notes: null,
        raw_data: {
          name: "Legacy Customer",
          createdAt: "2026-05-01T07:00:00.000Z",
          lastVisitAt: "2026-05-02T07:00:00.000Z"
        },
        created_at: "2026-06-01T07:00:00.000Z",
        updated_at: "2026-06-02T07:00:00.000Z"
      })
    ).toMatchObject({
      id: "customer-legacy",
      name: "Walk-in customer",
      createdAt: "2026-05-01T07:00:00.000Z",
      lastVisitAt: "2026-05-02T07:00:00.000Z"
    });
  });
});

describe("normalized customer history activity", () => {
  it("preserves session and tab visit times instead of substituting bill issue time", () => {
    const bills = [
      { id: "replacement", sessionId: "session-original", issuedAt: "2026-08-20T18:00:00.000Z" },
      { id: "session-bill", issuedAt: "2026-08-20T17:00:00.000Z" },
      { id: "tab-bill", issuedAt: "2026-08-20T16:00:00.000Z" },
      { id: "tab-carryover-bill", issuedAt: "2026-08-20T15:30:00.000Z" },
      { id: "counter-bill", issuedAt: "2026-08-20T15:00:00.000Z" }
    ] as never;

    expect(buildNormalizedCustomerBillVisitAt(
      bills,
      [
        { id: "session-original", started_at: "2026-08-20T10:00:00.000Z", closed_bill_id: "original-bill" },
        { id: "session-direct", started_at: "2026-08-20T11:00:00.000Z", closed_bill_id: "session-bill" },
        { id: "session-carried", started_at: "2026-08-20T09:00:00.000Z", closed_bill_id: "tab-carryover-bill" }
      ],
      [
        { opened_at: "2026-08-20T12:00:00.000Z", closed_bill_id: "tab-bill" },
        { opened_at: "2026-08-20T13:00:00.000Z", closed_bill_id: "tab-carryover-bill" }
      ]
    )).toEqual({
      replacement: "2026-08-20T10:00:00.000Z",
      "session-bill": "2026-08-20T11:00:00.000Z",
      "tab-bill": "2026-08-20T12:00:00.000Z",
      "tab-carryover-bill": "2026-08-20T13:00:00.000Z",
      "counter-bill": "2026-08-20T15:00:00.000Z"
    });
  });

  it("fails closed when an explicitly linked session is missing", () => {
    expect(() => buildNormalizedCustomerBillVisitAt(
      [{ id: "bill-orphaned", sessionId: "session-missing", issuedAt: "2026-08-20T18:00:00.000Z" }] as never,
      [],
      []
    )).toThrow(/missing linked session session-missing for bill bill-orphaned/i);
  });

  it("deduplicates a settlement payment returned on checkout and source-bill pages", () => {
    expect(dedupeNormalizedCustomerHistoryPayments([
      { id: "payment-settlement", billId: "bill-old", amount: 25, relatedCheckoutBillId: "bill-new" },
      { id: "payment-current", billId: "bill-new", amount: 75 },
      { id: "payment-settlement", billId: "bill-old", amount: 25, relatedCheckoutBillId: "bill-new" }
    ] as never).map((payment) => payment.id)).toEqual(["payment-settlement", "payment-current"]);
  });
});
