export interface PairPhaseTiming {
  phase: string;
  startedMs: number;
  endedMs?: number;
  durationMs?: number;
  outcome: "pending" | "passed" | "failed";
}

/** Observation only: invokes work immediately, retains failure without copying error data. */
export function createPairTimingEvidence(now: () => number = () => performance.now()) {
  const started = now();
  const phases: PairPhaseTiming[] = [];
  const elapsed = () => now() - started;
  function measure<T>(phase: string, work: () => Promise<T>): Promise<T> {
    const entry: PairPhaseTiming = { phase, startedMs: elapsed(), outcome: "pending" };
    phases.push(entry);
    const finish = (outcome: "passed" | "failed") => {
      entry.endedMs = elapsed();
      entry.durationMs = entry.endedMs - entry.startedMs;
      entry.outcome = outcome;
    };
    try {
      return work().then(value => { finish("passed"); return value; }, error => {
        finish("failed"); throw error;
      });
    } catch (error) {
      finish("failed");
      throw error;
    }
  }
  return { phases, measure, offsetAt: (timestamp: number) => timestamp - started };
}
