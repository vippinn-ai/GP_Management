## 1. Inventory Category Icons — Foundation

- [x] 1.1 In `src/constants.ts`, add a `CATEGORY_ICONS` record mapping each known category to its emoji: `{ Beverages: "🥤", Food: "🍔", Cigarettes: "🚬", "Refill Sheesha": "💨", Arcade: "🕹️" }` and export a helper `getCategoryIcon(category: string): string` that returns the mapped emoji or `"📦"` as fallback
- [x] 1.2 In `src/styles.css`, add `.category-icon` (inline-block, slight right margin, font-size ~1em) and `.category-icon--cigarettes` (color: `#d97706` amber accent) CSS classes

## 2. Inventory Category Icons — Render in All Three Locations

- [x] 2.1 In `src/panels/InventoryPanel.tsx`, import `getCategoryIcon` from constants; in the table row Category cell (`<td>{item.category}</td>`), prepend `<span className={`category-icon${item.category === "Cigarettes" ? " category-icon--cigarettes" : ""}`}>{getCategoryIcon(item.category)}</span>` before the category text
- [x] 2.2 In `src/panels/SalePanel.tsx`, import `getCategoryIcon`; in the catalog card where `<span>{item.category}</span>` is rendered (line ~71), prepend the icon span with the same cigarettes conditional class
- [x] 2.3 In `src/App.tsx`, in the session item-picker `<option>` render (the `{item.name} · {currency(item.price)} · ...` string, line ~3989), prepend `${getCategoryIcon(item.category)} ` to the option text so the icon shows in the dropdown
- [x] 2.4 Test: open inventory panel — confirm each row shows its icon in the category column; open sale panel catalog — confirm icons appear on cards; open session consumables — confirm icons appear in the item picker dropdown
- [x] 2.5 Test: add a custom-category item — confirm it shows 📦; confirm cigarette items have amber icon colour in inventory table and sale catalog

## 3. Deferred Revenue Attribution

- [x] 3.1 In `src/App.tsx`, find the `grossRevenue` calculation (line ~3328: `const grossRevenue = sumBy(issuedBills, (bill) => bill.total)`) and change it to also add `amountPaid` from pending deferred bills in the filtered period: add `const deferredCollected = sumBy(filteredBills.filter(b => b.status === "pending" && b.amountPaid > 0), b => b.amountPaid)` then `grossRevenue = issuedRevenue + deferredCollected`
- [x] 3.2 Add `const deferredOutstanding = sumBy(filteredBills.filter(b => b.status === "pending" && b.amountDue > 0), b => b.amountDue)` alongside the other summary metrics
- [x] 3.3 Pass `deferredOutstanding` into the reports summary object (wherever `grossRevenue`, `sessionRevenue` etc. are bundled and passed to `ReportsPanel`)
- [x] 3.4 In `src/panels/ReportsPanel.tsx`, render a "Deferred Outstanding" KPI card when `summary.deferredOutstanding > 0` — place it after the Gross Revenue card with a muted/amber styling to distinguish it from earned revenue
- [x] 3.5 Test: create a session, issue bill with "Pay Later" (deferred) collecting ₹200 upfront on a ₹500 total; check today's report — gross revenue should include ₹200, deferred outstanding should show ₹300
- [x] 3.6 Test: confirm a fully-paid (cash/upi) bill still shows the full amount in gross revenue and no deferred outstanding metric appears

## 4. Dashboard Active-Sessions-First Sort

- [x] 4.1 In `src/App.tsx`, find where `stations` is computed (line ~422: `const stations = appData.stations.filter(s => s.active)`) and apply a stable sort after filtering: active/paused sessions first, vacant stations after. Use `getActiveSessionForStation` to determine status — `[...filtered].sort((a, b) => (getActiveSessionForStation(b.id) ? 1 : 0) - (getActiveSessionForStation(a.id) ? 1 : 0))`
- [x] 4.2 Verify the sorted array is used as the `stations` prop passed to `DashboardPanel` — no other changes needed in DashboardPanel itself
- [x] 4.3 Test: with 2 active sessions and 3 vacant stations, confirm the 2 active cards appear first in the grid; start another session on a vacant station and confirm it immediately moves to the front

## 5. Customer Edit Permission — Code Already Correct, UX Clarity Needed

> **Finding (verified 2026-04-25):** `canEditSessionCustomerDetails` at App.tsx line 416 already includes all three roles. All four touchpoints (session-start modal, session manage modal, checkout form, DashboardPanel start form) are either ungated or gated on this flag. No code behaviour change is required. The likely user confusion is that the "Edit Customer Details" button is a secondary button inside the Manage modal — not an inline field. The task below adds a comment and a small UX hint.

- [x] 5.1 In `src/App.tsx` at line ~416, add inline comment: `// all roles: admin, manager, receptionist can edit customer details`
- [x] 5.2 In the session manage modal's Edit Customer Details form header (`src/App.tsx` ~line 3941), update the helper text to be explicit: "All staff can update customer name and phone. Admins can also correct session start time." — removing any admin-only implication from the current wording
- [x] 5.3 Test: log in as a receptionist account; open a running session; confirm "Edit Customer Details" button is visible and the name/phone fields are editable; confirm same at checkout
