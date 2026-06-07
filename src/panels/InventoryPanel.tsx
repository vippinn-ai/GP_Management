import { type FormEvent } from "react";
import type { InventoryItem, InventoryState, SaleVariant, StockMovement, StockMovementType } from "../types";
import { createId, currency } from "../utils";
import { getCategoryIcon } from "../constants";
import { getCategoryImage } from "../categoryImages";
import { Modal } from "../components/Modal";
import { NumericInput } from "../components/NumericInput";

interface InventoryAction {
  itemId: string;
  quantity: number;
  reason: string;
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
  onUpsertInventoryItem: (event: FormEvent<HTMLFormElement>) => void;
  onSaveEditedInventoryItem: (event: FormEvent<HTMLFormElement>) => void;
  onCloseEditInventoryModal: () => void;
  onBeginEditInventoryItem: (item: InventoryItem) => void;
  onRecordStockMovement: (type: StockMovementType, quantityOverride?: number) => void;
}) {
  const {
    itemForm, editItemForm, useCustomItemCategory, customItemCategory,
    useCustomEditItemCategory, customEditItemCategory, inventoryAction,
    inventoryItemSearch, filteredInventoryItems, inventoryCategoryOptions,
    canEditInventory, isManagerReadOnly
  } = props;
  const isItemFormCigarette = itemForm.category === "Cigarettes";
  const isEditItemFormCigarette = editItemForm?.category === "Cigarettes";

  return (
    <>
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
                <label className="checkbox-field">
                  <input type="checkbox" checked={itemForm.active} onChange={(event) => props.onItemFormChange({ ...itemForm, active: event.target.checked })} />
                  <span>Item active</span>
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
              <h3>Current Items</h3>
              <p>{canEditInventory ? "Review stock position, barcode setup, and quick edit access." : "Review stock position, barcode setup, and alert status."}</p>
            </div>
            <input
              className="search-input"
              value={inventoryItemSearch}
              onChange={(event) => props.onInventoryItemSearchChange(event.target.value)}
              placeholder="Search by item name or category"
            />
            <div className="table-wrap inventory-table-wrap">
              <table>
                <thead>
                  <tr><th>Item</th><th>Category</th><th>Type</th><th>Price</th><th>Stock</th><th>Threshold</th><th>Status</th><th>Barcode</th>{canEditInventory && <th />}</tr>
                </thead>
                <tbody>
                  {filteredInventoryItems.length === 0 && (
                    <tr>
                      <td colSpan={canEditInventory ? 9 : 8}>
                        <div className="empty-state">No inventory items match this search.</div>
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
                        <td><span className={`inventory-badge is-${state}`}>{props.getInventoryStateLabel(state)}</span></td>
                        <td>{item.barcode || "—"}</td>
                        {canEditInventory && (
                          <td><button className="ghost-button" type="button" onClick={() => props.onBeginEditInventoryItem(item)}>Edit</button></td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="inventory-mobile-list">
              {filteredInventoryItems.length === 0 && (
                <div className="empty-state">No inventory items match this search.</div>
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
                      <span className={`inventory-badge is-${state}`}>{props.getInventoryStateLabel(state)}</span>
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
                      <div><span className="muted">Barcode</span><strong>{item.barcode || "None"}</strong></div>
                    </div>
                    {canEditInventory && (
                      <button className="secondary-button" type="button" onClick={() => props.onBeginEditInventoryItem(item)}>
                        Edit Item
                      </button>
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
                const selectedMovementItem = props.inventoryItems.find((i) => i.id === inventoryAction.itemId);
                const isCigarette = !!selectedMovementItem?.cigarettePack;
                const packSize = selectedMovementItem?.cigarettePack?.size ?? 1;
                return (
                  <div className="form-grid">
                    <label>
                      <span>Item</span>
                      <select value={inventoryAction.itemId} onChange={(event) => props.onInventoryActionChange({ ...inventoryAction, itemId: event.target.value })}>
                        <option value="">Select item</option>
                        {props.inventoryItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
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
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editItemForm.active}
                onChange={(event) => props.onEditItemFormChange({ ...editItemForm, active: event.target.checked })}
              />
              <span>Item active</span>
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
    </>
  );
}
