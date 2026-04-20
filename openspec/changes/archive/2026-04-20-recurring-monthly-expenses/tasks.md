## 1. Data Model

- [x] 1.1 Add `ExpenseTemplateOverride` interface to `src/types.ts` with fields: `id`, `templateId`, `monthKey`, `amount` (number | null), `skipReason?`, `notes?`, `createdByUserId`, `updatedAt`
- [x] 1.2 Add `expenseTemplateOverrides: ExpenseTemplateOverride[]` array to the `AppData` interface in `src/types.ts`
- [x] 1.3 Seed `expenseTemplateOverrides: []` in any initial/default `AppData` construction in `src/App.tsx` or seed files

## 2. Core Logic (App.tsx)

- [x] 2.1 Write `resolveEffectiveAmount(template, monthKey, overrides)` utility in `src/utils.ts` that returns the effective amount (number | null) per the precedence rules in design.md
- [x] 2.2 Update `normalizedExpenseEntries` calculation in `App.tsx` to call `resolveEffectiveAmount` per month instead of using `template.amount` directly; skip months where effective amount is null
- [x] 2.3 Add `createOrUpdateOverride(templateId, monthKey, amount, skipReason?, notes?)` mutation in `App.tsx` that upserts an `ExpenseTemplateOverride` record
- [x] 2.4 Add `deleteOverride(overrideId)` mutation in `App.tsx` for restoring a skipped month
- [x] 2.5 Update `deleteExpenseTemplate` mutation in `App.tsx` to also remove all overrides with matching `templateId`
- [x] 2.6 Add "apply to future months" logic: given a start month and a new amount, call `createOrUpdateOverride` for each month from start through December of the same year

## 3. Backfill Prompt (Template Creation)

- [x] 3.1 Add state in `App.tsx` (or `ReportsPanel.tsx`) to hold a pending template awaiting backfill choice
- [x] 3.2 In `saveExpenseTemplate`, when creating a new template and current month is not January, save the template with a temporary `startMonth` and raise the backfill prompt state instead of finalising immediately
- [x] 3.3 Create a `BackfillPromptModal` component (or inline dialog) in `ReportsPanel.tsx` with two options: "From January [year]" and "From [current month] [year]"
- [x] 3.4 On backfill choice, set `template.startMonth` to `YYYY-01` or current `YYYY-MM` accordingly and persist the template

## 4. Month Grid UI (ReportsPanel.tsx)

- [x] 4.1 Add an expand/collapse toggle to each template row in the expense templates list
- [x] 4.2 Build a `TemplateMonthGrid` component that renders 12 month cells for a given template and year, showing: effective amount, "Skipped" label (with reason tooltip), and override indicator
- [x] 4.3 Add year navigator (prev/next arrows + year label) to `TemplateMonthGrid`
- [x] 4.4 Add an "Edit" action on each month cell that opens an edit dialog pre-filled with the current effective amount
- [x] 4.5 Build the edit dialog with amount input, validation (must be ≥ 0), and a radio choice: "Just this month" / "This and all future months through December"
- [x] 4.6 On edit dialog save, call `createOrUpdateOverride` (single month) or the future-months batch mutation depending on the user's choice
- [x] 4.7 Add a "Skip" action on non-skipped month cells; show a confirmation with an optional reason text input; on confirm call `createOrUpdateOverride` with `amount: null`
- [x] 4.8 Add a "Restore" action on skipped month cells; on confirm call `deleteOverride` to remove the skip override

## 5. Styling & Polish

- [x] 5.1 Add CSS in `src/styles.css` for the month grid layout (12-column or 3×4 grid), override indicator, and skipped state
- [x] 5.2 Ensure the month grid is readable on mobile/narrow viewports (wrap to fewer columns if needed)
- [x] 5.3 Add audit log entries (using existing `addAuditLog` helper) for override create, update, and delete actions

## 6. Testing & Validation

- [x] 6.1 Add unit tests in `src/pricing.test.ts` (or a new `src/expenses.test.ts`) for `resolveEffectiveAmount` covering: base amount, amount override, skip override, before-startMonth exclusion, inactive template exclusion
- [ ] 6.2 Manually verify the 12-month grid shows correct amounts after creating a template with backfill
- [ ] 6.3 Manually verify editing a single month and "all future months" produces the correct override records
- [ ] 6.4 Manually verify skipping a month removes it from normalized expense totals in the Reports summary
- [ ] 6.5 Manually verify deleting a template also removes all its overrides
