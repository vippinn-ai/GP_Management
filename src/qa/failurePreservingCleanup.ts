export interface CapturedCleanupFailure {
  label: string;
  error: unknown;
}

export interface FailurePreservingCleanup {
  run(label: string, action: () => unknown | Promise<unknown>): Promise<void>;
  failures(): readonly CapturedCleanupFailure[];
  throwIfFailed(): void;
}

export function createFailurePreservingCleanup(): FailurePreservingCleanup {
  const captured: CapturedCleanupFailure[] = [];

  return {
    async run(label, action) {
      try {
        await action();
      } catch (error) {
        captured.push({ label, error });
      }
    },
    failures() {
      return captured;
    },
    throwIfFailed() {
      if (captured.length === 0) return;
      if (captured.length === 1) throw captured[0].error;
      throw new AggregateError(captured.map((entry) => entry.error), `Multiple cleanup steps failed: ${captured.map((entry) => entry.label).join(", ")}`);
    }
  };
}
