import { describe, expect, it } from "vitest";
import {
  measureBootstrapDependencyDepth,
  requestStartedByBrowserMark,
  selectCriticalEvidence,
  sumCriticalShellTransferBytes,
  type CriticalResourceTiming,
  type CriticalResponseTiming
} from "./operationalPerformanceCriticalPath";

function resource(overrides: Partial<CriticalResourceTiming> & Pick<CriticalResourceTiming, "requestKey" | "path" | "startTime" | "responseEnd">): CriticalResourceTiming {
  return { api: true, shell: false, javascript: false, transferSize: 0, ...overrides };
}

function response(requestKey: string, path: string, status = 200): CriticalResponseTiming {
  return { requestKey, path, status };
}

describe("browser-domain operational performance evidence", () => {
  it("classifies request timing in the browser epoch at the exact safe boundary and fails closed on invalid timing", () => {
    expect(requestStartedByBrowserMark(10_400, 10_000, 400)).toBe(true);
    expect(requestStartedByBrowserMark(10_401, 10_000, 400)).toBe(false);
    expect(requestStartedByBrowserMark(0, 10_000, 400)).toBeNull();
    expect(requestStartedByBrowserMark(10_400, Number.NaN, 400)).toBeNull();
    expect(requestStartedByBrowserMark(10_400, 10_000, -1)).toBeNull();
  });

  it("includes requests before and exactly at the browser mark but excludes post-safe history despite delayed observation", () => {
    const resources = [
      resource({ requestKey: "org:0", path: "staging/rest/v1/organizations", startTime: 100, responseEnd: 200 }),
      resource({ requestKey: "live:0", path: "staging/rest/v1/sessions", startTime: 200, responseEnd: 300 }),
      resource({ requestKey: "tabs:0", path: "staging/rest/v1/customer_tabs", startTime: 300, responseEnd: 400 }),
      resource({ requestKey: "bills:0", path: "staging/rest/v1/bills", startTime: 401, responseEnd: 500 })
    ];
    const responses = resources.map((entry) => response(entry.requestKey, entry.path));

    const selected = selectCriticalEvidence(resources, responses, 400);

    expect(selected.errors).toEqual([]);
    expect(selected.criticalResources.map((entry) => entry.requestKey)).toEqual(["org:0", "live:0", "tabs:0"]);
    expect(selected.criticalResponses.map((entry) => entry.requestKey)).toEqual(["org:0", "live:0", "tabs:0"]);
    expect(measureBootstrapDependencyDepth(selected.criticalResources, selected.criticalResponses)).toBe(3);
  });

  it("keeps repeated paths distinct by correlation key and fails closed on missing or duplicate responses", () => {
    const resources = [
      resource({ requestKey: "profiles:0", path: "staging/rest/v1/profiles", startTime: 10, responseEnd: 20 }),
      resource({ requestKey: "profiles:1", path: "staging/rest/v1/profiles", startTime: 30, responseEnd: 40 })
    ];
    const selected = selectCriticalEvidence(resources, [
      response("profiles:0", resources[0].path),
      response("profiles:0", resources[0].path)
    ], 40);

    expect(selected.errors).toEqual([
      "Critical resource profiles:0 has 2 correlated responses.",
      "Critical resource profiles:1 has 0 correlated responses.",
      "Response correlation key profiles:0 is duplicated 2 times."
    ]);
  });

  it("measures parallel fan-out as one stage and a true sequential chain as separate stages", () => {
    const resources = [
      resource({ requestKey: "org", path: "staging/rest/v1/organizations", startTime: 10, responseEnd: 20 }),
      resource({ requestKey: "config", path: "staging/rest/v1/stations", startTime: 21, responseEnd: 40 }),
      resource({ requestKey: "catalog", path: "staging/rest/v1/inventory_items", startTime: 21, responseEnd: 45 }),
      resource({ requestKey: "live", path: "staging/rest/v1/sessions", startTime: 46, responseEnd: 60 })
    ];
    const responses = resources.map((entry) => response(entry.requestKey, entry.path));
    expect(measureBootstrapDependencyDepth(resources, responses)).toBe(3);
    expect(measureBootstrapDependencyDepth(resources.slice(1), responses.slice(1))).toBeNull();
  });

  it("uses encoded wire transfer bytes for the cold shell rather than decoded bodies", () => {
    const resources = [
      resource({ requestKey: "document", path: "staging/", api: false, shell: true, startTime: 0, responseEnd: 10, transferSize: 800 }),
      resource({ requestKey: "main-js", path: "staging/assets/index.js", api: false, shell: true, javascript: true, startTime: 5, responseEnd: 20, transferSize: 2_000 }),
      resource({ requestKey: "api", path: "staging/rest/v1/sessions", startTime: 20, responseEnd: 30, transferSize: 50_000 })
    ];
    expect(sumCriticalShellTransferBytes(resources)).toBe(2_800);
  });
});
