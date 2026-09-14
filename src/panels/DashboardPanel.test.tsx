import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "../dataGateway/activityFeed";
import { DashboardPanel } from "./DashboardPanel";

function activity(id: string): ActivityEvent {
  return {
    id,
    occurredAt: "2026-09-14T12:00:00.000Z",
    actorName: "Test Operator",
    action: "test_action",
    category: "other",
    summary: `Activity ${id}`,
    details: {},
    sourceKind: "audit_log",
    legacy: false
  };
}

function createProps() {
  return {
    stations: [], openCustomerTabs: [], recentActivity: [activity("one"), activity("two"), activity("three")],
    customers: [], inventoryItems: [], combos: [], sellableOptions: [], checkoutState: null,
    startSessionDraft: { stationId: "", customerName: "", customerPhone: "", playMode: "group", arcadeItemId: "", arcadeQuantity: 1 },
    selectedStartStation: null, arcadeInventoryItems: [], selectedArcadeStartItem: null,
    dashboardCustomerTabDraft: { customerName: "", customerPhone: "" }, lowStockItems: [], outOfStockItems: [], occupiedItems: [],
    pendingBillsCount: 0, totalAmountDue: 0, sessionPauseLogs: [], getActiveSessionForStation: vi.fn(),
    getSessionLiveTotal: vi.fn(() => 0), getPreviousHopTotalForSession: vi.fn(() => 0), getPendingDueForSession: vi.fn(() => 0),
    getPreviousHopTotalForCustomerTab: vi.fn(() => 0), getPendingDueForCustomerTab: vi.fn(() => 0),
    getPreviousHopItemCountForCustomerTab: vi.fn(() => 0), getFrozenEndAtForSession: vi.fn(), getCustomerTabTotal: vi.fn(() => 0),
    getInventoryState: vi.fn(() => "healthy"), getInventoryStateLabel: vi.fn(() => "In Stock"), getInventoryStatusDetail: vi.fn(() => ""),
    getAvailableStock: vi.fn(() => 0), getInventoryPickerDetail: vi.fn(() => ""),
    createStartSessionDraft: vi.fn(() => ({ stationId: "", customerName: "", customerPhone: "", playMode: "group", arcadeItemId: "", arcadeQuantity: 1 })),
    onStartSessionDraftChange: vi.fn(), onDashboardCustomerTabDraftChange: vi.fn(), onSetManageSessionId: vi.fn(),
    onSetShowStartSessionModal: vi.fn(), onToggleSessionPause: vi.fn(), onRejectSession: vi.fn(), onOpenSessionCheckout: vi.fn(),
    onOpenCustomerTabWorkspace: vi.fn(), onBeginCustomerTabCheckoutById: vi.fn(), onRejectCustomerTab: vi.fn(),
    onStartSession: vi.fn(), onCreateDashboardCustomerTab: vi.fn(), onShowAllActivity: vi.fn()
  } as unknown as Parameters<typeof DashboardPanel>[0];
}

describe("DashboardPanel recent activity preview", () => {
  it("renders the compact three-entry preview and preserves Show All navigation", () => {
    const props = createProps();
    const { container } = render(<DashboardPanel {...props} />);

    expect(container.querySelectorAll(".activity-timeline.is-dashboard-preview [data-activity-id]")).toHaveLength(3);
    expect(container.querySelectorAll(".activity-timeline.is-dashboard-preview .activity-event.is-compact")).toHaveLength(3);
    expect(screen.getByText("Activity one")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show All" }));
    expect(props.onShowAllActivity).toHaveBeenCalledTimes(1);
  });
});
