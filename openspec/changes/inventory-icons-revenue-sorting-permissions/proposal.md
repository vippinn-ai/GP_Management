## Why

Four operator-facing pain points have emerged from daily use: the inventory list is slow to scan visually (no category icons), deferred-payment revenue is being under-reported (only the outstanding amount, not the collected upfront amount, registers on the day of billing), the dashboard shows empty stations before active sessions making it harder to monitor live games, and there is uncertainty about whether all staff roles can edit customer details during sessions. These are quick, high-value improvements that don't require data model changes.

## What Changes

- **Inventory category icons**: Each inventory category gets a mapped emoji icon displayed in the inventory table, the sale-panel catalog card, and the session item-picker dropdown. Cigarettes get an additional amber highlight so they stand out on the shelf. Custom categories fall back to a generic box icon. No external icon library is added — emoji are used directly.
- **Deferred-payment revenue fix**: The revenue report (`grossRevenue`) currently excludes all `status: "pending"` bills. For deferred bills where a partial (or full) upfront amount was collected at billing time, that collected amount (`bill.amountPaid`) is now included in the day's gross revenue. A separate "Deferred Outstanding" metric shows the total still owed across pending bills in the period.
- **Dashboard active-sessions-first sorting**: Stations with a live (active or paused) session are sorted to the front of the dashboard grid; vacant stations follow. Order within each group is preserved. No visual grouping headers are added.
- **Customer-detail edit permission clarification**: Code audit confirms `canEditSessionCustomerDetails` already includes all three roles (admin, manager, receptionist). The issue is verified and the permission is extended to explicitly cover the session-start form's customer fields as well — ensuring receptionist and manager users can add/change customer name and phone at every touchpoint (session start, session manage modal, checkout).

## Capabilities

### New Capabilities
- `inventory-category-icons`: Emoji icon mapping per category, rendered in inventory list, sale panel catalog, and session item picker
- `deferred-revenue-attribution`: Collected upfront amounts from pending/deferred bills are included in gross revenue on the billing date; deferred outstanding shown as a separate metric

### Modified Capabilities
- `concurrent-update-handling`: *(no spec change — implementation only)*
- `zero-price-bill-guard`: *(no spec change — implementation only)*

> Note: Dashboard sorting and permission clarification are implementation-only fixes (no new spec-level requirements beyond the existing session and dashboard specs). They are tracked as tasks under the two new capabilities above.

## Impact

- **`src/constants.ts`**: Add `CATEGORY_ICONS` map (category → emoji)
- **`src/panels/InventoryPanel.tsx`**: Render icon in table rows
- **`src/panels/SalePanel.tsx`**: Render icon on catalog cards
- **`src/App.tsx`**: Render icon in session item-picker `<option>` text; fix revenue calculation to include `amountPaid` from pending bills; sort stations before passing to DashboardPanel; verify/extend customer-edit permission to session-start path
- **`src/styles.css`**: Add `.category-icon` and `.category-icon--cigarettes` (amber accent) styles
- No schema changes, no new dependencies
