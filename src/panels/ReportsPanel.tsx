import { type FormEvent, useState } from "react";
import type { Bill, BusinessProfile, Expense, ExpenseTemplate, ExpenseTemplateOverride, PendingReceivable, ReportFilterState, ReportPreset, Station } from "../types";
import { currency, formatDateTime, formatMonthLabel, getMonthKeysForYear, resolveEffectiveAmount } from "../utils";

interface NormalizedExpenseDetail {
  templateId: string;
  title: string;
  category: string;
  fullAmount: number;
  proratedAmount: number;
  daysInRange: number;
  daysInMonth: number;
  monthKey: string;
}
import { NumericInput } from "../components/NumericInput";
import { type ReportRow } from "../exporters";

interface ExpenseForm {
  title: string;
  category: string;
  amount: number;
  spentAt: string;
  notes: string;
}

interface ReportSummary {
  grossRevenue: number;
  netCashEarnings: number;
  normalizedNetProfit: number;
  issuedBillsCount: number;
  cashExpenses: number;
  normalizedExpenses: number;
  sessionRevenue: number;
  itemRevenue: number;
  totalDiscounts: number;
  pendingRevenue: number;
  deferredOutstanding: number;
  previousRangeLabel: string;
  previousRangeRevenue: number;
  revenueGrowthPct: number | null;
  averageBillValue: number;
  topStation: [string, number] | null;
  paymentModeTotals: { cash: number; upi: number };
  expenseByCategory: [string, number][];
  normalizedExpenseByCategory: [string, number][];
  normalizedExpenseDetails: NormalizedExpenseDetail[];
}


export function ReportsPanel(props: {
  stations: Station[];
  businessProfile: BusinessProfile;
  reportFilter: ReportFilterState;
  reportFromDate: string;
  reportToDate: string;
  resolvedReportRangeLabel: string;
  filteredBills: Bill[];
  filteredExpenses: Expense[];
  expenseTemplates: ExpenseTemplate[];
  expenseTemplateOverrides: ExpenseTemplateOverride[];
  pendingBackfillTemplateId: string | null;
  reportRows: ReportRow[];
  summary: ReportSummary;
  expenseForm: ExpenseForm;
  expenseTemplateForm: ExpenseTemplate;
  expenseCategoryOptions: string[];
  allPendingReceivables: PendingReceivable[];
  canEditReports: boolean;
  isManagerReadOnly: boolean;
  onSettlePendingBill: (billId: string) => void;
  onReportFilterChange: (next: ReportFilterState) => void;
  onExpenseFormChange: (next: ExpenseForm) => void;
  onExpenseTemplateFormChange: (next: ExpenseTemplate) => void;
  onCreateExpense: (event: FormEvent<HTMLFormElement>) => void;
  onDeleteExpense: (expenseId: string) => void;
  onSaveExpenseTemplate: (event: FormEvent<HTMLFormElement>) => void;
  onBeginEditExpenseTemplate: (template: ExpenseTemplate) => void;
  onToggleExpenseTemplateActive: (templateId: string) => void;
  onDeleteExpenseTemplate: (templateId: string) => void;
  onCreateOrUpdateOverride: (templateId: string, monthKey: string, amount: number | null, skipReason?: string, notes?: string) => void;
  onCreateOrUpdateOverrideForFutureMonths: (templateId: string, fromMonthKey: string, amount: number | null, skipReason?: string, notes?: string) => void;
  onDeleteOverride: (templateId: string, monthKey: string) => void;
  onResolveBackfillPrompt: (templateId: string, backfill: boolean) => void;
}) {
  const {
    reportFilter, reportFromDate, reportToDate, summary, expenseForm, expenseTemplateForm,
    filteredExpenses, expenseCategoryOptions, expenseTemplates, expenseTemplateOverrides,
    canEditReports, isManagerReadOnly
  } = props;

  const currentYear = new Date().getFullYear();
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null);
  const [gridYear, setGridYear] = useState<number>(currentYear);
  const [editingCell, setEditingCell] = useState<{ templateId: string; monthKey: string; amount: number } | null>(null);
  const [editAmount, setEditAmount] = useState<number>(0);
  const [editScope, setEditScope] = useState<"single" | "future">("single");
  const [skippingCell, setSkippingCell] = useState<{ templateId: string; monthKey: string } | null>(null);
  const [skipReason, setSkipReason] = useState<string>("");

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function openEditDialog(templateId: string, monthKey: string, currentAmount: number) {
    setEditingCell({ templateId, monthKey, amount: currentAmount });
    setEditAmount(currentAmount);
    setEditScope("single");
  }

  function submitEditDialog() {
    if (!editingCell || editAmount < 0) return;
    if (editScope === "single") {
      props.onCreateOrUpdateOverride(editingCell.templateId, editingCell.monthKey, editAmount);
    } else {
      props.onCreateOrUpdateOverrideForFutureMonths(editingCell.templateId, editingCell.monthKey, editAmount);
    }
    setEditingCell(null);
  }

  function openSkipDialog(templateId: string, monthKey: string) {
    setSkippingCell({ templateId, monthKey });
    setSkipReason("");
  }

  function submitSkipDialog() {
    if (!skippingCell) return;
    props.onCreateOrUpdateOverride(skippingCell.templateId, skippingCell.monthKey, null, skipReason || undefined);
    setSkippingCell(null);
  }

  return (
    <>
      <div className="reports-toolbar">
        <div className="reports-toolbar-copy">
          <h2>Operational Reports</h2>
          <p>Range-based revenue, expense, and profit insights for owners.</p>
          {isManagerReadOnly && <div className="read-only-banner compact">Manager view: read-only access on this page.</div>}
        </div>
        <div className="report-filter-inline">
          <label>
            <span>Range</span>
            <select value={reportFilter.preset} onChange={(event) => props.onReportFilterChange({ ...reportFilter, preset: event.target.value as ReportPreset })}>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="last_7_days">Last 7 Days</option>
              <option value="this_month">This Month</option>
              <option value="last_month">Last Month</option>
              <option value="this_year">This Year</option>
              <option value="custom">Custom Range</option>
            </select>
          </label>
          {reportFilter.preset === "custom" && (
            <>
              <label>
                <span>From</span>
                <input type="date" value={reportFilter.fromDate ?? reportFromDate} onChange={(event) => props.onReportFilterChange({ ...reportFilter, fromDate: event.target.value })} />
              </label>
              <label>
                <span>To</span>
                <input type="date" value={reportFilter.toDate ?? reportToDate} onChange={(event) => props.onReportFilterChange({ ...reportFilter, toDate: event.target.value })} />
              </label>
            </>
          )}
          <div className="report-range-chip">
            <div className="report-range-chip-head">
              <span className="muted">Selected Period</span>
              <strong>{props.resolvedReportRangeLabel}</strong>
            </div>
            <div className="muted">{reportFromDate} to {reportToDate}</div>
          </div>
        </div>
      </div>
      <section className="section-grid reports-layout">
        <div className="panel">
          <div className="section-block reports-summary-block">
            <div className="section-block-header">
              <h3>Performance Snapshot</h3>
              <p>Primary range KPIs first, followed by supporting revenue and profit signals.</p>
            </div>
            <div className="reports-kpi-grid">
              <div className="report-kpi-card is-primary">
                <span className="muted">Gross Revenue</span>
                <strong>{currency(summary.grossRevenue)}</strong>
              </div>
              {summary.deferredOutstanding > 0 && (
                <div className="report-kpi-card is-deferred">
                  <span className="muted">Deferred Outstanding</span>
                  <strong>{currency(summary.deferredOutstanding)}</strong>
                </div>
              )}
              <div className="report-kpi-card is-primary">
                <span className="muted">Net Cash Earnings</span>
                <strong>{currency(summary.netCashEarnings)}</strong>
              </div>
              <div className="report-kpi-card is-primary">
                <span className="muted">Net Profit (Normalized)</span>
                <strong>{currency(summary.normalizedNetProfit)}</strong>
              </div>
            </div>
            <div className="reports-support-grid">
              <div className="report-kpi-card is-secondary">
                <span className="muted">Bills</span>
                <strong>{`${summary.issuedBillsCount}`}</strong>
              </div>
              <div className="report-kpi-card is-secondary">
                <span className="muted">Cash Expenses</span>
                <strong>{currency(summary.cashExpenses)}</strong>
              </div>
              <div className="report-kpi-card is-secondary">
                <span className="muted">Monthly Expenses (Pro-rated)</span>
                <strong>{currency(summary.normalizedExpenses)}</strong>
              </div>
              <div className="report-kpi-card is-secondary">
                <span className="muted">Session Revenue</span>
                <strong>{currency(summary.sessionRevenue)}</strong>
              </div>
              <div className="report-kpi-card is-secondary">
                <span className="muted">Consumable Revenue</span>
                <strong>{currency(summary.itemRevenue)}</strong>
              </div>
              <div className="report-kpi-card is-secondary">
                <span className="muted">Discounts</span>
                <strong>{currency(summary.totalDiscounts)}</strong>
              </div>
              {summary.pendingRevenue > 0 && (
                <div className="report-kpi-card is-secondary">
                  <span className="muted">Outstanding (Pending)</span>
                  <strong className="pending-amount">{currency(summary.pendingRevenue)}</strong>
                </div>
              )}
            </div>
            <div className="insight-grid">
              <div className="insight-card">
                <span className="muted">Revenue Growth vs {summary.previousRangeLabel}</span>
                <strong>
                  {summary.revenueGrowthPct === null
                    ? "No comparable prior data"
                    : `${summary.revenueGrowthPct >= 0 ? "+" : ""}${summary.revenueGrowthPct.toFixed(1)}%`}
                </strong>
                <div className="muted">
                  Previous range revenue: {currency(summary.previousRangeRevenue)}
                </div>
              </div>
              <div className="insight-card">
                <span className="muted">Average Bill Value</span>
                <strong>{currency(summary.averageBillValue)}</strong>
                <div className="muted">
                  Discount given: {currency(summary.totalDiscounts)}
                </div>
              </div>
              <div className="insight-card">
                <span className="muted">Top Earning Channel</span>
                <strong>{summary.topStation?.[0] ?? "No sales yet"}</strong>
                <div className="muted">
                  {summary.topStation ? currency(summary.topStation[1]) : "No revenue in selected period"}
                </div>
              </div>
            </div>
          </div>
          <div className="section-block section-block-muted">
            <div className="panel-header">
              <div>
                <h2>Selected Period Analysis</h2>
                <p>Compare actual spend and normalized operating cost for the chosen range.</p>
              </div>
            </div>
            <div className="analysis-list">
              <div className="activity-row">
                <strong>Gross Revenue</strong>
                <span className="muted">{currency(summary.grossRevenue)}</span>
              </div>
              <div className="activity-row">
                <strong>Cash Expenses</strong>
                <span className="muted">{currency(summary.cashExpenses)}</span>
              </div>
              <div className="activity-row">
                <strong>Monthly Expenses (Pro-rated)</strong>
                <span className="muted">{currency(summary.normalizedExpenses)}</span>
              </div>
              <div className="activity-row">
                <strong>Net Cash Earnings</strong>
                <span className="muted">{currency(summary.netCashEarnings)}</span>
              </div>
              <div className="activity-row">
                <strong>Net Profit (Normalized)</strong>
                <span className="muted">{currency(summary.normalizedNetProfit)}</span>
              </div>
              <div className="activity-row">
                <strong>Payment Mix</strong>
                <span className="muted">
                  Cash {currency(summary.paymentModeTotals.cash)} · UPI {currency(summary.paymentModeTotals.upi)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="section-block section-block-muted">
            <div className="panel-header">
              <div><h2>Expense Breakdown</h2><p>Separate actual paid expenses from normalized monthly operating cost.</p></div>
            </div>
            <div className="expense-breakdown-grid">
              <div className="expense-breakdown-card">
                <strong>Cash Expenses</strong>
                {summary.expenseByCategory.length > 0 ? (
                  <div className="activity-list compact-list">
                    {summary.expenseByCategory.map(([category, amount]) => (
                      <div key={category} className="activity-row">
                        <strong>{category}</strong>
                        <span className="muted">{currency(amount)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">No one-time expenses in this period.</div>
                )}
              </div>
              <div className="expense-breakdown-card">
                <strong>Monthly Expenses (Pro-rated)</strong>
                {summary.normalizedExpenseDetails.length > 0 ? (
                  <div className="activity-list compact-list">
                    {summary.normalizedExpenseDetails.map((entry) => (
                      <div key={`${entry.templateId}-${entry.monthKey}`} className="activity-row-stacked">
                        <div className="activity-row">
                          <strong>{entry.title}</strong>
                          <span>{currency(entry.proratedAmount)}</span>
                        </div>
                        {entry.daysInRange < entry.daysInMonth && (
                          <div className="muted small-text">
                            {entry.daysInRange} of {entry.daysInMonth} days in {formatMonthLabel(entry.monthKey)} · Full: {currency(entry.fullAmount)}/mo
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">No active monthly templates affecting this period.</div>
                )}
              </div>
            </div>
          </div>
          {canEditReports && (
            <>
              <div className="section-block">
                <div className="panel-header">
                  <div><h2>One-Time Expense</h2><p>Log actual paid expenses for a specific date inside the selected range.</p></div>
                </div>
                <form className="form-grid" onSubmit={props.onCreateExpense}>
                  <label>
                    <span>Title</span>
                    <input required value={expenseForm.title} onChange={(event) => props.onExpenseFormChange({ ...expenseForm, title: event.target.value })} placeholder="Milk restock, electricity, rent..." />
                  </label>
                  <label>
                    <span>Category</span>
                    <select value={expenseForm.category} onChange={(event) => props.onExpenseFormChange({ ...expenseForm, category: event.target.value })}>
                      {expenseCategoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Amount</span>
                    <NumericInput required mode="decimal" min={0} value={expenseForm.amount} onValueChange={(value) => props.onExpenseFormChange({ ...expenseForm, amount: value })} />
                  </label>
                  <label>
                    <span>Date</span>
                    <input type="date" value={expenseForm.spentAt} onChange={(event) => props.onExpenseFormChange({ ...expenseForm, spentAt: event.target.value })} />
                  </label>
                  <label className="field-span-full">
                    <span>Notes</span>
                    <input value={expenseForm.notes} onChange={(event) => props.onExpenseFormChange({ ...expenseForm, notes: event.target.value })} placeholder="Optional details" />
                  </label>
                  <button className="primary-button field-span-full" type="submit">Add One-Time Expense</button>
                </form>
                <div className="activity-list">
                  {filteredExpenses.length > 0 ? filteredExpenses.slice(0, 8).map((expense) => (
                    <div key={expense.id} className="line-item-row">
                      <div>
                        <strong>{expense.title}</strong>
                        <div className="muted">{expense.category} · {formatDateTime(expense.spentAt)}</div>
                      </div>
                      <div className="button-row dense">
                        <span>{currency(expense.amount)}</span>
                        <button className="ghost-button danger" type="button" onClick={() => props.onDeleteExpense(expense.id)}>Delete</button>
                      </div>
                    </div>
                  )) : <div className="empty-state">No one-time expenses logged for this period.</div>}
                </div>
              </div>
              <div className="section-block section-block-muted">
                <div className="panel-header">
                  <div><h2>Monthly Expense Templates</h2><p>Track repeating monthly costs like rent and internet without creating fake daily entries.</p></div>
                </div>
                <form className="form-grid" onSubmit={props.onSaveExpenseTemplate}>
                  <label>
                    <span>Title</span>
                    <input required value={expenseTemplateForm.title} onChange={(event) => props.onExpenseTemplateFormChange({ ...expenseTemplateForm, title: event.target.value })} placeholder="Rent, internet, salaries..." />
                  </label>
                  <label>
                    <span>Category</span>
                    <select value={expenseTemplateForm.category} onChange={(event) => props.onExpenseTemplateFormChange({ ...expenseTemplateForm, category: event.target.value })}>
                      {expenseCategoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Monthly Amount</span>
                    <NumericInput required mode="decimal" min={0} value={expenseTemplateForm.amount} onValueChange={(value) => props.onExpenseTemplateFormChange({ ...expenseTemplateForm, amount: value })} />
                  </label>
                  <label>
                    <span>Start Month</span>
                    <input type="month" value={expenseTemplateForm.startMonth} onChange={(event) => props.onExpenseTemplateFormChange({ ...expenseTemplateForm, startMonth: event.target.value })} />
                  </label>
                  <label className="field-span-full">
                    <span>Notes</span>
                    <input value={expenseTemplateForm.notes ?? ""} onChange={(event) => props.onExpenseTemplateFormChange({ ...expenseTemplateForm, notes: event.target.value })} placeholder="Optional details" />
                  </label>
                  <label className="checkbox-field">
                    <input type="checkbox" checked={expenseTemplateForm.active} onChange={(event) => props.onExpenseTemplateFormChange({ ...expenseTemplateForm, active: event.target.checked })} />
                    <span>Template active</span>
                  </label>
                  <div className="button-row field-span-full">
                    <button className="primary-button" type="submit">
                      {expenseTemplateForm.id ? "Update Monthly Template" : "Create Monthly Template"}
                    </button>
                    {expenseTemplateForm.id && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => props.onExpenseTemplateFormChange({
                          id: "", title: "", category: "Rent", amount: 0, frequency: "monthly",
                          startMonth: reportToDate.slice(0, 7), active: true, notes: "", createdByUserId: ""
                        })}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </form>
                <div className="activity-list">
                  {expenseTemplates.length > 0 ? expenseTemplates.map((template) => {
                    const isExpanded = expandedTemplateId === template.id;
                    const monthKeys = getMonthKeysForYear(gridYear);
                    return (
                      <div key={template.id} className="expense-template-row">
                        <div className="line-item-row">
                          <div>
                            <strong>{template.title}</strong>
                            <div className="muted">{template.category} · {currency(template.amount)} / month · from {formatMonthLabel(template.startMonth)}</div>
                          </div>
                          <div className="button-row dense">
                            <span className="muted">{template.active ? "Active" : "Inactive"}</span>
                            <button className="ghost-button" type="button" onClick={() => setExpandedTemplateId(isExpanded ? null : template.id)}>
                              {isExpanded ? "Hide Months" : "View Months"}
                            </button>
                            <button className="ghost-button" type="button" onClick={() => props.onBeginEditExpenseTemplate(template)}>Edit</button>
                            <button className="ghost-button" type="button" onClick={() => props.onToggleExpenseTemplateActive(template.id)}>
                              {template.active ? "Deactivate" : "Activate"}
                            </button>
                            <button className="ghost-button danger" type="button" onClick={() => props.onDeleteExpenseTemplate(template.id)}>Delete</button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="template-month-grid-wrap">
                            <div className="template-month-grid-header">
                              <button className="ghost-button compact" type="button" onClick={() => setGridYear((y) => y - 1)}>◀</button>
                              <strong>{gridYear}</strong>
                              <button className="ghost-button compact" type="button" onClick={() => setGridYear((y) => y + 1)}>▶</button>
                            </div>
                            <div className="template-month-grid">
                              {monthKeys.map((monthKey, idx) => {
                                const effectiveAmount = resolveEffectiveAmount(template, monthKey, expenseTemplateOverrides);
                                const override = expenseTemplateOverrides.find((o) => o.templateId === template.id && o.monthKey === monthKey);
                                const isSkipped = override?.amount === null;
                                const hasOverride = !!override && override.amount !== null;
                                const isExcluded = effectiveAmount === null && !isSkipped;
                                return (
                                  <div key={monthKey} className={`month-cell${isSkipped ? " month-cell-skipped" : ""}${isExcluded ? " month-cell-excluded" : ""}${hasOverride ? " month-cell-overridden" : ""}`}>
                                    <div className="month-cell-label">{monthNames[idx]}</div>
                                    {isSkipped ? (
                                      <div className="month-cell-amount skipped" title={override?.skipReason || undefined}>Skipped{override?.skipReason ? ` — ${override.skipReason}` : ""}</div>
                                    ) : isExcluded ? (
                                      <div className="month-cell-amount excluded">—</div>
                                    ) : (
                                      <div className="month-cell-amount">{currency(effectiveAmount!)}{hasOverride && <span className="override-dot" title="Custom amount" />}</div>
                                    )}
                                    {canEditReports && (
                                      <div className="month-cell-actions">
                                        {isSkipped ? (
                                          <button className="ghost-button micro" type="button" onClick={() => props.onDeleteOverride(template.id, monthKey)}>Restore</button>
                                        ) : (
                                          <>
                                            {!isExcluded && <button className="ghost-button micro" type="button" onClick={() => openEditDialog(template.id, monthKey, effectiveAmount!)}>Edit</button>}
                                            {!isExcluded && <button className="ghost-button micro danger" type="button" onClick={() => openSkipDialog(template.id, monthKey)}>Skip</button>}
                                          </>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }) : <div className="empty-state">No monthly templates yet.</div>}
                </div>
              </div>
            </>
          )}

          {/* Backfill prompt modal */}
          {props.pendingBackfillTemplateId && (() => {
            const template = expenseTemplates.find((t) => t.id === props.pendingBackfillTemplateId);
            if (!template) return null;
            const year = new Date().getFullYear();
            const currentMonthName = monthNames[new Date().getMonth()];
            return (
              <div className="modal-overlay">
                <div className="modal-box">
                  <h3>Apply Template From When?</h3>
                  <p>You created <strong>{template.title}</strong> mid-year. Should it apply to all months this year, or only from this month onwards?</p>
                  <div className="button-row">
                    <button className="primary-button" type="button" onClick={() => props.onResolveBackfillPrompt(template.id, true)}>
                      From January {year}
                    </button>
                    <button className="secondary-button" type="button" onClick={() => props.onResolveBackfillPrompt(template.id, false)}>
                      From {currentMonthName} {year}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Edit month amount dialog */}
          {editingCell && (
            <div className="modal-overlay">
              <div className="modal-box">
                <h3>Edit Month Amount</h3>
                <p>Change the amount for <strong>{formatMonthLabel(editingCell.monthKey)}</strong>.</p>
                <label>
                  <span>Amount (₹)</span>
                  <NumericInput mode="decimal" min={0} value={editAmount} onValueChange={setEditAmount} />
                </label>
                <div className="radio-group">
                  <label>
                    <input type="radio" name="edit-scope" checked={editScope === "single"} onChange={() => setEditScope("single")} />
                    <span>Just this month</span>
                  </label>
                  <label>
                    <input type="radio" name="edit-scope" checked={editScope === "future"} onChange={() => setEditScope("future")} />
                    <span>This and all future months through December</span>
                  </label>
                </div>
                <div className="button-row">
                  <button className="primary-button" type="button" onClick={submitEditDialog}>Save</button>
                  <button className="secondary-button" type="button" onClick={() => setEditingCell(null)}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          {/* Skip month dialog */}
          {skippingCell && (
            <div className="modal-overlay">
              <div className="modal-box">
                <h3>Skip Month</h3>
                <p>Mark <strong>{formatMonthLabel(skippingCell.monthKey)}</strong> as skipped. This month will be excluded from expense totals.</p>
                <label>
                  <span>Reason (optional)</span>
                  <input value={skipReason} onChange={(e) => setSkipReason(e.target.value)} placeholder="e.g. Rent waived by landlord" />
                </label>
                <div className="button-row">
                  <button className="primary-button" type="button" onClick={submitSkipDialog}>Skip Month</button>
                  <button className="secondary-button" type="button" onClick={() => setSkippingCell(null)}>Cancel</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="section-grid">
        <div className="panel">
          <div className="section-block">
            <div className="section-block-header">
              <h3>Pending Receivables</h3>
              <p>All outstanding pending bills across all time, sorted by most overdue first.</p>
            </div>
            {props.allPendingReceivables.length === 0 ? (
              <div className="empty-state">No pending bills outstanding.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Bill #</th>
                      <th>Date</th>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Total</th>
                      <th>Paid</th>
                      <th>Due</th>
                      <th>Days Overdue</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {props.allPendingReceivables.map(({ bill, businessDate, daysOverdue }) => (
                      <tr key={bill.id}>
                        <td><strong>{bill.billNumber}</strong></td>
                        <td>{businessDate}</td>
                        <td>{bill.customerName || <span className="muted">Walk-in</span>}</td>
                        <td>{bill.customerPhone || <span className="muted">—</span>}</td>
                        <td>{currency(bill.total)}</td>
                        <td>{currency(bill.amountPaid)}</td>
                        <td><strong className="pending-amount">{currency(bill.amountDue)}</strong></td>
                        <td>
                          <span className={daysOverdue > 7 ? "pending-amount" : "muted"}>
                            {daysOverdue === 0 ? "Today" : `${daysOverdue}d`}
                          </span>
                        </td>
                        <td>
                          <button className="ghost-button" type="button" onClick={() => props.onSettlePendingBill(bill.id)}>
                            Settle
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
