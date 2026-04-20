## Why

The app already has `ExpenseTemplate` for recurring expenses, but it only stores a single fixed amount applied uniformly across all months — there is no way to view, override, or skip individual months. Users are forced to either accept a uniform amount forever or manually log separate one-time `Expense` entries every month, which defeats the purpose of templates.

## What Changes

- **New per-month override system**: Each `ExpenseTemplate` can have month-level overrides that change the amount for a specific month or mark it as skipped (with an optional reason).
- **Template month list view**: A UI surface that shows all 12 months of a year for a given recurring template, with their effective amounts, so users can see and act on each month at a glance.
- **Inline month editing**: Clicking a month's amount opens an edit prompt; on save, user is asked "Update just this month" or "Update this and all future months."
- **Month skip/delete with reason**: Users can mark a specific month as skipped (e.g., rent waived) with an optional reason field; skipped months are excluded from normalized expense calculations.
- **Backfill prompt on template creation**: When creating a new recurring expense mid-year, the system asks whether to apply it from January (backfill) or from the current month forward.
- **Year navigation**: The month list view supports switching years so users can review and adjust any calendar year.

## Capabilities

### New Capabilities
- `expense-template-overrides`: Per-month override records for recurring expense templates, supporting amount changes and skips with reasons.
- `expense-month-list-view`: UI panel/section showing all 12 months of a year for a recurring template, with inline edit and skip actions.
- `expense-backfill-prompt`: Prompt shown when creating a new recurring expense mid-year to choose between backfilling all months or starting from the current month.

### Modified Capabilities

## Impact

- **`src/types.ts`**: New `ExpenseTemplateOverride` interface added to `AppData`.
- **`src/App.tsx`**: New state, handlers for creating/editing/deleting overrides; backfill prompt logic on template save; normalized expense calculation updated to respect overrides.
- **`src/panels/ReportsPanel.tsx`**: New month list view for each template showing 12 months with edit/skip actions; year navigator.
- **`supabase/`**: New table `expense_template_overrides` with RLS policies consistent with existing expense tables.
- No breaking changes to existing `Expense` or `ExpenseTemplate` interfaces.
