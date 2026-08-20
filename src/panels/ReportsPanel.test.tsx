import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { exportRowsToCsv, exportRowsToPdf, exportRowsToXlsx } from "../exporters";
import { ReportsPanel } from "./ReportsPanel";

vi.mock("../exporters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../exporters")>();
  return {
    ...actual,
    exportRowsToCsv: vi.fn(),
    exportRowsToPdf: vi.fn(),
    exportRowsToXlsx: vi.fn()
  };
});

describe("ReportsPanel normalized reads", () => {
  it("fails closed and retries without rendering cached financial totals", () => {
    const onRefresh = vi.fn();
    const props = {
      stations: [],
      businessProfile: {},
      reportFilter: { preset: "today" },
      reportFromDate: "2026-08-20",
      reportToDate: "2026-08-20",
      resolvedReportRangeLabel: "Today",
      filteredBills: [],
      filteredExpenses: [],
      expenseTemplates: [],
      expenseTemplateOverrides: [],
      pendingBackfillTemplateId: null,
      reportRows: [],
      summary: { grossRevenue: 98765 },
      expenseForm: {},
      expenseTemplateForm: {},
      expenseCategoryOptions: [],
      allPendingReceivables: [],
      canCreateExpenses: true,
      canDeleteExpenses: true,
      canManageExpenseTemplates: true,
      isManagerReadOnly: false,
      normalizedReports: {
        enabled: true,
        ready: true,
        loading: false,
        error: "Backend report read failed.",
        onRefresh
      }
    } as unknown as Parameters<typeof ReportsPanel>[0];

    render(<ReportsPanel {...props} />);

    expect(screen.getByText(/Report data is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Gross Revenue")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export Excel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export PDF" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("exports the active normalized report range in CSV, Excel, and PDF formats", () => {
    const reportRows = [{
      billNumber: "BILL-20260820-006",
      date: "20/08/2026, 3:10 pm",
      station: "PlayStation 5",
      customer: "Release A QA",
      paymentMode: "cash",
      total: 10,
      status: "paid"
    }];
    const props = {
      stations: [],
      businessProfile: { name: "BreakPerfect" },
      reportFilter: { preset: "today" },
      reportFromDate: "2026-08-20",
      reportToDate: "2026-08-20",
      resolvedReportRangeLabel: "Today",
      filteredBills: [],
      filteredExpenses: [],
      expenseTemplates: [],
      expenseTemplateOverrides: [],
      pendingBackfillTemplateId: null,
      reportRows,
      summary: {
        grossRevenue: 10,
        netCashEarnings: 10,
        normalizedNetProfit: 10,
        issuedBillsCount: 1,
        oneTimeExpenses: 0,
        normalizedExpenses: 0,
        sessionRevenue: 10,
        itemRevenue: 0,
        totalDiscounts: 0,
        pendingRevenue: 0,
        deferredOutstanding: 0,
        previousRangeLabel: "Yesterday",
        previousRangeRevenue: 0,
        revenueGrowthPct: null,
        averageBillValue: 10,
        topStation: null,
        paymentModeTotals: { cash: 10, upi: 0 },
        expensePaymentModeTotals: { cash: 0, upi: 0, unknown: 0 },
        expenseByCategory: [],
        normalizedExpenseByCategory: [],
        normalizedExpenseDetails: []
      },
      expenseForm: {},
      expenseTemplateForm: {},
      expenseCategoryOptions: [],
      allPendingReceivables: [],
      canCreateExpenses: true,
      canDeleteExpenses: true,
      canManageExpenseTemplates: true,
      isManagerReadOnly: false,
      normalizedReports: {
        enabled: true,
        ready: true,
        loading: false,
        error: "",
        onRefresh: vi.fn()
      }
    } as unknown as Parameters<typeof ReportsPanel>[0];

    render(<ReportsPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Excel" }));
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));

    expect(exportRowsToCsv).toHaveBeenCalledWith(reportRows, "report-2026-08-20-2026-08-20.csv");
    expect(exportRowsToXlsx).toHaveBeenCalledWith(reportRows, "report-2026-08-20-2026-08-20.xlsx");
    expect(exportRowsToPdf).toHaveBeenCalledWith(reportRows, "report-2026-08-20-2026-08-20.pdf", "BreakPerfect");
  });
});
