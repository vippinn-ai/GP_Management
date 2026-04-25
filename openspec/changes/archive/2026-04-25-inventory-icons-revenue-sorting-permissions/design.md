## Context

Four independent improvements are batched into one change because they are all small, UI-only fixes with no shared data-model changes. The app has no external icon library; all existing visual indicators use CSS classes and plain text. Revenue calculations are done in-memory in `App.tsx` against the `AppData` blob. Permissions are plain role-string comparisons.

Current state of each area:
1. **Icons**: Categories are plain text strings. No icon system exists. Categories are defined as a constant array: `["Beverages", "Food", "Refill Sheesha", "Arcade", "Cigarettes"]`.
2. **Revenue**: `grossRevenue = Σ bill.total for status === "issued"`. Bills with `status: "pending"` (deferred payment) are excluded entirely, even when a partial upfront payment was collected.
3. **Sorting**: `stations.filter(active)` renders in raw array order; no sort applied.
4. **Permissions**: `canEditSessionCustomerDetails` already includes all three roles. The perceived issue is that the customer name/phone fields in the session-start form have no explicit permission guard — they are always editable by whoever can open the start-session modal. This is correct behavior; it just needs verification that the same applies in the session manage modal and checkout form.

## Goals / Non-Goals

**Goals:**
- Emoji icon per inventory category; cigarettes rendered with amber accent
- Icons appear consistently in inventory table, sale-panel catalog, and session item-picker dropdown
- `grossRevenue` includes `amountPaid` from `status: "pending"` deferred bills on their billing date
- New "Deferred Outstanding" metric in reports showing total remaining `amountDue` for pending bills in the period
- Dashboard station grid sorted: sessions active/paused first, vacant stations after
- Confirm and, if needed, patch all customer-detail edit touchpoints to be open to all roles

**Non-Goals:**
- Adding an external icon library (SVG, Lucide, Heroicons) — emoji are sufficient and zero-dependency
- Per-item icon overrides (icon is driven by category, not by individual items)
- Changing the `amountDue` / `amountPaid` accounting model on bills
- Adding dashboard section headers or visual group separators
- Role-based restrictions on which stations can be started (out of scope)

## Decisions

### D1 — Emoji icons, no library

**Decision**: Map each known category to a single emoji in a constant `CATEGORY_ICONS` record in `constants.ts`. Unknown/custom categories use `📦`. Render as a `<span>` with a `.category-icon` class, and add `.category-icon--cigarettes` for the amber accent on cigarettes.

**Alternatives considered**:
- SVG icon library (Lucide, Heroicons): Adds ~30–80 KB and a dependency for what is essentially 5 glyphs. Rejected.
- CSS background images: Hard to maintain, no semantic value. Rejected.
- Emoji: Zero dependency, render natively in all modern browsers, universally legible. Chosen.

**Icon map**:
| Category | Emoji | Notes |
|----------|-------|-------|
| Beverages | 🥤 | Soft drink / cup icon — universally understood |
| Food | 🍔 | Generic food; broad enough to cover snacks |
| Cigarettes | 🚬 | Literal; amber accent class draws extra attention |
| Refill Sheesha | 💨 | Smoke/breath — closest available without SVG |
| Arcade | 🕹️ | Joystick — universally recognised for gaming |
| *(any other)* | 📦 | Neutral fallback |

### D2 — Deferred revenue: include `amountPaid` from pending bills

**Decision**: Change the `grossRevenue` sum to:
```
grossRevenue = Σ(issued bills → bill.total)
             + Σ(pending bills in period → bill.amountPaid)
```
This preserves existing behaviour for fully-paid bills and adds the upfront-collected portion of deferred bills.

**Alternative considered**: Change pending bills to `status: "issued"` immediately (even when amount is still outstanding). Rejected — it would break the pending-bills receivable tracking and the settlement flow.

**New metric**: `deferredOutstanding = Σ(pending bills in period → bill.amountDue)` — surfaced in the report as an informational KPI alongside gross revenue.

### D3 — Station sort: computed in App.tsx before DashboardPanel

**Decision**: Sort the `stations` array passed to `DashboardPanel` by whether the station has an active session. Stations with a live session (status `active` or `paused`) float to the front; within each group, original order is preserved (stable sort).

**Alternative considered**: Sort inside DashboardPanel. Rejected — DashboardPanel receives `getActiveSessionForStation` as a callback, making sorting there awkward. Sorting in App.tsx keeps DashboardPanel a pure rendering component.

### D4 — Permission verification: no code change needed, minor guard cleanup

**Decision**: `canEditSessionCustomerDetails` already covers all roles. The session-start form has no permission check on the customer fields because those fields should be universally editable (you can always fill in customer info when starting). Confirm via code audit and add a brief inline comment for clarity. No behavior change.

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| Emoji rendering varies between OS/font | Emoji for these categories (food, drink, cigarette, gaming) are in Unicode 6–9 and render consistently on iOS, Android, and Windows. No mitigation needed beyond testing. |
| Deferred revenue change may surprise operators expecting old behaviour | Add a tooltip/label to the gross revenue figure explaining it includes collected upfront amounts. Document in release notes. |
| Station sort reorders the grid unexpectedly for operators used to fixed positions | Sort is purely by active/vacant; within vacant stations, original order preserved. No visual group headers added per requirements. |
| `amountPaid` on a newly-issued deferred bill may be 0 if nothing collected upfront | `bill.amountPaid = 0` contributes ₹0 to revenue — correct and harmless. |

## Migration Plan

No data migrations. No schema changes. Standard build + deploy. Rollback by reverting the build.

## Open Questions

- Should deferred bills with `amountPaid = 0` (100% deferred, nothing collected upfront) still be excluded from gross revenue? Current decision: yes — contributing ₹0 is harmless and consistent.
- Should `deferredOutstanding` be shown only when > 0, or always? Preference: only when > 0, to avoid confusing operators on days with no deferred bills.
