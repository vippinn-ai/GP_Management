import { describe, expect, it } from "vitest";
import {
  buildBillRegisterCursorFilter,
  buildBillRegisterSearchFilter,
  buildNormalizedBillRegisterPage,
  mapNormalizedBill,
  mapNormalizedBillLine,
  mapNormalizedPayment
} from "./normalizedBillRegister";

describe("normalized bill register filters", () => {
  it("builds a keyset cursor filter for descending issued_at and id pagination", () => {
    expect(buildBillRegisterCursorFilter({ issuedAt: "2026-06-20T10:00:00.000Z", id: "bill-2" })).toBe(
      "issued_at.lt.2026-06-20T10:00:00.000Z,and(issued_at.eq.2026-06-20T10:00:00.000Z,id.lt.bill-2)"
    );
  });

  it("builds a sanitized search OR filter for bill number, customer name, and phone", () => {
    expect(buildBillRegisterSearchFilter(" Vipin, 8800 ")).toBe(
      "bill_number.ilike.%Vipin%8800%,customer_name.ilike.%Vipin%8800%,customer_phone.ilike.%Vipin%8800%"
    );
  });
});

describe("normalized bill register row mapping", () => {
  it("maps bill lines and payments into current app models", () => {
    expect(
      mapNormalizedBillLine({
        bill_id: "bill-1",
        id: "line-1",
        type: "inventory_item",
        description: "Momo Plate",
        quantity: "2",
        unit_price: "80",
        subtotal: "160",
        discount_amount: "10",
        total: "150",
        linked_session_id: null,
        inventory_item_id: "item-momo",
        sold_as_pack_of: null,
        sale_variant_id: "variant-plate",
        stock_units_per_sale: "8",
        combo_application_id: null,
        combo_id: null,
        raw_data: null
      })
    ).toEqual({
      id: "line-1",
      type: "inventory_item",
      description: "Momo Plate",
      quantity: 2,
      unitPrice: 80,
      subtotal: 160,
      discountAmount: 10,
      total: 150,
      linkedSessionId: undefined,
      inventoryItemId: "item-momo",
      soldAsPackOf: undefined,
      saleVariantId: "variant-plate",
      stockUnitsPerSale: 8,
      comboApplicationId: undefined,
      comboId: undefined
    });

    expect(
      mapNormalizedPayment({
        id: "payment-1",
        bill_id: "bill-1",
        mode: "upi",
        amount: "150",
        paid_at: "2026-06-20T10:05:00.000Z",
        received_by_user_id: "user-1",
        settlement_group_id: null,
        related_checkout_bill_id: null,
        raw_data: null
      })
    ).toEqual({
      id: "payment-1",
      billId: "bill-1",
      mode: "upi",
      amount: 150,
      createdAt: "2026-06-20T10:05:00.000Z",
      receivedByUserId: "user-1",
      settlementGroupId: undefined,
      relatedCheckoutBillId: undefined
    });
  });

  it("maps bill rows and preserves optional status metadata", () => {
    expect(
      mapNormalizedBill({
        id: "bill-1",
        bill_number: "BILL-20260620-001",
        status: "pending",
        created_at_source: "2026-06-20T10:00:00.000Z",
        issued_at: "2026-06-20T10:01:00.000Z",
        issued_by_user_id: "user-1",
        customer_id: "customer-1",
        customer_name: "Vipin",
        customer_phone: "8800",
        payment_mode: "deferred",
        station_id: null,
        session_id: null,
        amount_paid: "50",
        amount_due: "100",
        subtotal: "150",
        total_discount_amount: "0",
        bill_discount_amount: "0",
        round_off_enabled: false,
        round_off_amount: "0",
        total: "150",
        receipt_type: "digital",
        replacement_of_bill_id: null,
        replaced_by_bill_id: null,
        replaced_at: null,
        replaced_by_user_id: null,
        replace_reason: null,
        voided_at: null,
        voided_by_user_id: null,
        void_reason: null,
        settled_at: "2026-06-21T09:00:00.000Z",
        settled_by_user_id: "user-2",
        raw_data: null
      })
    ).toMatchObject({
      id: "bill-1",
      billNumber: "BILL-20260620-001",
      status: "pending",
      issuedAt: "2026-06-20T10:01:00.000Z",
      customerName: "Vipin",
      paymentMode: "deferred",
      amountPaid: 50,
      amountDue: 100,
      total: 150,
      settledAt: "2026-06-21T09:00:00.000Z",
      settledByUserId: "user-2",
      lines: [],
      lineDiscounts: []
    });
  });
});

describe("normalized bill register page model", () => {
  it("returns one extra-row-backed cursor and includes related page rows only", () => {
    const page = buildNormalizedBillRegisterPage({
      pageSize: 2,
      billRows: [
        {
          id: "bill-3",
          bill_number: "BILL-3",
          status: "issued",
          created_at_source: "2026-06-20T11:00:00.000Z",
          issued_at: "2026-06-20T11:00:00.000Z",
          issued_by_user_id: "user-1",
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          payment_mode: "cash",
          station_id: "station-1",
          session_id: "session-1",
          amount_paid: 100,
          amount_due: 0,
          subtotal: 100,
          total_discount_amount: 0,
          bill_discount_amount: 0,
          round_off_enabled: false,
          round_off_amount: 0,
          total: 100,
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
        },
        {
          id: "bill-2",
          bill_number: "BILL-2",
          status: "issued",
          created_at_source: "2026-06-20T10:00:00.000Z",
          issued_at: "2026-06-20T10:00:00.000Z",
          issued_by_user_id: "user-1",
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          payment_mode: "cash",
          station_id: "station-1",
          session_id: "session-1",
          amount_paid: 100,
          amount_due: 0,
          subtotal: 100,
          total_discount_amount: 0,
          bill_discount_amount: 0,
          round_off_enabled: false,
          round_off_amount: 0,
          total: 100,
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
        },
        {
          id: "bill-1",
          bill_number: "BILL-1",
          status: "issued",
          created_at_source: "2026-06-20T09:00:00.000Z",
          issued_at: "2026-06-20T09:00:00.000Z",
          issued_by_user_id: "user-1",
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          payment_mode: "cash",
          station_id: "station-1",
          session_id: "session-1",
          amount_paid: 100,
          amount_due: 0,
          subtotal: 100,
          total_discount_amount: 0,
          bill_discount_amount: 0,
          round_off_enabled: false,
          round_off_amount: 0,
          total: 100,
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
          bill_id: "bill-2",
          mode: "cash",
          amount: 100,
          paid_at: "2026-06-20T10:01:00.000Z",
          received_by_user_id: "user-1",
          settlement_group_id: null,
          related_checkout_bill_id: null,
          raw_data: null
        }
      ]
    });

    expect(page.bills.map((bill) => bill.id)).toEqual(["bill-3", "bill-2"]);
    expect(page.payments.map((payment) => payment.id)).toEqual(["payment-1"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({
      issuedAt: "2026-06-20T10:00:00.000Z",
      id: "bill-2"
    });
  });
});
