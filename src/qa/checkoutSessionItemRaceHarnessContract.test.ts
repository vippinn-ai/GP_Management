import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("checkout-session-item staging race harness", () => {
  it("exposes only read-only listings and guarded exact full or remaining-two execution", () => {
    const packageJson = read("package.json");
    const runner = read("scripts/run-checkout-session-item-race-staging-e2e.mjs");
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-session-item-race"');
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-session-item-race:list"');
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-session-item-race:remaining-two"');
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-session-item-race:remaining-two:list"');
    expect(packageJson).toContain('"test:db:staging:v2:checkout-session-item-race:preflight"');
    expect(packageJson).toContain('"test:db:staging:v2:checkout-session-item-race:remaining-two:preflight"');
    expect(packageJson).toContain('"test:db:staging:v2:checkout-session-item-race:reconcile"');
    expect(runner).toContain('new Set(["--list", "--remaining-two", "--remaining-two-list"])');
    expect(runner).toContain('E2E_SESSION_ITEM_RACE_SCENARIOS = selectedScenarios.join(",")');
    expect(runner).toContain('evidence.selectedScenarios');
    expect(runner).toContain("preflight-checkout-session-item-race-staging.mjs");
    expect(runner).toContain("release-b-checkout-session-item-race-v2.e2e.ts");
  });

  it("fails closed on production, dirty floor, identity reuse, actor drift, and compatibility drift", () => {
    const source = read("scripts/preflight-checkout-session-item-race-staging.mjs");
    const adminEnv = read("scripts/session-item-race-admin-env.mjs");
    expect(source).toContain("STAGING_PROJECT_REF");
    expect(source).toContain("PRODUCTION_PROJECT_REF");
    expect(source).toContain('role.data !== "admin"');
    expect(source).toContain("openSessions.data.length === 0");
    expect(source).toContain("openTabs.data.length === 0");
    expect(source).toContain("artifactCollisions.length === 0");
    expect(source).toContain("actorsDistinct: origin.identity.actorId !== observer.identity.actorId");
    expect(source).toContain("evidence.actorsDistinct");
    expect(source).toContain("loadSessionItemRaceAdmin(root)");
    expect(source).toContain("temporaryAdmin.actorId");
    expect(source).toContain("reviewed.temporaryAdmin");
    expect(adminEnv).toContain('SESSION_ITEM_RACE_ADMIN_FILE = ".env.e2e.session-item-admin.local"');
    expect(adminEnv).toContain("STAGING_PROJECT_REF");
    expect(adminEnv).toContain("STAGING_APP_URL");
    expect(adminEnv).toContain("STAGING_MUTATION_CONFIRMATION");
    expect(adminEnv).toContain("session-item-race-admin-create-${runId}.json");
    expect(adminEnv).toContain("createArtifact.account?.actorId");
    expect(adminEnv).toContain("createArtifactSha256");
    expect(adminEnv).toContain("immutable deactivation evidence");
    expect(source).toContain("reviewed_preflight_drift");
    expect(source).toContain('flag: "wx"');
  });

  it("provisions and deactivates one exact temporary staging admin without exposing its password", () => {
    const packageJson = read("package.json");
    const manager = read("scripts/manage-session-item-race-admin-staging.mjs");
    const runner = read("scripts/run-checkout-session-item-race-staging-e2e.mjs");
    const cleanupRunner = read("scripts/run-checkout-session-item-race-cleanup-staging-e2e.mjs");
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-session-item-race:admin:create"');
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-session-item-race:admin:deactivate"');
    expect(manager).toContain('new Set(["create", "deactivate"])');
    expect(manager).toContain('selectOption("admin")');
    expect(manager).toContain('writeCredentialFile(account, "provisioning")');
    expect(manager).toContain('writeCredentialFile(account, "active")');
    expect(manager).toContain('writeCredentialFile(account, "recovery_required")');
    expect(manager).toContain('writeCredentialFile(account, "deactivation_incomplete")');
    expect(manager.indexOf('const existing = await authoritativeProfile(adminPage, adminRequest, account.username)'))
      .toBeLessThan(manager.indexOf('writeCredentialFile(account, "provisioning")'));
    expect(manager).toContain("account.actorId = candidate.id");
    expect(manager).toContain("clearPasswordFields");
    expect(manager).toContain('passwordField.fill("", { timeout: 1_000 })');
    expect(manager).toContain("sanitizedErrorMessage(error, account.password)");
    expect(manager).toContain("still exists after deletion");
    expect(manager).toContain('flag: "wx"');
    expect(manager).toContain("passwordsPrinted: false");
    expect(manager).toContain("productionAllowed: false");
    expect(runner).toContain("temporaryAdmin?.overlay");
    expect(cleanupRunner).toContain("if (recovery.temporaryAdmin)");
    expect(cleanupRunner).toContain("loadSessionItemRaceAdmin(root, { required: true })");
    expect(cleanupRunner).toContain("recovery.actors?.item !== temporaryAdmin.actorId");
  });

  it("captures each command once and binds full or remaining-two zero-retry orderings", () => {
    const source = read("tests/e2e/staging/release-b-checkout-session-item-race-v2.e2e.ts");
    expect(source).toContain('type Scenario = "checkout_first" | "item_first" | "simultaneous"');
    expect(source).toContain("allowedScenarioSelections");
    expect(source).toContain("selectedScenarioNames");
    expect(source).toContain("selectedScenarios: selectedScenarioNames");
    expect(source).toContain('"**/rest/v1/rpc/commit_checkout_bill_v2"');
    expect(source).toContain('"**/rest/v1/rpc/add_session_item"');
    expect(source).toContain("checkoutCommand.captureCount()).toBe(1)");
    expect(source).toContain("itemCommand.captureCount()).toBe(1)");
    expect(source).toContain("checkoutCommand.submit(checkoutEnvelope)");
    expect(source).toContain("itemCommand.submit(itemEnvelope)");
    expect(source).toContain("source_item_mismatch");
    expect(source).toContain("session_not_open");
    expect(source).toContain("raceDispatched && !raceReconciled");
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("await signIn(page, credentials(\"A\"))");
    expect(source).toContain("await signIn(observer.page, credentials(\"B\"))");
    expect(source).not.toContain("Promise.all([signIn(page");
    expect(source.indexOf("Promise.all([clearConflict(page), clearConflict(observer.page)])"))
      .toBeLessThan(source.indexOf("Promise.all([waitForSynced(page), waitForSynced(observer.page)])", source.indexOf("Promise.all([clearConflict(page), clearConflict(observer.page)])")));
    expect(source).toContain("stable-synced");
    expect(source).toContain("Date.now() - syncedSince >= 1_500");
    expect(source).toContain("startAcknowledgedPath");
    expect(source).toContain("saveAcknowledgedPath");
    expect(source).toContain("cleanupAcknowledgedPath");
    expect(source).toContain("archiveAcknowledgedPath");
  });

  it("binds exact bills, items, reservations, actors, mutation lookups, compatibility, and empty-floor cleanup", () => {
    const source = read("tests/e2e/staging/release-b-checkout-session-item-race-v2.e2e.ts");
    expect(source).toContain("authenticatedJwtSubject(capturedCheckout.headers)");
    expect(source).toContain("authenticatedJwtSubject(capturedItem.headers)");
    expect(source).toContain("expect(checkoutStatus).toBeNull()");
    expect(source).toContain('type: "session_reservation"');
    expect(source).toContain('action: "session_item_added"');
    expect(source).toContain('event_type: "add_session_item"');
    expect(source).toContain("expect(openSessions).toEqual([])");
    expect(source).toContain("expect(openTabs).toEqual([])");
    expect(source).toContain("appStateHash(stateAfter[0].data)");
  });

  it("classifies partial effects and provides fresh-id identity-bound cleanup plus mandatory postflight", () => {
    const packageJson = read("package.json");
    const reconciler = read("scripts/reconcile-checkout-session-item-race-staging.mjs");
    const runner = read("scripts/run-checkout-session-item-race-cleanup-staging-e2e.mjs");
    const cleanup = read("tests/e2e/staging/release-b-checkout-session-item-race-cleanup.e2e.ts");
    const postflight = read("scripts/reconcile-checkout-session-item-race-cleanup-staging.mjs");
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-session-item-race:cleanup"');
    expect(packageJson).toContain('"test:db:staging:v2:checkout-session-item-race:cleanup-postflight"');
    expect(reconciler).toContain("corruptCandidates");
    expect(reconciler).toContain("scenarioClassifications");
    expect(reconciler).toContain("safeForAutomaticRetry: false");
    expect(reconciler).toContain("safeForIdentityBoundCleanup: recoveryFailures.length === 0");
    expect(reconciler).toContain("both competing effects are present");
    expect(reconciler).toContain("Run event cardinality includes a missing or extra event");
    expect(reconciler).toContain("Lifecycle audit");
    expect(reconciler).toContain("recovery session details");
    expect(reconciler).toContain("Issued ${expected.candidateBillNumber}.");
    expect(reconciler).toContain("Updated during checkout: end time: not set -> ${endedAt}.");
    expect(reconciler).toContain("E2E_RECONCILIATION_ID is required");
    expect(runner).toContain("Cleanup E2E_RUN_ID must differ from the fixture run identity");
    expect(runner).toContain("safeForIdentityBoundCleanup !== true");
    expect(runner).toContain("collides with existing artifacts");
    expect(cleanup).toContain('checkpoint("prepared"');
    expect(cleanup).toContain('checkpoint(`reject-${action.id}-acknowledged`');
    expect(cleanup).toContain('checkpoint("archive-acknowledged"');
    expect(cleanup).toContain("expect(stable(finalLines)).toBe(stable(recovery.snapshot.lines))");
    expect(cleanup).toContain("expect(stable(finalMovements)).toBe(stable(recovery.snapshot.movements))");
    expect(cleanup).toContain('close_disposition: "rejected"');
    expect(cleanup).toContain("expect(stable(afterSession)).toBe(stable(beforeSession))");
    expect(postflight).toContain("Cleanup changed committed bill lines");
    expect(postflight).toContain("Cleanup changed committed payments");
    expect(postflight).toContain("Cleanup created or changed stock movements");
    expect(postflight).toContain("Compatibility version did not advance exactly once");
    expect(postflight).toContain("to exact closed/rejected/null-bill state");
    expect(postflight).toContain("Cleanup audit identity/type/message/actor is incorrect");
    expect(postflight).toContain("exact acknowledged and prior events");
    expect(postflight).toContain("knownEventIds");
    expect(postflight).toContain("E2E_POSTFLIGHT_ID is required");
  });
});
