# Architecture — BreakPerfect Gaming Lounge Management App

## Table of Contents
1. [Tech Stack](#tech-stack)
2. [High-Level Architecture](#high-level-architecture)
3. [Frontend Architecture](#frontend-architecture)
4. [Data Model](#data-model)
5. [Backend Architecture](#backend-architecture)
6. [Authentication Flow](#authentication-flow)
7. [Data Sync Architecture](#data-sync-architecture)
8. [Pricing Engine](#pricing-engine)
9. [Billing Model](#billing-model)
10. [Security Model](#security-model)
11. [Local vs Staging vs Production](#local-vs-staging-vs-production)
12. [Key Design Decisions](#key-design-decisions)
13. [Known Technical Debt](#known-technical-debt)

---

## Tech Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| UI Framework | React | 19 | Component rendering |
| Language | TypeScript | 5.8 | Type safety across the full codebase |
| Build Tool | Vite | 6.3 | Dev server + production bundling |
| Database + Auth | Supabase (PostgreSQL) | JS v2 | Data persistence, user auth, realtime |
| Server Functions | Supabase Edge Functions (Deno) | — | Protected admin operations |
| Hosting | Cloudflare Workers (Static Assets) | — | CDN + global edge delivery |
| PDF Generation | jsPDF | 2.5 | Receipt and report PDFs |
| Excel Export | SheetJS (xlsx) | 0.18 | Daily report spreadsheet exports |

**Infrastructure cost: ₹0** — Supabase free tier + Cloudflare Workers free tier.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────┐
│              User's Browser                      │
│                                                  │
│   React SPA (compiled JS/CSS/HTML)               │
│   Served from Cloudflare Workers (CDN edge)      │
└──────────────┬───────────────────────────────────┘
               │  HTTPS
               │
       ┌───────▼────────┐
       │   Supabase     │
       │                │
       │  ┌──────────┐  │
       │  │ Auth     │  │  ← Login, sessions, JWT tokens
       │  └──────────┘  │
       │  ┌──────────┐  │
       │  │ Database │  │  ← profiles + app_state tables
       │  │(Postgres)│  │
       │  └──────────┘  │
       │  ┌──────────┐  │
       │  │ Realtime │  │  ← Live sync across browser tabs
       │  └──────────┘  │
       │  ┌──────────┐  │
       │  │  Edge    │  │  ← Admin-only operations (Deno)
       │  │Functions │  │
       │  └──────────┘  │
       └────────────────┘
```

The app is a **client-rendered single-page application**. There is no traditional backend server. All business logic runs in the browser. Supabase provides the database, authentication, and server functions.

---

## Frontend Architecture

### File Structure

```
src/
├── App.tsx              # Root component — state, event handlers, modal orchestration
├── main.tsx             # Entry point — mounts App inside ErrorBoundary
├── ErrorBoundary.tsx    # React class component — catches rendering crashes
├── backend.ts           # All Supabase communication (auth + data)
├── types.ts             # All TypeScript interfaces and types
├── utils.ts             # Pure utility functions (formatting, date, math)
├── pricing.ts           # Session charge calculation engine
├── billing.ts           # Pure billing/payment logic (checkout, settlement, validation)
├── exporters.ts         # PDF and Excel export logic
├── storage.ts           # localStorage read/write + AppData hydration
├── styles.css           # Global CSS (rem-based, 80% root font-size)
├── hooks/
│   ├── useClock.ts      # 1-second interval clock hook
│   └── useAppSync.ts    # Supabase realtime + debounced save hook
├── components/
│   ├── Modal.tsx
│   ├── MetricCard.tsx
│   ├── NumericInput.tsx
│   ├── LoginScreen.tsx
│   ├── AppLoadingScreen.tsx
│   ├── LoadingOverlay.tsx
│   └── CustomerAutocompleteFields.tsx
└── panels/
    ├── DashboardPanel.tsx
    ├── SalePanel.tsx
    ├── BillRegisterPanel.tsx
    ├── InventoryPanel.tsx
    ├── ReportsPanel.tsx
    ├── CustomersPanel.tsx
    ├── SettingsPanel.tsx
    └── UsersPanel.tsx
```

### Component Structure

The entire UI lives in `App.tsx` as a single component tree. It renders different "panels" based on the active tab, controlled by `activeTab` state.

```
<ErrorBoundary>           ← catches any render crash, shows recovery UI
  <App>
    ├── <AppLoadingScreen>    ← shown during session restore on page load
    ├── <LoginScreen>         ← shown when no active session
    └── App Shell
        ├── Sidebar
        │   ├── Brand/Logo
        │   ├── Nav buttons (tabs)
        │   └── User card + logout
        └── Main Content
            ├── DashboardPanel    (activeTab = "dashboard")
            ├── SalePanel         (activeTab = "sale")
            ├── BillRegisterPanel (activeTab = "bills")
            ├── InventoryPanel    (activeTab = "inventory")
            ├── ReportsPanel      (activeTab = "reports")   [renamed from "Analytics"]
            ├── CustomersPanel    (activeTab = "customers")
            ├── SettingsPanel     (activeTab = "settings")
            └── UsersPanel        (activeTab = "users")
```

### State Management

There is **no external state library** (no Redux, no Zustand). All state is managed with React's built-in `useState` and `useEffect`.

The entire application state is one large object:

```typescript
const [appData, setAppData] = useState<AppData>(...)
```

`AppData` contains all entities: stations, sessions, bills, inventory, customers, expenses, audit logs — everything. When any entity changes, the entire `AppData` object is replaced with a new copy (immutable update pattern).

---

## Data Model

### Database Tables (Supabase)

Only **two tables** exist in the database.

#### `profiles` table
Stores staff user accounts. Linked 1:1 to Supabase Auth users.

```sql
profiles (
  id uuid PRIMARY KEY          -- same UUID as auth.users.id
  username text UNIQUE         -- what staff type to log in (e.g. "admin")
  auth_email text UNIQUE       -- internal email, never shown to users
  name text                    -- display name
  role app_role                -- "admin" | "manager" | "receptionist"
  active boolean               -- false = account disabled, login rejected
  created_at / updated_at
)
```

#### `app_state` table
Stores the **entire application data** as a single JSON blob.

```sql
app_state (
  id text PRIMARY KEY          -- always "primary" (single row)
  data jsonb                   -- ALL app data: stations, bills, inventory...
  version integer              -- optimistic concurrency counter
  updated_at timestamptz
  updated_by uuid              -- which user last saved
)
```

### The AppData JSON Shape

The `data` column in `app_state` is a JSON object with these top-level arrays:

```
AppData {
  users[]              ← staff accounts (loaded from profiles table, not here)
  businessProfile      ← name, address, phone, receipt footer
  stations[]           ← gaming stations (Arcade 1, Snooker Star Table, etc.)
  pricingRules[]       ← day/night rates per timed station
  inventoryItems[]     ← catalog of sellable items with stock levels
  inventoryCategories  ← list of category names
  sessions[]           ← all gaming sessions (active and closed)
  sessionPauseLogs[]   ← pause/resume events linked to sessions
  customerTabs[]       ← walk-in counter orders (not linked to a session)
  customers[]          ← customer profiles (name, phone, visit history)
  bills[]              ← issued invoices
  payments[]           ← payment records linked to bills
  stockMovements[]     ← inventory stock change history
  expenses[]           ← operational expenses (rent, supplies, etc.)
  expenseTemplates[]   ← recurring expense definitions
  auditLogs[]          ← who did what and when
}
```

> **Note:** `users` are intentionally NOT stored in the `data` column. They are loaded separately from the `profiles` table and merged into `AppData` in memory. This prevents user credentials from ever appearing in the JSON blob.

### Versioned Optimistic Concurrency

When saving, the app sends:
```
UPDATE app_state SET data = ?, version = current + 1
WHERE id = 'primary' AND version = current
```

If another tab saved first, the `WHERE version = current` clause matches nothing — the save returns no rows — and the app detects the conflict and shows an error rather than silently overwriting.

---

## Backend Architecture

### Supabase Edge Functions (Deno)

Five server-side functions handle operations that require admin-level database access. They run on Deno (not Node.js) inside Supabase's infrastructure.

```
supabase/functions/
├── _shared/
│   ├── cors.ts         # Multi-origin CORS header builder
│   ├── admin.ts        # JWT verification + Supabase admin client creation
│   └── rateLimit.ts    # In-process sliding window rate limiter
├── resolve-login-email/   # Maps username → email (called before login)
├── admin-create-user/     # Creates new staff account
├── admin-update-user/     # Changes name, username, or role
├── admin-change-password/ # Resets any user's password
└── admin-toggle-user-active/  # Enables or disables an account
```

#### Why Edge Functions exist

The Supabase client library exposes a **service role key** which bypasses all Row Level Security policies and can do anything. This key must never be sent to the browser. Edge Functions run server-side with this key, so they can:
- Create/delete auth users
- Update any row regardless of RLS policies
- Enforce business rules (e.g. "can't disable the last admin")

#### `_shared/admin.ts` — The auth guard

Every admin function calls `requireAdmin(request)` first. This:
1. Reads the `Authorization: Bearer <token>` header
2. Verifies the JWT against Supabase
3. Looks up the caller's profile and confirms `role = 'admin'`
4. Returns an `adminClient` (service role) only if all checks pass

#### `_shared/rateLimit.ts` — Brute force protection

An in-memory sliding window limiter on `resolve-login-email`. Limits each IP to 10 login attempts per 60 seconds. Since Supabase Edge Functions run in isolates (not a persistent server), this is per-isolate — effective against naive brute force, not a distributed attack. Best available option on the free tier.

---

## Authentication Flow

Users log in with a **username** (not email). Supabase Auth requires email. The flow bridges this gap:

```
1. User types username + password

2. Browser calls resolve-login-email edge function
   → Looks up profiles table: SELECT auth_email WHERE username = ?
   → Returns the internal email (e.g. "admin@breakperfect.internal")
   → Rate limited: 10 attempts / 60 seconds per IP

3. Browser calls supabase.auth.signInWithPassword(email, password)
   → Supabase verifies credentials
   → Returns a session (JWT access token + refresh token)

4. Session is stored in localStorage (persistSession: true)
   → survives page refresh

5. Browser looks up profiles table with the auth user's UUID
   → Confirms account is active (active = true)
   → Loads name, role, display info

6. On every subsequent page load:
   → supabase.auth.getSession() reads token from localStorage
   → If valid and not expired, session is restored silently
   → autoRefreshToken: true keeps the session alive automatically
```

---

## Data Sync Architecture

### How data flows between browser and database

```
App starts
    │
    ▼
Restore session from localStorage (no network call)
    │
    ▼
Load app_state from Supabase (single SELECT)
Load profiles from Supabase (single SELECT)
    │
    ▼
Merge into AppData → render UI
    │
    ▼
User makes a change (e.g. starts a session)
    │
    ▼
State updated immediately in React (optimistic)
    │
    ▼ (debounced 1.2 seconds)
    ▼
Save to Supabase (UPDATE app_state SET data = ?, version = current + 1
                  WHERE version = current)
    │
    ├─ Success → update local version counter
    └─ Conflict → show error banner "Data changed in another tab"
```

### Realtime sync across tabs

```
Supabase Realtime listens on app_state table for any UPDATE event
    │
    ▼
Another browser tab saves a change
    │
    ▼
Supabase broadcasts the change to all subscribers
    │
    ▼
This tab receives the notification
    │
    ▼
Fetches fresh app_state from database
    │
    ▼
Updates local React state → UI re-renders with latest data
```

This means two staff members on different machines will see each other's actions within ~1 second.

### The `skipRemotePersistRef` flag

When the app loads fresh data from Supabase, it sets `AppData` state — which would normally trigger a debounced save back to Supabase (creating a pointless write loop). The `skipRemotePersistRef` ref is set to `true` when loading data to suppress this.

---

## Pricing Engine

The pricing engine (`src/pricing.ts`) calculates session charges for timed stations.

### How it works

Each timed station has **pricing rules** — time windows with hourly rates:

```
Example: Snooker Star Table
  Day rate:   ₹400/hr  (10:00 AM – 9:00 PM, minute 600 to 1260)
  Night rate: ₹500/hr  (9:00 PM – 10:00 AM, minute 1260 to 600)
```

When a session closes, the engine:
1. Takes the session's start and end timestamps
2. Subtracts all pause intervals (paused time is free)
3. Splits remaining time into segments at rate-change boundaries
4. Multiplies each segment's duration by its applicable hourly rate
5. Sums all segments → total charge

```
Example: 2-hour session crossing a rate boundary
  7:00 PM – 9:00 PM
  Segment 1: 7:00–9:00 PM = 2 hrs × ₹400 (Day) = ₹800
  → Total: ₹800

  If session ran 8:00 PM – 10:00 PM:
  Segment 1: 8:00–9:00 PM = 1 hr × ₹400 (Day)  = ₹400
  Segment 2: 9:00–10:00 PM = 1 hr × ₹500 (Night) = ₹500
  → Total: ₹900
```

### Pricing snapshot

When a session starts, the current pricing rules are **copied into the session** as `pricingSnapshot`. This means pricing rule changes don't retroactively affect in-progress sessions — the rate a customer was quoted at the start is the rate they're charged.

---

## Billing Model

A bill is generated when a session closes or a customer tab is settled.

### Bill structure

```
Bill
├── lines[]               ← what was charged
│   ├── type: "session_charge"    (timed station usage)
│   ├── type: "inventory_item"    (food/drinks/coins sold)
│   └── type: "manual_charge"     (ad-hoc item)
│
├── lineDiscounts[]        ← discounts on individual line items
│   └── { type: "amount"|"percentage", value, reason }
│
├── billDiscount           ← single discount on the whole bill total
│
├── subtotal               ← sum of all line subtotals (before discounts)
├── totalDiscountAmount    ← sum of all discounts
├── roundOffAmount         ← small adjustment to reach a round number
└── total                  ← what the customer actually pays
```

### Payment modes

| Mode | Meaning |
|---|---|
| `cash` | Full amount paid in cash |
| `upi` | Full amount paid via UPI |
| `split` | Amount split between cash and UPI (must sum to total) |
| `deferred` | Pay-later — customer may pay a partial upfront amount; remainder tracked as a pending debt |

### Bill statuses

| Status | Meaning |
|---|---|
| `issued` | Fully paid bill |
| `pending` | Deferred bill with outstanding balance (`amountDue > 0`) |
| `voided` | Cancelled (stock is reversed for issued bills; for pending bills written off as bad debt, stock is NOT reversed since goods were already consumed) |
| `refunded` | Money returned to customer |
| `replaced` | Superseded by a corrected replacement bill |

### Pending bill tracking

Bills with `paymentMode = "deferred"` may have a partial upfront payment collected at checkout. The bill is saved with:
- `amountPaid` — amount collected so far
- `amountDue` — remaining balance (= `total - amountPaid`)
- `status = "pending"` — until fully settled

When a pending bill is settled (partially or fully), a new `Payment` record is created and `amountPaid`/`amountDue` are updated. Full settlement sets `status = "issued"` and stamps `settledAt` + `settledByUserId` on the bill.

Admins can write off a pending bill as bad debt (sets `status = "voided"` with a required reason). Stock is intentionally not reversed.

The pure billing logic (validation, payment record construction, settlement computation) lives in `src/billing.ts` and is covered by unit tests.

### Stock deduction

When a bill is issued, each `inventory_item` line deducts from `stockQty` and creates a `StockMovement` record. If a bill is voided, a `void_refund_reversal` movement adds the stock back. Pending bills written off as bad debt do **not** reverse stock.

---

## Security Model

### Row Level Security (RLS)

Both database tables have RLS enabled. The policies use a helper function `current_profile_is_active()` which checks if the calling auth user has an active profile.

```
profiles table:
  SELECT → any authenticated user with an active profile can read all profiles

app_state table:
  SELECT → any authenticated + active user
  UPDATE → any authenticated + active user
  INSERT/DELETE → blocked (only one row ever exists, seeded at schema creation)
```

Disabled users (active = false) cannot read data — the RLS function returns false for them, blocking all queries.

### Edge Function Security

- All functions check request size (max 4096 bytes) to prevent payload attacks
- Admin functions verify the caller's JWT and confirm `role = 'admin'` before doing anything
- `resolve-login-email` is rate-limited per IP (10 req/min)
- Passwords are validated server-side (minimum 8 characters)
- CORS is restricted to known origins via `ALLOWED_ORIGIN` environment secret

### Local mode password storage

In local mode (no Supabase), passwords are hashed using **PBKDF2** (SubtleCrypto, SHA-256, 100 000 iterations, random 16-byte salt) before being stored in `localStorage`. The stored format is `pbkdf2:<base64salt>:<base64hash>`. Login uses async comparison via `verifyPassword()`. Backward compatibility is maintained: if a stored password does not start with `pbkdf2:`, it is compared as plaintext (for any passwords created before the hashing was introduced).

### What is NOT protected

- The Supabase `anon` key is embedded in the built JavaScript bundle (this is by design and expected — it is not a secret, just a public identifier)
- The database schema and table names are discoverable by anyone with the anon key
- RLS is the actual protection layer, not the anon key

---

## Local vs Staging vs Production

| Aspect | Local Dev | Staging | Production |
|---|---|---|---|
| **URL** | `http://localhost:5173` | `*.workers.dev` (staging) | `https://management.breakperfectgaminglounge.workers.dev` |
| **Supabase project** | Staging project | Staging project | Production project |
| **Database data** | Staging data (test/real mix) | Staging data | Real customer data |
| **Auth users** | Staging users | Staging users | Production users (separate accounts) |
| **Edge functions** | Calls staging Supabase functions | Staging functions | Production functions (separately deployed) |
| **ALLOWED_ORIGIN secret** | `...,http://localhost:4173` | Staging worker URL | Production worker URL |
| **How to deploy** | `npm run dev` | `npm run deploy:staging` (manual, after `git push`) | `npm run deploy:production` (manual) |
| **Build credentials** | `.env.local` | `.env.staging` | `.env.production` |
| **Triggered by** | Developer | GitHub push | Deliberate manual action |
| **Safe to break?** | Yes | Yes | No |

### Key difference: credentials are baked in at build time

Vite reads the `.env.*` file at **build time** and embeds the Supabase URL and anon key directly into the JavaScript bundle. There is no runtime config switching — a staging build literally contains different strings than a production build.

This means:
- A staging build **cannot** connect to production, even if deployed to the same Cloudflare Worker
- A production build **cannot** connect to staging
- The only way to deploy to production is to build with `.env.production` and then deploy

### What is identical across all environments

- The application code (`src/`) is identical
- The edge function code (`supabase/functions/`) is identical
- The database schema (`supabase/schema.sql`) is identical
- The `public/_headers` security headers are identical

### What differs per environment

- **Supabase project** (different URL, different anon key, different database)
- **Cloudflare Worker name** (`gp-management-staging-pages` vs `management`)
- **`ALLOWED_ORIGIN` secret** (different per Supabase project)
- **Data** (staging has test data; production has real business data)
- **User accounts** (separate auth users in each Supabase project)

---

## Tab Permissions Model

Each user has a **role** (`admin`, `manager`, `receptionist`) that determines their default tab access, defined in `src/constants.ts`:

```
admin       → dashboard, sale, bills, inventory, reports, customers, settings, users
manager     → dashboard, sale, bills, inventory, reports, settings
receptionist → dashboard, sale, bills
```

Admins can grant **additive** extra tab access to any individual user via the Users panel. These are stored as `tabPermissions?: TabId[]` on the user record (in `app_state.data.users`). The field stores only the *extra* grants — tabs already in the role default are never stored here.

At runtime, `visibleTabs` is computed by merging role defaults with any extra grants:
```typescript
const extras = ALL_TABS.filter(t => user.tabPermissions?.includes(t.id) && !roleDefaultIds.has(t.id));
visibleTabs = [...roleTabs, ...extras];
```

Panel rendering and nav tabs both use `canAccessTab(tabId)` — a function derived from `visibleTabs`. Write-action permissions (`canEditInventory`, `canEditSettings`, etc.) remain role-gated regardless of tab grants.

In backend mode, `tabPermissions` is saved to the `app_state` JSON blob (not the `profiles` table) via `mutateAppData` after the `adminUpdateUserRemote` call completes.

---

## Key Design Decisions

### 1. Single JSON blob for all app data

**Decision:** Store all app data (stations, bills, inventory, sessions...) as one JSONB column in a single `app_state` row, rather than normalised tables.

**Why:** The app was built for a single location with one active user at a time. A single-row approach eliminates complex SQL, JOIN queries, migration management, and RLS rules for dozens of tables. The entire app state can be loaded in one query.

**Trade-off:** As data grows (many months of bills + sessions), the JSON blob gets large. Reads and writes always transfer the full dataset. This will become a performance issue eventually — the planned Phase 6 refactor will address this by either paginating history or archiving old records.

### 2. Username-based login (not email)

**Decision:** Staff log in with a short username (e.g. `admin`, `reception1`) rather than email addresses.

**Why:** Gaming parlour staff are often not tech-savvy and don't have professional email addresses. Typing `admin` is faster and less error-prone than `someone@example.com` on a shared terminal.

**How it works:** A synthetic internal email (`username@breakperfect.internal`) is created per user and stored in `profiles.auth_email`. The `resolve-login-email` function maps username → email before calling Supabase Auth.

### 3. No dedicated backend server

**Decision:** No Express, Fastify, or any other Node.js server. Supabase Edge Functions only for privileged operations.

**Why:** Zero infrastructure cost, zero maintenance of a server process. Supabase handles auth, database, and the handful of admin operations that need elevated privileges.

**Trade-off:** Complex server-side logic (e.g. scheduled jobs, webhooks) is harder to add.

### 4. Offline-capable local storage fallback

**Decision:** The app can run in "local mode" without Supabase, storing data in `localStorage`.

**Why:** Built originally as a local app, then evolved to support Supabase. The local mode still works if `.env` variables are missing — useful for demos or if internet is unavailable.

**Current state:** In production, local mode is never used. The app always connects to Supabase.

### 5. 80% root font-size for compact display

**Decision:** `html { font-size: 80%; }` is set globally. All dimensions use `rem`.

**Why:** The app is designed for a 1920×1080 monitor at a gaming parlour reception desk. The default browser font-size (16px) makes the layout too spacious — 80% gives a denser, more information-rich display that fits the full dashboard without scrolling.

---

## Known Technical Debt

These are documented gaps to address in future development phases:

| Item | Impact | Status |
|---|---|---|
| ~~`App.tsx` is ~6000 lines (one file for all UI)~~ | ~~Hard to navigate, slow to edit, hard to test~~ | ✅ Resolved — split into `src/panels/` and `src/components/` |
| ~~No automated tests~~ | ~~Regressions found manually~~ | ✅ Resolved — Vitest unit tests added (`billing.test.ts`, `pricing.test.ts`, `utils.test.ts`) |
| ~~`seed.ts` contains demo passwords in the JS bundle~~ | ~~Cosmetic (not a real credential)~~ | ✅ Resolved — `seed.ts` deleted |
| No ESLint / Prettier enforced in CI | Code style inconsistencies over time | Config files added locally; not yet enforced in CI |
| App data grows unboundedly | Large JSON blob after months of operation | Future — archive old bills/sessions |
| Rate limiter is per-isolate (not global) | Less effective against distributed brute force | Future — use Cloudflare KV for global state |
| No error tracking (Sentry etc.) | Production errors are invisible | Future — add if user base grows |
| Bill numbering resets if `app_state` is wiped | Could create duplicate bill numbers across periods | Low priority — add date prefix guard |
