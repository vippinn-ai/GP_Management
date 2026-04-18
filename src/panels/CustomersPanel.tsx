import { type FormEvent } from "react";
import type { Bill, Customer, CustomerProfileEditDraft, Station } from "../types";
import { currency, formatDateTime } from "../utils";
import { Modal } from "../components/Modal";

interface CustomerStatEntry {
  customer: Customer;
  bills: Bill[];
  totalSpend: number;
  visitCount: number;
  lastVisitAt: string;
  favoriteStationName?: string;
}

interface CustomerAnalytics {
  stats: CustomerStatEntry[];
  topSpend: CustomerStatEntry | undefined;
  topVisits: CustomerStatEntry | undefined;
  totalProfiles: number;
  repeatCustomersCount: number;
  repeatRate: number;
  averageSpendPerCustomer: number;
  oneTimeCustomersCount: number;
  activeCustomersCount: number;
  mostPlayedStation: string | undefined;
  peakHourLabel: string;
  peakWeekdayLabel: string;
  recentHighValueCustomers: CustomerStatEntry[];
  atRiskCustomers: CustomerStatEntry[];
}

export function CustomersPanel(props: {
  stations: Station[];
  customerAnalytics: CustomerAnalytics;
  filteredCustomerProfiles: CustomerStatEntry[];
  selectedCustomerProfile: Customer | null;
  selectedCustomerProfileStats: CustomerStatEntry | null;
  customerProfileSearch: string;
  customerProfileSort: "last_visit" | "total_spend" | "visit_count";
  editCustomerProfileDraft: CustomerProfileEditDraft | null;
  onCustomerProfileSearchChange: (value: string) => void;
  onCustomerProfileSortChange: (value: "last_visit" | "total_spend" | "visit_count") => void;
  onSelectCustomerProfile: (customerId: string) => void;
  onEditCustomerProfileDraftChange: (next: CustomerProfileEditDraft | null) => void;
  onBeginEditCustomerProfile: (customer: Customer) => void;
  onSaveCustomerProfile: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { customerAnalytics, filteredCustomerProfiles, selectedCustomerProfile, selectedCustomerProfileStats, editCustomerProfileDraft } = props;

  return (
    <>
      <section className="section-grid sales-layout customer-profiles-layout">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Customer Analytics</h2>
              <p>Track repeat visits, top spenders, business timing, and offline follow-up opportunities.</p>
            </div>
          </div>
          <div className="reports-kpi-grid">
            <div className="report-kpi-card is-primary">
              <span className="muted">Total Profiles</span>
              <strong>{customerAnalytics.totalProfiles}</strong>
            </div>
            <div className="report-kpi-card is-primary">
              <span className="muted">Repeat Customers</span>
              <strong>{customerAnalytics.repeatCustomersCount}</strong>
              <span className="muted">{customerAnalytics.repeatRate.toFixed(1)}% repeat rate</span>
            </div>
            <div className="report-kpi-card is-primary">
              <span className="muted">Average Spend / Customer</span>
              <strong>{currency(customerAnalytics.averageSpendPerCustomer)}</strong>
            </div>
          </div>
          <div className="insight-grid">
            <div className="insight-card">
              <span className="muted">Top Customer by Spend</span>
              <strong>{customerAnalytics.topSpend?.customer.name ?? "No data"}</strong>
              <span className="muted">{customerAnalytics.topSpend ? currency(customerAnalytics.topSpend.totalSpend) : "No issued bills yet"}</span>
            </div>
            <div className="insight-card">
              <span className="muted">Top Customer by Visits</span>
              <strong>{customerAnalytics.topVisits?.customer.name ?? "No data"}</strong>
              <span className="muted">{customerAnalytics.topVisits ? `${customerAnalytics.topVisits.visitCount} visits` : "No issued bills yet"}</span>
            </div>
            <div className="insight-card">
              <span className="muted">Customer Mix</span>
              <strong>{customerAnalytics.activeCustomersCount} active</strong>
              <span className="muted">{customerAnalytics.oneTimeCustomersCount} one-time customers</span>
            </div>
          </div>
          <div className="section-block section-block-muted">
            <div className="section-block-header">
              <h3>Owner Insights</h3>
              <p>Operational and marketing signals from issued customer bills.</p>
            </div>
            <div className="insight-grid">
              <div className="insight-card">
                <span className="muted">Most-Played Station</span>
                <strong>{customerAnalytics.mostPlayedStation ?? "No data"}</strong>
              </div>
              <div className="insight-card">
                <span className="muted">Peak Visit Hour</span>
                <strong>{customerAnalytics.peakHourLabel}</strong>
              </div>
              <div className="insight-card">
                <span className="muted">Peak Weekday</span>
                <strong>{customerAnalytics.peakWeekdayLabel}</strong>
              </div>
            </div>
            <div className="section-grid customer-insight-lists">
              <div className="section-block">
                <div className="section-block-header">
                  <h3>Top Customers by Spend</h3>
                </div>
                <div className="activity-list compact-list">
                  {customerAnalytics.stats.filter((entry) => entry.totalSpend > 0).slice().sort((left, right) => right.totalSpend - left.totalSpend).slice(0, 5).map((entry) => (
                    <div key={entry.customer.id} className="activity-row">
                      <strong>{entry.customer.name}</strong>
                      <span className="muted">{currency(entry.totalSpend)}</span>
                    </div>
                  ))}
                  {customerAnalytics.stats.every((entry) => entry.totalSpend <= 0) && <div className="empty-state">No issued customer spend yet.</div>}
                </div>
              </div>
              <div className="section-block">
                <div className="section-block-header">
                  <h3>Top Customers by Visits</h3>
                </div>
                <div className="activity-list compact-list">
                  {customerAnalytics.stats.filter((entry) => entry.visitCount > 0).slice().sort((left, right) => right.visitCount - left.visitCount).slice(0, 5).map((entry) => (
                    <div key={entry.customer.id} className="activity-row">
                      <strong>{entry.customer.name}</strong>
                      <span className="muted">{entry.visitCount} visits</span>
                    </div>
                  ))}
                  {customerAnalytics.stats.every((entry) => entry.visitCount <= 0) && <div className="empty-state">No visit history yet.</div>}
                </div>
              </div>
              <div className="section-block">
                <div className="section-block-header">
                  <h3>Recent High-Value Customers</h3>
                </div>
                <div className="activity-list compact-list">
                  {customerAnalytics.recentHighValueCustomers.length > 0 ? customerAnalytics.recentHighValueCustomers.map((entry) => (
                    <div key={entry.customer.id} className="activity-row">
                      <strong>{entry.customer.name}</strong>
                      <span className="muted">{currency(entry.totalSpend)} · {formatDateTime(entry.lastVisitAt)}</span>
                    </div>
                  )) : <div className="empty-state">No high-value history yet.</div>}
                </div>
              </div>
              <div className="section-block">
                <div className="section-block-header">
                  <h3>At-Risk Customers</h3>
                </div>
                <div className="activity-list compact-list">
                  {customerAnalytics.atRiskCustomers.length > 0 ? customerAnalytics.atRiskCustomers.slice(0, 5).map((entry) => (
                    <div key={entry.customer.id} className="activity-row">
                      <strong>{entry.customer.name}</strong>
                      <span className="muted">Last visit {formatDateTime(entry.lastVisitAt)}</span>
                    </div>
                  )) : <div className="empty-state">No at-risk customers right now.</div>}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Customer Directory</h2>
              <p>Search by customer name or phone, then review or edit the selected profile.</p>
            </div>
          </div>
          <div className="form-grid">
            <label>
              <span>Search</span>
              <input
                value={props.customerProfileSearch}
                onChange={(event) => props.onCustomerProfileSearchChange(event.target.value)}
                placeholder="Search by name or phone"
              />
            </label>
            <label>
              <span>Sort By</span>
              <select
                value={props.customerProfileSort}
                onChange={(event) => props.onCustomerProfileSortChange(event.target.value as "last_visit" | "total_spend" | "visit_count")}
              >
                <option value="last_visit">Last Visit</option>
                <option value="total_spend">Total Spend</option>
                <option value="visit_count">Visit Count</option>
              </select>
            </label>
          </div>
          <div className="section-block customer-profile-directory">
            <div className="activity-list compact-list">
              {filteredCustomerProfiles.length > 0 ? filteredCustomerProfiles.map((entry) => (
                <button
                  key={entry.customer.id}
                  type="button"
                  className={`tab-chip ${selectedCustomerProfile?.id === entry.customer.id ? "is-active" : ""}`}
                  onClick={() => props.onSelectCustomerProfile(entry.customer.id)}
                >
                  <strong>{entry.customer.name}</strong>
                  <span>{entry.customer.phone || "No phone"}</span>
                  <span className="muted">{entry.visitCount} visits · {currency(entry.totalSpend)}</span>
                </button>
              )) : <div className="empty-state">No customer profiles match this search.</div>}
            </div>
          </div>
          <div className="section-block section-block-muted">
            <div className="panel-header">
              <div>
                <h2>Selected Customer</h2>
                <p>Profile details and billed visit history for the chosen customer.</p>
              </div>
              {selectedCustomerProfile && (
                <button className="secondary-button" type="button" onClick={() => props.onBeginEditCustomerProfile(selectedCustomerProfile)}>
                  Edit Profile
                </button>
              )}
            </div>
            {selectedCustomerProfile && selectedCustomerProfileStats ? (
              <>
                <div className="reports-support-grid">
                  <div className="report-kpi-card is-secondary">
                    <span className="muted">Customer</span>
                    <strong>{selectedCustomerProfile.name}</strong>
                    <span className="muted">{selectedCustomerProfile.phone || "No phone recorded"}</span>
                  </div>
                  <div className="report-kpi-card is-secondary">
                    <span className="muted">Visits</span>
                    <strong>{selectedCustomerProfileStats.visitCount}</strong>
                    <span className="muted">Average bill {currency(selectedCustomerProfileStats.visitCount ? selectedCustomerProfileStats.totalSpend / selectedCustomerProfileStats.visitCount : 0)}</span>
                  </div>
                  <div className="report-kpi-card is-secondary">
                    <span className="muted">Favorite Station</span>
                    <strong>{selectedCustomerProfileStats.favoriteStationName ?? "Consumables Tab"}</strong>
                    <span className="muted">Last visit {formatDateTime(selectedCustomerProfileStats.lastVisitAt)}</span>
                  </div>
                </div>
                <div className="analysis-list">
                  <div className="line-item-row">
                    <strong>Total Spend</strong>
                    <span className="muted">{currency(selectedCustomerProfileStats.totalSpend)}</span>
                  </div>
                  <div className="line-item-row">
                    <strong>Created</strong>
                    <span className="muted">{formatDateTime(selectedCustomerProfile.createdAt)}</span>
                  </div>
                  <div className="line-item-row">
                    <strong>Last Visit</strong>
                    <span className="muted">{formatDateTime(selectedCustomerProfileStats.lastVisitAt)}</span>
                  </div>
                </div>
                <div className="section-block">
                  <div className="section-block-header">
                    <h3>Recent Billed Visits</h3>
                  </div>
                  <div className="activity-list compact-list">
                    {selectedCustomerProfileStats.bills.length > 0 ? selectedCustomerProfileStats.bills
                      .slice()
                      .sort((left, right) => new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime())
                      .slice(0, 8)
                      .map((bill) => (
                        <div key={bill.id} className="activity-row">
                          <div>
                            <strong>{bill.billNumber}</strong>
                            <div className="muted">
                              {(bill.stationId && props.stations.find((station) => station.id === bill.stationId)?.name) || "Consumables Tab"} · {formatDateTime(bill.issuedAt)}
                            </div>
                          </div>
                          <span className="muted">{currency(bill.total)}</span>
                        </div>
                      )) : <div className="empty-state">No billed visits for this customer yet.</div>}
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-state">Select a customer profile to review its details.</div>
            )}
          </div>
        </div>
      </section>

      {editCustomerProfileDraft && (
        <Modal title="Edit Customer Profile" onClose={() => props.onEditCustomerProfileDraftChange(null)}>
          <form className="form-grid" onSubmit={props.onSaveCustomerProfile}>
            <label>
              <span>Customer Name</span>
              <input
                required
                value={editCustomerProfileDraft.name}
                onChange={(event) =>
                  props.onEditCustomerProfileDraftChange({ ...editCustomerProfileDraft, name: event.target.value })
                }
              />
            </label>
            <label>
              <span>Customer Phone</span>
              <input
                value={editCustomerProfileDraft.phone}
                placeholder="Optional"
                onChange={(event) =>
                  props.onEditCustomerProfileDraftChange({ ...editCustomerProfileDraft, phone: event.target.value })
                }
              />
            </label>
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => props.onEditCustomerProfileDraftChange(null)}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Save Profile
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
