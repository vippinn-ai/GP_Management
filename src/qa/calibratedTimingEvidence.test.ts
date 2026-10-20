import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCalibrationEvidence } from "./calibratedTimingEvidence";
import { createFailurePreservingCleanup } from "./failurePreservingCleanup";

describe("failure-safe calibrated timing capture", () => {
  for (const stage of ["setup", "concurrent-close", "budget"] as const) {
    it(`retains ${stage} failure evidence without replacing the primary error`, async () => {
      const evidence = createCalibrationEvidence("run");
      const cleanup = createFailurePreservingCleanup();
      const primary = new Error("primary");
      let saved: unknown;
      const run = async () => {
        try {
          evidence.stage(stage, stage === "setup" ? 0 : 3);
          if (stage === "budget") evidence.budget(0.9495604841081983);
          throw primary;
        } finally {
          await cleanup.run("evidence", () => { saved = evidence.snapshot([]); });
        }
        cleanup.throwIfFailed();
      };
      await expect(run()).rejects.toBe(primary);
      expect(saved).toMatchObject({ stage, completed: false, samples: [],
        budgetOutcome: stage === "budget" ? "failed" : "incomplete" });
    });
  }
  it("preserves the original error when attachment fails, but fails on attachment-only failure", async () => {
    for (const primaryFails of [true, false]) {
      const cleanup = createFailurePreservingCleanup();
      const primary = new Error("primary");
      const attachment = new Error("attachment");
      const run = async () => {
        try { if (primaryFails) throw primary; }
        finally { await cleanup.run("evidence", () => { throw attachment; }); }
        cleanup.throwIfFailed();
      };
      await expect(run()).rejects.toBe(primaryFails ? primary : attachment);
    }
  });
  it("copies only allowlisted fields and numeric server duration", () => {
    const evidence = createCalibrationEvidence("run");
    const secret = "DO_NOT_CAPTURE";
    const rpc = {
      client: "origin" as const, rpc: "reject_session_v2", mutationId: "mutation",
      startedAt: "2026-10-20T00:00:00Z", completedAt: "2026-10-20T00:00:01Z", elapsedMs: 1000, status: 200,
      headers: { authorization: secret, apikey: secret, cookie: secret },
      request: { payload: { password: secret } },
      response: { server_duration_ms: 3, access_token: secret, refresh_token: secret, message: secret },
      url: `https://example.invalid/?token=${secret}`, stack: secret
    };
    const saved = evidence.snapshot([rpc]);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(Object.keys(saved.directRpcEvidence[0]).sort()).toEqual(
      ["client", "rpc", "mutationId", "startedAt", "completedAt", "elapsedMs", "status", "serverDurationMs", "requestPostAwaitMs", "bodyReadAndParseMs", "phaseOutcome"].sort());
    expect(saved.directRpcEvidence[0].serverDurationMs).toBe(3);
    for (const invalid of ["3", -1, Infinity, NaN, { token: secret }]) {
      expect(evidence.snapshot([{ ...rpc, response: { server_duration_ms: invalid } }]).directRpcEvidence[0].serverDurationMs).toBeNull();
    }
  });
  it("keeps detached sample snapshots and marks exact threshold as failed", () => {
    const evidence = createCalibrationEvidence("run");
    evidence.samples.push({ iteration: 1, concurrentWallMs: 80, sequentialWallMs: 100, wallRatio: 0.8,
      submissionStartSkewMs: 1, concurrentMutationIds: ["a", "b"], sequentialMutationIds: ["c", "d"] });
    evidence.budget(0.85);
    expect(evidence.snapshot([]).budgetOutcome).toBe("failed");
    evidence.budget(0.8); evidence.stage("complete", 10);
    const saved = evidence.snapshot([]);
    evidence.samples[0].concurrentMutationIds.push("later");
    expect(saved.samples[0].concurrentMutationIds).toEqual(["a", "b"]);
    expect(saved).toMatchObject({ completed: true, budgetOutcome: "passed", iteration: 10, wallRatioP95: 0.8 });
  });
  it("retains sanitized partial phases without inventing success or changing gate samples", () => {
    const evidence = createCalibrationEvidence("run");
    const base = { client: "origin" as const, rpc: "reject_session_v2", mutationId: "id",
      startedAt: "2026-10-20T00:00:00Z", completedAt: "2026-10-20T00:00:01Z", elapsedMs: 1000, status: null };
    const saved = evidence.snapshot([{ ...base, requestPostAwaitMs: 0, bodyReadAndParseMs: null,
      phaseOutcome: "body-failed" as const, response: { error: "SECRET" } }]);
    expect(saved.directRpcEvidence[0]).toMatchObject({ requestPostAwaitMs: 0, bodyReadAndParseMs: null,
      phaseOutcome: "body-failed", status: null });
    expect(saved.budgetOutcome).toBe("incomplete");
    expect(saved.samples).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain("SECRET");
    expect(evidence.snapshot([base]).directRpcEvidence[0]).toMatchObject({
      requestPostAwaitMs: null, bodyReadAndParseMs: null, phaseOutcome: "incomplete"
    });
  });
  it("wires finally capture into the real case without changing operations, limits or ordering", () => {
    const source = readFileSync("tests/e2e/staging/operational-lifecycle-v2-concurrency.e2e.ts", "utf8");
    const body = source.split('test("ten calibrated unrelated pairs overlap instead of using one global queue"')[1].split('test("50 reload-versus')[0];
    expect(body).toContain("test.setTimeout(8 * 60_000)");
    expect(body).toContain("iteration <= 10");
    expect(body).toContain(".toBeLessThan(0.85)");
    expect(body).toContain(".toBeLessThan(100)");
    expect(body).toContain("const concurrentResults = await Promise.all([");
    expect(body).toContain("const concurrentWallMs = performance.now() - concurrentStarted;");
    expect(body).toContain("const sequentialWallMs = performance.now() - sequentialStarted;");
    expect(body).toContain("wallRatio: concurrentWallMs / sequentialWallMs");
    expect(body).not.toContain("requestPostAwaitMs");
    expect(body).not.toContain("bodyReadAndParseMs");
    expect(body.indexOf("const sequentialFirst = await postRpc")).toBeLessThan(body.indexOf("const sequentialSecond = await postRpc"));
    expect(body.indexOf("} finally {")).toBeLessThan(body.indexOf('finalization.run("calibration timing evidence"'));
    expect(body).toContain('calibration.snapshot(directRpcEvidence)');
    expect(body).toContain("finalization.throwIfFailed()");
  });
});
