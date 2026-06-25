## 1. Discovery And Guardrails

- [ ] 1.1 Inventory every current `loadAppDataSnapshot()` call site and classify as startup, conflict recovery, checkout fallback, admin fallback, or manual refresh
- [ ] 1.2 Identify every screen still reading historical `appData` arrays directly at startup
- [ ] 1.3 Confirm normalized tables contain the data required for startup parity
- [ ] 1.4 Add explicit rollback plan before enabling the new flag anywhere

## 2. Normalized Bootstrap Loader

- [ ] 2.1 Add `VITE_BACKEND_NORMALIZED_BOOTSTRAP`
- [ ] 2.2 Add a normalized bootstrap loader that does not select `app_state.data`
- [ ] 2.3 Read only lightweight app-state metadata/version where needed
- [ ] 2.4 Load config, catalog, combos, live sessions/tabs, pending bills, recent dashboard context, and expenses from normalized tables
- [ ] 2.5 Keep historical bill/payment/stock/audit rows out of startup unless bounded by an explicit recent window

## 3. Save Safety

- [ ] 3.1 Track snapshot source as `app_state` or `normalized_bootstrap`
- [ ] 3.2 Block generic full-state app-state saves when current data came from normalized bootstrap
- [ ] 3.3 Keep operational RPC and financial RPC writes enabled
- [ ] 3.4 Ensure admin/settings/full-state fallback writes either use `app_state` startup or purpose-built RPCs

## 4. UI And Data Fallbacks

- [ ] 4.1 Ensure dashboard works from bounded normalized startup data
- [ ] 4.2 Ensure bill register uses normalized paginated history rather than startup `appData.bills`
- [ ] 4.3 Ensure reports and inventory report use normalized scoped reads
- [ ] 4.4 Ensure customer search and pending receivables do not require all historical customers/bills in startup
- [ ] 4.5 Ensure receipt/replacement/void/refund flows can load required bill rows by ID

## 5. Telemetry

- [ ] 5.1 Add startup/bootstrap telemetry samples
- [ ] 5.2 Include source, duration, slice payload sizes, skipped full app-state flag, and compatibility version
- [ ] 5.3 Add browser-console helper output for startup telemetry verification

## 6. Tests

- [ ] 6.1 Unit test normalized bootstrap does not call app-state `data` loader
- [ ] 6.2 Unit test generic app-state save is blocked after normalized bootstrap
- [ ] 6.3 Unit test operational and financial RPC writes still work after normalized bootstrap
- [ ] 6.4 Regression test dashboard, sessions, tabs, checkout, bill register, reports, inventory report, pending settlement/write-off, void/refund, replacement, and expenses
- [ ] 6.5 Run `npm test -- --run`
- [ ] 6.6 Run `npm run build`

## 7. Staging Rollout

- [ ] 7.1 Deploy staging with `VITE_BACKEND_NORMALIZED_BOOTSTRAP=true`
- [ ] 7.2 Hard refresh staging browsers
- [ ] 7.3 Confirm startup telemetry skips full `app_state.data`
- [ ] 7.4 Smoke test normal live operations and financial flows
- [ ] 7.5 Soak staging before production

## 8. Production Rollout

- [ ] 8.1 Capture production egress baseline immediately before rollout
- [ ] 8.2 Deploy production only after explicit approval
- [ ] 8.3 Require all staff browsers to hard refresh
- [ ] 8.4 Confirm startup telemetry skips full `app_state.data`
- [ ] 8.5 Monitor first business day egress and sync errors
- [ ] 8.6 Keep rollback flag ready until egress and workflow stability are proven
