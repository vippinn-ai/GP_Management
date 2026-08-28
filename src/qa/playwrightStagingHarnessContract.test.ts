import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("staging Playwright harness contract", () => {
  it("is reproducible and excluded from the Vitest unit run", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const viteConfig = read("vite.config.ts");

    expect(packageJson.devDependencies["@playwright/test"]).toBe("^1.59.1");
    expect(packageJson.scripts["test:e2e:staging"]).toBe("node scripts/run-staging-e2e.mjs");
    expect(packageJson.scripts["test:e2e:staging:v2"]).toBe(
      "node scripts/run-financial-v2-staging-e2e.mjs"
    );
    expect(packageJson.scripts["test:db:staging:v2-reconcile"]).toBe(
      "node scripts/reconcile-financial-v2-staging.mjs"
    );
    expect(packageJson.scripts["test:db:staging:reject-proof:build"]).toBe(
      "node scripts/build-reject-rpc-transactional-proof.mjs"
    );
    expect(packageJson.scripts["test:db:staging:reject-proof:preflight"]).toBe(
      "node scripts/preflight-reject-rpc-staging-proof.mjs"
    );
    expect(packageJson.scripts["test:db:staging:reject-proof:reconcile"]).toBe(
      "node scripts/reconcile-reject-rpc-staging-proof.mjs"
    );
    expect(packageJson.scripts["test:db:staging:reject-install:build"]).toBe(
      "node scripts/build-reject-rpc-staging-install.mjs"
    );
    expect(viteConfig).toContain('"tests/e2e/**"');
  });

  it("fails closed against production and requires explicit staging mutation confirmation", () => {
    const guard = read("scripts/playwright-staging-env.mjs");
    const runner = read("scripts/run-staging-e2e.mjs");
    const v2Runner = read("scripts/run-financial-v2-staging-e2e.mjs");
    const v2DbSmoke = read("scripts/run-financial-v2-staging-db-smoke.mjs");
    const config = read("playwright.staging.config.ts");
    const v2Config = read("playwright.financial-v2.staging.config.ts");

    expect(guard).toContain('STAGING_PROJECT_REF = "tkbdyzxwwbhkpztgjjxh"');
    expect(guard).toContain('PRODUCTION_PROJECT_REF = "rrdwbxvuwrbxefarxnse"');
    expect(guard).toContain('STAGING_MUTATION_CONFIRMATION = "release-a-staging-only"');
    expect(guard).toContain("parsed.href !== STAGING_APP_URL");
    expect(guard).toContain("hostname !== expectedHostname");
    expect(guard).toContain('`${STAGING_PROJECT_REF}.supabase.co`');
    expect(guard).toContain("expectedFinancialV2 = false");
    expect(guard).toContain("VITE_BACKEND_FINANCIAL_RPC_V2 !== String(expectedFinancialV2)");
    expect(runner).toContain("assertStagingSupabaseEnvironment(stagingEnv)");
    expect(v2Runner).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(v2DbSmoke).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(v2DbSmoke).toContain('restrictedProfile.data.role === "admin"');
    expect(v2DbSmoke).toContain('["writeOffPendingBills", "voidBill", "refundBill"]');
    expect(v2DbSmoke).toContain('"role_access_denied", "non-admin bill replacement"');
    expect(v2DbSmoke).toContain('rejectionCode(permittedSettlementResult) === "role_access_denied"');
    expect(v2DbSmoke).toContain('await updateRestrictedRole("receptionist")');
    expect(v2DbSmoke).toContain('await updateRestrictedRole("admin")');
    expect(v2DbSmoke).toContain("finally {");
    expect(v2Runner).toContain("--config=playwright.financial-v2.staging.config.ts");
    expect(runner).toContain("assertLiveCredentials(env)");
    expect(runner).toContain("verifyDeployedStagingArtifact");
    expect(runner).toContain("!bundle.includes(STAGING_PROJECT_REF) || bundle.includes(PRODUCTION_PROJECT_REF)");
    expect(config).toContain("retries: 0");
    expect(config).toContain('trace: "off"');
    expect(config).toContain('screenshot: "only-on-failure"');
    expect(config).toContain('video: "retain-on-failure"');
    expect(v2Config).toContain("retries: 0");
    expect(v2Config).toContain('trace: "off"');
  });

  it("uses two browser contexts, compact RPC evidence, and cleanup branches", () => {
    const support = read("tests/e2e/staging/support/app.ts");
    const scenario = read("tests/e2e/staging/release-a-hop-pause.e2e.ts");
    const reporter = read("scripts/playwright-compact-reporter.mjs");

    expect(support).toContain("browser.newContext");
    expect(support).toContain('const marker = "/rest/v1/rpc/"');
    expect(support).toContain('getByText(/^Synced(?:\\s|$)/)');
    expect(support).toContain("await expect(dashboard.or(rejected)).toBeVisible()");
    expect(support).toContain('await password.fill("")');
    expect(support).toContain('throw new Error("Staging sign-in was rejected.")');
    expect(scenario).toContain('entry.rpc === "edit_pause_log"');
    expect(scenario).toContain('entry.rpc === "hop_session"');
    expect(scenario).toContain('entry.rpc === "record_session_audit"');
    expect(scenario).toContain("rejectSessionIfOpen");
    expect(support).toContain("Cleanup refused because the station no longer belongs to the exact QA customer.");
    expect(support).toContain("Cleanup refused because the stored session customer no longer matches the exact QA customer.");
    expect(support).toContain('modal.getByLabel("Customer Name", { exact: true })');
    expect(scenario).toContain("billNewestHoppedSession");
    expect(scenario).toContain('changedRowIds(checkout, "sessions").includes(hopSessionId)');
    expect(scenario).toContain('changedRowIds(committedCheckout, "sessions").includes(hopSessionId)');
    expect(scenario).toContain("cleanupBillId = committedCheckout.billId");
    expect(scenario).toContain("cleanupBillingAttempted && !cleanupBilled");
    expect(scenario.match(/sessionStarted = sessionStarted \|\| rpcEvidence\.some/g)).toHaveLength(2);
    expect(scenario).toContain("no automatic retry was issued");
    expect(reporter).toContain("summary-${this.runId}.json");
  });

  it("validates a frozen checkout end time against the fresh transaction timestamp", () => {
    const app = read("src/App.tsx");

    expect(app).toMatch(
      /const issuedAt = new Date\(\)\.toISOString\(\);[\s\S]*const nowDate = new Date\(issuedAt\);[\s\S]*endedAt\.getTime\(\) > nowDate\.getTime\(\)/
    );
  });

  it("builds an exact-definition rollback-only reject RPC proof", () => {
    const generator = read("scripts/build-reject-rpc-transactional-proof.mjs");
    const proof = read("supabase/phase4-reject-rpcs-transactional-proof.sql");

    expect(generator).toContain('"supabase/phase4-start-session-rpc.sql"');
    expect(generator).toContain('"supabase/phase4-reject-rpcs.sql"');
    expect(generator).toContain('"supabase/phase4-link-customer-tab-continuation-rpc.sql"');
    expect(generator).toContain("qa_reject_rpc_definition_before on commit preserve rows");
    expect(generator).toContain('hashQuery("during")');
    expect(generator).toContain('hashQuery("after")');
    expect(generator).toContain("before_snapshot.definition_sha256 is distinct from after_snapshot.definition_sha256");
    expect(generator).toContain("before_snapshot.authenticated_can_execute is distinct from after_snapshot.authenticated_can_execute");
    expect(generator).toContain("before_snapshot.anon_can_execute is distinct from after_snapshot.anon_can_execute");
    expect(generator).toContain("SAVEPOINT rollback did not restore all four function definitions and grants exactly");
    expect(generator).toContain("qa_reject_rpc_app_state_before on commit preserve rows");
    expect(generator).toContain("before_snapshot.version is distinct from after_snapshot.version");
    expect(generator).toContain("before_snapshot.data_sha256 is distinct from after_snapshot.data_sha256");
    expect(generator).toContain("SAVEPOINT rollback did not restore the original app_state version and data hash exactly");
    expect(generator).toContain('"savepoint qa_reject_rpc_proof;"');
    expect(generator).toContain('"rollback to savepoint qa_reject_rpc_proof;"');
    expect(generator).toContain('"release savepoint qa_reject_rpc_proof;"');
    expect(generator).toContain('"begin;"');
    expect(generator).toContain("commit;");
    expect(generator).toContain("qa_reject_rpc_fixture_ids_before");
    expect(generator).toContain("SAVEPOINT rollback left one or more proof fixtures behind");
    expect(generator).toContain("verified_in_savepoint_app_state_version_delta");
    expect(generator).toContain("const requiredOrder = [");
    expect(generator).toContain("const hasRequiredOrder = requiredOrder.every(");
    expect(generator).toContain("one correctly ordered outer BEGIN/COMMIT, one SAVEPOINT/ROLLBACK TO/RELEASE");
    expect(generator).toContain("contains COMMIT");
    expect(proof).toContain("QA_REJECT_RPC_PROOF_BODY");
    expect(proof).toContain("set local role authenticated");
    expect(proof).toContain("Nested PL/pgSQL exception blocks provide rollback savepoints");
    expect(proof).toContain("app_state_conflict");
    expect(proof).toContain("organization_access_denied");
    expect(proof).toContain("audit_id_conflict");
    expect(proof).toContain("mutation_identity_mismatch");
    expect(proof).toContain("released_continued_from_session_ids");
    expect(proof).toContain("Malformed legacy continuation JSON");
    expect(proof).toContain("start_result := public.start_session");
    expect(proof).toContain("link_result := public.link_customer_tab_continuation");
    expect(proof).toContain("did not leave exactly one valid consumer for the hopped source");
    expect(proof).toContain("Normalized start/link RPCs unexpectedly changed the compatibility app_state snapshot");
    expect(proof).toContain("Tab audit actor or server-built release message is incorrect");
    expect(proof).toContain("did not restore the selected membership to active");
    expect(proof).toContain("set active = false");
    expect(proof).not.toMatch(/\b(begin|rollback|commit)\s*;/i);
  });

  it("builds a fail-closed persistent staging installer from the exact proven definitions", () => {
    const installer = read("scripts/build-reject-rpc-staging-install.mjs");

    expect(installer).toContain('"supabase/phase4-start-session-rpc.sql"');
    expect(installer).toContain('"supabase/phase4-reject-rpcs.sql"');
    expect(installer).toContain('"supabase/phase4-link-customer-tab-continuation-rpc.sql"');
    expect(installer).toContain("public.raise_operational_rpc_error(text,text,jsonb)");
    expect(installer).toContain("public.patch_app_state_array_by_id(jsonb,jsonb)");
    expect(installer).toContain("candidate.expected_authenticated");
    expect(installer).toContain("candidate.expected_anon");
    expect(installer).toContain("candidate.expected_security_definer");
    expect(installer).toContain("Installed reject-release RPC definitions or grants do not match");
    expect(installer).toContain("const hasRequiredOrder = requiredOrder.every(");
    expect(installer).toContain("one correctly ordered BEGIN/COMMIT");
  });

  it("guards the exact quarantined continuation repair and records its maintenance audit", () => {
    const repair = read("supabase/staging-qa-multihop-quarantine-repair.sql");

    expect(repair).toContain("Do not run in production");
    expect(repair).toContain("PREPARATION ONLY");
    expect(repair).toContain("v_second_attempt_authorization constant text := 'NOT_AUTHORIZED'");
    expect(repair).toContain("Second staging repair attempt is not explicitly authorized.");
    expect(repair).toMatch(/^begin;\s+set local time zone 'UTC';/im);
    expect(repair).toContain("session-9ef998d5-e5a9-44f9-b68a-f815df023b7a");
    expect(repair).toContain("session-4f9e640d-877d-4817-a005-bc08e6d3a76c");
    expect(repair).toContain("v_expected_app_state_version constant integer := 624");
    expect(repair).toContain("22368f8e74c3026017685fbc096f4281deb5c71277778c4b42691758ad743e51");
    expect(repair).toContain("00a8c647f5ea99964b50a2c0499bda024e3644d6fcb32dbe215f7b644de8b31b");
    expect(repair).toContain("v_now timestamptz := now()");
    expect(repair).not.toContain("v_now timestamptz := clock_timestamp()");
    expect(repair).toContain("Expected staging updated_at trigger definitions changed; repair refused.");
    expect(repair).toContain("and trigger_row.tgenabled = 'O'");
    expect(repair).toContain("v_consumer.continued_from_session_ids is distinct from jsonb_build_array");
    expect(repair).toContain("linked_session_id in (v_source_session_id, v_rejected_consumer_id)");
    expect(repair).toContain("v_reference_count <> 1");
    expect(repair).toMatch(/order by id\s+for update;/);
    expect(repair).toContain("v_repaired_compatibility_consumer := jsonb_set");
    expect(repair).toContain("jsonb_build_array(v_repaired_compatibility_consumer)");
    expect(repair).toContain("where audit_entry->>'id' = v_audit_id");
    expect(repair).toContain("designated_staging_maintenance_actor");
    expect(repair).toContain("It identifies the approved QA owner; it does not claim to be the SQL Editor operator");
    expect(repair).toContain("for share");
    expect(repair).not.toContain("for key share");
    expect(repair).toContain("to_char(v_now at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')");
    expect(repair).toContain("created_by, created_at, metadata");
    expect(repair).toContain("and created_at = v_now");
    expect(repair).toContain("and updated_at = v_now");
    expect(repair).toContain("Guarded repair compatibility state verification failed.");
    expect(repair).toContain("Guarded repair normalized or compatibility audit verification failed.");
    expect(repair).toContain("and raw_data = v_audit");
    expect(repair).toContain("and metadata->'changed_rows' = jsonb_build_object");
    expect(repair).toContain("qa_continuation_repair");
    expect(repair).toContain("public.patch_app_state_array_by_id");
    expect(repair).toContain("normalized and compatibility continuation links");
    expect(repair).toContain("'passed' as repair_result");
    expect(repair.match(/^begin;$/gim)).toHaveLength(1);
    expect(repair.match(/^commit;$/gim)).toHaveLength(1);
    expect(repair).not.toMatch(/^rollback;$/gim);
    expect(repair).not.toContain("rrdwbxvuwrbxefarxnse");
  });

  it("requires a reusable read-only empty-floor staging preflight", () => {
    const preflight = read("scripts/preflight-reject-rpc-staging-proof.mjs");

    expect(preflight).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(preflight).toContain('const organizationId = "org-primary"');
    expect(preflight).toContain("Reject RPC proof preflight is hard-locked to org-primary");
    expect(preflight).toContain("/^[A-Za-z0-9_-]{1,80}$/");
    expect(preflight).toContain('role.data !== "admin"');
    expect(preflight).toContain('.from("sessions")');
    expect(preflight).toContain('.neq("status", "closed")');
    expect(preflight).toContain('.from("customer_tabs")');
    expect(preflight).toContain('.eq("status", "open")');
    expect(preflight).toContain("safeToRunRollbackProof: openSessions.data.length === 0 && openTabs.data.length === 0");
    expect(preflight).toContain("process.exitCode = 2");
    expect(preflight).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(preflight).not.toContain(".update({");
    expect(preflight).not.toContain('supabase.rpc("reject_');
    expect(preflight).not.toContain('supabase.rpc("start_session"');
    expect(preflight).not.toContain('supabase.rpc("link_customer_tab_continuation"');
  });

  it("reconciles every rollback-proof fixture through a reusable read-only script", () => {
    const reconciliation = read("scripts/reconcile-reject-rpc-staging-proof.mjs");

    expect(reconciliation).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(reconciliation).toContain('const organizationId = "org-primary"');
    expect(reconciliation).toContain("E2E_POSTFLIGHT_EXPECTED_APP_STATE_VERSION");
    expect(reconciliation).toContain("E2E_POSTFLIGHT_EXPECTED_APP_STATE_HASH");
    expect(reconciliation).toContain('"qa-reject-proof-start-new-consumer"');
    expect(reconciliation).toContain('"qa-reject-proof-link-target"');
    expect(reconciliation).toContain('"qa-reject-proof-inactive-audit"');
    expect(reconciliation).toContain('"qa-reject-proof-audit-collision-mutation"');
    expect(reconciliation).toContain('in("metadata->>mutation_id", mutationIds)');
    expect(reconciliation).toContain("fixtureIdsInAppState");
    expect(reconciliation).toContain("residualCount === 0");
    expect(reconciliation).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(reconciliation).not.toContain(".update({");
    expect(reconciliation).not.toContain('supabase.rpc("reject_');
    expect(reconciliation).not.toContain('supabase.rpc("start_session"');
    expect(reconciliation).not.toContain('supabase.rpc("link_customer_tab_continuation"');
  });

  it("clears hop continuation only from positive normalized terminal evidence", () => {
    const app = read("src/App.tsx");

    expect(app).toContain("lastHoppedSessionIdRef.current = sessionId");
    expect(app).toContain("const reconciledSessionId = lastHoppedSessionId");
    expect(app).toContain("hasHoppedSessionContinuationTerminalEvidence(");
    expect(app).toContain("const latestAppData = appDataRef.current");
    expect(app).toContain("lastHoppedSessionIdRef.current,");
    expect(app).toContain("latestAppData.sessions,");
    expect(app).not.toContain("observedNormalizedHoppedSessionIdsRef");
  });

  it("requires server acknowledgement and same-ID recovery for every backend rejection", () => {
    const app = read("src/App.tsx");
    const sessionReject = app.match(/async function rejectSession\([\s\S]*?async function hopSession/)?.[0] ?? "";
    const tabReject = app.match(/async function rejectCustomerTab\([\s\S]*?function openBillReplacement/)?.[0] ?? "";

    for (const source of [sessionReject, tabReject]) {
      expect(source).toContain('retryPolicy: "manual"');
      expect(source).toContain("optimistic: false");
      expect(source).toContain("acknowledgementRequired: true");
      expect(source).toContain('mutation.status === "failed"');
      expect(source).toContain("existingMutation: true");
      expect(source).toContain("await commitCriticalOperationalChange");
      expect(source).not.toContain("commitOperationalChange(mutation");
    }
  });

  it("serializes a two-reservation limited-stock race and cleans its dedicated fixture", () => {
    const scenario = read("tests/e2e/staging/release-b-limited-stock-v2.e2e.ts");

    expect(scenario).toContain('getByLabel("Opening Stock", { exact: true }).fill("2")');
    expect(scenario).toContain('response.url().includes("/rest/v1/rpc/add_customer_tab_item")');
    expect(scenario).toContain("const responses = await Promise.all([");
    expect(scenario).toContain('expect(responses.map((response) => response.status())).toEqual([200, 200])');
    expect(scenario).toContain("expect(new Set(bodies.map((body) => body.bill_id)).size).toBe(2)");
    expect(scenario).toContain("expect(new Set(bodies.map((body) => body.mutation_id)).size).toBe(2)");
    expect(scenario).toContain("expect(new Set(bodies.map((body) => body.event_id)).size).toBe(2)");
    expect(scenario).toContain("expect(inventoryIds[1]).toEqual(inventoryIds[0])");
    expect(scenario).toContain("expect(finalStock.stock).toBe(0)");
    expect(scenario).toContain('expect(errors[index].pageErrors).toEqual(["TypeError: Failed to fetch"])');
    expect(scenario).toContain('response.url().includes("/rest/v1/rpc/commit_admin_data_change")');
    expect(scenario).toContain("expect((await archived).status()).toBeLessThan(300)");
    expect(scenario).toContain("await expect(row).toHaveCount(0)");
    expect(scenario).toContain('E2E_V2_LIMITED_STOCK_CLEANUP_ONLY === "true"');
    expect(scenario).toContain('name: "Archive Item"');
    expect(scenario).toContain('expect(responses.map((response) => response.status())).toEqual([400, 400])');
    expect(scenario).toContain('expect(rejectionCodes).toEqual(["inventory_conflict", "inventory_conflict"])');
    expect(scenario).toContain("expect(mutationStatuses).toEqual([null, null])");
    expect(scenario).toContain("expect(stock.stock).toBe(0)");
    expect(scenario).toContain("normalizedStockExpected: 1");
    expect(scenario).toContain("expect(stock.text).toMatch(/in sessions/)");
    expect(scenario).toContain('"concurrent admin metadata save cannot restore checkout-consumed stock"');
    expect(scenario).toContain("expect(changedItem?.expectedStockQty).toBe(2)");
    expect(scenario).toContain("expect([200, 400]).toContain(adminResponse.status())");
    expect(scenario).toContain('expect(adminRejectionCode).toBe("inventory_conflict")');
    expect(scenario).toContain("expect(finalStock.stock).toBe(1)");
    expect(scenario).toContain("expect(checkoutCaptureCount).toBe(1)");
    expect(scenario).toContain("expect(adminCaptureCount).toBe(1)");
    expect(scenario).toContain("expect(originErrors.pageErrors.length).toBeLessThanOrEqual(1)");
    expect(scenario).toContain("expect(adminErrors.pageErrors.length).toBeLessThanOrEqual(1)");
    expect(scenario).toContain('message === "TypeError: Failed to fetch"');
    expect(scenario).toContain('"checkout-first stale-admin metadata save is rejected without restoring stock"');
    expect(scenario).toContain(': [await submitCheckout(), await submitAdmin()]');
    expect(scenario).toContain('if (ordering === "checkout-first")');
    expect(scenario).toContain("expect(adminResponse.status()).toBe(400)");
    expect(scenario).toContain('"metadata->>mutation_id": `eq.${adminMutationId}`');
    expect(scenario).toContain('capturedCheckout.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result")');
    expect(scenario).toContain("expect(actorIds.size).toBe(1)");
    expect(scenario).toContain('expect(JSON.stringify(appStateRows[0].data)).not.toContain("expectedStockQty")');
    expect(scenario).toContain("raceEvidence.databaseEvidence = {");
    expect(scenario).toContain('test("admin inventory lifecycle preserves stock and authenticated writes"');
    expect(scenario).toContain('getByRole("button", { name: "Restock", exact: true })');
    expect(scenario).toContain('getByRole("button", { name: "Deduct / Adjust", exact: true })');
    expect(scenario).toContain('getByRole("button", { name: "Restore", exact: true })');
    expect(scenario).toContain("expect(new Set(eventIds).size).toBe(6)");
  });

  it("binds checkout against every customer-tab source mutation with zero retries", () => {
    const contract = read("src/qa/customerTabMutationRace.ts");
    const scenario = read("tests/e2e/staging/release-b-checkout-tab-mutation-race-v2.e2e.ts");
    const cleanup = read("tests/e2e/staging/release-b-checkout-tab-mutation-race-cleanup.e2e.ts");
    const preflight = read("scripts/preflight-checkout-tab-mutation-race-staging.mjs");
    const reconciler = read("scripts/reconcile-checkout-tab-mutation-race-staging.mjs");
    const runner = read("scripts/run-checkout-tab-mutation-race-staging-e2e.mjs");
    const cleanupRunner = read("scripts/run-checkout-tab-mutation-race-cleanup-staging-e2e.mjs");
    const cleanupPostflight = read("scripts/reconcile-checkout-tab-mutation-race-cleanup-staging.mjs");
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    expect(contract).toContain('"add_item"');
    expect(contract).toContain('"update_item"');
    expect(contract).toContain('"remove_item"');
    expect(contract).toContain('"apply_combo"');
    expect(contract).toContain('rpc: "add_customer_tab_item"');
    expect(contract).toContain('rpc: "update_customer_tab_item_quantity"');
    expect(contract).toContain('rpc: "remove_customer_tab_item"');
    expect(contract).toContain('rpc: "apply_customer_tab_combo"');
    expect(contract).toContain("expectedAuditCount: 0");
    expect(contract).toContain("expectedReservationDelta: -1");
    expect(contract).toContain('return winner === "checkout" ? "customer_tab_not_open" : "source_item_mismatch"');
    expect(scenario).toContain("for (const mode of modes)");
    expect(scenario).toContain("for (const scenario of scenarios)");
    expect(scenario).toContain('scenario === "checkout_first"');
    expect(scenario).toContain('scenario === "mutation_first"');
    expect(scenario).toContain("await Promise.all([");
    expect(scenario).toContain("expect(checkoutCommand.captureCount()).toBe(1)");
    expect(scenario).toContain("expect(operationalCommand.captureCount()).toBe(1)");
    expect(scenario).toContain("expect(movementDelta).toEqual([])");
    expect(scenario).toContain("expect(physicalStockAfter).toBe(physicalStockBefore)");
    expect(scenario).toContain("expect(logicalReservation).toBe(1 + contract.expectedReservationDelta)");
    expect(scenario).toContain("expect(checkoutStatus).toBeNull()");
    expect(scenario).toContain("run the exact read-only reconciler before cleanup or retry");
    expect(preflight).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(preflight).toContain("actorsDistinct");
    expect(preflight).toContain("artifactCollisions.length === 0");
    expect(preflight).toContain('flag: "wx"');
    expect(preflight).not.toContain("PRODUCTION_PROJECT_REF).supabase.co");
    expect(reconciler).toContain('client.rpc("get_financial_mutation_result"');
    expect(reconciler).toContain("const safeForIdentityBoundCleanup = !postflight && failures.length === 0");
    expect(reconciler).toContain("safeForAutomaticRetry: false");
    expect(reconciler).toContain("productionAllowed: false");
    expect(reconciler).toContain("Current app_state version differs from the latest acknowledged compatibility-writing response.");
    expect(reconciler).toContain("Fixture stock movement IDs differ from checkout winners.");
    expect(reconciler).toContain('validateAdminLifecycle("fixture item creation"');
    expect(reconciler).toContain('validateAdminLifecycle("fixture combo creation"');
    expect(reconciler).toContain("validateOperationalLifecycle(`${key} tab open`");
    expect(reconciler).toContain("validateOperationalLifecycle(`${key} baseline item add`");
    expect(reconciler).toContain("rejected operational-winner cleanup");
    expect(reconciler).toContain("customer_tab_id: entry.tabId");
    expect(reconciler).toContain("customer_id: payload?.customer?.id");
    expect(reconciler).toContain("audit_log_id: payload?.auditLog?.id");
    expect(reconciler).toContain("released_continued_from_session_ids: []");
    expect(reconciler).toContain("const expectedOperationalMetadata = entry.mode === \"add_item\"");
    expect(reconciler).toContain("operationalAudit[0].message === operationalEnvelope.payload?.auditLog?.message");
    expect(reconciler).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(reconciler).not.toContain(".update({");
    expect(runner).toContain('E2E_TAB_MUTATION_RACE_MODES = "add_item,update_item,remove_item,apply_combo"');
    expect(runner).toContain('E2E_TAB_MUTATION_RACE_SCENARIOS = "checkout_first,mutation_first,simultaneous"');
    expect(runner).toContain('"--verify"');
    expect(cleanupRunner).toContain("recovery.safeForIdentityBoundCleanup !== true");
    expect(cleanupRunner).toContain("cleanupRunId === sourceRunId");
    expect(cleanupRunner).toContain("E2E_TAB_MUTATION_RECOVERY_SHA256");
    expect(cleanup).toContain("expect(identity.actorId).toBe(recovery.actors.checkout)");
    expect(cleanup).toContain("expect(openSessionsBefore).toEqual([])");
    expect(cleanup).toContain('response.url().includes("/rest/v1/rpc/reject_customer_tab")');
    expect(cleanup).toContain('checkpoint(`reject-${tab.id}-acknowledged`');
    expect(cleanup).toContain('checkpoint("combo-archive-acknowledged"');
    expect(cleanup).toContain('checkpoint("item-archive-acknowledged"');
    expect(cleanup).toContain('checkpoint("final", evidence)');
    expect(cleanupPostflight).toContain("Cleanup did not checkpoint the exact authorized recovery snapshot before its first write.");
    expect(cleanupPostflight).toContain("Compatibility version did not advance exactly once per acknowledged cleanup action.");
    expect(cleanupPostflight).toContain('if (!env.E2E_POSTFLIGHT_ID?.trim())');
    expect(cleanupPostflight).toContain("postflightId === cleanupRunId || postflightId === sourceRunId");
    expect(cleanupPostflight).toContain('key !== "operational_events"');
    expect(cleanupPostflight).toContain('changedIds(result, "operational_events").join() === event.id');
    expect(cleanupPostflight).toContain("safeForAutomaticRetry: false");
    expect(cleanupPostflight).toContain("productionAllowed: false");
    expect(cleanupPostflight).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(cleanupPostflight).not.toContain(".update({");
    expect(packageJson.scripts["test:e2e:staging:v2:checkout-tab-mutation-race:list"]).toContain("--list");
    expect(packageJson.scripts["test:db:staging:v2:checkout-tab-mutation-race:preflight"]).toBe(
      "node scripts/preflight-checkout-tab-mutation-race-staging.mjs"
    );
    expect(packageJson.scripts["test:db:staging:v2:checkout-tab-mutation-race:reconcile"]).toBe(
      "node scripts/reconcile-checkout-tab-mutation-race-staging.mjs"
    );
    expect(packageJson.scripts["test:db:staging:v2:checkout-tab-mutation-race:postflight"]).toContain("--postflight");
    expect(packageJson.scripts["test:e2e:staging:v2:checkout-tab-mutation-race:cleanup:list"]).toContain("--list");
    expect(packageJson.scripts["test:db:staging:v2:checkout-tab-mutation-race:cleanup:postflight"]).toBe(
      "node scripts/reconcile-checkout-tab-mutation-race-cleanup-staging.mjs"
    );
  });

  it("locks one hopped session against two distinct checkout mutations", () => {
    const scenario = read("tests/e2e/staging/release-b-hopped-concurrency-v2.e2e.ts");

    expect(scenario).toContain('getByLabel(/Game hop - close station without billing/).check()');
    expect(scenario).toContain('getByRole("button", { name: "Bill & Done", exact: true }).click()');
    expect(scenario).toContain("const responses = await Promise.all([");
    expect(scenario).toContain('expect(loserDetails.code).toBe("session_not_billable")');
    expect(scenario).toContain("expect(await loserStatus.json()).toBeNull()");
    expect(scenario).toContain("expect(replayBody.bill_id).toBe(bodies[winnerIndex].bill_id)");
    expect(scenario).toContain("expect(replayBody.event_id).toBe(bodies[winnerIndex].event_id)");
  });

  it("locks a complete three-session hop chain against two single-send checkout commands", () => {
    const scenario = read("tests/e2e/staging/release-b-multihop-concurrency-v2.e2e.ts");
    const support = read("tests/e2e/staging/support/app.ts");
    const startSessionSql = read("supabase/phase4-start-session-rpc.sql");
    const hopSessionSql = read("supabase/phase4-hop-session-rpc.sql");
    const manifestGenerator = read("scripts/generate-checkout-review-manifest.mjs");

    expect(scenario).toContain('test.describe.serial("Release B admin multi-hop checkout concurrency"');
    expect(scenario).toContain("await editAndHop(-12, -9, 1)");
    expect(scenario).toContain("await editAndHop(-8, -5, 2)");
    expect(scenario).toContain('getByText("Station", { exact: true })');
    expect(scenario).toContain('locator("xpath=ancestor::label")');
    expect(scenario).toContain("expect(new Set(chainSessionIds).size).toBe(3)");
    expect(scenario).toContain('interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2")');
    expect(scenario).toContain('interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/commit_checkout_bill_v2")');
    expect(scenario).toContain("originCommand.submit(envelopes[0])");
    expect(scenario).toContain("observerCommand.submit(envelopes[1])");
    expect(scenario).toContain("captureAuthenticatedRestRequests(page, originAuthenticatedRequests)");
    expect(support).toContain('if (!url.pathname.includes("/rest/v1/")) return');
    expect(scenario).toContain("restApiBase(observerPreflightRequest!.url)");
    expect(scenario).toContain('const organizationId = "org-primary"');
    expect(scenario).toContain("configuredOrganizationId && configuredOrganizationId !== organizationId");
    expect(scenario).toContain("Multi-hop staging E2E is locked to organization");
    expect(scenario).toContain('select: "id,role,active"');
    expect(scenario).not.toContain('select: "id,organization_id,role,active"');
    expect(scenario).toContain("const [authoritativeRoles, beforeAppState, timingRows] = await Promise.all([");
    expect(scenario).toMatch(/expect\(roleValues\)\.toEqual\(\["admin", "admin"\]\);[\s\S]*originCommand = await interceptSingleRpcCommand/);
    expect(scenario).toMatch(/expect\(compatibilityStart,[\s\S]*originCommand = await interceptSingleRpcCommand/);
    expect(scenario).toMatch(/raceStarted = true;[\s\S]*originCommand\.submit\(envelopes\[0\]\)/);
    expect(scenario).toContain("originCommand ? originCommand.dispose() : Promise.resolve()");
    expect(scenario).toContain("observerCommand ? observerCommand.dispose() : Promise.resolve()");
    expect(scenario).toContain("expect(sourceSessionIds).toHaveLength(3)");
    expect(scenario).toContain("expect([...sourceSessionIds].sort()).toEqual(expectedChainSessionIds)");
    expect(scenario).toContain("expect(submittedSessionUpdateIds).toHaveLength(3)");
    expect(scenario).toContain('select: "id,started_at,raw_data"');
    expect(scenario).toContain("const carriedSessionIds = chainSessionIds.slice(0, -1)");
    expect(scenario).toContain('`${sessionId} carried compatibility multiplicity`');
    expect(scenario).toContain('`${primarySessionId} normalized-only primary compatibility absence`');
    expect(startSessionSql).not.toContain("update public.app_state");
    expect(hopSessionSql).toContain("update public.app_state");
    expect(hopSessionSql).toContain("public.patch_app_state_array_by_id");
    expect(scenario).toContain('`${sessionId} typed start presence`');
    expect(scenario).toContain('`${sessionId} typed start validity`');
    expect(scenario).toContain('`${sessionId} normalized/raw start`');
    expect(scenario).toContain('`${sessionId} normalized/compatibility start`');
    expect(scenario).toContain('`${envelope.payload.mutation_id} ${sessionId} submitted start validity`');
    expect(scenario).toContain('`${envelope.payload.mutation_id} ${sessionId} submitted/typed start`');
    expect(scenario).toContain("responseStatuses: responses.map((response) => response.status())");
    expect(scenario).toContain("responseBodies: bodies");
    expect(scenario).toContain('expect(rpcRejectionCode(bodies[loserIndex])).toBe("session_not_billable")');
    expect(scenario).toContain("expect(mutationStatusBodies[loserIndex]).toBeNull()");
    expect(scenario).toContain("expect(winnerChangedSessionIds).toHaveLength(3)");
    expect(scenario).toContain("expect([...winnerChangedSessionIds].sort()).toEqual(expectedChainSessionIds)");
    expect(scenario).toContain("expect(sessionChargeRows).toHaveLength(3)");
    expect(scenario).toContain("expect(appStateHashAfter).toBe(appStateHashBefore)");
    expect(scenario).toContain("expect(originCommand.captureCount()).toBe(1)");
    expect(scenario).toContain("expect(observerCommand.captureCount()).toBe(1)");
    expect(scenario).toContain("expect(errorCaptures[winnerIndex].pageErrors).toEqual([])");
    expect(scenario).toContain("expect(errorCaptures[loserIndex].pageErrors).toHaveLength(1)");
    expect(scenario).toContain("if (hasCommittedHop || !rejected)");
    expect(scenario).not.toContain("replay");
    expect(manifestGenerator).toContain('path === "tests/e2e/staging/release-b-multihop-concurrency-v2.e2e.ts"');
    expect(manifestGenerator).toContain('"bill_lines"');
  });

  it("reconciles an exact rejected staging race without issuing another mutation", () => {
    const script = read("scripts/reconcile-financial-v2-staging.mjs");

    expect(script).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(script).toContain("E2E_RECONCILE_MUTATION_IDS");
    expect(script).toContain("E2E_RECONCILE_BILL_IDS");
    expect(script).toContain("E2E_RECONCILE_SESSION_IDS");
    expect(script).toContain("mutationIds.length !== expectedMutationCount");
    expect(script).toContain("billIds.length !== expectedBillCount");
    expect(script).toContain("sessionIds.length !== expectedSessionCount");
    expect(script).toContain("expectedSessionCount !== 3");
    expect(script).toContain('supabase.rpc("get_financial_mutation_result"');
    expect(script).not.toContain('supabase.rpc("commit_checkout_bill_v2"');
    expect(script).toContain("mutationStatuses.some((entry) => entry.result !== null)");
    expect(script).toContain("bills.data.length || payments.data.length || events.data.length");
    expect(script).toContain('firstSession.status !== "closed" || firstSession.close_disposition !== "hopped"');
    expect(script).toContain('thirdSession.status !== "active"');
    expect(script).toContain("JSON.stringify([firstSessionId, secondSessionId])");
    expect(script).toContain("appState.data.version !== expectedAppStateVersion");
  });

  it("retains a single-send active three-session cleanup after a rejected race", () => {
    const scenario = read("tests/e2e/staging/release-b-active-multihop-cleanup-v2.e2e.ts");

    expect(scenario).toContain('test("bills one exact active three-session chain once"');
    expect(scenario).toContain("sourceSessionIds.length !== 3 || new Set(sourceSessionIds).size !== 3");
    expect(scenario).toContain('expect(managed.getByLabel("Customer Name", { exact: true })).toHaveValue(customerName!)');
    expect(scenario).toContain("expect(envelope.payload.payload.source_session_ids).toHaveLength(3)");
    expect(scenario).toContain("expect(submittedSessionIds).toHaveLength(3)");
    expect(scenario).toContain("expect(envelope.payload.payload.primary_bill.lines).toHaveLength(3)");
    expect(scenario).toContain("expect(linkedLineSessionIds).toHaveLength(3)");
    expect(scenario).toContain('status: "active", close_disposition: null, continued_from_session_ids: [firstId, secondId]');
    expect(scenario).toContain("expect(appStateBefore[0].version).toBe(expectedAppStateVersion)");
    expect(scenario).toContain('E2E_GUARDED_ACTIVE_CAPTURE_ONLY === "true"');
    expect(scenario).toContain("await command.settled");
    expect(scenario).toContain("submittedSessionUpdates: envelope.payload.payload.session_updates");
    expect(scenario).toContain("timingComparisons");
    expect(scenario).toContain("comparison.startedAtMatches");
    expect(scenario).toContain("comparison.endedAtMatches");
    expect(scenario).toContain("const response = await command.submit(envelope)");
    expect(scenario).toContain("responseStatus: response.status(), responseBody: body");
    expect(scenario).toContain("expect(changedSessionIds).toHaveLength(3)");
    expect(scenario).toContain("expect(lines).toHaveLength(3)");
    expect(scenario).toContain("expect(persistedLinkedIds).toHaveLength(3)");
    expect(scenario).toContain("reconcile its exact mutation ID before any cleanup or retry");
  });

  it("retains an exact-identity single-send recovery for an abandoned staging hopped session", () => {
    const scenario = read("tests/e2e/staging/release-b-multihop-concurrency-v2.e2e.ts");

    expect(scenario).toContain('test("guardedly bills one exact abandoned hopped QA session"');
    expect(scenario).toContain("E2E_GUARDED_HOPPED_SESSION_ID");
    expect(scenario).toContain("E2E_GUARDED_HOPPED_CUSTOMER");
    expect(scenario).toContain("E2E_GUARDED_HOPPED_STATION");
    expect(scenario).toContain("E2E_GUARDED_HOPPED_SOURCE_IDS");
    expect(scenario).toContain("E2E_GUARDED_HOPPED_SOURCE_COUNT");
    expect(scenario).toContain("expect(envelope.payload.entity_id).toBe(guardedCleanupSessionId)");
    expect(scenario).toContain("expect(guardedCleanupSourceSessionIds).toHaveLength(guardedCleanupExpectedSourceCount)");
    expect(scenario).toContain("expect(new Set(guardedCleanupSourceSessionIds).size).toBe(guardedCleanupExpectedSourceCount)");
    expect(scenario).toContain("expect([...envelope.payload.payload.source_session_ids].sort()).toEqual(expectedSourceIds)");
    expect(scenario).toContain("expect(submittedSessionUpdateIds).toHaveLength(guardedCleanupExpectedSourceCount)");
    expect(scenario).toContain("expect(envelope.payload.payload.primary_bill.lines).toHaveLength(1)");
    expect(scenario).toContain("linkedSessionId: guardedCleanupSessionId");
    expect(scenario).toContain("expect(submittedStart).toBe(typedStart)");
    expect(scenario).toContain("expect(submittedEnd).toBe(typedEnd)");
    expect(scenario).toContain("expect(changedSessionIds).toHaveLength(guardedCleanupExpectedSourceCount)");
    expect(scenario).toContain('"bill_lines"');
    expect(scenario).toContain("expect(billLineRows).toHaveLength(1)");
    expect(scenario).toContain("linked_session_id: guardedCleanupSessionId");
    expect(scenario).toContain('close_disposition: "hopped"');
    expect(scenario).toContain("station_name_snapshot: guardedCleanupStation");
    expect(scenario).toContain("customer_name: guardedCleanupCustomer");
    expect(scenario).toContain("continued_from_session_ids");
    expect(scenario).toContain("const response = await command.submit(envelope)");
    expect(scenario).toContain("expect(command.captureCount()).toBe(1)");
    expect(scenario).toContain("reconcile its mutation ID before any cleanup or retry");
  });

  it("captures the pending operational conflict queue in multi-hop failure evidence", () => {
    const scenario = read("tests/e2e/staging/release-b-multihop-concurrency-v2.e2e.ts");
    const support = read("tests/e2e/staging/support/app.ts");

    expect(support).toContain("game-parlour-management-system/pending-operations/v1");
    expect(scenario).toContain("readPendingOperationalMutations(page)");
    expect(scenario).toContain("pendingOperationalMutations,");
  });

  it("serializes both checkout versus rejection orderings with exact reconciliation", () => {
    const scenario = read("tests/e2e/staging/release-b-checkout-reject-race-v2.e2e.ts");
    const manifestGenerator = read("scripts/generate-checkout-review-manifest.mjs");

    expect(scenario).toContain('for (const ordering of ["checkout-first", "reject-first"] as const)');
    expect(scenario).toContain("checkoutResponse = await checkoutCommand.submit(checkoutEnvelope)");
    expect(scenario).toContain("rejectResponse = await rejectCommand.submit(capturedReject.body)");
    expect(scenario).toContain('expect(rpcRejectionCode(rejectBody)).toBe("session_not_open")');
    expect(scenario).toContain('expect(rpcRejectionCode(checkoutBody)).toBe("session_not_billable")');
    expect(scenario).toContain('capturedCheckout.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result")');
    expect(scenario).toContain("expect(mutationStatus).toBeNull()");
    expect(scenario).toContain("expect(afterAppState[0].version).toBe(beforeAppState[0].version)");
    expect(scenario).toContain("expect(afterAppState[0].version).toBe(beforeAppState[0].version + 1)");
    expect(scenario).toContain("const expectedWinnerActorId = ordering === \"checkout-first\" ? checkoutActorId : rejectActorId");
    expect(scenario).toContain("expect([...actorIds]).toEqual([expectedWinnerActorId])");
    expect(scenario).toContain("checkoutAuditRows.forEach((audit) => actorIds.add(audit.user_id))");
    expect(scenario).toContain("expect(Number(billRows[0].amount_paid)).toBe(Number(billRows[0].total))");
    expect(scenario).toContain("expect(checkoutCommand.captureCount()).toBe(1)");
    expect(scenario).toContain("expect(rejectCommand.captureCount()).toBe(1)");
    expect(scenario).toContain('getByText("1 conflict", { exact: true })');
    expect(scenario).toContain('getByRole("button", { name: "Clear", exact: true }).click()');
    expect(scenario).toContain('entry.rpc === "start_session" && entry.status < 300');
    expect(scenario).toContain('page.off("dialog", dismissOriginDialog)');
    expect(scenario).toContain("expect(originErrors.pageErrors).toHaveLength(1)");
    expect(scenario).toContain("/The primary session is no longer billable\\.?/i");
    expect(scenario).toContain("raceStarted && !raceResolved");
    expect(scenario).toContain("reconcile their mutation IDs before any cleanup or retry");
    expect(manifestGenerator).toContain('path === "tests/e2e/staging/release-b-checkout-reject-race-v2.e2e.ts"');
    expect(manifestGenerator).toContain('names.add("customers")');
    expect(manifestGenerator).toContain('"save_live_session_details"');
    expect(manifestGenerator).toContain('"commit_checkout_bill_v2"');
    expect(manifestGenerator).toContain('"reject_session"');
    expect(manifestGenerator).toContain('"get_financial_mutation_result"');
    expect(manifestGenerator).toContain('path === "supabase/phase4-hop-session-rpc.sql"');
    expect(manifestGenerator).toContain('"src/dataGateway/operationalSqlContract.test.ts"');
  });

  it("reuses a single-send controller for checkout versus hop in both orders and concurrently", () => {
    const support = read("tests/e2e/staging/support/app.ts");
    const scenario = read("tests/e2e/staging/release-b-checkout-hop-race-v2.e2e.ts");
    const manifestGenerator = read("scripts/generate-checkout-review-manifest.mjs");

    expect(support).toContain("export async function interceptSingleRpcCommand");
    expect(support).toContain('await manageButton.press("Enter")');
    expect(support).toContain("const isPrimaryCapture = captureCount === 1");
    expect(support).toContain("if (isPrimaryCapture)");
    expect(support).toContain("settled,");
    expect(scenario).toContain('test.describe.serial("Release B admin checkout versus game-hop concurrency"');
    expect(support).toContain('await abortIgnoringHandledRoute(route, "blockedbyclient")');
    expect(support).toContain('await abortIgnoringHandledRoute(route, "aborted")');
    expect(support).toContain('if (!/Route is already handled!?/i.test(message)) throw error');
    expect(support).toContain("async dispose()");
    expect(support).toContain("if (!primaryCaptured) settleOnce()");
    expect(support).toContain("await route.fetch({ postData: JSON.stringify(next.body), timeout: 30_000 })");
    expect(support).toContain("await route.fulfill({ response: serverResponse })");
    expect(support).toContain("command can only be submitted once");
    expect(scenario).toContain('for (const ordering of ["checkout-first", "hop-first", "concurrent"] as const)');
    expect(scenario).toContain('interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/hop_session")');
    expect(scenario).toContain('fill(checkoutEndAt)');
    expect(scenario).toContain('fill(hopEndAt)');
    expect(scenario).toContain('role: "admin", active: true');
    expect(scenario).toContain('rpc/current_user_org_role');
    expect(scenario).toContain('expect(checkoutOrgRole).toBe("admin")');
    expect(scenario).toContain('expect(hopOrgRole).toBe("admin")');
    expect(scenario).toContain("checkoutResponse = await checkoutCommand.submit(checkoutEnvelope)");
    expect(scenario).toContain("hopResponse = await hopCommand.submit(capturedHop.body)");
    expect(scenario).toContain("[checkoutResponse, hopResponse] = await Promise.all([");
    expect(scenario).toContain("expect(checkoutResponse.status()).toBe(200)");
    expect(scenario).toContain('expect(rpcRejectionCode(hopBody)).toBe("session_not_open")');
    expect(scenario).toContain('close_disposition: "billed"');
    expect(scenario).toContain("expect(afterAppState[0].version).toBe(beforeAppState[0].version + 1)");
    expect(scenario).toContain("expect(afterAppState[0].version).toBe(beforeAppState[0].version)");
    expect(scenario).toContain("expect([...checkoutActorIds]).toEqual([checkoutActorId])");
    expect(scenario).toContain("expect(checkoutCommand.captureCount()).toBe(1)");
    expect(scenario).toContain("expect(hopCommand.captureCount()).toBe(1)");
    expect(scenario).toContain('getByText("1 conflict", { exact: true })');
    expect(scenario).toContain("staleContinuationClosedBeforeReload");
    expect(scenario).toContain("The game hop was not completed. Latest data has been refreshed; review the session and try again.");
    expect(scenario).toContain("reconcile their mutation IDs before any cleanup or retry");
    expect(manifestGenerator).toContain('path === "tests/e2e/staging/release-b-checkout-hop-race-v2.e2e.ts"');
    expect(manifestGenerator).toContain('"hop_session"');
    expect(manifestGenerator).toContain('"current_user_org_role"');
  });

  it("gates the receptionist-manager timing matrix behind distinct authoritative staging identities", () => {
    const support = read("tests/e2e/staging/support/app.ts");
    const runner = read("scripts/run-financial-v2-role-matrix-staging-e2e.mjs");
    const scenario = read("tests/e2e/staging/release-b-role-checkout-hop-timing-v2.e2e.ts");
    const financialRpcClient = read("src/dataGateway/financialRpcClient.ts");
    const example = read(".env.e2e.roles.example");
    const packageJson = read("package.json");

    expect(example).toContain("E2E_RECEPTIONIST_USER=staging_receptionist_username");
    expect(example).toContain("E2E_MANAGER_USER=staging_manager_username");
    expect(runner).toContain('parseEnvFile(path.join(root, ".env.e2e.roles.local"))');
    expect(runner).toContain('roleEnv.E2E_ROLE_ACCOUNT_STATE?.trim() !== "active"');
    expect(runner).toContain("env.E2E_USER_A = roleEnv.E2E_RECEPTIONIST_USER");
    expect(runner).toContain("The role matrix requires distinct receptionist and manager accounts.");
    expect(runner).not.toContain("admin-update-user");
    expect(runner).toContain("The role-matrix runner accepts no argument or exactly one documented mode.");
    expect(runner).toContain('env.E2E_ROLE_MATRIX_PHASE = remainingThreeOnly ? "remaining-three" : remainingOnly ? "remaining" : "all"');
    expect(runner).toContain('mode.endsWith("-list") ? ["--list"] : []');
    expect(runner).not.toContain("[runner, scenario, ...args]");
    expect(runner).toContain('env.E2E_ROLE_MATRIX = "release-b-receptionist-manager"');
    expect(runner).toContain("release-b-role-checkout-hop-timing-v2.e2e.ts");
    expect(packageJson).toContain('"test:e2e:staging:v2:roles:remaining": "node scripts/run-financial-v2-role-matrix-staging-e2e.mjs --remaining"');
    expect(packageJson).toContain('"test:e2e:staging:v2:roles:remaining:list": "node scripts/run-financial-v2-role-matrix-staging-e2e.mjs --remaining-list"');
    expect(packageJson).toContain('"test:e2e:staging:v2:roles:remaining-three": "node scripts/run-financial-v2-role-matrix-staging-e2e.mjs --remaining-three"');
    expect(packageJson).toContain('"test:e2e:staging:v2:roles:remaining-three:list": "node scripts/run-financial-v2-role-matrix-staging-e2e.mjs --remaining-three-list"');
    expect(support).toContain("export async function assertAuthoritativeOrganizationIdentity");
    expect(support).toContain('rpc/current_user_org_role');
    expect(support).toContain("expect(profiles[0]).toMatchObject({ id: actorId, role: expectedRole, active: true })");
    expect(scenario).toContain('process.env.E2E_ROLE_MATRIX !== ROLE_MATRIX_CONFIRMATION');
    expect(scenario).toContain('writesAttempted: false');
    expect(scenario).toContain("expect(cleanupPayments).toHaveLength(cleanupAmountPaid > 0 ? 1 : 0)");
    expect(scenario).toContain("...cleanupPayments.map((payment) => payment.received_by_user_id)");
    expect(scenario).not.toContain("cleanupPayments[0].received_by_user_id");
    expect(scenario).toContain('expect(receptionist.actorId).not.toBe(manager.actorId)');
    expect(scenario).toContain('matrixPhase === "remaining"');
    expect(scenario).toContain('scenarios.filter((scenario) => scenario.ordering !== "checkout-first")');
    expect(scenario).toContain('matrixPhase === "remaining-three"');
    expect(scenario).toContain('scenarios.filter((scenario) => remainingThreeScenarioIds.has(scenario.id))');
    expect(scenario).toContain('for (const scenario of selectedScenarios)');
    expect(scenario).toContain('ordering: "checkout-first"');
    expect(scenario).toContain('ordering: "hop-first"');
    expect(scenario).toContain('ordering: "concurrent"');
    expect(scenario).toContain('getByLabel("Session Start Time", { exact: true })');
    expect(scenario).toContain('getByLabel("Session End Time", { exact: true })).toHaveCount(0)');
    expect(scenario).not.toContain('.fill(checkoutEndAt)');
    expect(scenario).not.toContain('.fill(hopEndAt)');
    expect(scenario.indexOf("const [beforeSession, beforeAppState]")).toBeLessThan(
      scenario.indexOf("checkoutCommand = await interceptSingleRpcCommand")
    );
    expect(scenario).toContain('entry.rpc === "start_session" && entry.status < 300');
    expect(financialRpcClient).toContain("session_updates: FinancialCheckoutPatch[\"sessions\"]");
    expect(scenario).toContain("FinancialCheckoutV2RpcPayloadEnvelope");
    expect(scenario).toContain("payload.session_updates.find");
    expect(scenario).not.toContain("payload.sessions.find");
    expect(scenario).toContain('expect(rpcRejectionCode(checkoutBody)).toBe("invalid_session_timing")');
    expect(scenario).toContain('expect(rpcRejectionCode(hopBody)).toBe("session_not_open")');
    expect(scenario).toContain("expect(paymentRows).toHaveLength(billTotal === 0 ? 0 : 1)");
    expect(scenario).toContain("paymentRows.reduce((sum, payment) => sum + Number(payment.amount), 0)");
    expect(scenario).toContain("...paymentRows.map((payment) => payment.received_by_user_id)");
    expect(scenario).not.toContain("paymentRows[0].received_by_user_id");
    expect(scenario).toContain("hopDialogs.every((message) => [syncGuardDialog, refreshedConflictDialog].includes(message))");
    expect(scenario).toContain("if (!checkoutCommitted) expect(hopDialogs).not.toContain(refreshedConflictDialog)");
    expect(scenario).not.toContain('expect(hopDialogs).toContain("The game hop was not completed.');
    expect(scenario).toContain('getByRole("button", { name: "Bill & Done", exact: true }).click()');
    expect(scenario).toContain('expect(cleanupAppState).toEqual(afterRaceAppState)');
    expect(scenario).toContain("expect(cleanupCommand.captureCount()).toBe(1)");
    expect(scenario).toContain("expect(cleanupMutationStatus?.bill_id).toBe(cleanupBillId)");
    expect(scenario).toContain('expect(cleanupLines).toHaveLength(1)');
    expect(scenario).toContain('type: "session_charge", linked_session_id: sessionId');
    expect(scenario).toContain("if (!cleanupConfirmed)");
    expect(scenario).toContain("Pre-race cleanup did not positively confirm rejection of the exact QA session.");
    expect(scenario).toContain("reconcile their mutation IDs and any hopped session before cleanup or retry");
  });

  it("provisions and deactivates dedicated role accounts without exposing their passwords", () => {
    const manager = read("scripts/manage-financial-v2-role-accounts-staging.mjs");

    expect(manager).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(manager).toContain("assertStagingBaseUrl");
    expect(manager).toContain('await authoritativeRole(adminPage, adminRequest, "admin")');
    expect(manager).toContain('await authoritativeRole(page, request, account.role)');
    expect(manager).toContain('url.hostname !== `${STAGING_PROJECT_REF}.supabase.co`');
    expect(manager).toContain("captured.url.includes(PRODUCTION_PROJECT_REF)");
    expect(manager).toContain("expect(identities[0].actorId).not.toBe(identities[1].actorId)");
    expect(manager).toContain('writeRoleFile(accounts, "provisioning")');
    expect(manager).toContain('writeRoleFile(accounts, "active")');
    expect(manager).toContain('writeRoleFile(accounts, "recovery_required")');
    expect(manager).toContain('writeRoleFile(accounts, "deactivation_incomplete")');
    expect(manager).toContain('for (const account of [...accounts].reverse())');
    expect(manager).toContain('Both deterministic candidates were reconciled:');
    expect(manager).toContain('Provisioning cleanup is unresolved:');
    expect(manager).toContain('passwordsPrinted: false');
    expect(manager).not.toContain("console.log(account.password)");
    expect(manager).toContain("await disableUser(adminPage, adminRequest, account, true)");
    expect(manager).toContain('async function authoritativeProfile(page, captured, account)');
    expect(manager).toContain('await page.request.get(`${restBase}/profiles`');
    expect(manager).toContain('await expect.poll(async () => (await authoritativeProfile(page, captured, account))?.active).toBe(false)');
    expect(manager).toContain("exactAccountsFromRoleFile()");
    expect(manager).toContain("The ignored role credential file does not match the exact generated QA username/run-ID pattern.");
    expect(manager).toContain("const UI_TIMEOUT_MS = 20_000");
    expect(manager).toContain('page.locator(".login-form-panel .error-text")');
    expect(manager).toContain("Staging account sign-in failed:");
    expect(manager).toContain('form.locator("select").selectOption(account.role)');
    expect(manager).toContain("await expect(row).toContainText(account.name)");
    expect(manager).toContain("await expect(row).toContainText(account.role)");
    expect(manager).toContain("unlinkSync(rolePath)");
    expect(manager).toContain('new Set(["create", "deactivate"])');
  });

  it("keeps exact staging session inspection read-only, role-bound, and password-free", () => {
    const inspector = read("scripts/inspect-staging-sessions.mjs");

    expect(inspector).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(inspector).toContain('new URL(supabaseUrl).hostname !== `${STAGING_PROJECT_REF}.supabase.co`');
    expect(inspector).toContain('new Set(["admin", "manager", "receptionist"])');
    expect(inspector).toContain('select("id,bill_number,status,total,amount_paid,amount_due,payment_mode,issued_by_user_id,created_at")');
    expect(inspector).toContain('select("id,bill_id,amount,mode,received_by_user_id,paid_at")');
    expect(inspector).toContain('const auditIds = (env.E2E_INSPECT_AUDIT_IDS ?? "")');
    expect(inspector).toContain('select("id,event_type,entity_id,metadata,created_at,created_by")');
    expect(inspector).toContain("if (auditIds.length && exactAudits.data.length !== auditIds.length)");
    expect(inspector).toContain('supabase.rpc("get_financial_mutation_result"');
    expect(inspector).toContain('mutation_kind: "commitCheckoutBill"');
    expect(inspector).toContain("passwordsPrinted: false");
    expect(inspector).not.toContain("login.data.session");
  });

  it("retains a rollback-only staging role-authorization proof", () => {
    const proof = read(
      "openspec/changes/financial-checkout-app-state-decoupling/release-b-role-authorization-proof.sql"
    );

    expect(proof).toContain("This script must never be run against production");
    expect(proof).toContain("begin;");
    expect(proof).toContain("set local role authenticated;");
    expect(proof).toContain("v_code <> 'role_access_denied'");
    expect(proof).toContain("v_code = 'role_access_denied'");
    expect(proof).toContain("rollback;");
    expect(proof).toContain("restored_membership_role");
  });

  it("retains a rollback-only staging inactive-user authorization proof", () => {
    const proof = read(
      "openspec/changes/financial-checkout-app-state-decoupling/release-b-inactive-authorization-proof.sql"
    );

    expect(proof).toContain("This script must never be run against production");
    expect(proof).toContain("update public.profiles set active = false");
    expect(proof).toContain("Profile trigger did not deactivate the organization membership");
    expect(proof).toContain("set local role authenticated;");
    expect(proof.match(/v_code <> 'organization_access_denied'/g)).toHaveLength(2);
    expect(proof).toContain("rollback;");
    expect(proof).toContain("restored_profile_active");
    expect(proof).toContain("restored_membership_active");
  });
});
