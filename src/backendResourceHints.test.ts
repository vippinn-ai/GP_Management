import { describe, expect, it } from "vitest";
import { getBackendResourceHints } from "./backendResourceHints";

describe("backend resource hints", () => {
  it("emits one credential-free DNS hint and one anonymous preconnect for the configured origin", () => {
    expect(getBackendResourceHints("https://example.supabase.co/rest/v1?key=secret")).toEqual([
      { rel: "dns-prefetch", href: "https://example.supabase.co" },
      { rel: "preconnect", href: "https://example.supabase.co", crossorigin: "anonymous" }
    ]);
  });

  it("keeps staging and production origins isolated by the supplied build-time URL", () => {
    expect(getBackendResourceHints("https://staging.supabase.co")[0]?.href).toBe("https://staging.supabase.co");
    expect(getBackendResourceHints("https://production.supabase.co")[0]?.href).toBe("https://production.supabase.co");
  });

  it("emits no hints for missing, invalid, or non-http URLs", () => {
    expect(getBackendResourceHints(undefined)).toEqual([]);
    expect(getBackendResourceHints("not-a-url")).toEqual([]);
    expect(getBackendResourceHints("javascript:alert(1)")).toEqual([]);
  });
});
