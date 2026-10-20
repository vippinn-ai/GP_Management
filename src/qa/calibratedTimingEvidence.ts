/** Test-only projection. Never persist RPC payloads, response bodies or error text. */
export interface CalibrationSample {
  iteration: number;
  concurrentWallMs: number;
  sequentialWallMs: number;
  wallRatio: number;
  submissionStartSkewMs: number;
  concurrentMutationIds: string[];
  sequentialMutationIds: string[];
}

export interface CalibrationRpc {
  client: "origin" | "observer";
  rpc: string;
  mutationId: string | null;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  status: number;
  response?: unknown;
}

export function createCalibrationEvidence(runId: string) {
  const samples: CalibrationSample[] = [];
  let iteration = 0;
  let stage: "setup" | "concurrent-create" | "concurrent-close" | "sequential-create" | "sequential-close" | "budget" | "state" | "complete" = "setup";
  let wallRatioP95: number | null = null;
  let budgetOutcome: "incomplete" | "failed" | "passed" = "incomplete";
  return {
    samples,
    stage(next: typeof stage, currentIteration = iteration) { stage = next; iteration = currentIteration; },
    budget(value: number) {
      wallRatioP95 = value;
      budgetOutcome = Number.isFinite(value) && value < 0.85 ? "passed" : "failed";
    },
    snapshot(rpcs: readonly CalibrationRpc[]) {
      return {
        runId, iteration, stage, completed: stage === "complete", budgetOutcome, wallRatioP95,
        samples: samples.map(s => ({
          iteration: s.iteration, concurrentWallMs: s.concurrentWallMs,
          sequentialWallMs: s.sequentialWallMs, wallRatio: s.wallRatio,
          submissionStartSkewMs: s.submissionStartSkewMs,
          concurrentMutationIds: [...s.concurrentMutationIds], sequentialMutationIds: [...s.sequentialMutationIds]
        })),
        directRpcEvidence: rpcs.map(r => {
          const response = r.response as { server_duration_ms?: unknown } | null;
          const duration = response?.server_duration_ms;
          return {
            client: r.client, rpc: r.rpc, mutationId: r.mutationId,
            startedAt: r.startedAt, completedAt: r.completedAt, elapsedMs: r.elapsedMs, status: r.status,
            serverDurationMs: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null
          };
        })
      };
    }
  };
}
