import fs from "node:fs";
import path from "node:path";
import { createSourceFile, forEachChild, ScriptKind, ScriptTarget, SyntaxKind } from "typescript";
import { describe, expect, it } from "vitest";

const SELECTED_OPERATIONAL_SPECS = [
  "operational-lifecycle-v2.e2e.ts",
  "operational-lifecycle-v2-concurrency.e2e.ts",
  "operational-lifecycle-v2-continuations.e2e.ts",
  "operational-lifecycle-v2-recovery-realtime.e2e.ts",
  "operational-lifecycle-v2-downstream-parity.e2e.ts",
  "operational-lifecycle-v2-hop-mutation-races.e2e.ts",
  "release-a-hop-pause.e2e.ts",
  "release-a-inventory-matrix.e2e.ts",
  "release-a-report-exports.e2e.ts",
  "release-b-checkout-reject-race-v2.e2e.ts",
  "release-b-checkout-hop-race-v2.e2e.ts",
  "release-b-hopped-concurrency-v2.e2e.ts",
  "release-b-multihop-concurrency-v2.e2e.ts",
  "release-b-role-checkout-hop-timing-v2.e2e.ts"
] as const;

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
    const negativeMatrixSource = runner.match(/const REQUIRED_NEGATIVE_CASES = \[([\s\S]*?)\]\.sort\(\);/)?.[1];
    expect(negativeMatrixSource).toBeDefined();
    const requiredNegativeCases = [...negativeMatrixSource!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(requiredNegativeCases).toHaveLength(49);
    expect(new Set(requiredNegativeCases).size).toBe(49);
    for (const negativeCase of [
      "missing-mutation-id",
      "missing-mutation-kind",
      "missing-entity-type",
      "empty-hop-mutation-kind",
      "empty-hop-entity-type",
      "missing-reject-session-mutation-kind",
      "missing-reject-session-entity-type",
      "empty-reject-session-mutation-kind",
      "empty-reject-session-entity-type",
      "missing-reject-tab-mutation-kind",
      "missing-reject-tab-entity-type",
      "empty-reject-tab-mutation-kind",
      "empty-reject-tab-entity-type",
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

  it("keeps every selected staging spec free of failure-masking finally control flow", () => {
    const config = read("playwright.operational-v2.staging.config.ts");
    const staticGate = read("scripts/check-operational-v2-staging-static.mjs");
    const unsafeCleanupControlFlow: string[] = [];
    const configuredSpecs = [...config.matchAll(/"([^"]+\.e2e\.ts)"/g)].map((match) => match[1]);

    expect(configuredSpecs).toEqual([...SELECTED_OPERATIONAL_SPECS]);

    for (const specName of SELECTED_OPERATIONAL_SPECS) {
      expect(config).toContain(`"${specName}"`);
      expect(staticGate).toContain(`"${specName}"`);
      const relativePath = `tests/e2e/staging/${specName}`;
      const sourceText = read(relativePath);
      const sourceFile = createSourceFile(relativePath, sourceText, ScriptTarget.Latest, true, ScriptKind.TS);

      const collectUnsafeCleanup = (node: import("typescript").Node, rejectionContained = false) => {
        if (node.kind === SyntaxKind.AwaitExpression && /^await\s+finalization\.run\s*\(/.test(node.getText(sourceFile))) {
          return;
        }
        if (node.kind === SyntaxKind.ThrowStatement) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          unsafeCleanupControlFlow.push(`${relativePath}:${line}:throw`);
        }
        if (node.kind === SyntaxKind.AwaitExpression && !rejectionContained) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          unsafeCleanupControlFlow.push(`${relativePath}:${line}:await`);
        }
        if (node.kind === SyntaxKind.TryStatement) {
          const statement = node as import("typescript").TryStatement;
          collectUnsafeCleanup(statement.tryBlock, rejectionContained || Boolean(statement.catchClause));
          if (statement.catchClause) collectUnsafeCleanup(statement.catchClause, rejectionContained);
          if (statement.finallyBlock) collectUnsafeCleanup(statement.finallyBlock, rejectionContained);
          return;
        }
        forEachChild(node, (child) => collectUnsafeCleanup(child, rejectionContained));
      };

      const inspect = (node: import("typescript").Node) => {
        if (node.kind === SyntaxKind.TryStatement) {
          const finallyBlock = (node as import("typescript").TryStatement).finallyBlock;
          if (finallyBlock) collectUnsafeCleanup(finallyBlock);
        }
        forEachChild(node, inspect);
      };

      inspect(sourceFile);
    }

    expect(unsafeCleanupControlFlow).toEqual([]);
    expect(staticGate).toContain('"--target", "ES2023"');
    expect(staticGate).toContain('"--types", "node,@playwright/test,vite/client"');
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
    expect(runner).toContain('import { sameAppStateIdentity, sameJsonValue } from "./json-value-equality.mjs"');
    expect(runner).toContain("!sameJsonValue(dataset.shape_counts, scaleFixtureManifest.value.plan?.shape?.targetCounts)");
    expect(runner).toContain("!sameJsonValue(scaleFixtureVerification.value.appStateAfter, dataset.app_state)");
    expect(runner).toContain("!sameAppStateIdentity(postflightVerification.value.appState, scaleFixtureVerification.value.appStateBefore)");
    expect(runner).not.toContain("JSON.stringify(dataset.shape_counts) !== JSON.stringify(scaleFixtureManifest.value.plan?.shape?.targetCounts)");
    expect(runner).toContain("E2E_EXPECTED_DATASET_IDENTITY");
    expect(runner).toContain("E2E_EXPECTED_RECENT_STOCK_MOVEMENTS");
    expect(runner).toContain("dataset.shape_counts");
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
    expect(spec).toContain("PERFORMANCE_METRIC_VERSION = 2");
    expect(spec).toContain("requestStartedByBrowserMark");
    expect(spec).toContain("requestStartedByBrowserMarkAfterCompletion");
    expect(spec).toContain('coldPage.on("requestfinished"');
    expect(spec).toContain("requestLifecycleTasks.get(request)!");
    expect(spec).toContain("requestLifecycleResolvers.get(request)?.();");
    expect(spec.indexOf('coldPage.on("requestfinished"')).toBeGreaterThan(spec.indexOf('coldPage.on("response"'));
    expect(spec).toContain("settledResourceEvidence");
    expect(spec).toContain("CRITICAL_RESOURCE_TIMING_SETTLE_TIMEOUT_MS");
    expect(spec).toContain("missingExpectedCriticalResourceKeys");
    expect(spec).toContain("startMinusSafeMs");
    expect(spec).toContain("criticalEvidenceErrors");
    expect(spec).toContain("entry.criticalResponses.every(isSuccessfulCriticalResponse)");
    const commonCriticalResponseGateIndex = spec.indexOf("entry.criticalResponses.every(isSuccessfulCriticalResponse)");
    expect(commonCriticalResponseGateIndex).toBeGreaterThan(-1);
    expect(commonCriticalResponseGateIndex).toBeLessThan(
      spec.indexOf('if (mode === "candidate")', commonCriticalResponseGateIndex)
    );
    expect(spec).toContain("bp-visible-dashboard-ready");
    expect(spec).toContain('expect(marks["bp-realtime-requested"]).toBeLessThan(marks["bp-app-module-ready"])');
    expect(spec).toContain("bootstrapRpcResponseCount === 1");
    expect(spec).toContain("installVisibleReadyObserver");
    expect(spec).not.toContain("bp-baseline-interactive-observed");
    expect(spec).toContain("sumCriticalShellTransferBytes");
    expect(spec).toContain("largestContentfulPaintElement");
    expect(spec).toContain('largestContentfulPaintResourcePath = "";');
    expect(spec).toContain("inventoryNetworkCompleteMs");
    expect(spec).toContain("intervals: [INVENTORY_RENDER_POLL_INTERVAL_MS]");
    expect(spec).toContain("expect.soft");
    expect(spec).toContain("baseline.deployedBundleSha256");
    expect(spec).toContain("summary.p95");
    expect(spec).toContain("3_500");
    expect(spec).toContain("Deferred Inventory history must load without a remote error banner.");
    expect(spec).toContain("inventoryStockMovementCount");
    expect(spec).toContain("inventoryStockMovementPages");
    expect(spec).toContain("bodyBytes: response.bodyBytes");
    expect(spec).toContain("inventoryStockMovementBytesP95");
    expect(spec).toContain("inventoryStockMovementBytesMax");
    expect(spec).toContain("Number.isFinite(response.bodyBytes) && response.bodyBytes >= 0");
    expect(spec).toContain("inventoryHistoryReadyMs");
    expect(spec).toContain("inventoryHistoryReadyP95Ms");
    expect(spec).toContain('recentMovementsSection.locator(".activity-row").count()');
    expect(spec).toContain("/rest/v1/stock_movements");
    expect(spec).toContain("movementResponses.reduce");
    expect(spec).toContain("[200, 206].includes(response.status)");
    expect(spec).toContain("expectedRequestOffsets");
    expect(spec).toContain("expectedRequestLimits");
    expect(spec).toContain("expectedContentRanges");
    expect(spec).toContain("parsePostgrestPageEvidence");
    expect(spec).toContain("response.stockMovementHistoryPage === true");
    expect(read("src/dataGateway/normalizedReads.ts")).toContain("request.range(offset, offset + pageLimit - 1)");
    expect(read("src/dataGateway/normalizedReads.ts")).toContain('{ count: "exact" }');
    expect(read("src/dataGateway/normalizedReads.ts")).toContain("changed while it was being loaded");
    expect(read("src/dataGateway/normalizedReads.ts")).toContain("stable descending order");
    expect(read("src/dataGateway/normalizedReads.ts")).toContain("const deadlineAt = Date.now() + NORMALIZED_READ_TIMEOUT_MS");
  });

  it("keeps the profiling renderer on the initial graph and renders one responsive Inventory catalog layout", () => {
    const main = read("src/main.tsx");
    const vite = read("vite.config.ts");
    const app = read("src/App.tsx");
    const inventory = read("src/panels/InventoryPanel.tsx");
    expect(main).toContain('import { createRoot } from "react-dom/client"');
    expect(main).not.toContain('await import("react-dom/profiling")');
    expect(main).toContain("preloadShellImage(brandLogo)");
    expect(vite).toContain('{ find: "react-dom/client", replacement: "react-dom/profiling" }');
    expect(app).toContain('const loadInventoryPanel = () => import("./panels/InventoryPanel")');
    expect(app).toContain("lazy(loadInventoryPanel)");
    expect(app).toContain("window.requestIdleCallback(preload");
    expect(app).toContain("<Suspense fallback=");
    expect(inventory).toContain('COMPACT_INVENTORY_MEDIA_QUERY = "(max-width: 720px)"');
    expect(inventory).toContain("!compactInventoryLayout && <div className=\"table-wrap inventory-table-wrap\"");
    expect(inventory).toContain("compactInventoryLayout && <div className=\"inventory-mobile-list\"");
    expect(inventory).toContain("catalogPresentationById");
  });

  it("builds the performance dataset from a read-only exact staging snapshot and verified production-scale restore source", () => {
    const sql = read("supabase/operational-performance-dataset-readonly.sql");
    const builder = read("scripts/build-operational-performance-dataset-manifest.mjs");
    expect(sql).toContain("repeatable read read only");
    expect(sql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(sql).toContain("public_counts");
    expect(sql).toContain("identity_nonce");
    expect(sql).toContain("recoverable_hopped_sessions");
    expect(sql).toContain("shape_counts");
    expect(sql).toContain("qa_performance_scale");
    expect(sql).toContain("qaPerformanceScaleFixture");
    expect(sql).toContain("md5(replace(replace(prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))");
    expect(sql).toContain("md5(replace(replace(pg_get_functiondef(to_regprocedure('public.get_operational_performance_scale_identity(jsonb)')),chr(13)||chr(10),chr(10)),chr(13),chr(10)))");
    expect(builder).toContain("Restore artifact ${entry.name} failed integrity validation.");
    expect(builder).toContain("restoreFile.value.baselineEvidence?.sha256 !== productionFile.sha256");
    expect(builder).toContain('readBound("restore-drill"');
    expect(builder).toContain('replace(/^\\uFEFF/, "")');
    expect(builder).toContain("restoreDrill.sourceManifest?.sha256 !== restoreFile.sha256");
    expect(builder).toContain("Disposable restore drill count differs");
    expect(builder).toContain("Staging dataset is below the production logical scale");
    expect(builder).toContain("Staging dataset workload-shape identity is incomplete.");
    expect(builder).toContain('readBound("fixture-manifest"');
    expect(builder).toContain('readBound("fixture-verification"');
    expect(builder).toContain("plannedCleanup");
    expect(builder).toContain('flag: "wx"');
  });

  it("provides a guarded synthetic scale fixture and a two-state performance identity chain", () => {
    const fixtureBuilder = read("scripts/build-operational-performance-scale-fixture.mjs");
    const fixtureLibrary = read("scripts/operational-performance-scale-fixture-lib.mjs");
    const fixtureVerifier = read("scripts/verify-operational-performance-scale-fixture.mjs");
    const runner = read("scripts/run-operational-performance-staging-e2e.mjs");
    for (const marker of [
      "7623125441096521075",
      "f9bc0aed-b6c4-410f-ba2a-572522d03869",
      "qa_performance_scale",
      "qaPerformanceScaleFixture",
      "automaticRetryAllowed:false",
      'flag:"wx"'
    ]) expect(fixtureBuilder + fixtureLibrary).toContain(marker);
    expect(fixtureLibrary).toContain("scaled dataset drift prevents cleanup");
    expect(fixtureLibrary).toContain("disable trigger app_state_set_updated_at");
    expect(fixtureLibrary).toContain("enable trigger app_state_set_updated_at");
    expect(fixtureLibrary).toContain("assertSafeGeneratedSql");
    expect(fixtureLibrary).toContain("drop schema ${SCALE_SCHEMA};");
    expect(fixtureLibrary).toContain('sql.includes("drop schema qa_performance_scale cascade")');
    expect(fixtureLibrary).toContain("AUXILIARY_IDENTITY_TABLES");
    expect(fixtureLibrary).toContain("scale fixture identity RPC already exists");
    expect(fixtureLibrary).toContain("estimateRepresentativeAppStateUpperBoundBytes");
    expect(fixtureLibrary).toContain("runtimeExactSizeGuard");
    expect(fixtureLibrary).toContain("shape_counts");
    expect(fixtureLibrary).toContain("aclexplode");
    expect(fixtureLibrary).not.toContain("has_function_privilege('public'");
    expect(fixtureLibrary).not.toContain("to_jsonb(a)");
    expect(fixtureVerifier).toContain('mode==="apply"');
    expect(fixtureVerifier).toContain("Applied fixture workload-shape counts differ from the manifest.");
    expect(fixtureBuilder).toContain("Scale fixture packages must be generated from a clean committed worktree.");
    expect(runner).toContain("scaleFixtureVerification.value.appStateBefore");
    expect(runner).toContain("scaleFixtureVerification.value.appStateAfter");
    expect(runner).toContain("E2E_PERFORMANCE_DATASET_RPC = SCALE_RPC");
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
    expect(sql).toContain("identity_nonce='__IDENTITY_NONCE__'::uuid");
    expect(sql).toContain("'identity_nonce','__IDENTITY_NONCE__'");
    expect(builder).toContain("rollbackOnly !== true");
    expect(builder).toContain("proofManifest.target?.identityNonce");
    expect(builder).toContain('.replaceAll("__IDENTITY_NONCE__", identityNonce)');
    expect(read("scripts/build-operational-v2-transactional-proof.mjs")).toContain("assertBalancedStatementParentheses(generated)");
    expect(verifier).toContain("Transactional proof rollback left ${name} rows.");
    expect(verifier).toContain("observed.identity_nonce !== identityNonce");
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
    expect(sql).toContain("physical database is not the approved staging cluster");
    expect(sql).toContain("compatibility_customers");
    expect(builder).toContain("expectedAppStateBefore");
    expect(verifier).toContain("customerCleanupProven");
    expect(spec).toContain("explicitSessionCustomerId");
    expect(spec).toContain("observerDeletionConvergedAndSurvivedReload");
  });
});
