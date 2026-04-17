# Development Workflow — BreakPerfect Gaming Lounge Management App

## The Core Rule

> **Finish it completely in local. Prove it works in staging. Only then touch production.**

A half-done feature never goes to staging. Staging is not a development environment — it is a dress rehearsal for production. Production only receives code that has already passed the full staging test.

---

## The Three-Gate Model

```
Local Dev  ──(all work done, self-tested)──►  Staging  ──(smoke test passes)──►  Production
```

Each gate has a hard stop. You cannot skip gates, and you cannot pass a gate with known failures.

| Gate | Question to answer | Who decides |
|---|---|---|
| Local → Staging | "Is the feature complete and does it work on my machine?" | You |
| Staging → Production | "Did a full smoke test pass on staging with no errors?" | You |
| Production deploy | "Is there no active customer session running right now?" | You |

---

## Stage 1 — Local Development

**Command:** `npm run dev`
**Points to:** Staging Supabase (safe data, no real customers)

### What to do here
- Write all code changes
- Fix all TypeScript errors (`tsc -b` must pass clean)
- Fix all build errors (`npm run build` must pass clean)
- Test every code path you touched — happy path, edge cases, error states
- Test on multiple screen sizes if the change touches UI
- Test all related flows, not just the one you changed

### Rules
- Do NOT push to GitHub until **all** work for the current task is complete
- Do NOT push with TypeScript errors, even if they are in unrelated files
- Do NOT push with console errors or React warnings from your new code
- A partial feature stays on your machine until it is 100% done

### Definition of "done" for Local
- [ ] All intended functionality works as expected
- [ ] No TypeScript errors (`tsc -b` clean)
- [ ] No build errors (`npm run build` clean)
- [ ] No runtime console errors from new code
- [ ] Edge cases handled (empty states, invalid input, network failure if applicable)
- [ ] The change does not break any adjacent feature you can test locally

---

## Stage 2 — Staging

**Command:** `git push origin main`
**Points to:** Staging Supabase, staging Cloudflare Worker
**URL:** `https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev`

Pushing to GitHub automatically triggers a Cloudflare build and deploys to the staging worker. This is the only automated deployment in the system.

### What to do here
Run the full smoke test (see below). This is not optional. The point of staging is to catch anything that worked on your machine but breaks in the real built environment (env variables, bundling, edge function calls, auth, realtime).

### Full Smoke Test Checklist
- [ ] Open the staging URL in a fresh browser (no cached state)
- [ ] Log in with valid credentials → dashboard loads
- [ ] Hard-refresh (`Ctrl+F5`) → still on dashboard, not redirected to login
- [ ] Log out → login screen appears
- [ ] Log back in → dashboard loads again
- [ ] Start a station session → timer counts up
- [ ] Add an inventory item to the session
- [ ] End the session → bill generated correctly
- [ ] Collect payment → bill marked paid
- [ ] Check dashboard metrics update
- [ ] If the change touched a specific feature → test that feature end-to-end
- [ ] Check browser console for errors → must be clean
- [ ] Check Network tab → no failed API requests

### Rules
- If the smoke test fails at any step — fix in local, push again, re-run the full smoke test from the top
- Do not deploy to production until you complete the full smoke test with zero failures in one run
- If you find a bug during staging testing that is unrelated to your current task — note it, do not fix it in this branch. Fix it in a separate task.

### Definition of "done" for Staging
- [ ] Full smoke test passed from top to bottom with no failures
- [ ] Feature-specific tests passed
- [ ] No console errors
- [ ] No failed network requests

---

## Stage 3 — Production

**Command:** `npm run deploy:production` (run manually in your terminal)
**Points to:** Production Supabase, production Cloudflare Worker
**URL:** `https://management.breakperfectgaminglounge.workers.dev`

This is never automatic. It requires `.env.production` on your machine and a deliberate manual command.

### Pre-Deploy Checklist
- [ ] Staging smoke test fully passed (Stage 2 complete)
- [ ] No active customer sessions on production right now (avoid mid-session disruption)
- [ ] `.env.production` file exists on this machine
- [ ] You are on the `main` branch and it is up to date

### Deploy
```bash
npm run deploy:production
```

### Post-Deploy Verification (do this immediately after every production deploy)
- [ ] Open `https://management.breakperfectgaminglounge.workers.dev`
- [ ] Log in → dashboard loads
- [ ] Hard-refresh → still logged in
- [ ] Start and end one test station session
- [ ] Confirm billing works

### If Something Breaks After Deploy
See the rollback procedure in `deploymentrules.md` — Emergency: Production App Down section.

---

## How to Approach Any Task

### For a Bug Fix
1. Reproduce the bug locally using `npm run dev`
2. Fix it
3. Confirm the bug is gone
4. Confirm you haven't broken anything adjacent
5. Push to GitHub → wait for staging build → run smoke test
6. Deploy to production

### For a New Feature
1. Build the entire feature locally — all states, all edge cases, all error handling
2. Only push when the feature is 100% complete — no "I'll add validation later"
3. Push to GitHub → staging smoke test
4. Deploy to production

### For a Refactor (code cleanup, moving files, renaming)
1. Refactor locally
2. Run `tsc -b` and `npm run build` — must be clean
3. Test every feature that touches the refactored code
4. Push → staging smoke test — pay extra attention because refactors silently break things
5. Deploy to production

### For an Edge Function Change
Edge functions (in `supabase/functions/`) must be deployed separately — they are not part of the Cloudflare deploy.

1. Make your changes locally
2. Deploy the changed function(s) to **staging** Supabase:
   ```bash
   npx supabase link --project-ref tkbdyzxwwbhkpztgjjxh
   npx supabase functions deploy <function-name> --no-verify-jwt
   ```
3. Test the function on staging (login, user management, etc.)
4. Push app code to GitHub → staging smoke test
5. If all passes → deploy function(s) to **production** Supabase:
   ```bash
   npx supabase link --project-ref rrdwbxvuwrbxefarxnse
   npx supabase functions deploy <function-name> --no-verify-jwt
   ```
6. Run `npm run deploy:production`
7. Post-deploy verification

### For a Database Schema Change
Schema changes are the most risky — they cannot be automatically rolled back.

1. Write the SQL change
2. Run it on **staging** first via Supabase Dashboard → SQL Editor
3. Test all features that touch the changed tables on staging
4. Only apply to production SQL Editor when staging passes
5. Then deploy the app and edge functions

Full checklist in `deploymentrules.md` → "Checklist: After Schema Changes"

---

## Ongoing Improvement Work (Refactor Plan)

The full improvement roadmap lives in `plan.md` in this repo. Current status:

| Phase | What | Status |
|---|---|---|
| 1 | Fix session/refresh bug | ✅ Done |
| 2 | CORS + rate limiting + input guards | 🔧 Code done, re-deploy edge functions |
| 3 | Error boundaries + re-render fix | ✅ Done |
| 4 | Cloudflare security headers | ✅ Done |
| 5 | Extract types, utils, hooks from App.tsx | ⬜ Pending |
| 6 | Decompose App.tsx into feature panels | ⬜ Pending |
| 7 | Loading skeleton + UX validation | ⬜ Pending |
| 8 | Tests + linting | ⬜ Pending |

### How to work through the phases
- Complete one phase fully (all tasks in it) in local before pushing
- Each phase is one PR / one push to GitHub
- Phases 1–4 can go together in one push (they are small and non-breaking)
- Phase 5 must go before Phase 6 (Phase 6 depends on Phase 5 extractions)
- Phases 7 and 8 are independent of each other once Phase 6 is done
- After each phase: staging smoke test → production deploy → verify

---

## What Never Goes Directly to Production

| Action | Why |
|---|---|
| Push to GitHub | GitHub only deploys to staging, never production |
| Untested code | Staging gate exists for a reason |
| Partial features | Incomplete work breaks real users |
| Schema changes without staging test | SQL is not easily reversible |
| Deploys during active sessions | Mid-session reload can lose customer data |

---

## Quick Reference

```
Starting work:
  npm run dev                         → local dev against staging Supabase

Work complete, ready for staging:
  git add <files>
  git commit -m "description"
  git push origin main                → auto-deploys to staging worker

Staging tests pass, ready for production:
  npm run deploy:production           → builds with production credentials, deploys

Edge function changed:
  npx supabase link --project-ref <staging-ref>
  npx supabase functions deploy <name> --no-verify-jwt
  [test on staging]
  npx supabase link --project-ref <production-ref>
  npx supabase functions deploy <name> --no-verify-jwt
  npm run deploy:production
```

---

*See `deploymentrules.md` for credentials, project refs, emergency procedures, and schema migration steps.*
*See `architect.md` for how the system is built and why it is designed the way it is.*
