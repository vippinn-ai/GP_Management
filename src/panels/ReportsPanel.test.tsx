import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportsPanel } from "./ReportsPanel";

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
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
