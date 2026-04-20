# Deployment Rules — BreakPerfect Gaming Lounge Management App

## Overview

This app runs across three environments. Each is completely isolated — a change in one cannot affect another unless explicitly deployed.

```
Local Dev  →  Staging  →  Production
```

| Environment | Cloudflare Worker | Supabase Project | URL |
|---|---|---|---|
| Local Dev | (none — runs on localhost) | Staging Supabase | http://localhost:5173 |
| Staging | `gp-management-staging-pages` | Staging Supabase | `*.workers.dev` (staging name) |
| Production | `management` | Production Supabase | https://management.breakperfectgaminglounge.workers.dev |

---

## Environment Files

Three files live on your local machine only. **None of these are committed to GitHub.**

| File | Points to | Purpose |
|---|---|---|
| `.env.local` | Staging Supabase | Used by `npm run dev` (local development) |
| `.env.staging` | Staging Supabase | Used by `npm run deploy:staging` |
| `.env.production` | Production Supabase | Used by `npm run deploy:production` |

Each file contains two variables:
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

> **If these files are ever lost**, retrieve the values from the Supabase Dashboard → Project Settings → API.

---

## Supabase Projects

| Project | Ref | Purpose |
|---|---|---|
| Staging | `tkbdyzxwwbhkpztgjjxh` | Development and testing. Safe to break. |
| Production | `rrdwbxvuwrbxefarxnse` | Live app. Real customer data. Handle with care. |

Each project has its own:
- Database (separate data, no overlap)
- Auth users (separate login credentials)
- Edge functions (deployed independently)
- Secrets (`ALLOWED_ORIGIN` set per-project)

---

## The Golden Rule

> **A push to GitHub never touches production.**

Production is deployed only by running `npm run deploy:production` manually on a machine that has `.env.production`. There is no automated pipeline connected to the production worker.

---

## Development Workflow

```
Local Dev → Local Test → GitHub Push → Deploy to Staging → Client Test → Deploy to Production
     ↑                                        |                  |
     └────────────────────────────────────────┘                  |
              (if test fails, return to step 1)                   |
     ↑                                                            |
     └────────────────────────────────────────────────────────────┘
              (if client rejects, return to step 1)
```

### Gate 1 — Local Dev + Local Test *(before any push)*
```bash
npm run dev
```
- Runs at `http://localhost:5173`
- Uses `.env.local` → connects to **staging** Supabase
- Test the full golden path before pushing: login → start session → add inventory → close bill → view reports → log out
- **Only push to GitHub once local testing passes**
- If something fails, fix it here — do not push broken code

### Gate 2 — Push to GitHub + Deploy to Staging
```bash
git add .
git commit -m "your message"
git push origin main

# Then deploy to staging manually:
npm run deploy:staging
```
- Push to GitHub first (version control), then deploy staging as an explicit command
- **GitHub push does NOT auto-deploy staging** — `npm run deploy:staging` is always required
- Test at the staging URL, then share with client for approval
- **If staging test fails → return to Gate 1**
- **If client rejects → return to Gate 1**

### Gate 3 — Deploy to Production *(only after client approval)*
```bash
npm run deploy:production
```
- Builds using `.env.production` (production Supabase credentials baked in)
- Deploys to the `management` Cloudflare Worker
- **Only run after explicit client sign-off on staging**
- Requires `.env.production` to exist on your machine

---

## Deploy Scripts Reference

| Command | What it does |
|---|---|
| `npm run dev` | Start local dev server (staging Supabase) |
| `npm run build` | Build with default env (for local preview only) |
| `npm run deploy:staging` | Build with staging credentials → deploy to staging worker |
| `npm run deploy:production` | Build with production credentials → deploy to production worker |

---

## Edge Functions (Supabase)

There are 5 edge functions. They must be deployed separately to each Supabase project.

**Functions:**
- `resolve-login-email` — maps username → email for login (no JWT required)
- `admin-create-user` — creates a new staff account
- `admin-update-user` — updates name, username, or role
- `admin-change-password` — resets any user's password
- `admin-toggle-user-active` — enables or disables a user account

### Deploying Edge Functions to Staging
```bash
npx supabase link --project-ref tkbdyzxwwbhkpztgjjxh
npx supabase functions deploy resolve-login-email --no-verify-jwt
npx supabase functions deploy admin-create-user --no-verify-jwt
npx supabase functions deploy admin-update-user --no-verify-jwt
npx supabase functions deploy admin-change-password --no-verify-jwt
npx supabase functions deploy admin-toggle-user-active --no-verify-jwt
```

### Deploying Edge Functions to Production
```bash
npx supabase link --project-ref rrdwbxvuwrbxefarxnse
npx supabase functions deploy resolve-login-email --no-verify-jwt
npx supabase functions deploy admin-create-user --no-verify-jwt
npx supabase functions deploy admin-update-user --no-verify-jwt
npx supabase functions deploy admin-change-password --no-verify-jwt
npx supabase functions deploy admin-toggle-user-active --no-verify-jwt
```

> Edge functions only need to be redeployed if you change files inside `supabase/functions/`. Regular app changes (UI, logic in `src/`) do not require redeploying functions.

---

## Secrets (ALLOWED_ORIGIN)

Each Supabase project has an `ALLOWED_ORIGIN` secret that restricts which domain can call edge functions. Set via Supabase Dashboard → Edge Functions → Manage Secrets.

| Project | ALLOWED_ORIGIN value |
|---|---|
| Staging | `https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev,http://localhost:4173` |
| Production | `https://management.breakperfectgaminglounge.workers.dev` |

If you ever change the Cloudflare Worker name or add a custom domain, update this secret.

---

## Database Schema

The production database schema lives in three SQL files in the `supabase/` folder. Run them in this order when setting up a new Supabase project:

1. `supabase/schema.sql` — tables, RLS policies, functions, realtime
2. `supabase/add-app-state-version.sql` — adds version column to app_state
3. `supabase/fix-rls-recursion.sql` — fixes RLS infinite recursion

---

## Migrating Configuration to a New Production Environment

If you ever need to set up a fresh production instance (new Supabase project):

1. Export current `app_state` data from the old project:
   ```sql
   SELECT data FROM app_state WHERE id = 'primary';
   ```

2. Strip transactional data (bills, sessions, payments, customers, audit logs) — keep only:
   - `stations`, `pricingRules`, `inventoryItems`, `inventoryCategories`
   - `businessProfile`, `expenseTemplates`

3. Import into the new project:
   ```sql
   UPDATE public.app_state
   SET data = '<cleaned json>'::jsonb, version = 1
   WHERE id = 'primary';
   ```

A pre-built seed file for the current production configuration is saved at:
`production-seed.sql` (gitignored — kept locally only)

---

## Checklist: Before Every Production Deploy

- [ ] Feature tested locally (`npm run dev`)
- [ ] Changes pushed to GitHub and tested on staging URL
- [ ] No active sessions running on production (avoid mid-session disruption)
- [ ] `.env.production` exists on this machine
- [ ] Run `npm run deploy:production`
- [ ] Verify login works on production URL after deploy
- [ ] Verify a station session can be started and billed

---

## Checklist: After Schema Changes

If you modify `supabase/schema.sql` or add a new migration file:

- [ ] Test the SQL on staging first (Supabase Dashboard → SQL Editor)
- [ ] Deploy edge functions to staging if functions were changed
- [ ] Run full smoke test on staging
- [ ] Apply the same SQL to production (Supabase Dashboard → SQL Editor)
- [ ] Deploy edge functions to production if needed
- [ ] Run `npm run deploy:production`

---

## Emergency: Admin Password Reset

If the production admin password is lost:

1. Supabase Dashboard → production project → Authentication → Users
2. Find `admin@breakperfect.internal`
3. Click ⋯ → Change password
4. Log in at the production URL with username `admin` and the new password

---

## Emergency: Production App Down

If the production URL returns an error:

1. Check Cloudflare Dashboard → Workers → `management` → check deployment status
2. Check Supabase Dashboard → production project → check if project is paused (free tier pauses after inactivity)
   - If paused: click "Restore project" — takes ~2 minutes
3. If a bad deploy caused the issue:
   ```bash
   # Roll back by redeploying the last known good build
   git log --oneline   # find the last good commit
   git checkout <commit-hash>
   npm run deploy:production
   git checkout main
   ```

---

## File Structure Reference

```
Gaming/
├── src/                        # React app source
├── supabase/
│   ├── functions/              # Edge functions (Deno)
│   │   ├── _shared/            # Shared helpers (cors, admin, rateLimit)
│   │   ├── resolve-login-email/
│   │   ├── admin-create-user/
│   │   ├── admin-update-user/
│   │   ├── admin-change-password/
│   │   └── admin-toggle-user-active/
│   ├── schema.sql              # Full DB schema — run on new projects
│   ├── add-app-state-version.sql
│   ├── fix-rls-recursion.sql
│   └── config.toml             # Edge function JWT settings
├── public/
│   └── _headers                # Cloudflare security headers
├── wrangler.jsonc              # Cloudflare Workers config
├── .env.local                  # ← NOT in git. Local dev credentials.
├── .env.staging                # ← NOT in git. Staging credentials.
├── .env.production             # ← NOT in git. Production credentials.
├── .gitignore
├── package.json
└── deploymentrules.md          # This file
```
