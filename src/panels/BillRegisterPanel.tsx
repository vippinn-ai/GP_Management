import { useState, useMemo } from "react";
import type { Bill, BillStatus, BillPaymentMode, Station } from "../types";
import type { ReceiptPreviewModel } from "../exporters";
import { openReceiptWindow, downloadReceiptPdf } from "../exporters";
import { currency, formatDateTime, toBusinessDayKey, toLocalDateKey, addDays } from "../utils";
import brandLogo from "../../Branding/Logo.png";

type QuickFilter = "all" | "pending" | "today" | "this_week" | "issued" | "voided";

function currentBusinessDayKey(): string {
  return toBusinessDayKey(new Date());
}

function businessWeekAgoKey(): string {
  const businessToday = new Date(`${currentBusinessDayKey()}T12:00:00`);
  return toLocalDateKey(addDays(businessToday, -6));
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

export function BillRegisterPanel(props: {
  bills: Bill[];
  billBusinessDates: Record<string, string>;
  stations: Station[];
  businessProfile: { name: string; logoText: string; address: string; primaryPhone: string; secondaryPhone?: string; receiptFooter: string };
  selectedReceiptBillId: string | null;
  selectedReceiptBill: Bill | null;
  receiptPreviewModel: ReceiptPreviewModel | null;
  allBills: Bill[];
  canReplaceIssuedBills: boolean;
  canVoidRefundBills: boolean;
  canSettlePendingBills: boolean;
  onSelectReceiptBill: (billId: string | null) => void;
  onSettlePendingBill: (billId: string) => void;
  onVoidPendingBill: (billId: string) => void;
  onOpenBillReplacement: (billId: string) => void;
  onVoidOrRefundBill: (billId: string) => void;
}) {
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<BillStatus | "">("");
  const [filterMode, setFilterMode] = useState<BillPaymentMode | "">("");
  const [filterStation, setFilterStation] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const today = currentBusinessDayKey();
  const weekAgo = businessWeekAgoKey();

  const filteredBills = useMemo(() => {
    let list = props.bills;
    const bdate = (b: Bill) => props.billBusinessDates[b.id] ?? toBusinessDayKey(b.issuedAt);

    // Quick filter overrides date/status fields
    if (quickFilter === "pending") {
      list = list.filter((b) => b.status === "pending");
    } else if (quickFilter === "issued") {
      list = list.filter((b) => b.status === "issued");
    } else if (quickFilter === "voided") {
      list = list.filter((b) => b.status === "voided");
    } else if (quickFilter === "today") {
      list = list.filter((b) => bdate(b) === today);
    } else if (quickFilter === "this_week") {
      list = list.filter((b) => bdate(b) >= weekAgo && bdate(b) <= today);
    }

    // Full filters (only apply when quickFilter === "all")
    if (quickFilter === "all") {
      if (filterStatus) list = list.filter((b) => b.status === filterStatus);
      if (filterFrom)   list = list.filter((b) => bdate(b) >= filterFrom);
      if (filterTo)     list = list.filter((b) => bdate(b) <= filterTo);
    }

    if (filterMode)    list = list.filter((b) => b.paymentMode === filterMode);
    if (filterStation) list = list.filter((b) => b.stationId === filterStation || (!b.stationId && filterStation === "__tab__"));

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((b) =>
        b.billNumber.toLowerCase().includes(q) ||
        (b.customerName ?? "").toLowerCase().includes(q) ||
        (b.customerPhone ?? "").toLowerCase().includes(q)
      );
    }

    return list;
  }, [props.bills, props.billBusinessDates, quickFilter, search, filterStatus, filterMode, filterStation, filterFrom, filterTo, today, weekAgo]);

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
    { id: "this_week", label: "Last 7 Days" },
    { id: "issued", label: "Issued" },
    { id: "voided", label: "Voided" },
  ];

  const stationSource = (bill: Bill) =>
    bill.stationId
      ? props.stations.find((s) => s.id === bill.stationId)?.name ?? "Station"
      : "Customer Tab";

  return (
    <div className="bill-register-page">

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
          placeholder="Search bill #, customer name or phone…"
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
                {filteredBills.length === 0 && (
                  <tr><td colSpan={10}><div className="bill-register-empty">{props.bills.length === 0 ? "No bills have been recorded yet." : "No bills match the current filters."}</div></td></tr>
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
                    <td>{bill.amountDue > 0 ? <strong className="pending-amount">{currency(bill.amountDue)}</strong> : <span className="muted">—</span>}</td>
                    <td><span className={`bill-status-badge ${bill.status}`}>{statusLabel(bill.status)}</span></td>
                    <td>
                      <div className="button-row dense" onClick={(e) => e.stopPropagation()}>
                        {bill.status === "pending" && props.canSettlePendingBills && (
                          <button className="ghost-button" type="button" onClick={() => props.onSettlePendingBill(bill.id)}>Settle</button>
                        )}
                        {bill.status === "pending" && props.canVoidRefundBills && (
                          <button className="ghost-button danger" type="button" onClick={() => props.onVoidPendingBill(bill.id)}>Write Off</button>
                        )}
                        {bill.status === "issued" && props.canReplaceIssuedBills && (
                          <button className="ghost-button" type="button" onClick={() => props.onOpenBillReplacement(bill.id)}>Replace</button>
                        )}
                        {bill.status === "issued" && props.canVoidRefundBills && (
                          <button className="ghost-button danger" type="button" onClick={() => props.onVoidOrRefundBill(bill.id)}>Void</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                onClick={() => openReceiptWindow(props.businessProfile, selected, props.allBills)}
              >
                Print Receipt
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => downloadReceiptPdf(props.businessProfile, selected, props.allBills)}
              >
                Download PDF
              </button>
              {selected.status === "pending" && props.canSettlePendingBills && (
                <button className="primary-button" type="button" onClick={() => props.onSettlePendingBill(selected.id)}>
                  Settle Bill
                </button>
              )}
              {selected.status === "pending" && props.canVoidRefundBills && (
                <button className="danger-button" type="button" onClick={() => props.onVoidPendingBill(selected.id)}>
                  Write Off
                </button>
              )}
              {selected.status === "issued" && props.canReplaceIssuedBills && (
                <button className="secondary-button" type="button" onClick={() => props.onOpenBillReplacement(selected.id)}>
                  Replace Bill
                </button>
              )}
              {selected.status === "issued" && props.canVoidRefundBills && (
                <button className="danger-button" type="button" onClick={() => props.onVoidOrRefundBill(selected.id)}>
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
