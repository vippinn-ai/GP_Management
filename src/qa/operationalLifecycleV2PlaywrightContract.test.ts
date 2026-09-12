import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("operational lifecycle v2 Playwright and performance contract", () => {
  it("locks the reusable runner to staging, the v2 dependency flags, and zero retries", () => {
    const runner = read("scripts/run-operational-v2-staging-e2e.mjs");
    const config = read("playwright.operational-v2.staging.config.ts");
    expect(runner).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(runner).toContain("VITE_BACKEND_OPERATIONAL_RPC_V2");
    expect(runner).toContain("bundle.includes(PRODUCTION_PROJECT_REF)");
    expect(runner).toContain("E2E_EXPECTED_BUNDLE_SHA256");
    expect(runner).toContain("E2E_DB_MANIFEST_SHA256");
    expect(runner).toContain("E2E_DB_PROOF_MANIFEST_SHA256");
    expect(runner).toContain("E2E_DB_PROOF_RESULT_SHA256");
    expect(runner).toContain("E2E_DB_PROOF_ROLLBACK_VERIFICATION_SHA256");
    expect(runner).toContain("rollbackProven");
    expect(runner).toContain("REQUIRED_NEGATIVE_CASES");
    expect(runner).toContain("Object.keys(proofNegativeCases).sort()");
    for (const negativeCase of [
      "missing-mutation-id",
      "missing-mutation-kind",
      "missing-entity-type",
      "same-id-different-kind",
      "same-id-different-entity",
      "same-id-different-audit"
    ]) expect(runner).toContain(negativeCase);
    expect(runner).toContain("postflightVerification.manifestSha256 !== actualManifestSha");
    expect(runner).toContain("evidence-manifest-");
    expect(runner).toContain('productionAllowed: false');
    expect(read("scripts/playwright-compact-reporter.mjs")).toContain('flag: "wx"');
    expect(config).toMatch(/retries:\s*0/);
    expect(config).toMatch(/workers:\s*1/);
    expect(config).toMatch(/fullyParallel:\s*false/);
    expect(config).toContain("operational-lifecycle-v2.e2e.ts");
    expect(config).toContain("operational-lifecycle-v2-concurrency.e2e.ts");
    expect(config).toContain("operational-lifecycle-v2-continuations.e2e.ts");
    expect(config).toContain("operational-lifecycle-v2-recovery-realtime.e2e.ts");
    expect(config).toContain("operational-lifecycle-v2-downstream-parity.e2e.ts");
    expect(config).toContain("operational-lifecycle-v2-hop-mutation-races.e2e.ts");
    for (const regressionSpec of [
      "release-a-hop-pause.e2e.ts",
      "release-a-inventory-matrix.e2e.ts",
      "release-a-report-exports.e2e.ts",
      "release-b-checkout-reject-race-v2.e2e.ts",
      "release-b-checkout-hop-race-v2.e2e.ts",
      "release-b-hopped-concurrency-v2.e2e.ts",
      "release-b-multihop-concurrency-v2.e2e.ts",
      "release-b-role-checkout-hop-timing-v2.e2e.ts"
    ]) expect(config).toContain(regressionSpec);
  });

  it("provides a reusable immutable 30-load performance gate", () => {
    const runner = read("scripts/run-operational-performance-staging-e2e.mjs");
    const config = read("playwright.operational-performance.staging.config.ts");
    const spec = read("tests/e2e/staging/operational-performance.e2e.ts");
    expect(runner).toContain('E2E_PERFORMANCE_SAMPLES = "30"');
    expect(runner).toContain("E2E_PERFORMANCE_BASELINE_SHA256");
    expect(runner).toContain("E2E_EXPECTED_BUNDLE_SHA256");
    expect(runner).toContain('flag: "wx"');
    expect(config).toMatch(/retries:\s*0/);
    expect(config).toMatch(/workers:\s*1/);
    expect(spec).toContain("bp-safe-interactive");
    expect(spec).toContain("requestedFullAppStateData");
    expect(spec).toContain("Live normalized content fingerprints drifted from the immutable dataset snapshot.");
    expect(spec).toContain("requestedHistoryBeforeSafeInteractive");
    expect(spec).toContain("measureBootstrapDependencyDepth");
    expect(spec).not.toContain("bootstrapDependencyDepth: 3");
    expect(spec).toContain("criticalApiBytesP95");
    expect(spec).toContain("coldShellBytesP95");
    expect(spec).toContain("lcpP75");
    expect(spec).toContain("clsMax");
    expect(spec).toContain("activePanelCommitP95Ms");
    expect(runner).toContain("E2E_EXPECTED_BASELINE_BUNDLE_SHA256");
    expect(runner).toContain("E2E_PERFORMANCE_DATASET_MANIFEST_SHA256");
    expect(runner).toContain("scaleSource?.restoreManifest?.sha256");
    expect(runner).toContain("scaleSource?.restoreDrill?.sha256");
    expect(runner).toContain("E2E_EXPECTED_DATASET_IDENTITY");
    expect(runner).toContain("E2E_DB_POSTFLIGHT_VERIFICATION_SHA256");
    expect(runner).toContain("E2E_PERFORMANCE_PROFILE_MANIFEST_SHA256");
    expect(runner).toContain("E2E_PERFORMANCE_BASELINE_MANIFEST_SHA256");
    expect(spec).toContain("initialJavascriptBytesMax");
    expect(spec).toContain("initialJavascriptGzipBytesMax");
    expect(spec).toContain("1_000 * 1024");
    expect(spec).toContain("300 * 1024");
    expect(runner).toContain("profileManifest.value.hostFingerprint !== currentHostFingerprint");
    expect(runner).toContain("profileManifest.value.browserChannel");
    expect(spec).toContain("baseline.browserVersion !== browserVersion");
    expect(spec).toContain("organizationResponse.requestStartMs");
    expect(spec).toContain("baseline.deployedBundleSha256");
    expect(spec).toContain("summary.p95");
    expect(spec).toContain("3_500");
  });

  it("builds the performance dataset from a read-only exact staging snapshot and verified production-scale restore source", () => {
    const sql = read("supabase/operational-performance-dataset-readonly.sql");
    const builder = read("scripts/build-operational-performance-dataset-manifest.mjs");
    expect(sql).toContain("repeatable read read only");
    expect(sql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(sql).toContain("public_counts");
    expect(builder).toContain("Restore artifact ${entry.name} failed integrity validation.");
    expect(builder).toContain("restoreFile.value.baselineEvidence?.sha256 !== productionFile.sha256");
    expect(builder).toContain('readBound("restore-drill"');
    expect(builder).toContain("restoreDrill.sourceManifest?.sha256 !== restoreFile.sha256");
    expect(builder).toContain("Disposable restore drill count differs");
    expect(builder).toContain("Staging dataset is below the production logical scale");
    expect(builder).toContain('flag: "wx"');
  });

  it("keeps the database proof on the approved strict latency budget", () => {
    const proof = read("supabase/operational-lifecycle-v2-transactional-proof.sql");
    const runner = read("scripts/run-operational-v2-staging-e2e.mjs");
    const runbook = read("openspec/changes/operational-performance-decoupling/staging-runbook.md");
    expect(proof).toContain("p95_ms>=500 or max_ms>=2000");
    expect(runner).toContain("p95_ms) < 500");
    expect(runner).toContain("max_ms) < 2_000");
    expect(runbook).toContain("database p95 below 500 ms and maximum below 2 seconds");
  });

  it("uses the intent-only lifecycle envelope in every selected checkout race and role case", () => {
    for (const scenario of [
      "tests/e2e/staging/release-b-checkout-hop-race-v2.e2e.ts",
      "tests/e2e/staging/release-b-checkout-reject-race-v2.e2e.ts",
      "tests/e2e/staging/release-b-role-checkout-hop-timing-v2.e2e.ts"
    ]) {
      const source = read(scenario);
      expect(source).toContain("payload.entity_id");
      expect(source).toContain("audit_log_id");
      expect(source).not.toMatch(/payload\.payload\.(?:session|auditLog)\b/);
    }
    const hopPause = read("tests/e2e/staging/release-a-hop-pause.e2e.ts");
    expect(hopPause).toContain('rpc.startsWith("commit_checkout_bill")');
  });

  it("covers canonical hop, paused rejection, same-ID replay, mismatch, actor, realtime, cleanup, and app_state invariance", () => {
    const spec = read("tests/e2e/staging/operational-lifecycle-v2.e2e.ts");
    for (const marker of [
      "hop_session_v2",
      "reject_session_v2",
      "mutation_identity_mismatch",
      "idempotent: true",
      "authenticatedJwtSubject",
      "operational_events",
      "appStateBefore",
      "appStateAfter",
      "cleanupBillId",
      "serverDurationMs",
      "acknowledgementMs",
      "observer.page.reload"
    ]) expect(spec).toContain(marker);
  });

  it("runs real independent-connection lifecycle races and fifty reload-versus-unrelated mutation pairs", () => {
    const spec = read("tests/e2e/staging/operational-lifecycle-v2-concurrency.e2e.ts");
    expect(spec).toContain('["hop", "hop"]');
    expect(spec).toContain('["reject", "reject"]');
    expect(spec).toContain('["hop", "reject"]');
    expect(spec).toContain("for (let iteration = 1; iteration <= 50; iteration += 1)");
    expect(spec).toContain('"session/session"');
    expect(spec).toContain('"session/tab"');
    expect(spec).toContain('"tab/tab"');
    expect(spec).toContain("observer.page.reload");
    expect(spec).toContain("appStateSnapshot");
    expect(spec).toContain("operational_events");
    expect(spec).toContain("directRpcEvidence");
    expect(spec).toContain("expectTargetsVisible");
    expect(spec).toContain("expectTargetsAbsent");
    expect(spec).toContain("winnerActorId");
    expect(spec).toContain("requires distinct authenticated actors");
    expect(spec).toContain("latency.serverP95Ms");
    expect(spec).toContain("latency.clientP95Ms");
    expect(spec).toContain("latency.browserCompletionMaxMs");
    expect(spec).toContain("ten calibrated unrelated pairs");
    expect(spec).toContain("Concurrent wall time must beat isolated sequential calibration");
    expect(spec).toContain("Concurrent calibration submissions must begin together");
    expect(spec).toContain("directRpcEvidence");
    expect(spec).toContain("full two-browser convergence");
    expect(spec).toContain("twenty browser-observed samples per lifecycle target class");
    expect(spec).toContain("operational-v2-20x3-lifecycle-latency");
    expect(spec).toContain("targetSummary.httpP95Ms");
  });

  it("covers unit-sale and every continuation consumer topology with terminal cleanup", () => {
    const spec = read("tests/e2e/staging/operational-lifecycle-v2-continuations.e2e.ts");
    for (const marker of [
      "unit-sale session can hop",
      '"new-tab", "existing-tab"',
      "triple-consumer",
      "reject-vs-consumer",
      "activeConsumers",
      "billRecoverableSource",
      "hopped_session_unavailable",
      "Continuation races require distinct actors",
      "itemsAfterStart.map(canonicalItem)",
      "inventoryAfterHop).toEqual(inventoryAfterStart)",
      "billedItems).toEqual(itemsAfterStart.map(canonicalItem))",
      "inventoryAfterBill",
      "must decrement exactly once",
      "billStockMovements",
      "directRpcEvidence",
      "event cardinality",
      "audit cardinality",
      "unresolvedSourceIds",
      "consoleErrors: [], pageErrors: []"
    ]) expect(spec).toContain(marker);
  });

  it("proves same-ID lost-response recovery and both realtime ordering directions", () => {
    const spec = read("tests/e2e/staging/operational-lifecycle-v2-recovery-realtime.e2e.ts");
    for (const marker of [
      "No automatic resend may occur before manual recovery",
      "Retry Game Hop",
      "Exactly one manual same-ID replay is allowed",
      "configured 20-second boundary",
      "observerSawRealtimeBeforeOriginResponse",
      "responseBeforeRealtime",
      "observerOfflineGapRecovered",
      "duplicateSameIdWasIdempotent",
      "duplicateRealtimeFrameDelivered",
      "observerPanelUnmountedDuringDuplicate"
    ]) expect(spec).toContain(marker);
    expect(spec).toContain("unresolvedSessionIds");
    expect(spec).toContain("consoleErrors: [], pageErrors: []");
  });

  it("reconstructs the same bill and receipt after refresh, mobile resize, and logout-login", () => {
    const spec = read("tests/e2e/staging/operational-lifecycle-v2-downstream-parity.e2e.ts");
    for (const marker of [
      "Bill Register",
      "thermal-receipt-preview",
      "width: 390, height: 844",
      "Sign Out",
      "afterRefresh.receiptText",
      "afterLogin.receiptText",
      "bill_lines",
      "payments"
    ]) expect(spec).toContain(marker);
  });

  it("serializes hop against all five live session mutation classes", () => {
    const spec = read("tests/e2e/staging/operational-lifecycle-v2-hop-mutation-races.e2e.ts");
    for (const marker of [
      '"timing", "pause", "resume", "add-item", "remove-item"',
      "save_live_session_details",
      "pause_session",
      "resume_session",
      "add_session_item",
      "remove_session_item",
      "legal serialized outcome",
      "Bill Hopped Session",
      "Hop mutation races require distinct authenticated actors",
      "session_not_open",
      "close_disposition: \"hopped\"",
      "must not leave an open pause",
      "Rejected timing mutation must leave canonical start unchanged",
      "Rejected pause mutation must not create a pause row",
      "mutation event cardinality",
      "mutation audit cardinality",
      "itemsAfterBill",
      "billLines",
      "unresolvedSourceIds",
      "consoleErrors: [], pageErrors: []"
    ]) expect(spec).toContain(marker);
    const safeEvidence = spec.slice(spec.indexOf("function safeCommandEvidence"), spec.indexOf("async function timedSubmit"));
    expect(safeEvidence).toContain("urlPath");
    expect(safeEvidence).not.toContain("headers");
    expect(spec).not.toMatch(/\bcapturedHop,\s*\n\s*capturedMutation\b/);
  });

  it("keeps heavy exports demand-loaded and removes the one-second App render cadence", () => {
    const exporters = read("src/exporters.ts");
    const app = read("src/App.tsx");
    expect(exporters).toMatch(/await import\("xlsx"\)/);
    expect(exporters).toMatch(/await import\("jspdf"\)/);
    expect(app).toContain("useClock(30_000)");
    expect(app).not.toContain("const now = useClock();");
  });

  it("provides a read-only exact-run post-test reconciliation and immutable verifier", () => {
    const sql = read("supabase/operational-v2-staging-posttest-readonly.sql");
    const builder = read("scripts/build-operational-v2-posttest-reconciliation.mjs");
    const verifier = read("scripts/verify-operational-v2-posttest-reconciliation.mjs");
    expect(sql).toContain("repeatable read read only");
    expect(sql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(sql).toContain("qa_live_residuals");
    expect(sql).toContain("qa_terminal_evidence");
    expect(sql).toContain("same_target_race_integrity");
    expect(builder).toContain("expectedFunctionDefinitionMd5");
    expect(builder).toContain('flag: "wx"');
    expect(verifier).toContain("browserEvidenceManifestSha256");
    expect(verifier).toContain("Compatibility app_state changed");
    expect(verifier).toContain("Same-target races did not retain exactly one committed");
  });

  it("proves the rollback-only SQL left no exact proof-run residue before browser execution", () => {
    const sql = read("supabase/operational-v2-proof-postrollback-readonly.sql");
    const builder = read("scripts/build-operational-v2-proof-postrollback.mjs");
    const verifier = read("scripts/verify-operational-v2-proof-postrollback.mjs");
    expect(sql).toContain("repeatable read read only");
    expect(sql).toContain("__PROOF_RUN_ID__");
    expect(builder).toContain("rollbackOnly !== true");
    expect(verifier).toContain("Transactional proof rollback left ${name} rows.");
    expect(verifier).toContain("appStateRestored: true");
  });

  it("binds the rollback-only proof to exact installed v2 and pre-install legacy definitions", () => {
    const builder = read("scripts/build-operational-v2-transactional-proof.mjs");
    const proof = read("supabase/operational-lifecycle-v2-transactional-proof.sql");
    expect(builder).toContain("installManifest.preflight.sha256");
    expect(builder).toContain('const legacyFunctionNames = ["hop_session", "reject_session", "reject_customer_tab"]');
    expect(builder).toContain("legacyFunctionDefinitionMd5");
    expect(proof).toContain("performance_comparison");
    expect(proof).toContain("v2_at_least_50_percent_faster");
    expect(proof).toContain("large_small_within_budget");
    expect(proof).toContain("qa_expect_rpc_error");
  });

  it("keeps customer snapshot parity in a separately reconciled, staging-identity-bound suite", () => {
    const sql = read("supabase/operational-v2-customer-profile-posttest-readonly.sql");
    const builder = read("scripts/build-operational-v2-customer-profile-posttest.mjs");
    const verifier = read("scripts/verify-operational-v2-customer-profile-posttest.mjs");
    const spec = read("tests/e2e/staging/customer-profile-snapshot-parity.e2e.ts");
    expect(sql).toContain("database-owned staging API URL identity failed");
    expect(sql).toContain("compatibility_customers");
    expect(builder).toContain("expectedAppStateBefore");
    expect(verifier).toContain("customerCleanupProven");
    expect(spec).toContain("explicitSessionCustomerId");
    expect(spec).toContain("observerDeletionConvergedAndSurvivedReload");
  });
});
