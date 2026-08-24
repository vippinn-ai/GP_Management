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
  });

  it("reuses a single-send controller for checkout versus hop in both orders and concurrently", () => {
    const support = read("tests/e2e/staging/support/app.ts");
    const scenario = read("tests/e2e/staging/release-b-checkout-hop-race-v2.e2e.ts");
    const manifestGenerator = read("scripts/generate-checkout-review-manifest.mjs");

    expect(support).toContain("export async function interceptSingleRpcCommand");
    expect(scenario).toContain('test.describe.serial("Release B admin checkout versus game-hop concurrency"');
    expect(support).toContain('await route.abort("blockedbyclient")');
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
