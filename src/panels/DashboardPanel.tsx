import { type Dispatch, type FormEvent, type SetStateAction } from "react";
import type {
  AuditLog,
  CheckoutState,
  Customer,
  CustomerTab,
  CustomerTabDraft,
  InventoryItem,
  InventoryState,
  PlayMode,
  Session,
  StartSessionDraft,
  Station
} from "../types";
import { currency, formatDateTime, formatTime } from "../utils";
import { MetricCard } from "../components/MetricCard";
import { NumericInput } from "../components/NumericInput";
import { CustomerAutocompleteFields } from "../components/CustomerAutocompleteFields";

export function DashboardPanel(props: {
  stations: Station[];
  openCustomerTabs: CustomerTab[];
  auditLogs: AuditLog[];
  customers: Customer[];
  inventoryItems: InventoryItem[];
  checkoutState: CheckoutState | null;
  startSessionDraft: StartSessionDraft;
  selectedStartStation: Station | null;
  arcadeInventoryItems: InventoryItem[];
  selectedArcadeStartItem: InventoryItem | null;
  dashboardCustomerTabDraft: CustomerTabDraft;
  lowStockItems: InventoryItem[];
  outOfStockItems: InventoryItem[];
  occupiedItems: InventoryItem[];
  pendingBillsCount: number;
  totalAmountDue: number;
  getActiveSessionForStation: (stationId: string) => Session | undefined;
  getSessionLiveTotal: (session: Session, effectiveEndAt?: string) => number;
  getFrozenEndAtForSession: (sessionId: string) => string | undefined;
  getCustomerTabTotal: (tab: CustomerTab) => number;
  getInventoryState: (item: InventoryItem) => InventoryState;
  getInventoryStateLabel: (state: InventoryState) => string;
  getInventoryStatusDetail: (item: InventoryItem) => string;
  getAvailableStock: (item: InventoryItem, ignoreSessionId?: string, ignoreCustomerTabId?: string) => number;
  getInventoryPickerDetail: (item: InventoryItem, ignoreSessionId?: string, ignoreCustomerTabId?: string) => string;
  createStartSessionDraft: (station?: Station) => StartSessionDraft;
  onStartSessionDraftChange: Dispatch<SetStateAction<StartSessionDraft>>;
  onDashboardCustomerTabDraftChange: Dispatch<SetStateAction<CustomerTabDraft>>;
  onSetManageSessionId: (sessionId: string) => void;
  onSetShowStartSessionModal: (show: boolean) => void;
  onToggleSessionPause: (sessionId: string, pause: boolean) => void;
  onRejectSession: (sessionId: string) => void;
  onOpenSessionCheckout: (sessionId: string) => void;
  onOpenCustomerTabWorkspace: (tabId: string) => void;
  onBeginCustomerTabCheckoutById: (tabId: string) => void;
  onRejectCustomerTab: (tabId: string) => void;
  onStartSession: (event: FormEvent<HTMLFormElement>) => void;
  onCreateDashboardCustomerTab: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const {
    stations, openCustomerTabs, startSessionDraft, selectedStartStation,
    arcadeInventoryItems, selectedArcadeStartItem, dashboardCustomerTabDraft,
    lowStockItems, outOfStockItems, occupiedItems, checkoutState
  } = props;

  return (
    <section className="section-grid dashboard-grid">
      <div className="panel dashboard-column">
        <div className="dashboard-tile">
          <div className="panel-header">
            <div>
              <h2>Live Sessions</h2>
              <p>Monitor gaming sessions and open consumables tabs so nothing is left unbilled.</p>
            </div>
          </div>
          <div className="dashboard-tile-body panel-scroll">
            <div className="station-grid">
              {stations.map((station) => {
                const session = props.getActiveSessionForStation(station.id);
                const isBillingFrozen =
                  session &&
                  checkoutState?.mode === "session" &&
                  checkoutState.sessionId === session.id;
                return (
                  <article key={station.id} className={`station-card ${session ? `is-${session.status}` : "is-available"}`}>
                    <div className="station-card-header">
                      <div>
                        <h3>{station.name}</h3>
                        <p>{session ? (isBillingFrozen ? "Billing" : session.status === "paused" ? "Paused" : "Running") : "Available"}</p>
                      </div>
                      <button
                        className={session ? "ghost-button" : "station-start-link"}
                        type="button"
                        onClick={() =>
                          session
                            ? props.onSetManageSessionId(session.id)
                            : (() => {
                                props.onStartSessionDraftChange(props.createStartSessionDraft(station));
                                props.onSetShowStartSessionModal(true);
                              })()
                        }
                      >
                        {session ? "Manage" : "Start"}
                      </button>
                    </div>
                    {session ? (
                      <>
                        <div className="station-metrics">
                          <div>
                            <span className="muted">Started</span>
                            <strong>{formatTime(session.startedAt)}</strong>
                          </div>
                          <div>
                            <span className="muted">Live bill</span>
                            <strong>{currency(props.getSessionLiveTotal(session, props.getFrozenEndAtForSession(session.id)))}</strong>
                          </div>
                          <div>
                            <span className="muted">Customer</span>
                            <strong>{session.customerName || "Walk-in"}</strong>
                          </div>
                        </div>
                        <div className="button-row">
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => props.onSetManageSessionId(session.id)}
                          >
                            Consumables
                          </button>
                          {session.mode === "timed" &&
                            (session.status === "active" ? (
                              <button type="button" onClick={() => props.onToggleSessionPause(session.id, true)}>
                                Pause
                              </button>
                            ) : (
                              <button type="button" onClick={() => props.onToggleSessionPause(session.id, false)}>
                                Resume
                              </button>
                            ))}
                          <button className="ghost-button danger" type="button" onClick={() => props.onRejectSession(session.id)}>
                            Reject
                          </button>
                          <button className="primary-button" type="button" onClick={() => props.onOpenSessionCheckout(session.id)}>
                            Close Bill
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="empty-card-copy">
                        Click <strong>Start</strong> to open the session form for this station.
                      </div>
                    )}
                  </article>
                );
              })}
              {openCustomerTabs.map((tab) => (
                <article key={tab.id} className="station-card is-active customer-tab-live-card">
                  <div className="station-card-header">
                    <div>
                      <h3>{tab.customerName}</h3>
                      <p>Consumables tab</p>
                    </div>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => props.onOpenCustomerTabWorkspace(tab.id)}
                    >
                      Manage
                    </button>
                  </div>
                  <div className="station-metrics">
                    <div>
                      <span className="muted">Opened</span>
                      <strong>{formatTime(tab.createdAt)}</strong>
                    </div>
                    <div>
                      <span className="muted">Live bill</span>
                      <strong>{currency(props.getCustomerTabTotal(tab))}</strong>
                    </div>
                    <div>
                      <span className="muted">Items</span>
                      <strong>{`${tab.items.length}`}</strong>
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => props.onOpenCustomerTabWorkspace(tab.id)}
                    >
                      Manage Items
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => props.onBeginCustomerTabCheckoutById(tab.id)}
                    >
                      Close Bill
                    </button>
                    <button className="ghost-button danger" type="button" onClick={() => props.onRejectCustomerTab(tab.id)}>
                      Reject
                    </button>
                  </div>
                </article>
              ))}
              {stations.length === 0 && openCustomerTabs.length === 0 && (
                <div className="empty-state">No live stations or open consumables tabs right now.</div>
              )}
            </div>
          </div>
        </div>

        <div className="dashboard-tile">
          <div className="panel-header">
            <div>
              <h2>Recent Activity</h2>
              <p>Discounts, stock movements, and billing actions are all logged.</p>
            </div>
          </div>
          <div className="dashboard-tile-body panel-scroll">
            <div className="activity-list">
              {props.auditLogs.slice(0, 8).map((entry) => (
                <div key={entry.id} className="activity-row">
                  <strong>{entry.message}</strong>
                  <span className="muted">{formatDateTime(entry.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="panel dashboard-column">
        <div className="dashboard-tile">
          <div className="panel-header">
            <div>
              <h2>Start New Gaming Session</h2>
              <p>Use the station card Start button for the quickest flow, or start manually here.</p>
            </div>
          </div>
          <div className="dashboard-tile-body panel-scroll">
            <form className="form-grid dashboard-starter-form" onSubmit={props.onStartSession}>
              <label>
                <span>Station</span>
                <select
                  value={startSessionDraft.stationId}
                  onChange={(event) => {
                    const nextStation = props.stations.find((station) => station.id === event.target.value);
                    props.onStartSessionDraftChange((previous) => ({
                      ...previous,
                      stationId: event.target.value,
                      playMode: nextStation?.ltpEnabled ? previous.playMode : "group",
                      arcadeItemId: nextStation?.mode === "unit_sale" ? (props.arcadeInventoryItems[0]?.id ?? "") : "",
                      arcadeQuantity: 1
                    }));
                  }}
                >
                  <option value="">Select station</option>
                  {stations
                    .filter((station) => !props.getActiveSessionForStation(station.id))
                    .map((station) => (
                      <option key={station.id} value={station.id}>
                        {station.name}
                      </option>
                    ))}
                </select>
              </label>
              <CustomerAutocompleteFields
                customers={props.customers}
                customerId={startSessionDraft.customerId}
                customerName={startSessionDraft.customerName}
                customerPhone={startSessionDraft.customerPhone}
                namePlaceholder="Optional"
                phonePlaceholder="Optional"
                onChange={(next) => props.onStartSessionDraftChange((previous) => ({ ...previous, ...next }))}
              />
              {selectedStartStation?.ltpEnabled && (
                <label>
                  <span>Play Mode</span>
                  <select
                    value={startSessionDraft.playMode}
                    onChange={(event) =>
                      props.onStartSessionDraftChange((previous) => ({ ...previous, playMode: event.target.value as PlayMode }))
                    }
                  >
                    <option value="solo">Solo (LTP)</option>
                    <option value="group">Group</option>
                  </select>
                </label>
              )}
              {selectedStartStation?.mode === "unit_sale" && (
                <>
                  {arcadeInventoryItems.length === 0 && (
                    <div className="field-span-full error-text">
                      Add an active `Arcade` inventory item first so this station can start with coin packs.
                    </div>
                  )}
                  <label>
                    <span>Coin Pack</span>
                    <select
                      value={startSessionDraft.arcadeItemId}
                      onChange={(event) =>
                        props.onStartSessionDraftChange((previous) => ({ ...previous, arcadeItemId: event.target.value }))
                      }
                    >
                      <option value="">Select coin pack</option>
                      {arcadeInventoryItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {currency(item.price)} · {props.getInventoryPickerDetail(item)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Upfront Packs</span>
                    <NumericInput
                      min={1}
                      defaultValue={1}
                      value={startSessionDraft.arcadeQuantity}
                      onValueChange={(value) =>
                        props.onStartSessionDraftChange((previous) => ({ ...previous, arcadeQuantity: value }))
                      }
                    />
                  </label>
                  {selectedArcadeStartItem && (
                    <div className="field-span-full helper-text">
                      Default arcade entry: {selectedArcadeStartItem.name} at {currency(selectedArcadeStartItem.price)} each.
                      Increase packs here if the customer wants more coins upfront.
                    </div>
                  )}
                </>
              )}
              <div className="starter-submit-slot">
                <button className="primary-button" type="submit" disabled={selectedStartStation?.mode === "unit_sale" && arcadeInventoryItems.length === 0}>
                  Start Gaming Session
                </button>
              </div>
            </form>
            <div className="section-block section-block-muted dashboard-subsection">
              <div className="section-block-header">
                <h3>Start New Consumables Session</h3>
                <p>Open a food, drink, or sheesha tab directly from the dashboard.</p>
              </div>
              <form className="form-grid dashboard-starter-form" onSubmit={props.onCreateDashboardCustomerTab}>
                <CustomerAutocompleteFields
                  customers={props.customers}
                  customerId={dashboardCustomerTabDraft.customerId}
                  customerName={dashboardCustomerTabDraft.customerName}
                  customerPhone={dashboardCustomerTabDraft.customerPhone}
                  required
                  namePlaceholder="Enter customer name"
                  phonePlaceholder="Optional"
                  onChange={(next) => props.onDashboardCustomerTabDraftChange((previous) => ({ ...previous, ...next }))}
                />
                <div className="starter-submit-slot">
                  <button className="primary-button" type="submit">
                    Start Consumable Session
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>

        <div className="dashboard-tile">
          <div className="panel-header">
            <div>
              <h2>Inventory Alerts</h2>
              <p>Quick restock reminder for low, out-of-stock, and reusable occupied items.</p>
            </div>
          </div>
          <div className="dashboard-tile-body panel-scroll">
            <div className="metrics-row">
              <MetricCard label="Low Stock" value={`${lowStockItems.length}`} />
              <MetricCard label="Out of Stock" value={`${outOfStockItems.length}`} />
              <MetricCard label="Occupied" value={`${occupiedItems.length}`} />
              {props.pendingBillsCount > 0 && (
                <MetricCard label="Pending Bills" value={`${props.pendingBillsCount}`} sub={`₹${props.totalAmountDue.toFixed(0)} due`} />
              )}
            </div>
            <div className="inventory-alert-list">
              {props.inventoryItems
                .filter((item) => item.active)
                .sort((left, right) => {
                  const priority: Record<InventoryState, number> = {
                    occupied: 0,
                    out: 1,
                    low: 2,
                    available: 3,
                    healthy: 4
                  };
                  const stateDelta = priority[props.getInventoryState(left)] - priority[props.getInventoryState(right)];
                  if (stateDelta !== 0) {
                    return stateDelta;
                  }
                  return props.getAvailableStock(left) - props.getAvailableStock(right);
                })
                .slice(0, 6)
                .map((item) => {
                  const state = props.getInventoryState(item);
                  return (
                    <div key={item.id} className={`inventory-alert-row is-${state}`}>
                      <div>
                        <strong>{item.name}</strong>
                        <div className="muted">
                          {props.getInventoryStatusDetail(item)}
                        </div>
                      </div>
                      <span className={`inventory-badge is-${state}`}>
                        {props.getInventoryStateLabel(state)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
