import { type FormEvent, useState } from "react";
import type { Customer, CustomerTab, CustomerTabDraft, CustomerTabEditDraft, CustomerTabItem, InventoryItem, Session } from "../types";
import { currency, formatMinutes } from "../utils";
import { getCategoryIcon } from "../constants";
import { Modal } from "../components/Modal";
import { CATEGORY_IMAGES } from "../categoryImages";

const LARGE_ICON_CATEGORIES = new Set(["Herbal Pot Flavour", "Herbal Pot Flavours", "Herbal Flavour", "Food"]);
import { NumericInput } from "../components/NumericInput";
import { CustomerAutocompleteFields } from "../components/CustomerAutocompleteFields";

export function SalePanel(props: {
  inventoryItems: InventoryItem[];
  customers: Customer[];
  customerTabSearch: string;
  customerTabDraft: CustomerTabDraft;
  openCustomerTabs: CustomerTab[];
  selectedCustomerTab: CustomerTab | null;
  selectedCustomerTabPreviousHops: Session[];
  editCustomerTabDraft: CustomerTabEditDraft | null;
  canEditCustomerTabDetails: boolean;
  getInventoryPickerDetail: (item: InventoryItem, ignoreSessionId?: string, ignoreCustomerTabId?: string) => string;
  getCustomerTabTotal: (tab: CustomerTab) => number;
  getSessionLiveTotal: (session: Session, effectiveEndAt?: string) => number;
  getSessionBilledMinutes: (session: Session) => number;
  onCustomerTabSearchChange: (value: string) => void;
  onCustomerTabDraftChange: (next: CustomerTabDraft) => void;
  onSelectCustomerTab: (tabId: string) => void;
  onEditCustomerTabDraftChange: (next: CustomerTabEditDraft | null) => void;
  onAddItemToCustomerTab: (customerTabId: string, item: InventoryItem, sellAsPackOf?: number) => void;
  onCreateOrSelectCustomerTab: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateCustomerTabItemQuantity: (customerTabId: string, lineId: string, quantity: number) => void;
  onRemoveItemFromCustomerTab: (customerTabId: string, lineId: string) => void;
  onBeginEditCustomerTabDetails: (tab: CustomerTab) => void;
  onRejectCustomerTab: (tabId: string) => void;
  onBeginCustomerTabCheckout: () => void;
  onSaveCustomerTabDetails: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const {
    customerTabDraft,
    openCustomerTabs,
    selectedCustomerTab,
    selectedCustomerTabPreviousHops,
    editCustomerTabDraft,
    canEditCustomerTabDetails
  } = props;
  const [cigPackModal, setCigPackModal] = useState<{ item: InventoryItem } | null>(null);
  const [showInlineTabSwitcher, setShowInlineTabSwitcher] = useState(false);
  const previousHopTotal = selectedCustomerTabPreviousHops.reduce(
    (total, session) => total + props.getSessionLiveTotal(session, session.endedAt),
    0
  );
  const currentTabTotal = selectedCustomerTab ? props.getCustomerTabTotal(selectedCustomerTab) : 0;
  const liveTotal = currentTabTotal + previousHopTotal;
  const selectedTabItemCount =
    (selectedCustomerTab?.items.length ?? 0) +
    selectedCustomerTabPreviousHops.reduce((total, session) => total + session.items.length, 0);
  const hasSelectedTab = Boolean(selectedCustomerTab);

  function selectCustomerTab(tab: CustomerTab) {
    props.onSelectCustomerTab(tab.id);
    props.onCustomerTabDraftChange({
      customerId: tab.customerId,
      customerName: tab.customerName,
      customerPhone: tab.customerPhone ?? ""
    });
    setShowInlineTabSwitcher(false);
  }

  return (
    <>
      <section className="section-grid sales-layout">
        <div className="panel sale-catalog-panel">
          <div className={`active-tab-banner ${selectedCustomerTab ? "is-selected" : "is-empty"}`}>
            <div>
              <span className="active-tab-kicker">Adding to</span>
              <h2>{selectedCustomerTab ? selectedCustomerTab.customerName : "No customer tab selected"}</h2>
              <p>
                {selectedCustomerTab
                  ? [
                      selectedCustomerTab.customerPhone || "No phone",
                      `${selectedTabItemCount} item${selectedTabItemCount === 1 ? "" : "s"}`,
                      currency(liveTotal)
                    ].join(" · ")
                  : "Select the correct customer before adding inventory items."}
              </p>
            </div>
            <button className="secondary-button" type="button" onClick={() => setShowInlineTabSwitcher((value) => !value)}>
              {selectedCustomerTab ? "Change Tab" : "Select Tab"}
            </button>
            {showInlineTabSwitcher && (
              <div className="inline-tab-switcher">
                <div className="inline-tab-switcher-header">
                  <strong>Select customer tab</strong>
                  <span className="muted">{openCustomerTabs.length} open</span>
                </div>
                <div className="tab-chip-grid compact">
                  {openCustomerTabs.length === 0 && <div className="empty-state">No open customer tabs yet.</div>}
                  {openCustomerTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`tab-chip ${selectedCustomerTab?.id === tab.id ? "is-active" : ""}`}
                      onClick={() => selectCustomerTab(tab)}
                    >
                      <strong>{tab.customerName}</strong>
                      <span>{tab.customerPhone || "No phone"}</span>
                      <span>{tab.items.length} item{tab.items.length === 1 ? "" : "s"} · {currency(props.getCustomerTabTotal(tab))}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="panel-header">
            <div>
              <h2>Consumables Catalog</h2>
              <p>{selectedCustomerTab ? `Managing: ${selectedCustomerTab.customerName}` : "Select a customer tab before adding items."}</p>
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
                  disabled={!hasSelectedTab}
                  onClick={() => {
                    if (!selectedCustomerTab) {
                      return;
                    }
                    if (item.cigarettePack) {
                      setCigPackModal({ item });
                    } else {
                      props.onAddItemToCustomerTab(selectedCustomerTab.id, item);
                    }
                  }}
                >
                  <div className="catalog-card-info">
                    <strong>{item.name}</strong>
                    <span className={item.category === "Cigarettes" ? "category-icon--cigarettes" : ""}>{item.category}</span>
                    <span>{currency(item.price)}</span>
                    <span className="muted">{props.getInventoryPickerDetail(item, undefined, selectedCustomerTab?.id)}</span>
                  </div>
                  {CATEGORY_IMAGES[item.category] ? (
                    <img
                      src={CATEGORY_IMAGES[item.category]}
                      alt=""
                      className={`catalog-card-icon-large${LARGE_ICON_CATEGORIES.has(item.category) ? " catalog-card-icon-large--xl" : ""}`}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="catalog-card-icon-large" aria-hidden="true">{getCategoryIcon(item.category)}</span>
                  )}
                </button>
              ))}
          </div>
          {!selectedCustomerTab && (
            <div className="warning-banner">Select a customer tab first. Item buttons are disabled until the target is clear.</div>
          )}
        </div>

        <div className="panel sale-tab-panel">
          <div className="panel-header">
            <div>
              <h2>Consumables Tab</h2>
              <p>Track sheesha, food, and drink items for customers who pay when they leave.</p>
            </div>
          </div>
          <div className="section-block sale-tab-list-section">
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
                  onClick={() => selectCustomerTab(tab)}
                >
                  <strong>{tab.customerName}</strong>
                  <span>{tab.customerPhone || "No phone"}</span>
                  <span>{tab.items.length} item{tab.items.length === 1 ? "" : "s"} · {currency(props.getCustomerTabTotal(tab))}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="section-block section-block-muted sale-current-tab-section">
            <div className="section-block-header">
              <h3>{selectedCustomerTab ? `${selectedCustomerTab.customerName}'s Tab` : "Current Tab"}</h3>
              <p>{selectedCustomerTab ? "Add items from the left panel and finalize when the customer leaves." : "Open a tab to begin tracking consumables."}</p>
            </div>
            <div className="line-items">
              {!selectedCustomerTab && <div className="empty-state">Open or select a customer tab first.</div>}
              {selectedCustomerTab && selectedCustomerTab.items.length === 0 && selectedCustomerTabPreviousHops.length === 0 && (
                <div className="empty-state">Add items from the left panel.</div>
              )}
              {selectedCustomerTabPreviousHops.map((session) => (
                <div key={session.id} className="line-item-row">
                  <div>
                    <strong>{session.stationNameSnapshot}</strong>
                    <div className="muted">
                      Previous game session
                      {session.mode === "timed" ? ` · ${formatMinutes(props.getSessionBilledMinutes(session))}` : ""}
                    </div>
                    {session.items.length > 0 && (
                      <div className="muted">
                        {session.items.map((item) => `${item.quantity} x ${item.name}`).join(", ")}
                      </div>
                    )}
                  </div>
                  <div className="button-row dense">
                    <strong>{currency(props.getSessionLiveTotal(session, session.endedAt))}</strong>
                    <span className="muted">Carried forward</span>
                  </div>
                </div>
              ))}
              {selectedCustomerTab?.items.map((item: CustomerTabItem) => {
                const invCategory = props.inventoryItems.find((i) => i.id === item.inventoryItemId)?.category ?? "";
                const catImage = CATEGORY_IMAGES[invCategory];
                return (
                <div key={item.id} className="line-item-row">
                  <div>
                    <strong>
                      {catImage
                        ? <img src={catImage} alt="" className="category-icon-img" />
                        : invCategory ? <span className="category-icon">{getCategoryIcon(invCategory)}</span> : null}
                      {item.name}{item.soldAsPackOf ? ` (Pack of ${item.soldAsPackOf})` : ""}
                    </strong>
                    <div className="muted">{currency(item.unitPrice)} each</div>
                  </div>
                  <label className="inline-field small">
                    <span>Qty</span>
                    <NumericInput
                      value={item.quantity}
                      min={1}
                      defaultValue={1}
                      onValueChange={(value) => props.onUpdateCustomerTabItemQuantity(selectedCustomerTab.id, item.id, value)}
                    />
                  </label>
                  <div className="button-row dense">
                    <strong>{currency(item.unitPrice * item.quantity)}</strong>
                    <button className="ghost-button danger" type="button" onClick={() => props.onRemoveItemFromCustomerTab(selectedCustomerTab.id, item.id)}>
                      Remove
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
            <div className="checkout-footer">
              <div className="checkout-total-block">
                <span className="muted">{previousHopTotal > 0 ? "Live total" : "Tab total"}</span>
                <strong>{currency(selectedCustomerTab ? liveTotal : 0)}</strong>
                {previousHopTotal > 0 && <small className="muted">Includes previous sessions</small>}
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
                  if (selectedCustomerTab) {
                    props.onAddItemToCustomerTab(selectedCustomerTab.id, cigPackModal.item, undefined);
                  }
                  setCigPackModal(null);
                }}
              >
                Single — {currency(cigPackModal.item.price)}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  if (selectedCustomerTab) {
                    props.onAddItemToCustomerTab(selectedCustomerTab.id, cigPackModal.item, cigPackModal.item.cigarettePack!.size);
                  }
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
