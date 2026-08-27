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
});
