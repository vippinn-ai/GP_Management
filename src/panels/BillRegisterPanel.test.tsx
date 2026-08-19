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
        ready: true,
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
        ready: true,
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

  it("fails closed with a retry action when normalized history is unavailable", () => {
    const onRefresh = vi.fn();
    renderBillRegisterPanel({
      bills: [{ id: "stale-bill", billNumber: "STALE" } as never],
      normalizedHistory: {
        enabled: true,
        ready: false,
        loading: false,
        loadingMore: false,
        error: "Backend read failed.",
        hasMore: false,
        onQueryChange: vi.fn(),
        onLoadMore: vi.fn(),
        onRefresh
      }
    });

    expect(screen.getByText(/Bill register data is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("STALE")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
