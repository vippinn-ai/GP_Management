import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomersPanel } from "./CustomersPanel";

function renderCustomersPanel(overrides: Partial<Parameters<typeof CustomersPanel>[0]> = {}) {
  const props: Parameters<typeof CustomersPanel>[0] = {
    stations: [],
    customerAnalytics: {
      stats: [],
      topSpend: undefined,
      topVisits: undefined,
      totalProfiles: 0,
      repeatCustomersCount: 0,
      repeatRate: 0,
      averageSpendPerCustomer: 0,
      oneTimeCustomersCount: 0,
      activeCustomersCount: 0,
      mostPlayedStation: undefined,
      peakHourLabel: "No data",
      peakWeekdayLabel: "No data",
      recentHighValueCustomers: [],
      atRiskCustomers: []
    },
    filteredCustomerProfiles: [],
    selectedCustomerProfile: null,
    selectedCustomerProfileStats: null,
    customerProfileSearch: "",
    customerProfileSort: "last_visit",
    editCustomerProfileDraft: null,
    onCustomerProfileSearchChange: vi.fn(),
    onCustomerProfileSortChange: vi.fn(),
    onSelectCustomerProfile: vi.fn(),
    onEditCustomerProfileDraftChange: vi.fn(),
    onBeginEditCustomerProfile: vi.fn(),
    onSaveCustomerProfile: vi.fn(),
    ...overrides
  };
  render(<CustomersPanel {...props} />);
  return props;
}

describe("CustomersPanel normalized history", () => {
  it("fails closed and retries instead of rendering stale analytics", () => {
    const onRefresh = vi.fn();
    renderCustomersPanel({
      customerAnalytics: {
        stats: [], topSpend: undefined, topVisits: undefined, totalProfiles: 999,
        repeatCustomersCount: 0, repeatRate: 0, averageSpendPerCustomer: 0,
        oneTimeCustomersCount: 0, activeCustomersCount: 0, mostPlayedStation: undefined,
        peakHourLabel: "No data", peakWeekdayLabel: "No data",
        recentHighValueCustomers: [], atRiskCustomers: []
      },
      normalizedHistory: {
        enabled: true,
        ready: false,
        loading: false,
        error: "Backend read failed.",
        onRefresh
      }
    });

    expect(screen.getByText(/Cached financial data is hidden/)).toBeInTheDocument();
    expect(screen.queryByText("999")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
