import { describe, expect, it, vi } from "vitest";
import {
  QA_NORMALIZED_READ_FAILURE_HOST,
  resolveQaNormalizedReadFailureTarget,
  runQaControlledNormalizedRead
} from "./normalizedReadFailure";

const qaContext = {
  enabled: true,
  hostname: QA_NORMALIZED_READ_FAILURE_HOST,
  search: "?qaNormalizedReadFailure=customers",
  delayMs: 0
};

describe("controlled normalized-read QA failure", () => {
  it("resolves only a supported target on the exact isolated QA host", () => {
    expect(resolveQaNormalizedReadFailureTarget(qaContext)).toBe("customers");
    expect(resolveQaNormalizedReadFailureTarget({ ...qaContext, enabled: false })).toBeUndefined();
    expect(resolveQaNormalizedReadFailureTarget({ ...qaContext, hostname: "management.example.com" })).toBeUndefined();
    expect(resolveQaNormalizedReadFailureTarget({ ...qaContext, search: "?qaNormalizedReadFailure=unknown" })).toBeUndefined();
  });

  it("rejects the selected reader without calling it", async () => {
    const read = vi.fn().mockResolvedValue("stale data");

    await expect(runQaControlledNormalizedRead("customers", read, qaContext)).rejects.toThrow(
      "Controlled QA failure: normalized customers read is unavailable. QA attempt 1."
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("calls a different reader normally", async () => {
    const read = vi.fn().mockResolvedValue("fresh data");

    await expect(runQaControlledNormalizedRead("inventory", read, qaContext)).resolves.toBe("fresh data");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("increments the controlled attempt number for a scoped retry", async () => {
    const reportContext = { ...qaContext, search: "?qaNormalizedReadFailure=reports" };
    const read = vi.fn().mockResolvedValue("stale data");

    await expect(runQaControlledNormalizedRead("reports", read, reportContext)).rejects.toThrow("QA attempt 1.");
    await expect(runQaControlledNormalizedRead("reports", read, reportContext)).rejects.toThrow("QA attempt 2.");
    expect(read).not.toHaveBeenCalled();
  });
});
