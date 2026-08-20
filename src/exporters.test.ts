import { describe, expect, it } from "vitest";
import { pdfSafeText } from "./exporters";

describe("pdfSafeText", () => {
  it("uses a Helvetica-safe rupee label for PDF receipt amounts", () => {
    expect(pdfSafeText("₹20.00")).toBe("Rs 20.00");
    expect(pdfSafeText("2 × ₹10.00")).toBe("2 × Rs 10.00");
    expect(pdfSafeText("₹10.00 / ₹0.00")).toBe("Rs 10.00 / Rs 0.00");
  });

  it("does not alter non-currency receipt text", () => {
    expect(pdfSafeText("BILL-20260820-003")).toBe("BILL-20260820-003");
  });
});
