## Context

The app has two expense concepts today:
- `Expense` — a one-time cash expense entered manually with a date.
- `ExpenseTemplate` — a recurring monthly expense definition (`title`, `category`, `amount`, `startMonth`, `active`). Used only in report calculations (pro-rated across date ranges) — it never produces actual per-month records.

The gap: templates apply the same fixed amount for every month from `startMonth` onwards with no way to view, override, or skip individual months. Users resort to logging one-time `Expense` entries each month instead.

All app data is stored locally in a single `AppData` blob persisted via Supabase. Mutations use Immer drafts in `App.tsx`. The UI is a single-page React app with panel-based navigation.

## Goals / Non-Goals

**Goals:**
- Allow per-month amount overrides on an `ExpenseTemplate` (e.g., January rent is ₹12,000 instead of the usual ₹10,000).
- Allow skipping a specific month with an optional reason (e.g., June rent waived).
- Show a 12-month grid per template so users can see effective amounts at a glance and act on them.
- Prompt the user at template creation time whether to apply from January (backfill) or from the current month.
- When editing a month's amount, ask: "Just this month" or "This and all future months."
- Keep normalized expense calculations in reports accurate by incorporating overrides and skips.

**Non-Goals:**
- Weekly or annual recurring frequencies (only monthly).
- Bulk import of expense overrides.
- Recurring overrides that themselves recur (e.g., "every March is always ₹15,000") — one-off month edits only.
- Changes to one-time `Expense` entries.

## Decisions

### 1. New `ExpenseTemplateOverride` record (not mutating template)

**Decision**: Add a new `ExpenseTemplateOverride[]` array to `AppData` rather than storing override amounts inside `ExpenseTemplate`.

**Rationale**: Keeps the template as the single source of truth for the "base" amount. Overrides are sparse — only months that differ from the base need a record. This avoids bloating every template with a 12-item array and makes it easy to query "which months deviate from normal."

**Alternative considered**: Embed a `monthOverrides: Record<string, number | null>` map inside `ExpenseTemplate`. Rejected because it couples year-aware data to the template definition and complicates cross-year logic.

---

### 2. Override schema

```ts
interface ExpenseTemplateOverride {
  id: string;
  templateId: string;
  monthKey: string;        // "YYYY-MM", e.g. "2026-04"
  amount: number | null;   // null = skipped month
  skipReason?: string;     // only meaningful when amount === null
  notes?: string;
  createdByUserId: string;
  updatedAt: string;
}
```

`amount: null` signals a skip rather than a separate boolean, keeping the lookup simple: "what is the effective amount for month X?" — check for an override first; if override.amount is null, the month is skipped; if no override, use template.amount.

---

### 3. Effective-amount resolution

```
effectiveAmount(template, monthKey):
  override = overrides.find(o => o.templateId === template.id && o.monthKey === monthKey)
  if override exists:
    return override.amount   // null = skipped
  if monthKey < template.startMonth:
    return null              // before template started
  if !template.active:
    return null
  return template.amount
```

The normalized expense calculation in `App.tsx` will call this per month instead of using `template.amount` directly.

---

### 4. "Update this month vs. all future months" prompt

**Decision**: Implement as a modal/dialog in the React UI (not a browser `confirm()`). On "all future months", create/update overrides for every month from the selected month to December of the same year.

**Rationale**: Consistent with the app's existing modal patterns. Gives room to add notes or skip-reason in the same dialog.

---

### 5. Backfill prompt at template creation

**Decision**: When the user saves a new template and the current month is not January, show a prompt: "Apply from January [year]?" or "Apply from [current month]?"

**Implementation**: If user chooses backfill, set `template.startMonth` to `YYYY-01`. If they choose current month, set it to the current `YYYY-MM` as today. No override records are needed for backfill — it's just adjusting `startMonth`.

---

### 6. Month list view placement

**Decision**: Embed the 12-month grid inside the existing Reports panel's "Monthly Expenses" / templates section, as an expandable row per template (click to expand). Not a separate panel.

**Rationale**: The user said the expenses panel exists within Reports. Avoids adding a new top-level tab for a secondary management view.

## Risks / Trade-offs

- **Override accumulation**: A user who edits many months over years will accumulate many override records. Mitigation: overrides are keyed by `templateId + monthKey` so they stay bounded (max 12 per template per year in practice).
- **Template deletion**: Deleting a template should cascade-delete its overrides. Mitigation: handle in the `deleteExpenseTemplate` mutation.
- **Cross-year "all future months"**: "Update all future months" will only apply through December of the selected year (not into next year) to keep scope predictable. Document this behavior clearly in the UI.
- **Normalized expense calculation performance**: Already O(templates × months in range). Adding an override lookup per month is O(overrides) per month — acceptable given typical data sizes.
