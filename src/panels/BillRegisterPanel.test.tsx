import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BillRegisterPanel } from "./BillRegisterPanel";

function renderBillRegisterPanel(overrides: Partial<Parameters<typeof BillRegisterPanel>[0]> = {}) {
  const props: Parameters<typeof BillRegisterPanel>[0] = {
    bills: [],
    billBusinessDates: {},
    billPaymentBusinessDates: {},
    stations: [],
    businessProfile: {
      name: "BreakPerfect",
      logoText: "BP",
      address: "",
      primaryPhone: "",
      receiptFooter: ""
    },
    selectedReceiptBillId: null,
    selectedReceiptBill: null,
    receiptPreviewModel: null,
    allBills: [],
    allPayments: [],
    receivableGroups: [],
    canReplaceIssuedBills: true,
    canVoidRefundBills: true,
    canSettlePendingBills: true,
    onSelectReceiptBill: vi.fn(),
    onSettlePendingBill: vi.fn(),
    onSettlePendingBills: vi.fn(),
    onVoidPendingBill: vi.fn(),
    onVoidPendingBills: vi.fn(),
    onOpenBillReplacement: vi.fn(),
    onVoidOrRefundBill: vi.fn(),
    ...overrides
  };

  render(<BillRegisterPanel {...props} />);
  return props;
}

describe("BillRegisterPanel normalized history", () => {
  it("emits server query changes from existing filters when normalized history is enabled", async () => {
    const onQueryChange = vi.fn();
    renderBillRegisterPanel({
      normalizedHistory: {
        enabled: true,
        loading: false,
        loadingMore: false,
        error: "",
        hasMore: false,
        onQueryChange,
        onLoadMore: vi.fn(),
        onRefresh: vi.fn()
      }
    });

    await waitFor(() => expect(onQueryChange).toHaveBeenCalledWith({}));

    fireEvent.click(screen.getByRole("button", { name: "Pending" }));
    await waitFor(() => expect(onQueryChange).toHaveBeenLastCalledWith({ status: "pending" }));

    fireEvent.change(screen.getByPlaceholderText("Search bill #, customer name or phone..."), {
      target: { value: "Vipin" }
    });
    await waitFor(() => expect(onQueryChange).toHaveBeenLastCalledWith({ search: "Vipin", status: "pending" }));
  });

  it("shows and triggers the normalized load more control", () => {
    const onLoadMore = vi.fn();
    renderBillRegisterPanel({
      normalizedHistory: {
        enabled: true,
        loading: false,
        loadingMore: false,
        error: "",
        hasMore: true,
        onQueryChange: vi.fn(),
        onLoadMore,
        onRefresh: vi.fn()
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Load More Bills" }));

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
