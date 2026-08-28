import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyComboRaceEvidence,
  countComboRaceClassifications,
  selectComboRaceEvidenceCandidate
} from "../../scripts/checkout-repeat-combo-race-evidence.mjs";

const root = process.cwd();
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("checkout-repeat-combo staging race harness", () => {
  it("classifies zero through three completions plus setup-only and ambiguous execution", () => {
    const completed = { winner: "checkout", sessionId: "session-1", afterRace: {}, lifecycle: { outcomeResolved: true } };
    for (let completedCount = 0; completedCount <= 3; completedCount += 1) {
      const entries = Array.from({ length: 3 }, (_, index) => index < completedCount ? completed : null);
      expect(countComboRaceClassifications(entries)).toEqual({
        ...(completedCount > 0 ? { completed: completedCount } : {}),
        ...(completedCount < 3 ? { not_started: 3 - completedCount } : {})
      });
    }
    expect(classifyComboRaceEvidence({ sessionId: "session-2", lifecycle: { sessionStarted: true } })).toBe("setup_only");
    expect(classifyComboRaceEvidence({ sessionId: "session-3", lifecycle: { checkoutSubmitted: true } })).toBe("ambiguous");
    expect(classifyComboRaceEvidence({ sessionId: "session-4", lifecycle: { comboSubmitted: true } })).toBe("ambiguous");
    expect(classifyComboRaceEvidence({ sessionId: "session-5", lifecycle: { raceStarted: true } })).toBe("ambiguous");
  });

  it("falls back from a corrupt final artifact to an intact immutable checkpoint", () => {
    const evidence = {
      runId: "run-1",
      scenario: "checkout_first",
      sessionId: "session-1",
      lifecycle: { raceStarted: true, checkoutSubmitted: true }
    };
    const selected = selectComboRaceEvidenceCandidate([
      { artifactPath: "final.json", content: "{\"truncated\":" },
      { artifactPath: "responses.json", content: JSON.stringify(evidence) },
      { artifactPath: "prepared.json", content: JSON.stringify(evidence) }
    ], "run-1", "checkout_first");
    expect(selected.artifactPath).toBe("responses.json");
    expect(selected.classification).toBe("ambiguous");
    expect(selected.evidence).toEqual(evidence);
    expect(selected.rejectedCandidates).toEqual([
      { artifactPath: "final.json", reason: expect.stringMatching(/^invalid_json:/) }
    ]);
  });

  it("falls back from a wrong-identity response checkpoint to prepared evidence", () => {
    const prepared = {
      runId: "run-1",
      scenario: "combo_first",
      sessionId: "session-2",
      lifecycle: { raceStarted: true, comboSubmitted: true }
    };
    const selected = selectComboRaceEvidenceCandidate([
      { artifactPath: "responses.json", content: JSON.stringify({ ...prepared, runId: "wrong-run" }) },
      { artifactPath: "prepared.json", content: JSON.stringify(prepared) }
    ], "run-1", "combo_first");
    expect(selected.artifactPath).toBe("prepared.json");
    expect(selected.classification).toBe("ambiguous");
    expect(selected.rejectedCandidates).toEqual([
      { artifactPath: "responses.json", reason: "identity_mismatch" }
    ]);
  });

  it("exposes only dedicated zero-retry execution and read-only discovery", () => {
    const packageJson = read("package.json");
    const runner = read("scripts/run-checkout-repeat-combo-race-staging-e2e.mjs");
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-repeat-combo-race"');
    expect(packageJson).toContain('"test:e2e:staging:v2:checkout-repeat-combo-race:list"');
    expect(runner).toContain('"--simultaneous-only"');
    expect(runner).toContain('"--simultaneous-only-list"');
    expect(runner).toContain("release-b-checkout-repeat-combo-race-v2.e2e.ts");
    expect(runner).toContain("E2E_REPEAT_COMBO_NAME = evidence.fixture.combo.name");
    expect(runner).toContain('["--grep", "combo_first|simultaneous"');
    expect(runner).toContain('simultaneous commits exactly one compatible session transition');
  });

  it("preflights staging identity, empty floor, exact fixture, stock, and fresh artifacts", () => {
    const preflight = read("scripts/preflight-checkout-repeat-combo-race-staging.mjs");
    expect(preflight).toContain("STAGING_PROJECT_REF");
    expect(preflight).toContain('role.data !== "admin"');
    expect(preflight).toContain("results.openSessions.data.length === 0");
    expect(preflight).toContain("results.openTabs.data.length === 0");
    expect(preflight).toContain("requiredRunCapacity");
    expect(preflight).toContain("isReusable: Boolean(item.is_reusable)");
    expect(preflight).toContain("item.is_reusable ? 2 : 3");
    expect(preflight).toContain("rejectedFixtures");
    expect(preflight).toContain("requestedFixtureEvaluation");
    expect(preflight).toContain("artifactCollisions.length === 0");
    expect(preflight).toContain("E2E_REPEAT_COMBO_ID must explicitly select");
    expect(preflight).toContain("optionName: option.optionName");
    expect(preflight).toContain('flag: "wx"');
    expect(preflight).toContain("reviewed_preflight_drift");
    expect(preflight).toContain("JSON.stringify(reviewed.fixture) === JSON.stringify(evidence.fixture)");
    expect(preflight).toContain("JSON.stringify(reviewed.actors) === JSON.stringify(evidence.actors)");
    expect(preflight).toContain("appState");
  });

  it("covers both deterministic orderings and one simultaneous single-send race", () => {
    const scenario = read("tests/e2e/staging/release-b-checkout-repeat-combo-race-v2.e2e.ts");
    expect(scenario).toContain('{ scenario: "checkout_first", expectedWinner: "checkout" }');
    expect(scenario).toContain('{ scenario: "combo_first", expectedWinner: "combo" }');
    expect(scenario).toContain('{ scenario: "simultaneous" }');
    expect(scenario).toContain("checkoutCommand.submit(checkoutEnvelope)");
    expect(scenario).toContain("comboCommand.submit(comboEnvelope)");
    expect(scenario).toContain('captureWithin(comboCommand.captured, "repeat_session_combo")');
    expect(scenario).toContain("Repeat Combo was rejected by the UI before RPC dispatch");
    expect(scenario).toContain('captureWithin(checkoutCommand.captured, "commit_checkout_bill_v2")');
    expect(scenario.indexOf('captureWithin(comboCommand.captured, "repeat_session_combo")')).toBeLessThan(
      scenario.indexOf('getByRole("button", { name: "Issue Bill", exact: true }).click()')
    );
    expect(scenario).toContain('persistEvidenceCheckpoint(scenario, "prepared", preparedEvidence)');
    expect(scenario).toContain('persistEvidenceCheckpoint(scenario, "responses", responseEvidence)');
    expect(scenario).toContain('flag: "wx"');
    expect(scenario).toContain("await rename(temporaryPath, artifactPath)");
    expect(scenario.indexOf('persistEvidenceCheckpoint(scenario, "prepared", preparedEvidence)')).toBeLessThan(
      scenario.indexOf('checkoutCommand.submit(checkoutEnvelope)')
    );
    expect(scenario.indexOf('persistEvidenceCheckpoint(scenario, "responses", responseEvidence)')).toBeLessThan(
      scenario.indexOf("const checkoutWon = checkoutResponse.status() === 200")
    );
    expect(scenario).toContain('"session_not_open" : "source_item_mismatch"');
    expect(scenario).toContain("expect(checkoutStatus).toBeNull()");
    expect(scenario).not.toContain("changedRows.bill_lines");
    expect(scenario).toContain("appStateHash(appStateAfterRace[0].data)");
    expect(scenario).toContain("rejectSessionIfOpen(page, station, customerName, cleanupReason)");
    expect(scenario).toContain('cleanupDisposition: raceStarted && !outcomeResolved ? "skipped_ambiguous_race"');
    expect(scenario).toContain("emergencyCleanup");
    expect(scenario).toContain("checkoutSubmitted");
    expect(scenario).toContain("comboSubmitted");
    expect(scenario).toContain("Bill inventory rows do not match the locked session or tab items");
    expect(scenario).toContain('getByRole("combobox", { name: "Combo", exact: true })');
    expect(scenario).toContain("expect(await comboOption.getAttribute(\"value\")).toBe(comboId)");
    expect(scenario).toContain("selectOption({ label: comboOptionLabel! })");
    expect(scenario).toContain('getByRole("combobox", { name: selection.label, exact: true })');
    expect(scenario).toContain("expect(await choiceOption.getAttribute(\"value\")).toBe(selection.optionId)");
    expect(scenario).toContain("selectOption({ label: choiceOptionLabel! })");
    expect(scenario).toContain("Repeating combo: The session is no longer open.");
    expect(scenario).toContain('loserPage.locator(".remote-error-banner")');
    expect(scenario).toContain("toContainText(expectedLoserUiMessage)");
  });

  it("reconciles partial execution plus exact financial, cleanup, inventory, and compatibility evidence", () => {
    const reconciler = read("scripts/reconcile-checkout-repeat-combo-race-staging.mjs");
    expect(reconciler).toContain("refusing overwrite");
    expect(reconciler).toContain(`-${"responses"}.json`);
    expect(reconciler).toContain(`-${"prepared"}.json`);
    expect(reconciler).toContain("selectComboRaceEvidenceCandidate(candidates, runId, scenario)");
    expect(reconciler).toContain("rejectedCandidates");
    expect(reconciler).toContain("submitted outcome will be resolved from deterministic database evidence");
    expect(reconciler).toContain("E2E_REPEAT_COMBO_RECONCILE_REVISION");
    expect(reconciler).toContain("A superseding review requires the immutable original postflight artifact");
    expect(reconciler).not.toContain('changedIds(status, "bill_lines")');
    expect(reconciler).toContain("ambiguous checkout has exact zero effect");
    expect(reconciler).toContain("ambiguous combo has exact zero effect");
    expect(reconciler).toContain("ambiguousOutcomes");
    expect(reconciler).toContain("canonical payment changed_rows match");
    expect(reconciler).toContain("canonical repeat changed_rows match every persisted collection");
    expect(reconciler).toContain("payment amount, mode, and actor match");
    expect(reconciler).toContain("checkout audits and actors match");
    expect(reconciler).toContain("checkout sale movements and actors match");
    expect(reconciler).toContain("retained no losing combo residue");
    expect(reconciler).toContain("retained no losing checkout bill, lines, payments, audits, movements, mutation, or event");
    expect(reconciler).toContain("cleanup creates no compensating stock movements under reject_session");
    expect(reconciler).toContain("terminal session state releases reservation availability");
    expect(reconciler).toContain("Final stock arithmetic matches");
    expect(reconciler).toContain("The staging floor is empty");
    const cleanupPostflight = read("scripts/reconcile-checkout-repeat-combo-cleanup-staging.mjs");
    const recovery = read("scripts/inspect-checkout-repeat-combo-recovery-staging.mjs");
    expect(recovery).toContain("E2E_REPEAT_COMBO_RECOVERY_SCENARIO");
    expect(recovery).toContain("checkoutMutationStatus === null");
    expect(recovery).toContain('supabase.rpc("get_financial_mutation_result"');
    expect(recovery).toContain("checkoutMutationId: scenarioEvidence.checkoutMutationId");
    expect(recovery).toContain("comboSnapshotIdsAreExact");
    expect(recovery).toContain("snapshotEvidenceIsExact");
    expect(recovery).toContain("session.id === scenarioEvidence.sessionId");
    expect(recovery).toContain("repeatEvidenceIsExact");
    expect(recovery).toContain("movementSetIsExact");
    expect(recovery).toContain("scenarioEvidence.appStateBefore");
    expect(cleanupPostflight).toContain("exactSessionRejected: true");
    expect(cleanupPostflight).toContain("noFinancialEffect: true");
    expect(cleanupPostflight).toContain("noCleanupStockMovementExpectedByRejectRpc: true");
    expect(cleanupPostflight).toContain("recovery.events.length + 1");
    expect(cleanupPostflight).toContain("Cleanup changed the pre-authorized operational event chain");
    expect(cleanupPostflight).toContain("recovery.appState.version + 1");
    expect(cleanupPostflight).toContain("authorized recovery baseline");
    expect(cleanupPostflight).toContain('flag: "wx"');
    const cleanupRunner = read("scripts/run-checkout-repeat-combo-cleanup-staging-e2e.mjs");
    expect(cleanupRunner).toContain("recovery.safeForIdentityBoundCleanup !== true");
    expect(cleanupRunner).toContain("scenario.checkoutMutationId !== recovery.checkoutMutationId");
    expect(cleanupRunner).toContain("E2E_REPEAT_COMBO_RECOVERY_ARTIFACT");
    const cleanupSpec = read("tests/e2e/staging/release-b-checkout-settlement-cleanup-v2.e2e.ts");
    expect(cleanupSpec).toContain("comboRecovery.safeForIdentityBoundCleanup");
    expect(cleanupSpec).toContain("checkoutMutationResponse");
    expect(cleanupSpec).toContain("get_financial_mutation_result");
  });
});
