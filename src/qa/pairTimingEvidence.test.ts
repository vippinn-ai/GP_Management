import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createPairTimingEvidence } from "./pairTimingEvidence";

describe("pair timing observation", () => {
  it("invokes work immediately and retains overlapping intervals and exact results", async () => {
    let time = 10;
    const timing = createPairTimingEvidence(() => time);
    const calls: string[] = [];
    let resolve!: (value: number) => void;
    time = 12;
    const first = timing.measure("reload", () => { calls.push("reload"); return new Promise<number>(done => { resolve = done; }); });
    time = 13;
    const second = timing.measure("rpc", () => { calls.push("rpc"); return Promise.resolve(42); });
    expect(calls).toEqual(["reload", "rpc"]);
    expect(timing.offsetAt(15)).toBe(5);
    expect(await second).toBe(42);
    time = 20;
    resolve(7);
    expect(await first).toBe(7);
    expect(timing.phases).toEqual([
      { phase: "reload", startedMs: 2, endedMs: 10, durationMs: 8, outcome: "passed" },
      { phase: "rpc", startedMs: 3, endedMs: 3, durationMs: 0, outcome: "passed" }
    ]);
  });
  it("retains rejected timing and rethrows the original error without copying secrets", async () => {
    let time = 0;
    const timing = createPairTimingEvidence(() => time);
    const error = new Error("private token payload");
    await expect(timing.measure("synced", async () => { time = 8450; throw error; })).rejects.toBe(error);
    expect(timing.phases[0]).toMatchObject({ outcome: "failed", durationMs: 8450 });
    expect(JSON.stringify(timing.phases)).not.toContain("private");
  });
  it("retains synchronous failure and unfinished work without inventing completion", () => {
    const timing = createPairTimingEvidence(() => 1);
    const error = new Error("sync");
    let caught: unknown;
    try { timing.measure("rpc", () => { throw error; }); } catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    void timing.measure("pending", () => new Promise(() => {}));
    expect(timing.phases[0].outcome).toBe("failed");
    expect(timing.phases[1]).toEqual({ phase: "pending", startedMs: 0, outcome: "pending" });
  });
  it("keeps partial diagnostics before unchanged budget assertion and final attachment", () => {
    const source = readFileSync("tests/e2e/staging/operational-lifecycle-v2-concurrency.e2e.ts", "utf8");
    const pair = source.slice(source.indexOf('test("50 reload-versus'));
    expect(pair.indexOf("pairDiagnostics.push(diagnostic)")).toBeLessThan(pair.indexOf("const pairStarted"));
    expect(pair.indexOf("diagnostic.browserCompletionMs = browserCompletionMs")).toBeLessThan(pair.indexOf('`${label} full two-browser convergence`'));
    expect(pair.indexOf('diagnostic.budgetOutcome = browserCompletionMs < 7_000 ? "passed" : "failed"')).toBeLessThan(pair.indexOf('`${label} full two-browser convergence`'));
    expect(pair).toContain("diagnostic.pairStartedOffsetMs = timing.offsetAt(pairStarted)");
    expect(pair).toContain('`${label} full two-browser convergence`).toBeLessThan(7_000)');
    expect(pair).toContain("iteration <= 50");
    expect(pair).toContain("pairDiagnostics,");
    for (const phase of ["prepare.reload.origin", "prepare.reload.observer", "prepare.synced.origin", "prepare.synced.observer", "overlap.reload.observer", "overlap.rpc.origin", "overlap.rpc.observer", "converge.synced.observer", "converge.reconcile.origin", "converge.reconcile.observer", "converge.absent.origin", "converge.absent.observer"]) expect(pair).toContain(`timing.measure("${phase}"`);
  });
});
