import { describe, expect, it, vi } from "vitest";
import { createFailurePreservingCleanup } from "./failurePreservingCleanup";

describe("failure-preserving cleanup", () => {
  it("does not replace a primary failure when cleanup also fails", async () => {
    const primary = new Error("primary assertion");
    const cleanup = createFailurePreservingCleanup();
    let observed: unknown;

    try {
      try {
        throw primary;
      } finally {
        await cleanup.run("evidence", async () => {
          throw new Error("evidence attachment");
        });
      }
      cleanup.throwIfFailed();
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(primary);
    expect(cleanup.failures()).toHaveLength(1);
  });

  it("reports cleanup failure when the primary operation succeeded", async () => {
    const cleanupFailure = new Error("context close");
    const cleanup = createFailurePreservingCleanup();
    await cleanup.run("context", async () => {
      throw cleanupFailure;
    });
    expect(() => cleanup.throwIfFailed()).toThrow(cleanupFailure);
  });

  it("settles independent cleanup steps and aggregates all failures", async () => {
    const laterStep = vi.fn();
    const cleanup = createFailurePreservingCleanup();
    await cleanup.run("first", async () => {
      throw new Error("first failed");
    });
    await cleanup.run("second", laterStep);
    await cleanup.run("third", async () => {
      throw new Error("third failed");
    });

    expect(laterStep).toHaveBeenCalledOnce();
    expect(cleanup.failures().map((entry) => entry.label)).toEqual(["first", "third"]);
    expect(() => cleanup.throwIfFailed()).toThrow(AggregateError);
  });
});
