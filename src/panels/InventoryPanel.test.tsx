import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVENTORY_CATALOG_PAGE_SIZE, InventoryPanel } from "./InventoryPanel";

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const addEventListener = vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener));
  const removeEventListener = vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener));
  const media = {
    get matches() { return matches; },
    media: "(max-width: 720px)",
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return {
    addEventListener,
    removeEventListener,
    setMatches(next: boolean) {
      matches = next;
      const event = { matches, media: media.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    }
  };
}

function createCatalogProps() {
  const item = {
    id: "item-cola",
    name: "Test Cola",
    category: "Beverages",
    price: 50,
    stockQty: 12,
    lowStockThreshold: 3,
    unit: "pcs",
    isReusable: false,
    barcode: "COLA-1",
    active: true,
    saleVariants: []
  };
  const props = {
    inventoryItems: [item], stockMovements: [], itemForm: { ...item, id: "draft", name: "" }, editItemForm: null,
    useCustomItemCategory: false, customItemCategory: "", useCustomEditItemCategory: false, customEditItemCategory: "",
    inventoryAction: { itemId: "", quantity: 1, reason: "" }, inventoryItemSearch: "", inventoryArchiveView: "active",
    activeInventoryCount: 1, archivedInventoryCount: 0, inventoryArchiveDraft: null,
    inventoryReport: { summary: { added: 0, deducted: 0, manualAdjustments: 0, reversals: 0, netChange: 0, reserved: 0, touchedItems: 0 }, rows: [], details: [], detailsTruncated: false },
    inventoryReportFilter: { preset: "today" }, inventoryReportFromDate: "2026-09-13", inventoryReportToDate: "2026-09-13",
    inventoryReportRangeLabel: "Today", inventoryReportSearch: "", inventoryPanelView: "catalog", combos: [],
    comboDraft: { id: "", name: "", type: "game", active: true, stationIds: [], price: 0, includedMinutes: 60, fixedItems: [], choiceGroups: [], createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" },
    stations: [], sellableOptions: [], filteredInventoryItems: [item], inventoryCategoryOptions: ["Beverages"],
    canEditInventory: true, isManagerReadOnly: false, getInventoryState: vi.fn(() => "in_stock"),
    getInventoryStateLabel: vi.fn(() => "In Stock"), getAvailableStock: vi.fn(() => 10),
    onItemFormChange: vi.fn(), onEditItemFormChange: vi.fn(), onUseCustomItemCategoryChange: vi.fn(), onCustomItemCategoryChange: vi.fn(),
    onUseCustomEditItemCategoryChange: vi.fn(), onCustomEditItemCategoryChange: vi.fn(), onInventoryActionChange: vi.fn(),
    onInventoryItemSearchChange: vi.fn(), onInventoryArchiveViewChange: vi.fn(), onInventoryReportFilterChange: vi.fn(),
    onInventoryReportSearchChange: vi.fn(), onInventoryPanelViewChange: vi.fn(), onComboDraftChange: vi.fn(), onSaveCombo: vi.fn(),
    onEditCombo: vi.fn(), onToggleComboActive: vi.fn(), onArchiveDraftReasonChange: vi.fn(), onUpsertInventoryItem: vi.fn(),
    onSaveEditedInventoryItem: vi.fn(), onCloseEditInventoryModal: vi.fn(), onBeginEditInventoryItem: vi.fn(),
    onBeginArchiveInventoryItem: vi.fn(), onCloseArchiveInventoryModal: vi.fn(), onArchiveInventoryItem: vi.fn(),
    onRestoreInventoryItem: vi.fn(), onRecordStockMovement: vi.fn()
  } as unknown as Parameters<typeof InventoryPanel>[0];
  return { item, props };
}

afterEach(() => vi.unstubAllGlobals());

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
      inventoryPanelView: "report",
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

    expect(screen.getByText(/Inventory report data is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Stock Deducted")).not.toBeInTheDocument();
    expect(screen.queryByText("STALE STOCK ROW")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("requests a controlled report-view transition synchronously and renders it after the parent update", () => {
    const { props } = createCatalogProps();
    const rendered = render(<InventoryPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Inventory Report" }));
    expect(props.onInventoryPanelViewChange).toHaveBeenCalledWith("report");
    expect(screen.queryByRole("heading", { name: "Inventory Report" })).not.toBeInTheDocument();

    rendered.rerender(<InventoryPanel {...props} inventoryPanelView="report" />);
    expect(screen.getByRole("heading", { name: "Inventory Report" })).toBeVisible();

    rendered.unmount();
    render(<InventoryPanel {...props} inventoryPanelView="report" />);
    expect(screen.getByRole("heading", { name: "Inventory Report" })).toBeVisible();
  });

  it("renders exactly the desktop table initially and preserves its item action", () => {
    installMatchMedia(false);
    const { item, props } = createCatalogProps();
    const { container } = render(<InventoryPanel {...props} />);

    expect(container.querySelectorAll(".inventory-table-wrap")).toHaveLength(1);
    expect(container.querySelectorAll(".inventory-mobile-list")).toHaveLength(0);
    expect(within(container.querySelector(".inventory-table-wrap")!).getAllByText(item.name)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(props.onBeginEditInventoryItem).toHaveBeenCalledWith(item);
  });

  it("renders exactly the mobile cards initially and preserves their item action", () => {
    installMatchMedia(true);
    const { item, props } = createCatalogProps();
    const { container } = render(<InventoryPanel {...props} />);

    expect(container.querySelectorAll(".inventory-table-wrap")).toHaveLength(0);
    expect(container.querySelectorAll(".inventory-mobile-list")).toHaveLength(1);
    expect(within(container.querySelector(".inventory-mobile-list")!).getAllByText(item.name)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit Item" }));
    expect(props.onBeginEditInventoryItem).toHaveBeenCalledWith(item);
  });

  it("switches desktop to mobile and back without duplicate rows and removes its listener", () => {
    const matchMedia = installMatchMedia(false);
    const { item, props } = createCatalogProps();
    const rendered = render(<InventoryPanel {...props} />);

    expect(matchMedia.addEventListener).toHaveBeenCalledTimes(1);
    act(() => matchMedia.setMatches(true));
    expect(rendered.container.querySelectorAll(".inventory-table-wrap")).toHaveLength(0);
    expect(rendered.container.querySelectorAll(".inventory-mobile-list")).toHaveLength(1);
    expect(within(rendered.container.querySelector(".inventory-mobile-list")!).getAllByText(item.name)).toHaveLength(1);
    act(() => matchMedia.setMatches(false));
    expect(rendered.container.querySelectorAll(".inventory-table-wrap")).toHaveLength(1);
    expect(rendered.container.querySelectorAll(".inventory-mobile-list")).toHaveLength(0);
    expect(within(rendered.container.querySelector(".inventory-table-wrap")!).getAllByText(item.name)).toHaveLength(1);

    rendered.unmount();
    expect(matchMedia.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("bounds a production-shape catalog while preserving pagination and full-set search", () => {
    const matchMedia = installMatchMedia(false);
    const { item, props } = createCatalogProps();
    const items = Array.from({ length: 112 }, (_, index) => ({
      ...item,
      id: `item-${String(index + 1).padStart(3, "0")}`,
      name: `Inventory Item ${String(index + 1).padStart(3, "0")}`,
      barcode: `ITEM-${index + 1}`
    }));
    const catalogProps = {
      ...props,
      inventoryItems: items,
      filteredInventoryItems: items,
      activeInventoryCount: items.length
    };
    const rendered = render(<InventoryPanel {...catalogProps} />);

    const catalogTable = within(rendered.container.querySelector(".inventory-table-wrap")!);
    expect(rendered.container.querySelectorAll(".inventory-table-wrap tbody tr")).toHaveLength(INVENTORY_CATALOG_PAGE_SIZE);
    expect(catalogTable.getByText("Inventory Item 001")).toBeVisible();
    expect(catalogTable.queryByText("Inventory Item 041")).not.toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3 · 112 items")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(catalogTable.queryByText("Inventory Item 001")).not.toBeInTheDocument();
    expect(catalogTable.getByText("Inventory Item 041")).toBeVisible();
    expect(screen.getByText("Page 2 of 3 · 112 items")).toBeVisible();

    act(() => matchMedia.setMatches(true));
    const mobileCatalog = within(rendered.container.querySelector(".inventory-mobile-list")!);
    expect(rendered.container.querySelectorAll(".inventory-mobile-list .inventory-mobile-card")).toHaveLength(INVENTORY_CATALOG_PAGE_SIZE);
    expect(mobileCatalog.getByText("Inventory Item 041")).toBeVisible();

    fireEvent.change(screen.getByPlaceholderText("Search active items by name or category"), {
      target: { value: "112" }
    });
    expect(props.onInventoryItemSearchChange).toHaveBeenCalledWith("112");
    rendered.rerender(
      <InventoryPanel
        {...catalogProps}
        inventoryItemSearch="112"
        filteredInventoryItems={[items[111]]}
      />
    );
    expect(mobileCatalog.getByText("Inventory Item 112")).toBeVisible();
    expect(screen.queryByLabelText("Inventory catalog pagination")).not.toBeInTheDocument();
  });
});
