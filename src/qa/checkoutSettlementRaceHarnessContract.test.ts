import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("checkout-settlement race harness contract", () => {
  it("locks one reusable zero-retry case to staging", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const runner = read("scripts/run-checkout-settlement-race-staging-e2e.mjs");
    const scenario = read("tests/e2e/staging/release-b-checkout-settlement-race-v2.e2e.ts");

    expect(packageJson.scripts["test:e2e:staging:v2:checkout-settlement-race"]).toBe(
      "node scripts/run-checkout-settlement-race-staging-e2e.mjs"
    );
    expect(packageJson.scripts["test:e2e:staging:v2:checkout-settlement-race:list"]).toBe(
      "node scripts/run-checkout-settlement-race-staging-e2e.mjs --list"
    );
    expect(packageJson.scripts["test:db:staging:v2:checkout-settlement-race:preflight"]).toBe(
      "node scripts/preflight-checkout-settlement-race-staging.mjs"
    );
    expect(runner).toContain('const allowed = new Set(["--list"])');
    expect(runner).toContain("args.length > 1");
    expect(runner).toContain("run-financial-v2-staging-e2e.mjs");
    expect(runner).toContain("release-b-checkout-settlement-race-v2.e2e.ts");
    expect(scenario).toContain('interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2")');
    expect(scenario).toContain("settlementCommand = await interceptSingleRpcCommand(");
    expect(scenario).toContain('"**/rest/v1/rpc/commit_financial_adjustment_v2"');
    expect(scenario).toContain("checkoutCommand.submit(checkoutEnvelope)");
    expect(scenario).toContain("settlementCommand.submit(adjustmentEnvelope)");
    expect(scenario).toContain('winner.kind === "checkout"');
    expect(scenario).toContain('"financial_adjustment_conflict"');
    expect(scenario).toContain('"settlement_conflict"');
    expect(scenario).toContain("authoritativePendingBillBefore: livePendingBill");
    expect(scenario).not.toContain("expect(originRest).toEqual");
    expect(scenario).toContain("expect(originRest?.restBase).toBe(restBase)");
    expect(scenario).toContain("expect(authenticatedJwtSubject(originRest?.headers ?? {})).toBe(checkoutActorId)");
    expect(scenario).toContain("checkoutMutationId: checkoutEnvelope.payload.mutation_id");
    expect(scenario).toContain("adjustmentMutationId: adjustmentEnvelope.payload.mutation_id");
    expect(scenario).toContain("expect(winnerMutationStatus).toEqual(winner.body)");
    expect(scenario).toContain("expect(pendingPayments).toHaveLength(1)");
    expect(scenario).toContain("expect(settlementAudits).toHaveLength(1)");
    expect(scenario).toContain("Cleanup did not reject the exact open second session.");
    expect(scenario).toContain("expect(appStateHash(afterAppState[0].data)).toBe(appStateHashBefore)");
    expect(scenario).toContain("command.settled.catch(() => undefined)");
    expect(scenario.indexOf("command.settled.catch(() => undefined)")).toBeLessThan(
      scenario.indexOf("checkoutCommand?.dispose()")
    );
    expect(scenario).toContain("const quiescenceResults = await Promise.allSettled");
    expect(scenario).not.toContain('page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined)');
    expect(scenario).not.toContain('observer.page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined)');
    expect(scenario).toContain("if (!target.isClosed()) await target.close({ runBeforeUnload: false })");
    expect(scenario.indexOf("await target.close({ runBeforeUnload: false })")).toBeLessThan(
      scenario.indexOf("checkoutCommand?.dispose()")
    );
    expect(scenario).toContain("external reconciliation is required");
    expect(scenario).toContain("quiescenceError,");
    expect(scenario).toContain("primaryError: sanitizedErrorMessage(primaryError)");
    expect(scenario).not.toContain("primaryError instanceof Error ? primaryError.message : primaryError");
  });

  it("keeps the shared interceptor installed until its request settles", () => {
    const support = read("tests/e2e/staging/support/app.ts");
    const settledAt = support.indexOf("await settled;");
    const unrouteAt = support.indexOf("await page.unroute(pattern, handler);");

    expect(settledAt).toBeGreaterThan(-1);
    expect(unrouteAt).toBeGreaterThan(settledAt);
  });

  it("requires an exact read-only race preflight", () => {
    const preflight = read("scripts/preflight-checkout-settlement-race-staging.mjs");

    expect(preflight).toContain("assertStagingSupabaseEnvironment(stagingEnv, true)");
    expect(preflight).toContain("const runId = sanitizeRunId(env.E2E_RUN_ID)");
    expect(preflight).toContain('const organizationId = "org-primary"');
    expect(preflight).toContain('const retainedBillId = "bill-ea56ff7e-6233-46b0-8514-82cb7851e6f6"');
    expect(preflight).toContain('const retainedBillNumber = "BILL-20260827-001"');
    expect(preflight).toContain('retainedBill.status === "pending"');
    expect(preflight).toContain("Number(retainedBill.total) === 45");
    expect(preflight).toContain("retainedPayments.data.length === 0");
    expect(preflight).toContain("runSessions.data.length === 0");
    expect(preflight).toContain("runBills.data.length === 0");
    expect(preflight).toContain("artifactCollisions.length === 0");
    expect(preflight).toMatch(/const origin = await authenticateSlot\("A"\);[\s\S]*const observer = await authenticateSlot\("B"\);/);
    expect(preflight).toContain('client.rpc("current_user_org_role"');
    expect(preflight).toContain('client.from("profiles").select("id,role,active")');
    expect(preflight).toContain('role.data !== "admin"');
    expect(preflight).toContain('profile.data.role !== "admin"');
    expect(preflight).toContain("!profile.data.active");
    expect(preflight).toContain("actors: [origin.identity, observer.identity]");
    expect(preflight).toContain("actorId: login.data.user.id");
    expect(preflight).not.toContain("actors: [origin, observer]");
    expect(preflight).toContain("safeToRun");
    expect(preflight).toContain("process.exitCode = 2");
    expect(preflight).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(preflight).not.toContain(".update({");
    expect(preflight).not.toContain('supabase.rpc("commit_');
    expect(preflight).not.toContain('supabase.rpc("reject_');
  });

  it("reconciles and cleans an adjustment-winner race without another financial command", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const reconciliation = read("scripts/reconcile-checkout-settlement-race-staging.mjs");
    const runner = read("scripts/run-checkout-settlement-cleanup-staging-e2e.mjs");
    const cleanup = read("tests/e2e/staging/release-b-checkout-settlement-cleanup-v2.e2e.ts");

    expect(packageJson.scripts["test:db:staging:v2:checkout-settlement-race:reconcile"]).toBe(
      "node scripts/reconcile-checkout-settlement-race-staging.mjs"
    );
    expect(packageJson.scripts["test:e2e:staging:v2:checkout-settlement-race:cleanup"]).toBe(
      "node scripts/run-checkout-settlement-cleanup-staging-e2e.mjs"
    );
    expect(reconciliation).toContain('new Set(["before-cleanup", "after-cleanup"])');
    expect(reconciliation).toContain('["adjustment", adjustmentMutationId, "settlePendingBills"]');
    expect(reconciliation).toContain("mutationStatuses.checkout === null");
    expect(reconciliation).toContain('events.data[0].event_type === "financial_adjustment_committed_v2"');
    expect(reconciliation).toContain("adjustmentResult?.mutation_id === adjustmentMutationId");
    expect(reconciliation).toContain("adjustmentResult.entity_id === settlementBillId");
    expect(reconciliation).toContain("adjustmentResult.changed_rows?.payments");
    expect(reconciliation).toContain("adjustmentResult.changed_rows?.audit_logs");
    expect(reconciliation).toContain('message === `Settled Rs 30.00 on ${settlementBill.bill_number}. Remaining due: Rs 0.00.`');
    expect(reconciliation).toContain('message === `Rejected ${station}. Reason: ${cleanupReason}`');
    expect(reconciliation).toContain("candidateBills.data.length === 0");
    expect(reconciliation).toContain("activeLines.length === 0");
    expect(reconciliation).toContain("retainedPayments.length === 0");
    expect(reconciliation).toContain("openSessions.data.length === 1 && openSessions.data[0].id === activeSessionId");
    expect(reconciliation).toContain("openSessions.data.length === 0");
    expect(reconciliation).toContain("appState.data.version === expectedAppStateVersion");
    expect(reconciliation).toContain("metadata?.app_state_version) === expectedAppStateVersion");
    expect(reconciliation).toContain("Refusing to overwrite an existing checkout-settlement reconciliation artifact");
    expect(reconciliation).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(reconciliation).not.toContain(".update({");
    expect(reconciliation).not.toContain('supabase.rpc("commit_');
    expect(reconciliation).not.toContain('supabase.rpc("reject_');
    expect(runner).toContain("release-b-checkout-settlement-cleanup-v2.e2e.ts");
    expect(runner).toContain("process.argv.slice(2).length > 0");
    expect(runner).toContain("Cleanup execution ID must differ from the source race ID");
    expect(runner).toContain("Cleanup artifact identity already exists");
    expect(cleanup).toContain("rejectSessionIfOpen(page, station, customerName, reason)");
    expect(cleanup).toContain("E2E_RACE_SOURCE_RUN_ID");
    expect(cleanup).toContain('entry.rpc === "reject_session"');
    expect(cleanup).toContain('entry.rpc.startsWith("commit_financial") || entry.rpc === "commit_checkout_bill_v2"');
    expect(cleanup).toContain("expect(afterAppState[0].version).toBe(expectedVersion + 1)");
    expect(cleanup).not.toContain("Issue Bill");
    expect(cleanup).not.toContain("Confirm Settlement");
    const race = read("tests/e2e/staging/release-b-checkout-settlement-race-v2.e2e.ts");
    expect(race).toContain('status: "active"');
    expect(race).toContain("financialOutcomeResolved = true");
    expect(race.indexOf("financialOutcomeResolved = true")).toBeLessThan(
      race.indexOf('expect(checkoutCommand.wasSubmitted()).toBe(true)')
    );
    expect(race).toContain('financialOutcomeResolved && raceWinner === "adjustment"');
  });
});
