import { type FormEvent, useState } from "react";
import type { Bill, ComboPackage, Customer, CustomerTab, CustomerTabDraft, CustomerTabEditDraft, CustomerTabItem, InventoryItem, SellableInventoryOption, Session } from "../types";
import { currency, formatMinutes } from "../utils";
import { getCategoryIcon } from "../constants";
import { Modal } from "../components/Modal";
import { CATEGORY_IMAGES } from "../categoryImages";

const LARGE_ICON_CATEGORIES = new Set(["Herbal Pot Flavour", "Herbal Pot Flavours", "Herbal Flavour", "Food"]);
import { NumericInput } from "../components/NumericInput";
import { CustomerAutocompleteFields } from "../components/CustomerAutocompleteFields";

export function SalePanel(props: {
  inventoryItems: InventoryItem[];
  sellableOptions: SellableInventoryOption[];
  consumablesCombos: ComboPackage[];
  customers: Customer[];
  customerTabSearch: string;
  customerTabDraft: CustomerTabDraft;
  openCustomerTabs: CustomerTab[];
  selectedCustomerTab: CustomerTab | null;
  selectedCustomerTabPreviousHops: Session[];
  selectedCustomerTabPendingBills: Bill[];
  editCustomerTabDraft: CustomerTabEditDraft | null;
  canEditCustomerTabDetails: boolean;
  getSellableOptionPickerDetail: (option: SellableInventoryOption, ignoreSessionId?: string, ignoreCustomerTabId?: string) => string;
  getCustomerTabTotal: (tab: CustomerTab) => number;
  getPendingDueForCustomerTab: (tab: CustomerTab) => number;
  getSessionLiveTotal: (session: Session, effectiveEndAt?: string) => number;
  getSessionBilledMinutes: (session: Session) => number;
  onCustomerTabSearchChange: (value: string) => void;
  onCustomerTabDraftChange: (next: CustomerTabDraft) => void;
  onSelectCustomerTab: (tabId: string) => void;
  onEditCustomerTabDraftChange: (next: CustomerTabEditDraft | null) => void;
  onAddItemToCustomerTab: (customerTabId: string, option: SellableInventoryOption, sellAsPackOf?: number) => void;
  onApplyComboToCustomerTab: (customerTabId: string, comboId: string, choices: Record<string, string[]>) => void;
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
    selectedCustomerTabPendingBills,
    editCustomerTabDraft,
    canEditCustomerTabDetails
  } = props;
  const [cigPackModal, setCigPackModal] = useState<{ option: SellableInventoryOption } | null>(null);
  const [showInlineTabSwitcher, setShowInlineTabSwitcher] = useState(false);
  const [comboChoiceDrafts, setComboChoiceDrafts] = useState<Record<string, Record<string, string[]>>>({});
  const previousHopTotal = selectedCustomerTabPreviousHops.reduce(
    (total, session) => total + props.getSessionLiveTotal(session, session.endedAt),
    0
  );
  const currentTabTotal = selectedCustomerTab ? props.getCustomerTabTotal(selectedCustomerTab) : 0;
  const previousPendingDue = selectedCustomerTabPendingBills.reduce((total, bill) => total + bill.amountDue, 0);
  const liveTotal = currentTabTotal + previousHopTotal + previousPendingDue;
  const selectedTabItemCount =
    (selectedCustomerTab?.items.length ?? 0) +
    (selectedCustomerTab?.comboApplications?.length ?? 0) +
    selectedCustomerTabPreviousHops.reduce((total, session) => total + session.items.length, 0);
  const liveTotalDetail = [
    previousHopTotal > 0 ? "previous sessions" : "",
    previousPendingDue > 0 ? "previous dues" : ""
  ].filter(Boolean).join(" + ");
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

  function getSellableOptionName(optionId: string) {
    return props.sellableOptions.find((option) => option.id === optionId)?.name ?? "Item";
  }

  function setComboChoice(comboId: string, groupId: string, index: number, optionId: string) {
    setComboChoiceDrafts((previous) => {
      const comboDraft = previous[comboId] ?? {};
      const groupDraft = [...(comboDraft[groupId] ?? [])];
      groupDraft[index] = optionId;
      return {
        ...previous,
        [comboId]: {
          ...comboDraft,
          [groupId]: groupDraft
        }
      };
    });
  }

  function applyCombo(combo: ComboPackage) {
    if (!selectedCustomerTab) {
      return;
    }
    props.onApplyComboToCustomerTab(selectedCustomerTab.id, combo.id, comboChoiceDrafts[combo.id] ?? {});
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
                {selectedCustomerTab && liveTotalDetail && <span className="muted"> Includes {liveTotalDetail}.</span>}
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
                      {props.getPendingDueForCustomerTab(tab) > 0 && (
                        <span className="pending-amount">Previous dues {currency(props.getPendingDueForCustomerTab(tab))}</span>
                      )}
                      <span>
                        {tab.items.length + (tab.comboApplications?.length ?? 0)} item{tab.items.length + (tab.comboApplications?.length ?? 0) === 1 ? "" : "s"} · {currency(props.getCustomerTabTotal(tab))}
                      </span>
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
          {props.consumablesCombos.length > 0 && (
            <div className="section-block combo-sale-section">
              <div className="section-block-header">
                <h3>Combos</h3>
                <p>{selectedCustomerTab ? "Apply a package to this customer tab." : "Select a customer tab before applying combos."}</p>
              </div>
              <div className="combo-sale-grid">
                {props.consumablesCombos.map((combo) => (
                  <div key={combo.id} className="combo-sale-card">
                    <div className="combo-sale-card-header">
                      <div>
                        <strong>{combo.name}</strong>
                        <span>{currency(combo.price)}</span>
                      </div>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={!selectedCustomerTab}
                        onClick={() => applyCombo(combo)}
                      >
                        Apply
                      </button>
                    </div>
                    {combo.fixedItems.length > 0 && (
                      <div className="muted">
                        Includes {combo.fixedItems.map((item) => `${item.quantity} x ${getSellableOptionName(item.sellableOptionId)}`).join(", ")}
                      </div>
                    )}
                    {combo.choiceGroups.map((group) => {
                      const requiredQuantity = Math.max(1, Math.trunc(group.requiredQuantity));
                      const selectedValues = comboChoiceDrafts[combo.id]?.[group.id] ?? [];
                      return (
                        <div key={group.id} className="combo-sale-choice-group">
                          <span className="field-label">{group.label} ({requiredQuantity})</span>
                          {Array.from({ length: requiredQuantity }, (_, index) => (
                            <select
                              key={`${group.id}-${index}`}
                              value={selectedValues[index] ?? ""}
                              disabled={!selectedCustomerTab}
                              onChange={(event) => setComboChoice(combo.id, group.id, index, event.target.value)}
                            >
                              <option value="">Choose option {index + 1}</option>
                              {group.optionIds.map((optionId) => (
                                <option key={optionId} value={optionId}>{getSellableOptionName(optionId)}</option>
                              ))}
                            </select>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="catalog-grid">
            {props.sellableOptions
              .filter((option) =>
                `${option.name} ${option.sourceName} ${option.category} ${option.barcode ?? ""} ${option.sourceBarcode ?? ""}`.toLowerCase().includes(props.customerTabSearch.toLowerCase())
              )
              .map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="catalog-card"
                  disabled={!hasSelectedTab}
                  onClick={() => {
                    if (!selectedCustomerTab) {
                      return;
                    }
                    if (option.isBaseItem && option.item.cigarettePack) {
                      setCigPackModal({ option });
                    } else {
                      props.onAddItemToCustomerTab(selectedCustomerTab.id, option);
                    }
                  }}
                >
                  <div className="catalog-card-info">
                    <strong>{option.name}</strong>
                    <span className={option.category === "Cigarettes" ? "category-icon--cigarettes" : ""}>
                      {option.category}{option.isBaseItem ? "" : ` · from ${option.sourceName}`}
                    </span>
                    <span>{currency(option.price)}</span>
                    <span className="muted">{props.getSellableOptionPickerDetail(option, undefined, selectedCustomerTab?.id)}</span>
                  </div>
                  {CATEGORY_IMAGES[option.category] ? (
                    <img
                      src={CATEGORY_IMAGES[option.category]}
                      alt=""
                      className={`catalog-card-icon-large${LARGE_ICON_CATEGORIES.has(option.category) ? " catalog-card-icon-large--xl" : ""}`}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="catalog-card-icon-large" aria-hidden="true">{getCategoryIcon(option.category)}</span>
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
                  {props.getPendingDueForCustomerTab(tab) > 0 && (
                    <span className="pending-amount">Previous dues {currency(props.getPendingDueForCustomerTab(tab))}</span>
                  )}
                  <span>
                    {tab.items.length + (tab.comboApplications?.length ?? 0)} item{tab.items.length + (tab.comboApplications?.length ?? 0) === 1 ? "" : "s"} · {currency(props.getCustomerTabTotal(tab))}
                  </span>
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
              {selectedCustomerTab && selectedCustomerTab.items.length === 0 && (selectedCustomerTab.comboApplications?.length ?? 0) === 0 && selectedCustomerTabPreviousHops.length === 0 && selectedCustomerTabPendingBills.length === 0 && (
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
              {selectedCustomerTabPendingBills.map((bill) => (
                <div key={bill.id} className="line-item-row previous-due-session-row">
                  <div>
                    <strong>Previous due - {bill.billNumber}</strong>
                    <div className="muted">{bill.customerName || selectedCustomerTab?.customerName || "Customer"}</div>
                  </div>
                  <div className="button-row dense">
                    <strong className="pending-amount">{currency(bill.amountDue)}</strong>
                    <span className="muted">Pending bill</span>
                  </div>
                </div>
              ))}
              {selectedCustomerTab?.comboApplications?.map((combo) => (
                <div key={combo.id} className="line-item-row combo-package-row">
                  <div>
                    <strong>{combo.comboName}</strong>
                    <div className="muted">Combo package</div>
                  </div>
                  <div className="button-row dense">
                    <strong>{currency(combo.price)}</strong>
                    <span className="muted">Applied</span>
                  </div>
                </div>
              ))}
              {selectedCustomerTab?.items.map((item: CustomerTabItem) => {
                const invCategory = props.inventoryItems.find((i) => i.id === item.inventoryItemId)?.category ?? "";
                const catImage = CATEGORY_IMAGES[invCategory];
                const isComboIncluded = Boolean(item.comboApplicationId);
                return (
                <div key={item.id} className="line-item-row">
                  <div>
                    <strong>
                      {catImage
                        ? <img src={catImage} alt="" className="category-icon-img" />
                        : invCategory ? <span className="category-icon">{getCategoryIcon(invCategory)}</span> : null}
                      {item.name}{item.soldAsPackOf ? ` (Pack of ${item.soldAsPackOf})` : ""}
                    </strong>
                    <div className="muted">{isComboIncluded ? "Included in combo" : `${currency(item.unitPrice)} each`}</div>
                  </div>
                  <label className="inline-field small">
                    <span>Qty</span>
                    <NumericInput
                      value={item.quantity}
                      min={1}
                      defaultValue={1}
                      disabled={isComboIncluded}
                      onValueChange={(value) => props.onUpdateCustomerTabItemQuantity(selectedCustomerTab.id, item.id, value)}
                    />
                  </label>
                  <div className="button-row dense">
                    <strong>{currency(item.unitPrice * item.quantity)}</strong>
                    {isComboIncluded ? (
                      <span className="muted">Included</span>
                    ) : (
                      <button className="ghost-button danger" type="button" onClick={() => props.onRemoveItemFromCustomerTab(selectedCustomerTab.id, item.id)}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
            <div className="checkout-footer">
              <div className="checkout-total-block">
                <span className="muted">{previousPendingDue > 0 ? "Tab total + dues" : previousHopTotal > 0 ? "Live total" : "Tab total"}</span>
                <strong>{currency(selectedCustomerTab ? liveTotal : 0)}</strong>
                {liveTotalDetail && <small className="muted">Includes {liveTotalDetail}</small>}
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
        <Modal title={`Add ${cigPackModal.option.name}`} onClose={() => setCigPackModal(null)}>
          <div className="form-grid">
            <p>Choose how to sell this cigarette item:</p>
            <div className="button-row field-span-full">
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  if (selectedCustomerTab) {
                    props.onAddItemToCustomerTab(selectedCustomerTab.id, cigPackModal.option, undefined);
                  }
                  setCigPackModal(null);
                }}
              >
                Single — {currency(cigPackModal.option.price)}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  if (selectedCustomerTab) {
                    props.onAddItemToCustomerTab(selectedCustomerTab.id, cigPackModal.option, cigPackModal.option.item.cigarettePack!.size);
                  }
                  setCigPackModal(null);
                }}
              >
                Pack of {cigPackModal.option.item.cigarettePack!.size} — {currency(cigPackModal.option.item.cigarettePack!.packPrice)}
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
