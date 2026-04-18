import { type FormEvent } from "react";
import type { Bill, BusinessProfile, Expense, ExpenseTemplate, ReportFilterState, ReportPreset, Station } from "../types";
import { currency, formatDateTime, formatMonthLabel } from "../utils";
import { NumericInput } from "../components/NumericInput";
import { exportRowsToCsv, exportRowsToPdf, exportRowsToXlsx, type ReportRow } from "../exporters";

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
  previousRangeLabel: string;
  previousRangeRevenue: number;
  revenueGrowthPct: number | null;
  averageBillValue: number;
  topStation: [string, number] | null;
  paymentModeTotals: { cash: number; upi: number };
  expenseByCategory: [string, number][];
  normalizedExpenseByCategory: [string, number][];
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
  reportRows: ReportRow[];
  summary: ReportSummary;
  expenseForm: ExpenseForm;
  expenseTemplateForm: ExpenseTemplate;
  expenseCategoryOptions: string[];
  canEditReports: boolean;
  isManagerReadOnly: boolean;
  onReportFilterChange: (next: ReportFilterState) => void;
  onExpenseFormChange: (next: ExpenseForm) => void;
  onExpenseTemplateFormChange: (next: ExpenseTemplate) => void;
  onCreateExpense: (event: FormEvent<HTMLFormElement>) => void;
  onDeleteExpense: (expenseId: string) => void;
  onSaveExpenseTemplate: (event: FormEvent<HTMLFormElement>) => void;
  onBeginEditExpenseTemplate: (template: ExpenseTemplate) => void;
  onToggleExpenseTemplateActive: (templateId: string) => void;
  onDeleteExpenseTemplate: (templateId: string) => void;
}) {
  const {
    reportFilter, reportFromDate, reportToDate, summary, expenseForm, expenseTemplateForm,
    filteredBills, filteredExpenses, expenseCategoryOptions, expenseTemplates,
    canEditReports, isManagerReadOnly
  } = props;

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
                <span className="muted">Normalized Monthly Expenses</span>
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
                <strong>Normalized Monthly Expenses</strong>
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
                <strong>Normalized Monthly Expenses</strong>
                {summary.normalizedExpenseByCategory.length > 0 ? (
                  <div className="activity-list compact-list">
                    {summary.normalizedExpenseByCategory.map(([category, amount]) => (
                      <div key={category} className="activity-row">
                        <strong>{category}</strong>
                        <span className="muted">{currency(amount)}</span>
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
                  {expenseTemplates.length > 0 ? expenseTemplates.map((template) => (
                    <div key={template.id} className="line-item-row">
                      <div>
                        <strong>{template.title}</strong>
                        <div className="muted">{template.category} · {currency(template.amount)} / month · from {formatMonthLabel(template.startMonth)}</div>
                      </div>
                      <div className="button-row dense">
                        <span className="muted">{template.active ? "Active" : "Inactive"}</span>
                        <button className="ghost-button" type="button" onClick={() => props.onBeginEditExpenseTemplate(template)}>Edit</button>
                        <button className="ghost-button" type="button" onClick={() => props.onToggleExpenseTemplateActive(template.id)}>
                          {template.active ? "Deactivate" : "Activate"}
                        </button>
                        <button className="ghost-button danger" type="button" onClick={() => props.onDeleteExpenseTemplate(template.id)}>Delete</button>
                      </div>
                    </div>
                  )) : <div className="empty-state">No monthly templates yet.</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
