import { type FormEvent, useState } from "react";
import type { Customer, CustomerTab, CustomerTabDraft, CustomerTabEditDraft, CustomerTabItem, InventoryItem } from "../types";
import { currency } from "../utils";
import { getCategoryIcon } from "../constants";
import { Modal } from "../components/Modal";
import { NumericInput } from "../components/NumericInput";
import { CustomerAutocompleteFields } from "../components/CustomerAutocompleteFields";

export function SalePanel(props: {
  inventoryItems: InventoryItem[];
  customers: Customer[];
  customerTabSearch: string;
  customerTabDraft: CustomerTabDraft;
  openCustomerTabs: CustomerTab[];
  selectedCustomerTab: CustomerTab | null;
  editCustomerTabDraft: CustomerTabEditDraft | null;
  canEditCustomerTabDetails: boolean;
  getInventoryPickerDetail: (item: InventoryItem, ignoreSessionId?: string, ignoreCustomerTabId?: string) => string;
  getCustomerTabTotal: (tab: CustomerTab) => number;
  onCustomerTabSearchChange: (value: string) => void;
  onCustomerTabDraftChange: (next: CustomerTabDraft) => void;
  onSelectCustomerTab: (tabId: string) => void;
  onEditCustomerTabDraftChange: (next: CustomerTabEditDraft | null) => void;
  onAddItemToCustomerTab: (item: InventoryItem, sellAsPackOf?: number) => void;
  onCreateOrSelectCustomerTab: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateCustomerTabItemQuantity: (lineId: string, quantity: number) => void;
  onRemoveItemFromCustomerTab: (lineId: string) => void;
  onBeginEditCustomerTabDetails: (tab: CustomerTab) => void;
  onRejectCustomerTab: (tabId: string) => void;
  onBeginCustomerTabCheckout: () => void;
  onSaveCustomerTabDetails: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { customerTabDraft, openCustomerTabs, selectedCustomerTab, editCustomerTabDraft, canEditCustomerTabDetails } = props;
  const [cigPackModal, setCigPackModal] = useState<{ item: InventoryItem } | null>(null);

  return (
    <>
      <section className="section-grid sales-layout">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Consumables Catalog</h2>
              <p>Search by name or barcode and add items to the selected customer tab.</p>
            </div>
          </div>
          <input
            className="search-input"
            value={props.customerTabSearch}
            onChange={(event) => props.onCustomerTabSearchChange(event.target.value)}
            placeholder="Search items..."
          />
          <div className="catalog-grid">
            {props.inventoryItems
              .filter((item) => item.active)
              .filter((item) =>
                `${item.name} ${item.category} ${item.barcode ?? ""}`.toLowerCase().includes(props.customerTabSearch.toLowerCase())
              )
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="catalog-card"
                  onClick={() => {
                    if (item.cigarettePack) {
                      setCigPackModal({ item });
                    } else {
                      props.onAddItemToCustomerTab(item);
                    }
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>
                    <span className={`category-icon${item.category === "Cigarettes" ? " category-icon--cigarettes" : ""}`}>{getCategoryIcon(item.category)}</span>
                    {item.category}
                  </span>
                  <span>{currency(item.price)}</span>
                  <span className="muted">{props.getInventoryPickerDetail(item, undefined, selectedCustomerTab?.id)}</span>
                </button>
              ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Consumables Tab</h2>
              <p>Track sheesha, food, and drink items for customers who pay when they leave.</p>
            </div>
          </div>
          <div className="section-block">
            <div className="section-block-header">
              <h3>Open or Find Customer Tab</h3>
              <p>One active tab per customer. Reusing a customer automatically opens their current tab.</p>
            </div>
            <form className="form-grid" onSubmit={props.onCreateOrSelectCustomerTab}>
              <CustomerAutocompleteFields
                customers={props.customers}
                customerId={customerTabDraft.customerId}
                customerName={customerTabDraft.customerName}
                customerPhone={customerTabDraft.customerPhone}
                required
                namePlaceholder="Enter customer name"
                phonePlaceholder="Optional"
                onChange={(next) => props.onCustomerTabDraftChange({ ...customerTabDraft, ...next })}
              />
              <button className="primary-button" type="submit">
                Open / Find Tab
              </button>
            </form>
            <div className="tab-chip-grid">
              {openCustomerTabs.length === 0 && <div className="empty-state">No open customer tabs yet.</div>}
              {openCustomerTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`tab-chip ${selectedCustomerTab?.id === tab.id ? "is-active" : ""}`}
                  onClick={() => {
                    props.onSelectCustomerTab(tab.id);
                    props.onCustomerTabDraftChange({
                      customerId: tab.customerId,
                      customerName: tab.customerName,
                      customerPhone: tab.customerPhone ?? ""
                    });
                  }}
                >
                  <strong>{tab.customerName}</strong>
                  <span>{currency(props.getCustomerTabTotal(tab))}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="section-block section-block-muted">
            <div className="section-block-header">
              <h3>{selectedCustomerTab ? `${selectedCustomerTab.customerName}'s Tab` : "Current Tab"}</h3>
              <p>{selectedCustomerTab ? "Add items from the left panel and finalize when the customer leaves." : "Open a tab to begin tracking consumables."}</p>
            </div>
            <div className="line-items">
              {!selectedCustomerTab && <div className="empty-state">Open or select a customer tab first.</div>}
              {selectedCustomerTab && selectedCustomerTab.items.length === 0 && (
                <div className="empty-state">Add items from the left panel.</div>
              )}
              {selectedCustomerTab?.items.map((item: CustomerTabItem) => (
                <div key={item.id} className="line-item-row">
                  <div>
                    <strong>{item.name}{item.soldAsPackOf ? ` (Pack of ${item.soldAsPackOf})` : ""}</strong>
                    <div className="muted">{currency(item.unitPrice)} each</div>
                  </div>
                  <label className="inline-field small">
                    <span>Qty</span>
                    <NumericInput
                      value={item.quantity}
                      min={1}
                      defaultValue={1}
                      onValueChange={(value) => props.onUpdateCustomerTabItemQuantity(item.id, value)}
                    />
                  </label>
                  <div className="button-row dense">
                    <strong>{currency(item.unitPrice * item.quantity)}</strong>
                    <button className="ghost-button danger" type="button" onClick={() => props.onRemoveItemFromCustomerTab(item.id)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="checkout-footer">
              <div className="checkout-total-block">
                <span className="muted">Tab total</span>
                <strong>{currency(selectedCustomerTab ? props.getCustomerTabTotal(selectedCustomerTab) : 0)}</strong>
              </div>
              <div className="button-row">
                {selectedCustomerTab && canEditCustomerTabDetails && (
                  <button className="secondary-button" type="button" onClick={() => props.onBeginEditCustomerTabDetails(selectedCustomerTab)}>
                    Edit Tab Details
                  </button>
                )}
                {selectedCustomerTab && (
                  <button className="ghost-button danger" type="button" onClick={() => props.onRejectCustomerTab(selectedCustomerTab.id)}>
                    Reject Tab
                  </button>
                )}
                <button className="primary-button" type="button" onClick={props.onBeginCustomerTabCheckout}>
                  Proceed to Checkout
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {cigPackModal && (
        <Modal title={`Add ${cigPackModal.item.name}`} onClose={() => setCigPackModal(null)}>
          <div className="form-grid">
            <p>Choose how to sell this cigarette item:</p>
            <div className="button-row field-span-full">
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  props.onAddItemToCustomerTab(cigPackModal.item, undefined);
                  setCigPackModal(null);
                }}
              >
                Single — {currency(cigPackModal.item.price)}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  props.onAddItemToCustomerTab(cigPackModal.item, cigPackModal.item.cigarettePack!.size);
                  setCigPackModal(null);
                }}
              >
                Pack of {cigPackModal.item.cigarettePack!.size} — {currency(cigPackModal.item.cigarettePack!.packPrice)}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {editCustomerTabDraft && (
        <Modal title="Edit Tab Details" onClose={() => props.onEditCustomerTabDraftChange(null)}>
          <form className="form-grid" onSubmit={props.onSaveCustomerTabDetails}>
            <CustomerAutocompleteFields
              customers={props.customers}
              customerId={editCustomerTabDraft.customerId}
              customerName={editCustomerTabDraft.customerName}
              customerPhone={editCustomerTabDraft.customerPhone}
              required
              phonePlaceholder="Optional"
              onChange={(next) =>
                props.onEditCustomerTabDraftChange({ ...editCustomerTabDraft, ...next })
              }
            />
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => props.onEditCustomerTabDraftChange(null)}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Save Tab Details
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
