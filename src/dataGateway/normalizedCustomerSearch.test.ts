import { describe, expect, it } from "vitest";
import { buildCustomerSearchFilter, mapNormalizedCustomer } from "./normalizedCustomerSearch";

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
