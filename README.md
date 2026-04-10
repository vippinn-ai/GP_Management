# Game Parlour Management System

Production-capable web app for a single gaming parlour with:

- timed session billing with time-band pricing
- session pause/resume and live running totals
- consumables linked to sessions or sold standalone
- stock in, stock out, and manual stock adjustments
- pre-bill line and bill discounts with reasons
- manager/admin void or refund handling
- daily reports with CSV, Excel, and PDF export
- digital receipt preview and receipt window output
- local browser persistence fallback when no backend is configured
- optional Supabase-backed shared production mode for multi-device usage

## Run

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

## Backend Mode

When these environment variables are set, the app uses Supabase instead of browser-only storage:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

If they are not set, the app falls back to local browser persistence for development/demo use.

## Production Setup

1. Create a Supabase project.
2. Run [supabase/schema.sql](./supabase/schema.sql) in the SQL editor.
3. Deploy the edge functions in [supabase/functions](./supabase/functions).
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in your frontend environment.
5. Bootstrap config and users:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
node scripts/bootstrap-production.mjs scripts/production-config.sample.json
```

6. Deploy the frontend to Cloudflare Pages from GitHub.

## Seed Users

- `admin` / `admin123`
- `manager` / `manager123`
- `reception` / `reception123`

## Main Files

- `src/App.tsx`: main app shell, UI flows, and role-based actions
- `src/pricing.ts`: session pricing engine with time-band splitting
- `src/storage.ts`: local fallback persistence plus hydration helpers
- `src/backend.ts`: Supabase auth, shared app-state sync, and admin user actions
- `src/exporters.ts`: CSV, XLSX, PDF, and receipt window helpers
- `src/seed.ts`: initial stations, pricing, users, and inventory
- `supabase/schema.sql`: production database schema and RLS
- `supabase/functions/*`: backend username-login and admin user-management functions
- `scripts/bootstrap-production.mjs`: config-only production bootstrap script
