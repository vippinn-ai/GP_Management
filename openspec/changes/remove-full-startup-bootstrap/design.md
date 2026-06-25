## Current State

`createNormalizedRemoteDataGateway().loadAppDataSnapshot()` still starts with:

```ts
appStateRemoteDataGateway.loadAppDataSnapshot()
```

That call fetches `public.app_state.select("id, data, version")`, including the full `data` blob. Normalized overlays then replace selected slices, but the large startup payload has already been downloaded.

The app also still has generic save and conflict-recovery paths that can call `loadAppDataSnapshot()` or `saveAppData()`. Those paths are useful for rollback, but they are unsafe if the browser starts from a partial normalized model and later writes that partial model back to `app_state`.

## Proposed Design

### Feature Flag

Add a flag such as:

```env
VITE_BACKEND_NORMALIZED_BOOTSTRAP=true
```

When disabled, startup remains unchanged.

When enabled, `loadAppDataSnapshot()` must use a normalized bootstrap loader and must not fetch `app_state.data`.

### Bootstrap Shape

Add a new data-gateway function:

```ts
loadNormalizedBootstrapSnapshot(): Promise<RemoteAppDataSnapshot>
```

The returned `AppData` must be complete enough for the first screen and common operating flows, but historical data should stay bounded:

- `users`: from profiles/current profile data
- `businessProfile`, `inventoryCategories`, `stations`, `pricingRules`: normalized config
- `inventoryItems`: normalized catalog plus sale variants
- `combos`: normalized combo tables
- `sessions`, `sessionPauseLogs`, `customerTabs`: open live rows only
- `bills`, `payments`: pending bills plus a bounded recent window required by dashboard/receivables
- `stockMovements`, `auditLogs`: empty or bounded only where a screen explicitly requires immediate display
- `expenses`, `expenseTemplates`, `expenseTemplateOverrides`: normalized expense data needed by analytics/admin

### Historical Screens

Bill register, reports, inventory report, and customer search should continue using normalized screen-specific loaders. They must not depend on full startup arrays for older history.

### Save Safety

Add an internal snapshot source marker, for example:

```ts
source: "app_state" | "normalized_bootstrap"
```

When the current snapshot source is `normalized_bootstrap`, generic full-state `saveAppData()` must be blocked unless explicitly allowed by an admin-only rollback/manual path. Operational and financial RPC writes remain allowed.

### Versioning

RPC payloads currently carry `base_app_state_version`. The normalized bootstrap still needs a lightweight version source. Acceptable options:

- read only `public.app_state.id, version, updated_at` without `data`, or
- return the latest compatibility version from a small RPC/view.

The implementation must not select `app_state.data` in normalized bootstrap mode.

### Telemetry

Startup telemetry should record:

- whether startup used `app_state` or `normalized_bootstrap`
- estimated bootstrap payload bytes by slice
- duration
- whether full `app_state.data` was skipped
- app-state compatibility version used

### Rollout

1. Implement behind the new flag.
2. Enable in staging only.
3. Hard refresh staging browsers and verify login/startup.
4. Run smoke tests across operational and financial flows.
5. Monitor staging telemetry for no full `app_state` startup reads.
6. Deploy production only after explicit approval.
