import { Fragment, useDeferredValue, useEffect, useState, useMemo } from "react";
import type { Bill, BillStatus, BillPaymentMode, Payment, PendingReceivableGroup, Station } from "../types";
import type { NormalizedBillRegisterQuery } from "../dataGateway";
import type { ReceiptPreviewModel } from "../exporters";
import { openReceiptWindow, downloadReceiptPdf } from "../exporters";
import { currency, formatDateTime, toBusinessDayKey, toLocalDateKey, addDays } from "../utils";
import brandLogo from "../../Branding/Logo.png";

type QuickFilter = "all" | "pending" | "today" | "yesterday" | "this_week" | "issued" | "voided";
type RegisterView = "bills" | "receivables";
type BillRegisterServerQuery = Omit<NormalizedBillRegisterQuery, "cursor" | "limit" | "organizationId">;

function currentBusinessDayKey(): string {
  return toBusinessDayKey(new Date());
}

function businessWeekAgoKey(): string {
  const businessToday = new Date(`${currentBusinessDayKey()}T12:00:00`);
  return toLocalDateKey(addDays(businessToday, -6));
}

function businessYesterdayKey(): string {
  const businessToday = new Date(`${currentBusinessDayKey()}T12:00:00`);
  return toLocalDateKey(addDays(businessToday, -1));
}

function statusLabel(status: BillStatus): string {
  if (status === "issued") return "Issued";
  if (status === "pending") return "Pending";
  if (status === "voided") return "Voided";
  if (status === "refunded") return "Refunded";
  if (status === "replaced") return "Replaced";
  return status;
}

function paymentModeLabel(mode: BillPaymentMode): string {
  if (mode === "cash") return "Cash";
  if (mode === "upi") return "UPI";
  if (mode === "split") return "Split";
  if (mode === "deferred") return "Deferred";
  return mode;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [delayMs, value]);
  return debouncedValue;
}

export function BillRegisterPanel(props: {
  bills: Bill[];
  billBusinessDates: Record<string, string>;
  billPaymentBusinessDates: Record<string, string[]>;
  stations: Station[];
  businessProfile: { name: string; logoText: string; address: string; primaryPhone: string; secondaryPhone?: string; receiptFooter: string };
  selectedReceiptBillId: string | null;
  selectedReceiptBill: Bill | null;
  receiptPreviewModel: ReceiptPreviewModel | null;
  allBills: Bill[];
  allPayments: Payment[];
  receivableGroups: PendingReceivableGroup[];
  receivableFocusToken?: number;
  receivableFocusSearch?: string;
  canReplaceIssuedBills: boolean;
  canVoidRefundBills: boolean;
  canSettlePendingBills: boolean;
  normalizedHistory?: {
    enabled: boolean;
    initialized: boolean;
    ready: boolean;
    loading: boolean;
    loadingMore: boolean;
    error: string;
    hasMore: boolean;
    onQueryChange: (query: BillRegisterServerQuery) => void;
    onLoadMore: () => void;
    onRefresh: () => void;
  };
  onSelectReceiptBill: (billId: string | null) => void;
  onSettlePendingBill: (billId: string) => void;
  onSettlePendingBills: (billIds: string[]) => void;
  onVoidPendingBill: (billId: string) => void;
  onVoidPendingBills: (billIds: string[], customerLabel: string) => void;
  onOpenBillReplacement: (billId: string) => void;
  onVoidOrRefundBill: (billId: string) => void;
}) {
  const [registerView, setRegisterView] = useState<RegisterView>("bills");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<BillStatus | "">("");
  const [filterMode, setFilterMode] = useState<BillPaymentMode | "">("");
  const [filterStation, setFilterStation] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [expandedReceivableGroupId, setExpandedReceivableGroupId] = useState<string | null>(null);
  const [selectedReceivableBillIds, setSelectedReceivableBillIds] = useState<Record<string, string[]>>({});
  const deferredSearch = useDeferredValue(search);
  const debouncedServerSearch = useDebouncedValue(search.trim(), 250);
  const normalizedHistoryEnabled = props.normalizedHistory?.enabled ?? false;
  const onNormalizedHistoryQueryChange = props.normalizedHistory?.onQueryChange;

  const today = currentBusinessDayKey();
  const yesterday = businessYesterdayKey();
  const weekAgo = businessWeekAgoKey();

  useEffect(() => {
    if (!props.receivableFocusToken) {
      return;
    }
    setRegisterView("receivables");
    setSearch(props.receivableFocusSearch ?? "");
    setExpandedReceivableGroupId(null);
  }, [props.receivableFocusToken, props.receivableFocusSearch]);

  const filteredBills = useMemo(() => {
    let list = props.bills;
    const bdate = (b: Bill) => props.billBusinessDates[b.id] ?? toBusinessDayKey(b.issuedAt);
    const hasBillOrPaymentInRange = (bill: Bill, fromDate: string, toDate: string) => {
      const billDate = bdate(bill);
      if (billDate >= fromDate && billDate <= toDate) {
        return true;
      }
      return (props.billPaymentBusinessDates[bill.id] ?? []).some((paymentDate) => paymentDate >= fromDate && paymentDate <= toDate);
    };

    // Quick filter overrides date/status fields
    if (quickFilter === "pending") {
      list = list.filter((b) => b.status === "pending");
    } else if (quickFilter === "issued") {
      list = list.filter((b) => b.status === "issued");
    } else if (quickFilter === "voided") {
      list = list.filter((b) => b.status === "voided");
    } else if (quickFilter === "today") {
      list = list.filter((b) => hasBillOrPaymentInRange(b, today, today));
    } else if (quickFilter === "yesterday") {
      list = list.filter((b) => hasBillOrPaymentInRange(b, yesterday, yesterday));
    } else if (quickFilter === "this_week") {
      list = list.filter((b) => hasBillOrPaymentInRange(b, weekAgo, today));
    }

    // Full filters (only apply when quickFilter === "all")
    if (quickFilter === "all") {
      if (filterStatus) list = list.filter((b) => b.status === filterStatus);
      if (filterFrom || filterTo) {
        const fromDate = filterFrom || "0000-01-01";
        const toDate = filterTo || "9999-12-31";
        list = list.filter((b) => hasBillOrPaymentInRange(b, fromDate, toDate));
      }
    }

    if (filterMode)    list = list.filter((b) => b.paymentMode === filterMode);
    if (filterStation) list = list.filter((b) => b.stationId === filterStation || (!b.stationId && filterStation === "__tab__"));

    if (deferredSearch.trim()) {
      const q = deferredSearch.trim().toLowerCase();
      list = list.filter((b) =>
        b.billNumber.toLowerCase().includes(q) ||
        (b.customerName ?? "").toLowerCase().includes(q) ||
        (b.customerPhone ?? "").toLowerCase().includes(q)
      );
    }

    return list;
  }, [props.bills, props.billBusinessDates, props.billPaymentBusinessDates, quickFilter, deferredSearch, filterStatus, filterMode, filterStation, filterFrom, filterTo, today, yesterday, weekAgo]);

  const normalizedServerQuery = useMemo<BillRegisterServerQuery>(() => {
    const query: BillRegisterServerQuery = {};
    if (debouncedServerSearch) {
      query.search = debouncedServerSearch;
    }
    if (filterMode) {
      query.paymentMode = filterMode;
    }
    if (filterStation === "__tab__") {
      query.customerTabOnly = true;
    } else if (filterStation) {
      query.stationId = filterStation;
    }

    if (quickFilter === "pending") {
      query.status = "pending";
    } else if (quickFilter === "issued") {
      query.status = "issued";
    } else if (quickFilter === "voided") {
      query.status = "voided";
    } else if (quickFilter === "today") {
      query.businessDateFrom = today;
      query.businessDateTo = today;
    } else if (quickFilter === "yesterday") {
      query.businessDateFrom = yesterday;
      query.businessDateTo = yesterday;
    } else if (quickFilter === "this_week") {
      query.businessDateFrom = weekAgo;
      query.businessDateTo = today;
    } else {
      if (filterStatus) {
        query.status = filterStatus;
      }
      if (filterFrom || filterTo) {
        query.businessDateFrom = filterFrom || filterTo;
        query.businessDateTo = filterTo || filterFrom;
      }
    }
    return query;
  }, [debouncedServerSearch, filterFrom, filterMode, filterStation, filterStatus, filterTo, quickFilter, today, weekAgo, yesterday]);

  const normalizedServerQueryKey = useMemo(() => JSON.stringify(normalizedServerQuery), [normalizedServerQuery]);

  useEffect(() => {
    if (!normalizedHistoryEnabled || !onNormalizedHistoryQueryChange || registerView !== "bills") {
      return;
    }
    onNormalizedHistoryQueryChange(normalizedServerQuery);
  }, [normalizedHistoryEnabled, onNormalizedHistoryQueryChange, normalizedServerQuery, normalizedServerQueryKey, registerView]);

  const filteredReceivableGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return props.receivableGroups;
    return props.receivableGroups.filter((group) =>
      group.label.toLowerCase().includes(q) ||
      (group.customerPhone ?? "").toLowerCase().includes(q) ||
      group.bills.some((bill) =>
        bill.billNumber.toLowerCase().includes(q) ||
        (bill.customerName ?? "").toLowerCase().includes(q) ||
        (bill.customerPhone ?? "").toLowerCase().includes(q)
      )
    );
  }, [props.receivableGroups, search]);

  const selected = props.selectedReceiptBill;
  const model = props.receiptPreviewModel;

  function handleQuickFilter(next: QuickFilter) {
    setQuickFilter(next);
    if (next !== "all") {
      setFilterStatus("");
      setFilterFrom("");
      setFilterTo("");
      setFilterMode("");
      setFilterStation("");
    }
  }

  const quickFilters: Array<{ id: QuickFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "pending", label: "Pending" },
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
    { id: "this_week", label: "Last 7 Days" },
    { id: "issued", label: "Issued" },
    { id: "voided", label: "Voided" },
  ];

  const stationSource = (bill: Bill) =>
    bill.stationId
      ? props.stations.find((s) => s.id === bill.stationId)?.name ?? "Station"
      : "Customer Tab";

  const selectedBillIdsForGroup = (group: PendingReceivableGroup) =>
    selectedReceivableBillIds[group.id] ?? group.bills.map((bill) => bill.id);

  const selectedDueForGroup = (group: PendingReceivableGroup) => {
    const selectedIds = new Set(selectedBillIdsForGroup(group));
    return group.bills.reduce((sum, bill) => sum + (selectedIds.has(bill.id) ? bill.amountDue : 0), 0);
  };

  function toggleReceivableBillSelection(group: PendingReceivableGroup, billId: string, checked: boolean) {
    setSelectedReceivableBillIds((previous) => {
      const current = previous[group.id] ?? group.bills.map((bill) => bill.id);
      return {
        ...previous,
        [group.id]: checked
          ? Array.from(new Set([...current, billId]))
          : current.filter((entry) => entry !== billId)
      };
    });
  }

  function setReceivableGroupSelection(group: PendingReceivableGroup, checked: boolean) {
    setSelectedReceivableBillIds((previous) => ({
      ...previous,
      [group.id]: checked ? group.bills.map((bill) => bill.id) : []
    }));
  }

  if (props.normalizedHistory?.enabled && !props.normalizedHistory.initialized) {
    return (
      <div className="bill-register-page">
        <div className={`read-only-banner ${props.normalizedHistory.error ? "is-warning" : ""}`}>
          <span>
            {props.normalizedHistory.loading
              ? "Loading bill register data from the backend..."
              : `Bill register data is temporarily unavailable. ${props.normalizedHistory.error || "Please retry."}`}
          </span>
          <button
            className="secondary-button"
            type="button"
            onClick={props.normalizedHistory.onRefresh}
            disabled={props.normalizedHistory.loading}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const normalizedRowsActionable = !props.normalizedHistory?.enabled || props.normalizedHistory.ready;

  if (registerView === "receivables") {
    return (
      <div className="bill-register-page">
        <div className="segmented-control bill-register-view-switch">
          <button type="button" onClick={() => setRegisterView("bills")}>
            Bills
          </button>
          <button type="button" className="is-active" onClick={() => setRegisterView("receivables")}>
            Receivables ({props.receivableGroups.length})
          </button>
        </div>
        <div className="bill-register-filter-bar">
          <input
            type="search"
            placeholder="Search customer, phone or pending bill #..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ flex: "2 1 16rem", maxWidth: "28rem" }}
          />
          {search && (
            <button className="ghost-button" type="button" onClick={() => setSearch("")}>
              Clear
            </button>
          )}
          <span className="muted" style={{ marginLeft: "auto", fontSize: "0.85rem" }}>
            {filteredReceivableGroups.length} customer group{filteredReceivableGroups.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="bill-register-list-pane receivables-pane">
          <div className="bill-register-list-scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Bills</th>
                  <th>Oldest</th>
                  <th>Overdue</th>
                  <th>Total Due</th>
                  <th>Selected Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredReceivableGroups.length === 0 && (
                  <tr><td colSpan={8}><div className="bill-register-empty">{props.receivableGroups.length === 0 ? "No pending receivables outstanding." : "No receivables match the current search."}</div></td></tr>
                )}
                {filteredReceivableGroups.map((group) => {
                  const selectedIds = selectedBillIdsForGroup(group);
                  const selectedDue = selectedDueForGroup(group);
                  const expanded = expandedReceivableGroupId === group.id;
                  return (
                    <Fragment key={group.id}>
                      <tr key={group.id} className={group.isUngrouped ? "receivable-row is-ungrouped" : "receivable-row"}>
                        <td>
                          <button className="ghost-button inline-toggle" type="button" onClick={() => setExpandedReceivableGroupId(expanded ? null : group.id)}>
                            {expanded ? "Hide" : "View"}
                          </button>
                          <strong>{group.label}</strong>
                        </td>
                        <td>{group.customerPhone || <span className="muted">-</span>}</td>
                        <td>{group.bills.length}</td>
                        <td>{group.oldestBusinessDate}</td>
                        <td><span className={group.daysOverdue > 7 ? "pending-amount" : "muted"}>{group.daysOverdue === 0 ? "Today" : `${group.daysOverdue}d`}</span></td>
                        <td><strong className="pending-amount">{currency(group.totalDue)}</strong></td>
                        <td><strong>{currency(selectedDue)}</strong></td>
                        <td>
                          <div className="button-row dense">
                            {props.canSettlePendingBills && (
                              <button className="ghost-button" type="button" disabled={selectedIds.length === 0} onClick={() => props.onSettlePendingBills(selectedIds)}>
                                Settle
                              </button>
                            )}
                            {props.canVoidRefundBills && (
                              <button className="ghost-button danger" type="button" disabled={selectedIds.length === 0} onClick={() => props.onVoidPendingBills(selectedIds, group.label)}>
                                Write Off
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr key={`${group.id}-details`} className="receivable-detail-row">
                          <td colSpan={8}>
                            <div className="receivable-detail-list">
                              <label className="checkbox-field">
                                <input
                                  type="checkbox"
                                  checked={selectedIds.length === group.bills.length}
                                  onChange={(event) => setReceivableGroupSelection(group, event.target.checked)}
                                />
                                <span>Select all pending bills</span>
                              </label>
                              {group.bills.map((bill) => (
                                <label key={bill.id} className="checkbox-field receivable-check-row">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.includes(bill.id)}
                                    onChange={(event) => toggleReceivableBillSelection(group, bill.id, event.target.checked)}
                                  />
                                  <span>
                                    <strong>{bill.billNumber}</strong> - {props.billBusinessDates[bill.id] ?? ""} - Paid {currency(bill.amountPaid)} - <span className="pending-amount">{currency(bill.amountDue)} due</span>
                                  </span>
                                </label>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bill-register-page">
      <div className="segmented-control bill-register-view-switch">
        <button type="button" className="is-active" onClick={() => setRegisterView("bills")}>
          Bills
        </button>
        <button type="button" onClick={() => setRegisterView("receivables")}>
          Receivables ({props.receivableGroups.length})
        </button>
      </div>

      {/* Quick filters */}
      <div className="bill-register-filters">
        <div className="quick-filters">
          {quickFilters.map((qf) => (
            <button
              key={qf.id}
              type="button"
              className={`quick-filter-chip${quickFilter === qf.id ? " active" : ""}`}
              onClick={() => handleQuickFilter(qf.id)}
            >
              {qf.label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ marginLeft: "auto", fontSize: "0.85rem" }}>
          {filteredBills.length} bill{filteredBills.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Filter bar */}
      <div className="bill-register-filter-bar">
        <input
          type="search"
          placeholder="Search bill #, customer name or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: "2 1 16rem", maxWidth: "24rem" }}
        />
        <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value as BillStatus | ""); setQuickFilter("all"); }}>
          <option value="">All Statuses</option>
          <option value="issued">Issued</option>
          <option value="pending">Pending</option>
          <option value="voided">Voided</option>
          <option value="refunded">Refunded</option>
          <option value="replaced">Replaced</option>
        </select>
        <select value={filterMode} onChange={(e) => setFilterMode(e.target.value as BillPaymentMode | "")}>
          <option value="">All Modes</option>
          <option value="cash">Cash</option>
          <option value="upi">UPI</option>
          <option value="split">Split</option>
          <option value="deferred">Deferred</option>
        </select>
        <select value={filterStation} onChange={(e) => setFilterStation(e.target.value)}>
          <option value="">All Sources</option>
          <option value="__tab__">Customer Tab</option>
          {props.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={filterFrom} onChange={(e) => { setFilterFrom(e.target.value); setQuickFilter("all"); }} title="From date" />
        <input type="date" value={filterTo} onChange={(e) => { setFilterTo(e.target.value); setQuickFilter("all"); }} title="To date" />
        {(search || filterStatus || filterMode || filterStation || filterFrom || filterTo) && (
          <button className="ghost-button" type="button" onClick={() => { setSearch(""); setFilterStatus(""); setFilterMode(""); setFilterStation(""); setFilterFrom(""); setFilterTo(""); setQuickFilter("all"); }}>
            Clear
          </button>
        )}
      </div>

      {props.normalizedHistory?.enabled && (
        <div className="bill-register-filter-bar">
          <span className="muted">
            Normalized history {props.normalizedHistory.loading ? "refreshing..." : props.normalizedHistory.ready ? "active" : "read-only"}
            {props.normalizedHistory.error ? ` - ${props.normalizedHistory.error}` : ""}
          </span>
          <button
            className="ghost-button"
            type="button"
            disabled={props.normalizedHistory.loading || props.normalizedHistory.loadingMore}
            onClick={props.normalizedHistory.onRefresh}
          >
            Refresh
          </button>
        </div>
      )}

      {/* Split workspace */}
      <div className="bill-register-workspace">

        {/* Bill list */}
        <div className="bill-register-list-pane">
          <div className="bill-register-list-scroll">
            <table>
              <thead>
                <tr>
                  <th>Bill #</th>
                  <th>Date &amp; Time</th>
                  <th>Source</th>
                  <th>Customer</th>
                  <th>Mode</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {props.normalizedHistory?.loading && filteredBills.length === 0 && (
                  <tr><td colSpan={10}><div className="bill-register-empty">Loading bill history...</div></td></tr>
                )}
                {!props.normalizedHistory?.loading && filteredBills.length === 0 && (
                  <tr><td colSpan={10}><div className="bill-register-empty">{props.bills.length === 0 && !props.normalizedHistory?.loading ? "No bills have been recorded yet." : "No bills match the current filters."}</div></td></tr>
                )}
                {filteredBills.map((bill) => (
                  <tr
                    key={bill.id}
                    style={{ cursor: "pointer", background: props.selectedReceiptBillId === bill.id ? "#edf5ef" : undefined }}
                    onClick={() => props.onSelectReceiptBill(bill.id === props.selectedReceiptBillId ? null : bill.id)}
                  >
                    <td><strong>{bill.billNumber}</strong></td>
                    <td>{formatDateTime(bill.issuedAt)}</td>
                    <td>{stationSource(bill)}</td>
                    <td>{bill.customerName || <span className="muted">Walk-in</span>}{bill.customerPhone && <div className="muted" style={{ fontSize: "0.78rem" }}>{bill.customerPhone}</div>}</td>
                    <td>{paymentModeLabel(bill.paymentMode)}</td>
                    <td>{currency(bill.total)}</td>
                    <td>{currency(bill.amountPaid)}</td>
                    <td>{bill.amountDue > 0 ? <strong className="pending-amount">{currency(bill.amountDue)}</strong> : <span className="muted">-</span>}</td>
                    <td><span className={`bill-status-badge ${bill.status}`}>{statusLabel(bill.status)}</span></td>
                    <td>
                      <div className="button-row dense" onClick={(e) => e.stopPropagation()}>
                        {bill.status === "pending" && props.canSettlePendingBills && (
                          <button className="ghost-button" type="button" disabled={!normalizedRowsActionable} onClick={() => props.onSettlePendingBill(bill.id)}>Settle</button>
                        )}
                        {bill.status === "pending" && props.canVoidRefundBills && (
                          <button className="ghost-button danger" type="button" disabled={!normalizedRowsActionable} onClick={() => props.onVoidPendingBill(bill.id)}>Write Off</button>
                        )}
                        {bill.status === "issued" && props.canReplaceIssuedBills && (
                          <button className="ghost-button" type="button" disabled={!normalizedRowsActionable} onClick={() => props.onOpenBillReplacement(bill.id)}>Replace</button>
                        )}
                        {bill.status === "issued" && props.canVoidRefundBills && (
                          <button className="ghost-button danger" type="button" disabled={!normalizedRowsActionable} onClick={() => props.onVoidOrRefundBill(bill.id)}>Void</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {props.normalizedHistory?.enabled && (
              <div className="button-row dense" style={{ justifyContent: "center", padding: "0.75rem" }}>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!props.normalizedHistory.hasMore || props.normalizedHistory.loading || props.normalizedHistory.loadingMore}
                  onClick={props.normalizedHistory.onLoadMore}
                >
                  {props.normalizedHistory.loadingMore ? "Loading..." : props.normalizedHistory.hasMore ? "Load More Bills" : "No More Bills"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Receipt preview */}
        <div className="bill-register-preview-pane">
          <div className="bill-register-preview-header">
            <h3>{selected ? selected.billNumber : "Receipt Preview"}</h3>
            {selected && (
              <span className={`bill-status-badge ${selected.status}`}>{statusLabel(selected.status)}</span>
            )}
          </div>

          <div className="bill-register-preview-scroll">
            {selected && model ? (
              <div className="receipt-preview thermal-receipt-preview">
                <div className="thermal-receipt-brand">
                  <div className="thermal-receipt-logo-shell">
                    <img className="thermal-receipt-logo" src={brandLogo} alt={`${props.businessProfile.name} logo`} />
                  </div>
                  <div className="thermal-receipt-title">{model.brandTitle}</div>
                  <div className="thermal-receipt-subtitle">{model.brandSubtitle}</div>
                </div>
                <div className="thermal-receipt-info">
                  {model.infoLines.map((line, i) => <div key={i}>{line}</div>)}
                </div>
                <div className="thermal-receipt-divider" />
                <div className="thermal-receipt-meta">
                  {model.metaRows.map((row) => (
                    <div key={row.label} className="thermal-receipt-meta-row">
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                    </div>
                  ))}
                </div>
                <div className="thermal-receipt-divider" />
                <div className="thermal-receipt-entries">
                  {model.entries.map((entry) => (
                    <div key={entry.id} className={`thermal-receipt-entry ${entry.isDiscount ? "is-discount" : ""}`}>
                      <div className="thermal-receipt-entry-head">
                        <strong>{entry.title}</strong>
                        <strong>{entry.amount}</strong>
                      </div>
                      <div className="thermal-receipt-entry-detail">{entry.detail}</div>
                    </div>
                  ))}
                </div>
                <div className="thermal-receipt-divider" />
                <div className="thermal-receipt-totals">
                  <div><span>Subtotal</span><strong>{model.subtotal}</strong></div>
                  <div><span>Discount</span><strong>{model.discount}</strong></div>
                  {model.roundOff && <div><span>Round Off</span><strong>{model.roundOff}</strong></div>}
                  <div className="is-grand-total"><span>Total</span><strong>{model.total}</strong></div>
                </div>
                {model.previousDueSummary && (
                  <>
                    <div className="thermal-receipt-divider" />
                    <div className="thermal-receipt-totals previous-dues-summary">
                      <div><span>Previous Dues Paid</span><strong>{model.previousDueSummary.total}</strong></div>
                      <div><span>Bills</span><strong>{model.previousDueSummary.billNumbers}</strong></div>
                      <div><span>Cash / UPI</span><strong>{model.previousDueSummary.cash} / {model.previousDueSummary.upi}</strong></div>
                    </div>
                  </>
                )}
                {selected.amountDue > 0 && (
                  <>
                    <div className="thermal-receipt-divider" />
                    <div className="thermal-receipt-totals">
                      <div><span>Paid</span><strong>{currency(selected.amountPaid)}</strong></div>
                      <div><span className="pending-amount">Amount Due</span><strong className="pending-amount">{currency(selected.amountDue)}</strong></div>
                    </div>
                  </>
                )}
                <div className="thermal-receipt-divider" />
                <div className="thermal-receipt-footer">{model.footer}</div>
              </div>
            ) : (
              <div className="bill-register-empty">
                <p className="muted">Select a bill from the list to preview its receipt.</p>
              </div>
            )}
          </div>

          {selected && (
            <div className="bill-register-preview-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => openReceiptWindow(props.businessProfile, selected, props.allBills, props.allPayments)}
              >
                Print Receipt
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => downloadReceiptPdf(props.businessProfile, selected, props.allBills, props.allPayments)}
              >
                Download PDF
              </button>
              {selected.status === "pending" && props.canSettlePendingBills && (
                <button className="primary-button" type="button" disabled={!normalizedRowsActionable} onClick={() => props.onSettlePendingBill(selected.id)}>
                  Settle Bill
                </button>
              )}
              {selected.status === "pending" && props.canVoidRefundBills && (
                <button className="danger-button" type="button" disabled={!normalizedRowsActionable} onClick={() => props.onVoidPendingBill(selected.id)}>
                  Write Off
                </button>
              )}
              {selected.status === "issued" && props.canReplaceIssuedBills && (
                <button className="secondary-button" type="button" disabled={!normalizedRowsActionable} onClick={() => props.onOpenBillReplacement(selected.id)}>
                  Replace Bill
                </button>
              )}
              {selected.status === "issued" && props.canVoidRefundBills && (
                <button className="danger-button" type="button" disabled={!normalizedRowsActionable} onClick={() => props.onVoidOrRefundBill(selected.id)}>
                  Void / Refund
                </button>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
