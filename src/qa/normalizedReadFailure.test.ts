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
      "Controlled QA failure: normalized customers read is unavailable."
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("calls a different reader normally", async () => {
    const read = vi.fn().mockResolvedValue("fresh data");

    await expect(runQaControlledNormalizedRead("inventory", read, qaContext)).resolves.toBe("fresh data");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
