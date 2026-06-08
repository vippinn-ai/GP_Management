import { type FormEvent, useState } from "react";
import type {
  InventoryItem,
  InventoryReportFilterState,
  InventoryReportModel,
  InventoryReportPreset,
  InventoryState,
  ComboPackage,
  SaleVariant,
  SellableInventoryOption,
  Station,
  StockMovement,
  StockMovementType
} from "../types";
import { createId, currency, formatDateTime } from "../utils";
import { getCategoryIcon } from "../constants";
import { getCategoryImage } from "../categoryImages";
import { Modal } from "../components/Modal";
import { NumericInput } from "../components/NumericInput";

interface InventoryAction {
  itemId: string;
  quantity: number;
  reason: string;
}

type InventoryArchiveView = "active" | "archived";
type InventoryPanelView = "catalog" | "report" | "combos";

interface InventoryArchiveDraft {
  itemId: string;
  reason: string;
  remainingStock: number;
}

function createBlankSaleVariant(defaultPrice: number): SaleVariant {
  return {
    id: createId("variant"),
    name: "",
    price: defaultPrice,
    stockUnitsPerSale: 1,
    barcode: "",
    active: true
  };
}

function SaleVariantsEditor(props: {
  item: InventoryItem;
  heading: string;
  onChange: (next: InventoryItem) => void;
}) {
  const { item, heading } = props;
  if (item.isReusable || item.category === "Cigarettes") {
    return null;
  }

  const variants = item.saleVariants ?? [];

  function updateVariant(variantId: string, nextPatch: Partial<SaleVariant>) {
    props.onChange({
      ...item,
      saleVariants: variants.map((variant) =>
        variant.id === variantId ? { ...variant, ...nextPatch } : variant
      )
    });
  }

  return (
    <div className="field-span-full sale-variants-editor">
      <div className="section-block-header compact">
        <h3>{heading}</h3>
        <p>Sell this source item as different products while deducting from the same stock.</p>
      </div>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={item.sellBaseItem ?? true}
          onChange={(event) => props.onChange({ ...item, sellBaseItem: event.target.checked })}
        />
        <span>Sell base item directly</span>
      </label>
      <div className="variant-list">
        {variants.map((variant) => (
          <div key={variant.id} className="variant-row">
            <label>
              <span>Variant Name</span>
              <input
                required
                value={variant.name}
                onChange={(event) => updateVariant(variant.id, { name: event.target.value })}
                placeholder="Momo Plate"
              />
            </label>
            <label>
              <span>Sell Price</span>
              <NumericInput
                required
                mode="decimal"
                min={0}
                value={variant.price}
                onValueChange={(value) => updateVariant(variant.id, { price: value })}
              />
            </label>
            <label>
              <span>Stock Units / Sale</span>
              <NumericInput
                required
                min={1}
                value={variant.stockUnitsPerSale}
                onValueChange={(value) => updateVariant(variant.id, { stockUnitsPerSale: value })}
              />
            </label>
            <label>
              <span>Variant Barcode</span>
              <input
                value={variant.barcode ?? ""}
                onChange={(event) => updateVariant(variant.id, { barcode: event.target.value })}
                placeholder="Optional"
              />
            </label>
            <label className="checkbox-field variant-active-toggle">
              <input
                type="checkbox"
                checked={variant.active}
                onChange={(event) => updateVariant(variant.id, { active: event.target.checked })}
              />
              <span>Active</span>
            </label>
            <button
              className="ghost-button danger"
              type="button"
              onClick={() => props.onChange({ ...item, saleVariants: variants.filter((entry) => entry.id !== variant.id) })}
            >
              Remove
            </button>
          </div>
        ))}
        {variants.length === 0 && <div className="empty-state">No sale variants configured.</div>}
      </div>
      <button
        className="secondary-button"
        type="button"
        onClick={() => props.onChange({ ...item, saleVariants: [...variants, createBlankSaleVariant(item.price)] })}
      >
        Add Sale Variant
      </button>
    </div>
  );
}

export function InventoryPanel(props: {
  inventoryItems: InventoryItem[];
  stockMovements: StockMovement[];
  itemForm: InventoryItem;
  editItemForm: InventoryItem | null;
  useCustomItemCategory: boolean;
  customItemCategory: string;
  useCustomEditItemCategory: boolean;
  customEditItemCategory: string;
  inventoryAction: InventoryAction;
  inventoryItemSearch: string;
  inventoryArchiveView: InventoryArchiveView;
  activeInventoryCount: number;
  archivedInventoryCount: number;
  inventoryArchiveDraft: InventoryArchiveDraft | null;
  inventoryReport: InventoryReportModel;
  inventoryReportFilter: InventoryReportFilterState;
  inventoryReportFromDate: string;
  inventoryReportToDate: string;
  inventoryReportRangeLabel: string;
  combos: ComboPackage[];
  comboDraft: ComboPackage;
  stations: Station[];
  sellableOptions: SellableInventoryOption[];
  filteredInventoryItems: InventoryItem[];
  inventoryCategoryOptions: string[];
  canEditInventory: boolean;
  isManagerReadOnly: boolean;
  getInventoryState: (item: InventoryItem) => InventoryState;
  getInventoryStateLabel: (state: InventoryState) => string;
  getAvailableStock: (item: InventoryItem) => number;
  onItemFormChange: (next: InventoryItem) => void;
  onEditItemFormChange: (next: InventoryItem | null) => void;
  onUseCustomItemCategoryChange: (value: boolean) => void;
  onCustomItemCategoryChange: (value: string) => void;
  onUseCustomEditItemCategoryChange: (value: boolean) => void;
  onCustomEditItemCategoryChange: (value: string) => void;
  onInventoryActionChange: (next: InventoryAction) => void;
  onInventoryItemSearchChange: (value: string) => void;
  onInventoryArchiveViewChange: (value: InventoryArchiveView) => void;
  onInventoryReportFilterChange: (next: InventoryReportFilterState) => void;
  onComboDraftChange: (next: ComboPackage) => void;
  onSaveCombo: (event: FormEvent<HTMLFormElement>) => void;
  onEditCombo: (combo: ComboPackage) => void;
  onToggleComboActive: (comboId: string) => void;
  onArchiveDraftReasonChange: (value: string) => void;
  onUpsertInventoryItem: (event: FormEvent<HTMLFormElement>) => void;
  onSaveEditedInventoryItem: (event: FormEvent<HTMLFormElement>) => void;
  onCloseEditInventoryModal: () => void;
  onBeginEditInventoryItem: (item: InventoryItem) => void;
  onBeginArchiveInventoryItem: (item: InventoryItem) => void;
  onCloseArchiveInventoryModal: () => void;
  onArchiveInventoryItem: (event: FormEvent<HTMLFormElement>) => void;
  onRestoreInventoryItem: (itemId: string) => void;
  onRecordStockMovement: (type: StockMovementType, quantityOverride?: number) => void;
}) {
  const {
    itemForm, editItemForm, useCustomItemCategory, customItemCategory,
    useCustomEditItemCategory, customEditItemCategory, inventoryAction,
    inventoryItemSearch, inventoryArchiveView, filteredInventoryItems, inventoryCategoryOptions,
    canEditInventory, isManagerReadOnly, inventoryReport, inventoryReportFilter, comboDraft
  } = props;
  const [inventoryPanelView, setInventoryPanelView] = useState<InventoryPanelView>("catalog");
  const isItemFormCigarette = itemForm.category === "Cigarettes";
  const isEditItemFormCigarette = editItemForm?.category === "Cigarettes";
  const isArchivedView = inventoryArchiveView === "archived";
  const activeMovementItems = props.inventoryItems.filter((item) => item.active);
  const comboSellableOptions = props.sellableOptions;
  const archiveDraftItem = props.inventoryArchiveDraft
    ? props.inventoryItems.find((item) => item.id === props.inventoryArchiveDraft?.itemId) ?? null
    : null;

  function formatArchivedAt(item: InventoryItem) {
    return item.archivedAt ? new Date(item.archivedAt).toLocaleString() : "Archived";
  }

  function formatUnits(value: number) {
    return Number.isInteger(value) ? `${value}` : value.toFixed(2);
  }

  function formatSignedUnits(value: number) {
    if (value === 0) {
      return "0";
    }
    return `${value > 0 ? "+" : ""}${formatUnits(value)}`;
  }

  function movementTypeLabel(type: StockMovementType) {
    switch (type) {
      case "restock":
        return "Restock";
      case "sale":
        return "Sale";
      case "adjustment":
        return "Adjustment";
      case "void_refund_reversal":
        return "Void/Refund Restore";
      case "session_reservation":
        return "Session Reserved";
      case "session_reservation_void":
        return "Reservation Released";
    }
  }

  const inventoryReportPresets: Array<{ label: string; value: InventoryReportPreset }> = [
    { label: "Today", value: "today" },
    { label: "Yesterday", value: "yesterday" },
    { label: "Last 7 Days", value: "last_7_days" },
    { label: "Last 1 Month", value: "last_30_days" },
    { label: "Custom Range", value: "custom" }
  ];

  function updateComboDraft(patch: Partial<ComboPackage>) {
    props.onComboDraftChange({ ...comboDraft, ...patch });
  }

  return (
    <>
      <div className="segmented-control inventory-section-tabs" role="tablist" aria-label="Inventory section">
        <button
          type="button"
          className={inventoryPanelView === "catalog" ? "is-active" : ""}
          onClick={() => setInventoryPanelView("catalog")}
        >
          Catalog
        </button>
        <button
          type="button"
          className={inventoryPanelView === "report" ? "is-active" : ""}
          onClick={() => setInventoryPanelView("report")}
        >
          Inventory Report
        </button>
        <button
          type="button"
          className={inventoryPanelView === "combos" ? "is-active" : ""}
          onClick={() => setInventoryPanelView("combos")}
        >
          Combos
        </button>
      </div>

      {inventoryPanelView === "combos" ? (
        <section className="section-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Combo Designer</h2>
                <p>Create fixed-time game packages with included inventory and required choices.</p>
              </div>
            </div>
            {isManagerReadOnly && <div className="read-only-banner">Manager view: read-only access on this page.</div>}
            {canEditInventory && (
              <form className="form-grid" onSubmit={props.onSaveCombo}>
                <label>
                  <span>Combo Name</span>
                  <input required value={comboDraft.name} onChange={(event) => updateComboDraft({ name: event.target.value })} placeholder="Pool Pot Combo" />
                </label>
                <label>
                  <span>Combo Price</span>
                  <NumericInput required mode="decimal" min={0} value={comboDraft.price} onValueChange={(value) => updateComboDraft({ price: value })} />
                </label>
                <label>
                  <span>Included Game Minutes</span>
                  <NumericInput required min={1} value={comboDraft.includedMinutes} onValueChange={(value) => updateComboDraft({ includedMinutes: value })} />
                </label>
                <label className="checkbox-field">
                  <input type="checkbox" checked={comboDraft.active} onChange={(event) => updateComboDraft({ active: event.target.checked })} />
                  <span>Active combo</span>
                </label>
                <div className="field-span-full combo-station-grid">
                  <span className="field-label">Available Stations</span>
                  {props.stations.filter((station) => station.mode === "timed").map((station) => (
                    <label key={station.id} className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={comboDraft.stationIds.includes(station.id)}
                        onChange={(event) => updateComboDraft({
                          stationIds: event.target.checked
                            ? Array.from(new Set([...comboDraft.stationIds, station.id]))
                            : comboDraft.stationIds.filter((id) => id !== station.id)
                        })}
                      />
                      <span>{station.name}</span>
                    </label>
                  ))}
                </div>
                <div className="field-span-full sale-variants-editor">
                  <div className="section-block-header compact">
                    <h3>Fixed Included Items</h3>
                    <p>These items are always included and stock is reserved when the combo starts.</p>
                  </div>
                  <div className="variant-list">
                    {comboDraft.fixedItems.map((item) => (
                      <div key={item.id} className="combo-config-row">
                        <label>
                          <span>Item</span>
                          <select value={item.sellableOptionId} onChange={(event) => updateComboDraft({ fixedItems: comboDraft.fixedItems.map((entry) => entry.id === item.id ? { ...entry, sellableOptionId: event.target.value } : entry) })}>
                            <option value="">Select item</option>
                            {comboSellableOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>Qty</span>
                          <NumericInput min={1} value={item.quantity} onValueChange={(value) => updateComboDraft({ fixedItems: comboDraft.fixedItems.map((entry) => entry.id === item.id ? { ...entry, quantity: value } : entry) })} />
                        </label>
                        <button className="ghost-button danger" type="button" onClick={() => updateComboDraft({ fixedItems: comboDraft.fixedItems.filter((entry) => entry.id !== item.id) })}>Remove</button>
                      </div>
                    ))}
                    {comboDraft.fixedItems.length === 0 && <div className="empty-state">No fixed included items.</div>}
                  </div>
                  <button className="secondary-button" type="button" onClick={() => updateComboDraft({ fixedItems: [...comboDraft.fixedItems, { id: createId("combo-fixed"), sellableOptionId: "", quantity: 1 }] })}>
                    Add Fixed Item
                  </button>
                </div>
                <div className="field-span-full sale-variants-editor">
                  <div className="section-block-header compact">
                    <h3>Choice Groups</h3>
                    <p>Use for options like fries flavor where staff must pick one item at session start.</p>
                  </div>
                  <div className="variant-list">
                    {comboDraft.choiceGroups.map((group) => (
                      <div key={group.id} className="combo-choice-config">
                        <div className="combo-config-row">
                          <label>
                            <span>Choice Label</span>
                            <input value={group.label} onChange={(event) => updateComboDraft({ choiceGroups: comboDraft.choiceGroups.map((entry) => entry.id === group.id ? { ...entry, label: event.target.value } : entry) })} placeholder="Fries choice" />
                          </label>
                          <label>
                            <span>Qty</span>
                            <NumericInput min={1} value={group.requiredQuantity} onValueChange={(value) => updateComboDraft({ choiceGroups: comboDraft.choiceGroups.map((entry) => entry.id === group.id ? { ...entry, requiredQuantity: value } : entry) })} />
                          </label>
                          <button className="ghost-button danger" type="button" onClick={() => updateComboDraft({ choiceGroups: comboDraft.choiceGroups.filter((entry) => entry.id !== group.id) })}>Remove</button>
                        </div>
                        <div className="combo-option-grid">
                          {comboSellableOptions.map((option) => (
                            <label key={option.id} className="checkbox-field">
                              <input
                                type="checkbox"
                                checked={group.optionIds.includes(option.id)}
                                onChange={(event) => updateComboDraft({
                                  choiceGroups: comboDraft.choiceGroups.map((entry) =>
                                    entry.id === group.id
                                      ? {
                                          ...entry,
                                          optionIds: event.target.checked
                                            ? Array.from(new Set([...entry.optionIds, option.id]))
                                            : entry.optionIds.filter((id) => id !== option.id)
                                        }
                                      : entry
                                  )
                                })}
                              />
                              <span>{option.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                    {comboDraft.choiceGroups.length === 0 && <div className="empty-state">No choice groups configured.</div>}
                  </div>
                  <button className="secondary-button" type="button" onClick={() => updateComboDraft({ choiceGroups: [...comboDraft.choiceGroups, { id: createId("combo-choice"), label: "", requiredQuantity: 1, optionIds: [] }] })}>
                    Add Choice Group
                  </button>
                </div>
                <div className="button-row field-span-full">
                  <button className="secondary-button" type="button" onClick={() => props.onComboDraftChange({ id: "", name: "", active: true, stationIds: [], price: 0, includedMinutes: 60, fixedItems: [], choiceGroups: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })}>Reset</button>
                  <button className="primary-button" type="submit">{comboDraft.id ? "Update Combo" : "Create Combo"}</button>
                </div>
              </form>
            )}
          </div>
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Configured Combos</h2>
                <p>Active combos appear while starting sessions on their selected stations.</p>
              </div>
            </div>
            <div className="activity-list">
              {props.combos.length === 0 && <div className="empty-state">No combos configured.</div>}
              {props.combos.map((combo) => (
                <div key={combo.id} className="activity-row combo-list-row">
                  <div>
                    <strong>{combo.name}</strong>
                    <span className="muted">
                      {currency(combo.price)} - {combo.includedMinutes} min - {combo.stationIds.map((id) => props.stations.find((station) => station.id === id)?.name ?? "Station").join(", ") || "No stations"}
                    </span>
                  </div>
                  <div className="button-row compact-actions">
                    <span className={`inventory-badge ${combo.active ? "is-available" : "is-archived"}`}>{combo.active ? "Active" : "Archived"}</span>
                    {canEditInventory && <button className="ghost-button" type="button" onClick={() => props.onEditCombo(combo)}>Edit</button>}
                    {canEditInventory && <button className="ghost-button danger" type="button" onClick={() => props.onToggleComboActive(combo.id)}>{combo.active ? "Archive" : "Restore"}</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : inventoryPanelView === "report" ? (
        <section className="inventory-report-layout">
          <div className="panel">
            <div className="reports-toolbar inventory-report-toolbar">
              <div className="reports-toolbar-copy">
                <h2>Inventory Report</h2>
                <p>Business-day stock added, deducted, adjusted, restored, and currently reserved.</p>
                {isManagerReadOnly && <div className="read-only-banner compact">Manager view: read-only access on this page.</div>}
              </div>
              <div className="report-filter-inline">
                <label>
                  <span>Range</span>
                  <select
                    value={inventoryReportFilter.preset}
                    onChange={(event) => props.onInventoryReportFilterChange({
                      ...inventoryReportFilter,
                      preset: event.target.value as InventoryReportPreset
                    })}
                  >
                    {inventoryReportPresets.map((preset) => (
                      <option key={preset.value} value={preset.value}>{preset.label}</option>
                    ))}
                  </select>
                </label>
                {inventoryReportFilter.preset === "custom" && (
                  <>
                    <label>
                      <span>From</span>
                      <input
                        type="date"
                        value={inventoryReportFilter.fromDate ?? props.inventoryReportFromDate}
                        onChange={(event) => props.onInventoryReportFilterChange({ ...inventoryReportFilter, fromDate: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>To</span>
                      <input
                        type="date"
                        value={inventoryReportFilter.toDate ?? props.inventoryReportToDate}
                        onChange={(event) => props.onInventoryReportFilterChange({ ...inventoryReportFilter, toDate: event.target.value })}
                      />
                    </label>
                  </>
                )}
                <div className="report-range-chip">
                  <div className="report-range-chip-head">
                    <span className="muted">Selected Period</span>
                    <strong>{props.inventoryReportRangeLabel}</strong>
                  </div>
                  <div className="muted">{props.inventoryReportFromDate} to {props.inventoryReportToDate}</div>
                </div>
              </div>
            </div>

            <div className="reports-kpi-grid inventory-report-kpis">
              <div className="report-kpi-card is-primary">
                <span className="muted">Stock Added</span>
                <strong>{formatUnits(inventoryReport.summary.added)}</strong>
              </div>
              <div className="report-kpi-card is-primary">
                <span className="muted">Stock Deducted</span>
                <strong>{formatUnits(inventoryReport.summary.deducted)}</strong>
              </div>
              <div className="report-kpi-card is-secondary">
                <span className="muted">Manual Adjustments</span>
                <strong>{formatSignedUnits(inventoryReport.summary.manualAdjustments)}</strong>
              </div>
              <div className="report-kpi-card is-secondary">
                <span className="muted">Reversals / Restores</span>
                <strong>{formatUnits(inventoryReport.summary.reversals)}</strong>
              </div>
              <div className="report-kpi-card is-primary">
                <span className="muted">Net Stock Change</span>
                <strong>{formatSignedUnits(inventoryReport.summary.netChange)}</strong>
              </div>
              <div className="report-kpi-card is-secondary">
                <span className="muted">Currently Reserved</span>
                <strong>{formatUnits(inventoryReport.summary.reserved)}</strong>
              </div>
            </div>

            <div className="section-block section-block-muted">
              <div className="section-block-header">
                <h3>Item Summary</h3>
                <p>{inventoryReport.summary.touchedItems} item{inventoryReport.summary.touchedItems !== 1 ? "s" : ""} with movement in this period.</p>
              </div>
              <div className="table-wrap inventory-report-table-wrap">
                <table>
                  <thead>
                    <tr><th>Item</th><th>Category</th><th>Status</th><th>Added</th><th>Deducted</th><th>Adjustments</th><th>Reversals</th><th>Net</th><th>Current Stock</th><th>Reserved</th></tr>
                  </thead>
                  <tbody>
                    {inventoryReport.rows.length === 0 && (
                      <tr>
                        <td colSpan={10}><div className="empty-state">No inventory movements or open reservations found for this range.</div></td>
                      </tr>
                    )}
                    {inventoryReport.rows.map((row) => (
                      <tr key={row.itemId}>
                        <td>{row.itemName}</td>
                        <td>{row.category}</td>
                        <td>{row.active ? <span className="inventory-badge is-available">Active</span> : <span className="inventory-badge is-archived">Archived</span>}</td>
                        <td>{formatUnits(row.added)}</td>
                        <td>{formatUnits(row.deducted)}</td>
                        <td>{formatSignedUnits(row.manualAdjustments)}</td>
                        <td>{formatUnits(row.reversals)}</td>
                        <td>{formatSignedUnits(row.netChange)}</td>
                        <td>{formatUnits(row.currentStock)}</td>
                        <td>{formatUnits(row.reserved)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="section-block">
              <div className="section-block-header">
                <h3>Movement Details</h3>
                <p>Audit trail for stock movements within the selected business-day range.</p>
              </div>
              <div className="table-wrap inventory-report-table-wrap">
                <table>
                  <thead>
                    <tr><th>Business Date</th><th>Time</th><th>Item</th><th>Type</th><th>Quantity</th><th>Reason</th><th>Bill</th></tr>
                  </thead>
                  <tbody>
                    {inventoryReport.details.length === 0 && (
                      <tr>
                        <td colSpan={7}><div className="empty-state">No movement details found for this range.</div></td>
                      </tr>
                    )}
                    {inventoryReport.details.map((detail) => (
                      <tr key={detail.id}>
                        <td>{detail.businessDate}</td>
                        <td>{formatDateTime(detail.createdAt)}</td>
                        <td>{detail.itemName}</td>
                        <td>{movementTypeLabel(detail.type)}</td>
                        <td>{formatSignedUnits(detail.quantity)}</td>
                        <td>{detail.reason}</td>
                        <td>{detail.relatedBillNumber ?? detail.relatedBillId ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      ) : (
      <section className="section-grid">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Inventory Catalog</h2>
              <p>{canEditInventory ? "Create items, update prices, and keep barcode/search billing flexible." : "Review catalog, stock levels, and barcode setup in read-only mode."}</p>
            </div>
          </div>
          {isManagerReadOnly && <div className="read-only-banner">Manager view: read-only access on this page.</div>}
          {canEditInventory && (
            <div className="section-block reports-summary-block">
              <div className="section-block-header">
                <h3>Add New Item</h3>
                <p>Define price, opening stock, barcode, alert threshold, and reusable behavior.</p>
              </div>
              <form className="form-grid" onSubmit={props.onUpsertInventoryItem}>
                <label>
                  <span>Item Name</span>
                  <input required value={itemForm.name} onChange={(event) => props.onItemFormChange({ ...itemForm, name: event.target.value })} />
                </label>
                <label>
                  <span>Category</span>
                  <select
                    value={useCustomItemCategory ? "__other__" : itemForm.category}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      if (nextValue === "__other__") {
                        props.onUseCustomItemCategoryChange(true);
                        props.onCustomItemCategoryChange(itemForm.category);
                        return;
                      }
                      props.onUseCustomItemCategoryChange(false);
                      props.onCustomItemCategoryChange("");
                      props.onItemFormChange({ ...itemForm, category: nextValue });
                    }}
                  >
                    <option value="">Select category</option>
                    {inventoryCategoryOptions.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                    <option value="__other__">Other</option>
                  </select>
                </label>
                {useCustomItemCategory && (
                  <label>
                    <span>New Category</span>
                    <input
                      required
                      value={customItemCategory}
                      onChange={(event) => {
                        props.onCustomItemCategoryChange(event.target.value);
                        props.onItemFormChange({ ...itemForm, category: event.target.value });
                      }}
                      placeholder="Enter new category"
                    />
                  </label>
                )}
                <label>
                  <span>{isItemFormCigarette ? "Price (per single)" : "Price"}</span>
                  <NumericInput required mode="decimal" min={0} value={itemForm.price} onValueChange={(value) => props.onItemFormChange({ ...itemForm, price: value })} />
                </label>
                {isItemFormCigarette && (
                  <>
                    <label>
                      <span>Pack Size (cigarettes per pack)</span>
                      <NumericInput
                        required
                        min={1}
                        value={itemForm.cigarettePack?.size ?? 10}
                        onValueChange={(value) => props.onItemFormChange({ ...itemForm, cigarettePack: { size: value, packPrice: itemForm.cigarettePack?.packPrice ?? 0 } })}
                      />
                    </label>
                    <label>
                      <span>Pack Price</span>
                      <NumericInput
                        required
                        mode="decimal"
                        min={0}
                        value={itemForm.cigarettePack?.packPrice ?? 0}
                        onValueChange={(value) => props.onItemFormChange({ ...itemForm, cigarettePack: { size: itemForm.cigarettePack?.size ?? 10, packPrice: value } })}
                      />
                    </label>
                  </>
                )}
                <label>
                  <span>{isItemFormCigarette ? "Opening Stock (individual cigarettes)" : "Opening Stock"}</span>
                  <NumericInput required min={0} value={itemForm.stockQty} onValueChange={(value) => props.onItemFormChange({ ...itemForm, stockQty: value })} />
                </label>
                <label>
                  <span>Low Stock Threshold</span>
                  <NumericInput required min={0} value={itemForm.lowStockThreshold} onValueChange={(value) => props.onItemFormChange({ ...itemForm, lowStockThreshold: value })} />
                </label>
                <label>
                  <span>Barcode</span>
                  <input value={itemForm.barcode} onChange={(event) => props.onItemFormChange({ ...itemForm, barcode: event.target.value })} />
                </label>
                <label className="checkbox-field">
                  <input type="checkbox" checked={itemForm.isReusable} onChange={(event) => props.onItemFormChange({ ...itemForm, isReusable: event.target.checked })} />
                  <span>Reusable item</span>
                </label>
                <SaleVariantsEditor
                  item={itemForm}
                  heading="Sale Variants"
                  onChange={props.onItemFormChange}
                />
                <div className="button-row">
                  <button className="primary-button" type="submit">Create Item</button>
                </div>
              </form>
            </div>
          )}
          <div className="section-block section-block-muted">
            <div className="section-block-header">
              <h3>{isArchivedView ? "Archived Items" : "Active Items"}</h3>
              <p>{canEditInventory ? "Review stock position, barcode setup, and lifecycle actions." : "Review stock position, barcode setup, and alert status."}</p>
            </div>
            <div className="segmented-control inventory-archive-tabs" role="tablist" aria-label="Inventory item status">
              <button
                type="button"
                className={inventoryArchiveView === "active" ? "is-active" : ""}
                onClick={() => props.onInventoryArchiveViewChange("active")}
              >
                Active Items ({props.activeInventoryCount})
              </button>
              <button
                type="button"
                className={inventoryArchiveView === "archived" ? "is-active" : ""}
                onClick={() => props.onInventoryArchiveViewChange("archived")}
              >
                Archived ({props.archivedInventoryCount})
              </button>
            </div>
            <input
              className="search-input"
              value={inventoryItemSearch}
              onChange={(event) => props.onInventoryItemSearchChange(event.target.value)}
              placeholder={`Search ${isArchivedView ? "archived" : "active"} items by name or category`}
            />
            <div className="table-wrap inventory-table-wrap">
              <table>
                <thead>
                  <tr><th>Item</th><th>Category</th><th>Type</th><th>Price</th><th>Stock</th><th>Threshold</th><th>Status</th><th>{isArchivedView ? "Archived" : "Barcode"}</th>{canEditInventory && <th />}</tr>
                </thead>
                <tbody>
                  {filteredInventoryItems.length === 0 && (
                    <tr>
                      <td colSpan={canEditInventory ? 9 : 8}>
                        <div className="empty-state">No {isArchivedView ? "archived" : "active"} inventory items match this search.</div>
                      </td>
                    </tr>
                  )}
                  {filteredInventoryItems.map((item) => {
                    const state = props.getInventoryState(item);
                    return (
                      <tr key={item.id}>
                        <td>{item.name}</td>
                        <td>
                          {getCategoryImage(item.category) ? (
                            <img src={getCategoryImage(item.category)} alt="" className="category-icon-img" />
                          ) : (
                            <span className={`category-icon${item.category === "Cigarettes" ? " category-icon--cigarettes" : ""}`}>{getCategoryIcon(item.category)}</span>
                          )}
                          {item.category}
                        </td>
                        <td>{item.isReusable ? "Reusable" : `Consumable${(item.saleVariants ?? []).length > 0 ? ` · ${(item.saleVariants ?? []).length} variant${(item.saleVariants ?? []).length !== 1 ? "s" : ""}` : ""}`}</td>
                        <td>{currency(item.price)}</td>
                        <td>
                          {props.getAvailableStock(item)}
                          {item.stockQty !== props.getAvailableStock(item) && (
                            <span className="muted" style={{ fontSize: "0.8em", marginLeft: "0.4em" }}>
                              ({item.stockQty - props.getAvailableStock(item)} in sessions)
                            </span>
                          )}
                          {item.cigarettePack && (
                            <span className="muted" style={{ fontSize: "0.8em", marginLeft: "0.4em" }}>
                              (~{Math.floor(props.getAvailableStock(item) / item.cigarettePack.size)} packs + {props.getAvailableStock(item) % item.cigarettePack.size} loose)
                            </span>
                          )}
                        </td>
                        <td>{item.lowStockThreshold}</td>
                        <td>
                          {isArchivedView
                            ? <span className="inventory-badge is-archived">Archived</span>
                            : <span className={`inventory-badge is-${state}`}>{props.getInventoryStateLabel(state)}</span>}
                        </td>
                        <td>
                          {isArchivedView ? (
                            <span className="muted">
                              {formatArchivedAt(item)}
                              {item.archiveReason ? ` - ${item.archiveReason}` : ""}
                            </span>
                          ) : item.barcode || "None"}
                        </td>
                        {canEditInventory && (
                          <td>
                            {isArchivedView ? (
                              <button className="secondary-button" type="button" onClick={() => props.onRestoreInventoryItem(item.id)}>
                                Restore
                              </button>
                            ) : (
                              <div className="button-row compact-actions">
                                <button className="ghost-button" type="button" onClick={() => props.onBeginEditInventoryItem(item)}>Edit</button>
                                <button className="ghost-button danger" type="button" onClick={() => props.onBeginArchiveInventoryItem(item)}>Archive</button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="inventory-mobile-list">
              {filteredInventoryItems.length === 0 && (
                <div className="empty-state">No {isArchivedView ? "archived" : "active"} inventory items match this search.</div>
              )}
              {filteredInventoryItems.map((item) => {
                const state = props.getInventoryState(item);
                const availableStock = props.getAvailableStock(item);
                const reservedStock = item.stockQty - availableStock;
                const categoryImage = getCategoryImage(item.category);
                return (
                  <article key={item.id} className="inventory-mobile-card">
                    <div className="inventory-mobile-card-head">
                      <div>
                        <strong>{item.name}</strong>
                        <div className="inventory-mobile-category">
                          {categoryImage ? (
                            <img src={categoryImage} alt="" className="category-icon-img" />
                          ) : (
                            <span className={`category-icon${item.category === "Cigarettes" ? " category-icon--cigarettes" : ""}`}>{getCategoryIcon(item.category)}</span>
                          )}
                          <span>{item.category}</span>
                        </div>
                      </div>
                      {isArchivedView
                        ? <span className="inventory-badge is-archived">Archived</span>
                        : <span className={`inventory-badge is-${state}`}>{props.getInventoryStateLabel(state)}</span>}
                    </div>
                    <div className="inventory-mobile-details">
                      <div><span className="muted">Type</span><strong>{item.isReusable ? "Reusable" : `Consumable${(item.saleVariants ?? []).length > 0 ? ` · ${(item.saleVariants ?? []).length} variant${(item.saleVariants ?? []).length !== 1 ? "s" : ""}` : ""}`}</strong></div>
                      <div><span className="muted">Price</span><strong>{currency(item.price)}</strong></div>
                      <div>
                        <span className="muted">Stock</span>
                        <strong>{availableStock}</strong>
                        {reservedStock > 0 && <small className="muted">{reservedStock} in sessions</small>}
                        {item.cigarettePack && (
                          <small className="muted">
                            ~{Math.floor(availableStock / item.cigarettePack.size)} packs + {availableStock % item.cigarettePack.size} loose
                          </small>
                        )}
                      </div>
                      <div><span className="muted">Threshold</span><strong>{item.lowStockThreshold}</strong></div>
                      {isArchivedView ? (
                        <>
                          <div><span className="muted">Archived</span><strong>{formatArchivedAt(item)}</strong></div>
                          <div><span className="muted">Reason</span><strong>{item.archiveReason || "None"}</strong></div>
                        </>
                      ) : (
                        <div><span className="muted">Barcode</span><strong>{item.barcode || "None"}</strong></div>
                      )}
                    </div>
                    {canEditInventory && (
                      isArchivedView ? (
                        <button className="secondary-button" type="button" onClick={() => props.onRestoreInventoryItem(item.id)}>
                          Restore Item
                        </button>
                      ) : (
                        <div className="button-row compact-actions">
                          <button className="secondary-button" type="button" onClick={() => props.onBeginEditInventoryItem(item)}>
                            Edit Item
                          </button>
                          <button className="ghost-button danger" type="button" onClick={() => props.onBeginArchiveInventoryItem(item)}>
                            Archive
                          </button>
                        </div>
                      )
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Stock Movements</h2>
              <p>{canEditInventory ? "Restock or manually deduct stock with required reasons." : "Review the latest stock deductions, sales, and adjustments."}</p>
            </div>
          </div>
          {canEditInventory && (
            <div className="section-block">
              <div className="section-block-header">
                <h3>Record Movement</h3>
                <p>Capture restock and adjustment entries with a clear reason.</p>
              </div>
              {(() => {
                const selectedMovementItem = activeMovementItems.find((i) => i.id === inventoryAction.itemId);
                const isCigarette = !!selectedMovementItem?.cigarettePack;
                const packSize = selectedMovementItem?.cigarettePack?.size ?? 1;
                return (
                  <div className="form-grid">
                    <label>
                      <span>Item</span>
                      <select value={inventoryAction.itemId} onChange={(event) => props.onInventoryActionChange({ ...inventoryAction, itemId: event.target.value })}>
                        <option value="">Select item</option>
                        {activeMovementItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>{isCigarette ? "Number of packs to restock" : "Quantity"}</span>
                      <NumericInput min={1} defaultValue={1} value={inventoryAction.quantity} onValueChange={(value) => props.onInventoryActionChange({ ...inventoryAction, quantity: value })} />
                    </label>
                    {isCigarette && (
                      <div className="muted field-span-full" style={{ fontSize: "0.85em" }}>
                        = {inventoryAction.quantity * packSize} individual cigarettes will be added to stock
                      </div>
                    )}
                    <label className="field-span-full">
                      <span>Reason</span>
                      <input value={inventoryAction.reason} onChange={(event) => props.onInventoryActionChange({ ...inventoryAction, reason: event.target.value })} placeholder="damage, expiry, correction, opening stock..." />
                    </label>
                    <div className="button-row field-span-full">
                      <button className="primary-button" type="button" onClick={() => props.onRecordStockMovement("restock", isCigarette ? inventoryAction.quantity * packSize : undefined)}>Restock</button>
                      <button className="secondary-button" type="button" onClick={() => props.onRecordStockMovement("adjustment")}>Deduct / Adjust</button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          <div className="section-block section-block-muted">
            <div className="section-block-header">
              <h3>Recent Movements</h3>
              <p>Latest stock deductions, sales, and manual corrections.</p>
            </div>
            <div className="activity-list">
              {props.stockMovements.slice(0, 10).map((movement) => (
                <div key={movement.id} className="activity-row">
                  <strong>{props.inventoryItems.find((item) => item.id === movement.itemId)?.name || "Item"}</strong>
                  <span className="muted">{movement.type} · {movement.quantity} · {movement.reason}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      )}

      {editItemForm && (
        <Modal title={`Edit Inventory Item${editItemForm.name ? ` - ${editItemForm.name}` : ""}`} onClose={props.onCloseEditInventoryModal}>
          <form className="form-grid" onSubmit={props.onSaveEditedInventoryItem}>
            <label>
              <span>Item Name</span>
              <input
                required
                value={editItemForm.name}
                onChange={(event) => props.onEditItemFormChange({ ...editItemForm, name: event.target.value })}
              />
            </label>
            <label>
              <span>Category</span>
              <select
                value={useCustomEditItemCategory ? "__other__" : editItemForm.category}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  if (nextValue === "__other__") {
                    props.onUseCustomEditItemCategoryChange(true);
                    props.onCustomEditItemCategoryChange(editItemForm.category);
                    return;
                  }
                  props.onUseCustomEditItemCategoryChange(false);
                  props.onCustomEditItemCategoryChange("");
                  props.onEditItemFormChange({ ...editItemForm, category: nextValue });
                }}
              >
                <option value="">Select category</option>
                {inventoryCategoryOptions.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
                <option value="__other__">Other</option>
              </select>
            </label>
            {useCustomEditItemCategory && (
              <label>
                <span>New Category</span>
                <input
                  required
                  value={customEditItemCategory}
                  onChange={(event) => {
                    props.onCustomEditItemCategoryChange(event.target.value);
                    props.onEditItemFormChange({ ...editItemForm, category: event.target.value });
                  }}
                  placeholder="Enter new category"
                />
              </label>
            )}
            <label>
              <span>{isEditItemFormCigarette ? "Price (per single)" : "Price"}</span>
              <NumericInput
                required
                mode="decimal"
                min={0}
                value={editItemForm.price}
                onValueChange={(value) => props.onEditItemFormChange({ ...editItemForm, price: value })}
              />
            </label>
            {isEditItemFormCigarette && (
              <>
                <label>
                  <span>Pack Size (cigarettes per pack)</span>
                  <NumericInput
                    required
                    min={1}
                    value={editItemForm.cigarettePack?.size ?? 10}
                    onValueChange={(value) => props.onEditItemFormChange({ ...editItemForm, cigarettePack: { size: value, packPrice: editItemForm.cigarettePack?.packPrice ?? 0 } })}
                  />
                </label>
                <label>
                  <span>Pack Price</span>
                  <NumericInput
                    required
                    mode="decimal"
                    min={0}
                    value={editItemForm.cigarettePack?.packPrice ?? 0}
                    onValueChange={(value) => props.onEditItemFormChange({ ...editItemForm, cigarettePack: { size: editItemForm.cigarettePack?.size ?? 10, packPrice: value } })}
                  />
                </label>
              </>
            )}
            <label>
              <span>Opening Stock</span>
              <NumericInput
                required
                min={0}
                value={editItemForm.stockQty}
                onValueChange={(value) => props.onEditItemFormChange({ ...editItemForm, stockQty: value })}
              />
            </label>
            <label>
              <span>Low Stock Threshold</span>
              <NumericInput
                required
                min={0}
                value={editItemForm.lowStockThreshold}
                onValueChange={(value) => props.onEditItemFormChange({ ...editItemForm, lowStockThreshold: value })}
              />
            </label>
            <label>
              <span>Barcode</span>
              <input
                value={editItemForm.barcode}
                onChange={(event) => props.onEditItemFormChange({ ...editItemForm, barcode: event.target.value })}
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editItemForm.isReusable}
                onChange={(event) => props.onEditItemFormChange({ ...editItemForm, isReusable: event.target.checked })}
              />
              <span>Reusable item</span>
            </label>
            <SaleVariantsEditor
              item={editItemForm}
              heading="Sale Variants"
              onChange={props.onEditItemFormChange}
            />
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={props.onCloseEditInventoryModal}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Update Item
              </button>
            </div>
          </form>
        </Modal>
      )}
      {archiveDraftItem && props.inventoryArchiveDraft && (
        <Modal title={`Archive Inventory Item - ${archiveDraftItem.name}`} onClose={props.onCloseArchiveInventoryModal}>
          <form className="form-grid" onSubmit={props.onArchiveInventoryItem}>
            <div className="field-span-full warning-banner">
              {props.inventoryArchiveDraft.remainingStock > 0
                ? `${archiveDraftItem.name} still has ${props.inventoryArchiveDraft.remainingStock} ${archiveDraftItem.unit || "unit"} in stock. Archiving will hide it from sales and stock alerts, but the stock quantity will be preserved.`
                : `${archiveDraftItem.name} will be hidden from sales and inventory alerts. Historical bills and stock movements will stay available.`}
            </div>
            <label className="field-span-full">
              <span>Archive Reason (optional)</span>
              <input
                value={props.inventoryArchiveDraft.reason}
                onChange={(event) => props.onArchiveDraftReasonChange(event.target.value)}
                placeholder="Not restocking, duplicate item, incorrect setup..."
              />
            </label>
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={props.onCloseArchiveInventoryModal}>
                Cancel
              </button>
              <button className="ghost-button danger" type="submit">
                Archive Item
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
