# Production Refactor Plan — BreakPerfect Gaming Lounge Management App

## Status Legend
- ✅ Done (code merged to main, deployed to production)
- 🔧 Code done, needs edge function re-deploy to staging/prod
- ⬜ Not started

---

## ✅ Phase 1 — Fix the Session/Refresh Bug *(COMPLETE)*

All tasks done and deployed.

### ✅ Task 1.1 — Enable session persistence
`src/backend.ts` — `persistSession: true, autoRefreshToken: true`

### ✅ Task 1.2 — Remove the signOutRemote-on-mount effect
Removed. `signOutRemote()` is now only called from `handleLogout`.

### ✅ Task 1.3 — Add session restoration on mount
`src/App.tsx` — `fetchCurrentProfile()` effect restores session on hard refresh.

### ✅ Task 1.4 — Clear hardcoded default credentials
Login form fields are now empty strings by default.

### Phase 1 Test Checklist
- [x] Login form fields are empty on first load
- [ ] Log in with valid credentials → dashboard loads
- [ ] Hard-refresh (`Ctrl+F5`) → still on dashboard, no login screen
- [ ] DevTools > Application > Local Storage → `sb-*-auth-token` key exists
- [ ] Log out → token removed from localStorage
- [ ] Refresh after logout → login screen shown (not auto-logged-in)

---

## 🔧 Phase 2 — Security Hardening *(Code COMPLETE — edge functions need re-deploy)*

All code is written and merged. Edge functions must be re-deployed to staging and production to take effect.

**Re-deploy command (run for both staging and production):**
```bash
# Staging
npx supabase link --project-ref tkbdyzxwwbhkpztgjjxh
npx supabase functions deploy resolve-login-email --no-verify-jwt
npx supabase functions deploy admin-create-user --no-verify-jwt
npx supabase functions deploy admin-update-user --no-verify-jwt
npx supabase functions deploy admin-change-password --no-verify-jwt
npx supabase functions deploy admin-toggle-user-active --no-verify-jwt

# Production
npx supabase link --project-ref rrdwbxvuwrbxefarxnse
npx supabase functions deploy resolve-login-email --no-verify-jwt
npx supabase functions deploy admin-create-user --no-verify-jwt
npx supabase functions deploy admin-update-user --no-verify-jwt
npx supabase functions deploy admin-change-password --no-verify-jwt
npx supabase functions deploy admin-toggle-user-active --no-verify-jwt
```

### ✅ Task 2.1 — Restrict CORS origin
`supabase/functions/_shared/cors.ts` — validates `Origin` against `ALLOWED_ORIGIN` env secret. Supports comma-separated list. Falls back to `*` only when secret is not set (local dev only).

### ✅ Task 2.2 — Request size guard on all admin functions
413 response if `content-length > 4096` — done in all 4 admin functions.

### ✅ Task 2.3 — Password minimum length validation
8-character minimum enforced in `admin-create-user` and `admin-change-password`.

### ✅ Task 2.4 — Rate limit the login endpoint
`supabase/functions/_shared/rateLimit.ts` — sliding window, 10 requests/min per IP. Applied in `resolve-login-email`. Username length guard (64 chars max) also added.

### Phase 2 Test Checklist (run after re-deploying edge functions)
- [ ] DevTools Network → login request → `Access-Control-Allow-Origin` is your Worker domain, not `*`
- [ ] Send 11 rapid login attempts → 11th returns `429 Too many attempts`
- [ ] Wait 60s → login works again
- [ ] Create user with password "abc" → returns 400 error
- [ ] Normal login and user-creation flows still work

---

## ✅ Phase 3 — Error Boundaries + Re-render Performance Fix *(COMPLETE)*

### ✅ Task 3.1 — Add root-level Error Boundary
`src/ErrorBoundary.tsx` created. Wrapped around `<App />` in `src/main.tsx`.

### ✅ Task 3.2 — Extract `now` clock into a custom hook
`src/hooks/useClock.ts` created. Used in `src/App.tsx` via `const now = useClock()`.

### ✅ Task 3.3 — Replace blocking alert for save conflicts
`saveRemoteSnapshot` uses `setRemoteError()` instead of `window.alert`. Dismiss button present in sidebar footer.

*Note: Other `window.alert()` calls remain in the codebase for validation messages (stock, time, customer fields). These are a Phase 7 UX item — replace with inline errors.*

### Phase 3 Test Checklist
- [ ] Temporarily throw an error → error boundary shows instead of white screen
- [ ] "Try again" resets the boundary
- [ ] Live session timer still counts up correctly
- [ ] Trigger a data conflict (two tabs) → error appears inline, no alert dialog
- [ ] "Dismiss" clears the error message

---

## ✅ Phase 4 — Cloudflare Security Headers *(COMPLETE)*

### ✅ Task 4.1 — Create `public/_headers`
File exists. Headers set: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. `Cache-Control: no-cache` on `/index.html`, `immutable` on `/assets/*`.

### Phase 4 Test Checklist
- [ ] DevTools → Network → `index.html` response → `X-Frame-Options: DENY` present
- [ ] `Cache-Control: no-cache` on `index.html`
- [ ] `Cache-Control: immutable` on `/assets/*.js`

---

## Phase 5 — Code Architecture: Extract Utilities, Hooks, Types *(~3–4 hours)*

**Goal:** Decompose the monolith without touching UI. Pure functions and types leave `App.tsx`. Zero visible changes to users. Prerequisite for Phase 6.

### Task 5.1 — Move local types out of App.tsx
**Source:** `src/App.tsx` lines 68–161 (all local type/interface definitions)
**Destination:** Append to `src/types.ts`

Types to move: `TabId`, `StartSessionDraft`, `CheckoutState`, `DraftLineDiscountMap`, `CustomerTabDraft`, `SessionEditDraft`, `CustomerTabEditDraft`, `CustomerProfileEditDraft`, `StationEditDraft`, `UserEditDraft`, `UserPasswordDraft`, `NumericInputMode`, `ReportPreset`, `ReportFilterState`

Move one at a time, run `tsc -b` after each to confirm zero errors.

### Task 5.2 — Move pure utility functions to src/utils.ts
**Source:** `src/App.tsx` lines 188–443 (module-level pure functions before `App()`)
Also lines ~631–761 (customer helper functions currently inside `App()` body): `normalizeCustomerName`, `normalizeCustomerPhone`, `getCustomerDisplayName`, `findCustomerProfileMatch`, `resolveCustomerProfile`, `normalizeAppDataCustomers`

These functions only depend on TypeScript types and `AppData` — no React. Move them to `src/utils.ts`.

### Task 5.3 — Move constants to src/constants.ts
**Source:** `src/App.tsx` lines 162–186
**Destination:** New file `src/constants.ts`

Move: `DEFAULT_INVENTORY_CATEGORIES`, `DEFAULT_EXPENSE_CATEGORIES`, `tabsByRole`

### Task 5.4 — Extract remote sync logic into a hook
**File:** Create `src/hooks/useAppSync.ts`

Extract the three backend-facing `useEffect` blocks:
1. The session-restore effect (added in Phase 1)
2. The realtime subscription effect (App.tsx lines 779–789)
3. The debounced save effect (App.tsx lines 604–629)

Hook signature:
```typescript
export function useAppSync(params: {
  backendConfigured: boolean;
  activeUserId: string | null;
  appData: AppData;
  remoteLoading: boolean;
  remoteVersion: number;
  skipRemotePersistRef: React.MutableRefObject<boolean>;
  remoteSaveTimerRef: React.MutableRefObject<number | undefined>;
  setAppData: (data: AppData) => void;
  setActiveUserId: (id: string | null) => void;
  setRemoteVersion: (v: number) => void;
  setRemoteLoading: (loading: boolean) => void;
  setRemoteError: (err: string) => void;
  setRemoteSaving: (saving: boolean) => void;
  setActiveTab: (tab: TabId) => void;
}): void
```

### Phase 5 Test Checklist
- [ ] `tsc -b` zero errors after every task
- [ ] `npm run build` builds cleanly
- [ ] Full smoke test: login → start session → add inventory → close bill → view reports → create user → log out
- [ ] `src/App.tsx` is under ~5000 lines
- [ ] `src/types.ts`, `src/utils.ts`, `src/constants.ts` all have content

---

## Phase 6 — Code Architecture: Decompose App.tsx into Feature Panels *(~1–2 days)*

**Goal:** Split the monolithic JSX into feature panel components. `App.tsx` shrinks to ~800 lines. Each panel is independently re-renderable and testable.

### Task 6.1 — Extract shared UI components first
**Source:** Bottom of `src/App.tsx` (lines ~5746–6019)
**Destination:** Individual files in `src/components/`

Components to extract: `Modal`, `LoadingOverlay`, `NumericInput`, `LoginScreen`, `MetricCard`, `TodayMetricCard`, `CustomerAutocompleteFields`, `AppLoadingSkeleton` (new, from Phase 7)

### Task 6.2 — Extract feature panels one at a time

| Panel File | Tab ID | Notes |
|---|---|---|
| `src/panels/DashboardPanel.tsx` | `dashboard` | Wrap in `React.memo` — re-renders every second |
| `src/panels/SalePanel.tsx` | `sale` | |
| `src/panels/InventoryPanel.tsx` | `inventory` | Local state: search, form drafts, modals |
| `src/panels/ReportsPanel.tsx` | `reports` | Large — handle last |
| `src/panels/CustomersPanel.tsx` | `customers` | |
| `src/panels/SettingsPanel.tsx` | `settings` | |
| `src/panels/UsersPanel.tsx` | `users` | |

**Props pattern:** Each panel receives only the slice of `appData` it needs (NOT all of AppData). Pass specific arrays. Example: `DashboardPanel` needs `stations, sessions, customerTabs, inventoryItems, now` — not `bills`, `auditLogs`, etc. This is what enables `React.memo` to prevent unnecessary re-renders.

Local UI state (form drafts, search strings, modal open/closed) that belongs exclusively to one panel moves inside that panel. Shared state (e.g. `checkoutState` which bridges dashboard and billing) stays in `App.tsx` and is passed as props.

**Extract one panel, deploy, smoke test before continuing.**

### Task 6.3 — Remove seed.ts from production bundle
**Files:** `src/App.tsx` line 14 and `src/storage.ts` line 3 both import `src/seed.ts`

`seed.ts` contains plaintext passwords (`"admin123"`) and is always bundled.

Strategy:
- Replace `src/seed.ts` with an `emptyAppData` constant inline in `src/storage.ts` (no users, no passwords, just structural defaults)
- The initial state in `App.tsx` (`backendConfigured ? cloneValue(seedAppData) : loadAppData()`) becomes just `loadAppData()` unconditionally, since backend mode never needs seed data

### Phase 6 Test Checklist
- [ ] `tsc -b` and `npm run build` pass
- [ ] Full manual regression test
- [ ] `grep "admin123" dist/assets/*.js` — returns nothing
- [ ] DevTools Performance → record 5s with active session → only `DashboardPanel` re-renders every second
- [ ] `src/App.tsx` is under 1000 lines

---

## Phase 7 — UX: Loading Skeleton + Client-Side Validation *(~2–3 hours)*

**Goal:** Professional perceived performance. Instant feedback on form errors.

### Task 7.1 — App loading skeleton (replaces "Connecting..." login screen)
**File:** `src/components/AppLoadingSkeleton.tsx`

Replace the `remoteLoading` render gate in `App.tsx` (line 3312) with a shimmer skeleton that mirrors the app shell layout (sidebar + content area). CSS `@keyframes` shimmer animation. `aria-label="Loading"` + `role="status"` for accessibility.

### Task 7.2 — Login form client-side validation
**File:** `src/App.tsx` (or `src/components/LoginScreen.tsx` post-Phase 6), inside `handleLogin`

Before the async call:
```typescript
const trimmedUsername = loginUsername.trim();
if (!trimmedUsername) { setLoginError("Username is required."); return; }
if (!loginPassword) { setLoginError("Password is required."); return; }
if (trimmedUsername.length > 64) { setLoginError("Username is too long."); return; }
```

### Task 7.3 — Password form client-side validation
**File:** `src/App.tsx` (or `src/panels/UsersPanel.tsx` post-Phase 6), inside `saveUserPassword` (~line 2866)

Before `adminChangePasswordRemote` call:
```typescript
if (passwordDraft.password.length < 8) { /* show error */ return; }
if (passwordDraft.password !== passwordDraft.confirmPassword) { /* show error */ return; }
```

### Task 7.4 — Self-change password for non-admin users
**File:** Create `supabase/functions/change-own-password/index.ts`

Any authenticated user can change their own password. Use `userClient.auth.updateUser({ password: newPassword })` — the valid session token proves identity. No email lookup needed.

Add `changeOwnPasswordRemote(newPassword: string)` to `src/backend.ts`.

Wire up a "Change Password" option in the sidebar user card area (~line 3380 in App.tsx).

### Phase 7 Test Checklist
- [ ] Hard-refresh → shimmer skeleton visible before login/dashboard
- [ ] Submit empty login form → inline error, zero network requests
- [ ] Set password < 8 chars in user management → immediate error
- [ ] Non-admin user can change their own password end-to-end
- [ ] Skeleton renders correctly at 375px mobile width

---

## Phase 8 — Code Quality: Tests + Linting *(~3–4 hours)*

**Goal:** Establish testing foundation. Catch regressions. Enforce code style.

### Task 8.1 — Add Vitest + Testing Library
**File:** `package.json` — add devDependencies:
```json
"vitest": "^2.0.0",
"@vitest/ui": "^2.0.0",
"@testing-library/react": "^16.0.0",
"@testing-library/user-event": "^14.0.0",
"jsdom": "^25.0.0"
```

**File:** `vite.config.ts` — add:
```typescript
test: { environment: "jsdom", globals: true, setupFiles: ["./src/test/setup.ts"] }
```

**File:** `src/test/setup.ts`: `import "@testing-library/jest-dom";`

Add scripts: `"test": "vitest"`, `"test:ui": "vitest --ui"`

### Task 8.2 — Write tests for pure utility functions
**File:** `src/utils.test.ts`

Target: `toLocalDateKey`, `getDiscountAmount`, `buildBillPreview`, `formatBillNumber`, `getReportRange`
These are pure, zero-dependency — no mocking needed.

### Task 8.3 — Write tests for pricing logic
**File:** `src/pricing.test.ts`

Target: `calculateSessionCharge` — covers edge cases: 0-minute sessions, pause deductions, pricing rule boundary transitions.

### Task 8.4 — Add ESLint + Prettier
**Files:** `eslint.config.js` (flat config) + `.prettierrc`

Key rules: `react-hooks/rules-of-hooks: error`, `react-hooks/exhaustive-deps: warn`, `@typescript-eslint/no-explicit-any: warn`

Run `npm run lint` and fix all errors before shipping.

### Phase 8 Test Checklist
- [ ] `npm test` → all tests pass
- [ ] `npm run lint` → zero errors
- [ ] `npm run build` → clean build
- [ ] At least 15 unit tests covering utils and pricing

---

## Summary

| Phase | What | Scope | Status |
|---|---|---|---|
| **1** | Fix session/refresh bug | Small | ✅ Done |
| **2** | CORS + rate limiting + input guards | Small | 🔧 Code done, re-deploy edge functions |
| **3** | Error boundaries + re-render fix | Medium | ✅ Done |
| **4** | Cloudflare security headers | Tiny | ✅ Done |
| **5** | Extract types, utils, hooks | Medium | ⬜ Next up |
| **6** | Decompose App.tsx into panels | Large | ⬜ After Phase 5 |
| **7** | Loading skeleton + UX polish | Medium | ⬜ Can parallel with 6 |
| **8** | Tests + linting | Medium | ⬜ After Phase 6 |

**Before anything else:** Re-deploy edge functions (Phase 2) to staging and production — the new CORS, rate limiting, and validation code is not live until that's done.

**Phases 5–6 must be sequential** (Phase 6 depends on extracted utilities from Phase 5).

**Phases 7–8 are independent** of each other once Phase 6 is complete.

---

## Critical Files

| File | Phases Touching It |
|---|---|
| `src/backend.ts` | 1, 7 |
| `src/App.tsx` | 1, 3, 5, 6, 7 |
| `src/main.tsx` | 3 |
| `src/types.ts` | 5 |
| `src/utils.ts` | 5, 8 |
| `src/hooks/useClock.ts` | 3 (new) |
| `src/hooks/useAppSync.ts` | 5 (new) |
| `src/ErrorBoundary.tsx` | 3 (new) |
| `src/panels/*.tsx` | 6 (new) |
| `src/components/*.tsx` | 6 (new) |
| `supabase/functions/_shared/cors.ts` | 2 |
| `supabase/functions/_shared/rateLimit.ts` | 2 (new) |
| `supabase/functions/resolve-login-email/index.ts` | 2 |
| `supabase/functions/admin-*/index.ts` (all 4) | 2 |
| `supabase/functions/change-own-password/index.ts` | 7 (new) |
| `public/_headers` | 4 (new) |