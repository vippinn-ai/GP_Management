/** Diagnostic-only monotonic checkpoints. Never use these values as gate inputs.
 * APIRequestContext.post returns a buffered response, not response headers/TTFB.
 */
export function createRpcPhaseTiming(now: () => number = () => performance.now()) {
  const started = now();
  let bufferedAt: number | null = null;
  let completedAt: number | null = null;
  let phaseOutcome: "incomplete" | "complete" | "request-failed" | "body-failed" = "incomplete";
  return {
    buffered() { bufferedAt = now(); },
    complete() { completedAt = now(); phaseOutcome = "complete"; },
    fail() { phaseOutcome = bufferedAt === null ? "request-failed" : "body-failed"; },
    snapshot() {
      return {
        requestPostAwaitMs: bufferedAt === null ? null : bufferedAt - started,
        bodyReadAndParseMs: bufferedAt === null || completedAt === null ? null : completedAt - bufferedAt,
        phaseOutcome
      };
    }
  };
}

export type RpcPhaseSnapshot = ReturnType<ReturnType<typeof createRpcPhaseTiming>["snapshot"]>;
