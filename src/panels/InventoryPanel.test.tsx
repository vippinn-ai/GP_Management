import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InventoryPanel } from "./InventoryPanel";

describe("InventoryPanel normalized report reads", () => {
  it("fails closed and retries without rendering cached stock totals or rows", () => {
    const onRefresh = vi.fn();
    const props = {
      inventoryItems: [],
      stockMovements: [],
      itemForm: { category: "Beverages" },
      editItemForm: null,
      useCustomItemCategory: false,
      customItemCategory: "",
      useCustomEditItemCategory: false,
      customEditItemCategory: "",
      inventoryAction: { itemId: "", quantity: 1, reason: "" },
      inventoryItemSearch: "",
      inventoryArchiveView: "active",
      activeInventoryCount: 0,
      archivedInventoryCount: 0,
      inventoryArchiveDraft: null,
      inventoryReport: {
        summary: {
          added: 0,
          deducted: 987,
          manualAdjustments: 0,
          reversals: 0,
          netChange: -987,
          reserved: 0,
          touchedItems: 1
        },
        rows: [{ itemId: "stale-item", itemName: "STALE STOCK ROW" }],
        details: [],
        detailsTruncated: false
      },
      inventoryReportFilter: { preset: "today" },
      inventoryReportFromDate: "2026-08-20",
      inventoryReportToDate: "2026-08-20",
      inventoryReportRangeLabel: "Today",
      inventoryReportSearch: "",
      inventoryReportBackend: {
        enabled: true,
        ready: true,
        loading: false,
        error: "Backend inventory read failed.",
        onRefresh
      },
      combos: [],
      comboDraft: {
        id: "",
        name: "",
        type: "game",
        active: true,
        stationIds: [],
        price: 0,
        includedMinutes: 60,
        fixedItems: [],
        choiceGroups: [],
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z"
      },
      stations: [],
      sellableOptions: [],
      filteredInventoryItems: [],
      inventoryCategoryOptions: [],
      canEditInventory: true,
      isManagerReadOnly: false,
      getInventoryState: vi.fn(),
      getInventoryStateLabel: vi.fn(),
      getAvailableStock: vi.fn(),
      onItemFormChange: vi.fn(),
      onEditItemFormChange: vi.fn(),
      onUseCustomItemCategoryChange: vi.fn(),
      onCustomItemCategoryChange: vi.fn(),
      onUseCustomEditItemCategoryChange: vi.fn(),
      onCustomEditItemCategoryChange: vi.fn(),
      onInventoryActionChange: vi.fn(),
      onInventoryItemSearchChange: vi.fn(),
      onInventoryArchiveViewChange: vi.fn(),
      onInventoryReportFilterChange: vi.fn(),
      onInventoryReportSearchChange: vi.fn(),
      onInventoryPanelViewChange: vi.fn(),
      onComboDraftChange: vi.fn(),
      onSaveCombo: vi.fn(),
      onEditCombo: vi.fn(),
      onToggleComboActive: vi.fn(),
      onArchiveDraftReasonChange: vi.fn(),
      onUpsertInventoryItem: vi.fn(),
      onSaveEditedInventoryItem: vi.fn(),
      onCloseEditInventoryModal: vi.fn(),
      onBeginEditInventoryItem: vi.fn(),
      onBeginArchiveInventoryItem: vi.fn(),
      onCloseArchiveInventoryModal: vi.fn(),
      onArchiveInventoryItem: vi.fn(),
      onRestoreInventoryItem: vi.fn(),
      onRecordStockMovement: vi.fn()
    } as unknown as Parameters<typeof InventoryPanel>[0];

    render(<InventoryPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Inventory Report" }));

    expect(screen.getByText(/Inventory report data is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Stock Deducted")).not.toBeInTheDocument();
    expect(screen.queryByText("STALE STOCK ROW")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
