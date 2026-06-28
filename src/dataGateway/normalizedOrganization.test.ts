import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCachedNormalizedOrganizationIdForTests,
  rememberNormalizedOrganizationId,
  resolveNormalizedOrganizationId
} from "./normalizedOrganization";

function createOrganizationClient(result: unknown) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const limit = vi.fn(() => ({ maybeSingle }));
  const order = vi.fn(() => ({ limit }));
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return {
    client: { from },
    from,
    select,
    eq,
    order,
    limit,
    maybeSingle
  };
}

describe("normalized organization resolver", () => {
  beforeEach(() => {
    clearCachedNormalizedOrganizationIdForTests();
  });

  it("resolves and caches the active organization id", async () => {
    const query = createOrganizationClient({ data: { id: "org-primary" }, error: null });

    await expect(resolveNormalizedOrganizationId(query.client as never)).resolves.toBe("org-primary");
    await expect(resolveNormalizedOrganizationId(query.client as never)).resolves.toBe("org-primary");

    expect(query.from).toHaveBeenCalledTimes(1);
    expect(query.from).toHaveBeenCalledWith("organizations");
    expect(query.eq).toHaveBeenCalledWith("active", true);
  });

  it("uses a remembered organization id without querying", async () => {
    const query = createOrganizationClient({ data: { id: "org-primary" }, error: null });
    rememberNormalizedOrganizationId("org-primary");

    await expect(resolveNormalizedOrganizationId(query.client as never)).resolves.toBe("org-primary");

    expect(query.from).not.toHaveBeenCalled();
  });

  it("reports missing active organization clearly", async () => {
    const query = createOrganizationClient({ data: null, error: null });

    await expect(resolveNormalizedOrganizationId(query.client as never)).rejects.toThrow(
      "Normalized organization data was unavailable while resolving the active organization."
    );
  });
});
