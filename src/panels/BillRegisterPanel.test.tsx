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

  const view = render(<BillRegisterPanel {...props} />);
  return { props, ...view };
}

describe("BillRegisterPanel normalized history", () => {
  it("emits server query changes from existing filters when normalized history is enabled", async () => {
    const onQueryChange = vi.fn();
    renderBillRegisterPanel({
      normalizedHistory: {
        enabled: true,
        initialized: true,
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
        initialized: true,
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
        initialized: false,
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

  it("keeps the focused search input mounted while a follow-up query is loading", async () => {
    const onQueryChange = vi.fn();
    const view = renderBillRegisterPanel({
      normalizedHistory: {
        enabled: true,
        initialized: true,
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
    const input = screen.getByPlaceholderText("Search bill #, customer name or phone...");
    input.focus();
    fireEvent.change(input, { target: { value: "V" } });

    await waitFor(() => expect(onQueryChange).toHaveBeenLastCalledWith({ search: "V" }));
    view.rerender(
      <BillRegisterPanel
        {...view.props}
        normalizedHistory={{
          ...view.props.normalizedHistory!,
          initialized: true,
          ready: false,
          loading: true
        }}
      />
    );

    expect(screen.getByPlaceholderText("Search bill #, customer name or phone...")).toBe(input);
    expect(input).toHaveValue("V");
    expect(input).toHaveFocus();
    expect(screen.getByText(/Normalized history refreshing/)).toBeInTheDocument();

    view.rerender(
      <BillRegisterPanel
        {...view.props}
        normalizedHistory={{
          ...view.props.normalizedHistory!,
          initialized: true,
          ready: false,
          loading: false,
          error: "Backend read failed."
        }}
      />
    );

    expect(screen.getByPlaceholderText("Search bill #, customer name or phone...")).toBe(input);
    expect(input).toHaveValue("V");
    expect(input).toHaveFocus();
    expect(screen.getByText(/Backend read failed/)).toBeInTheDocument();
  });
});
