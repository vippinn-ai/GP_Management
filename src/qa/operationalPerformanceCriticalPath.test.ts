import { describe, expect, it, vi } from "vitest";
import {
  CRITICAL_RESOURCE_TIMING_SETTLE_TIMEOUT_MS,
  measureBootstrapDependencyDepth,
  installVisibleReadyObserver,
  INVENTORY_RENDER_POLL_INTERVAL_MS,
  missingExpectedCriticalResourceKeys,
  requestStartedByBrowserMark,
  requestStartedByBrowserMarkAfterCompletion,
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
  it("uses the event-granularity Inventory render polling budget", () => {
    expect(INVENTORY_RENDER_POLL_INTERVAL_MS).toBe(25);
  });

  it("bounds browser Resource Timing settlement without changing measured readiness", () => {
    expect(CRITICAL_RESOURCE_TIMING_SETTLE_TIMEOUT_MS).toBe(1_000);
    expect(missingExpectedCriticalResourceKeys(
      [{ requestKey: "document:0" }, { requestKey: "api:0" }],
      new Set(["document:0", "api:0", "logo:0"])
    )).toEqual(["logo:0"]);
    expect(missingExpectedCriticalResourceKeys(
      [{ requestKey: "document:0" }, { requestKey: "api:0" }, { requestKey: "logo:0" }],
      new Set(["document:0", "api:0", "logo:0"])
    )).toEqual([]);
  });
  it("classifies request timing in the browser epoch at the exact safe boundary and fails closed on invalid timing", () => {
    expect(requestStartedByBrowserMark(10_400, 10_000, 400)).toBe(true);
    expect(requestStartedByBrowserMark(10_401, 10_000, 400)).toBe(false);
    expect(requestStartedByBrowserMark(0, 10_000, 400)).toBeNull();
    expect(requestStartedByBrowserMark(10_400, Number.NaN, 400)).toBeNull();
    expect(requestStartedByBrowserMark(10_400, 10_000, -1)).toBeNull();
  });

  it("re-reads an initially unavailable request start only after that same request completes", async () => {
    const readStart = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10_400);
    await expect(requestStartedByBrowserMarkAfterCompletion(
      readStart,
      Promise.resolve(),
      10_000,
      400
    )).resolves.toBe(true);
    expect(readStart).toHaveBeenCalledTimes(2);
  });

  it("does not wait or re-read when request timing is already valid", async () => {
    const readStart = vi.fn().mockReturnValue(10_401);
    let completed = false;
    const completion = new Promise<void>((resolve) => setTimeout(() => {
      completed = true;
      resolve();
    }, 10));
    await expect(requestStartedByBrowserMarkAfterCompletion(readStart, completion, 10_000, 400)).resolves.toBe(false);
    expect(readStart).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    await completion;
  });

  it("remains fail-closed when request timing is invalid after completion", async () => {
    const readStart = vi.fn().mockReturnValue(0);
    await expect(requestStartedByBrowserMarkAfterCompletion(
      readStart,
      Promise.resolve(),
      10_000,
      400
    )).resolves.toBeNull();
    expect(readStart).toHaveBeenCalledTimes(2);
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

  it("creates the common visible-ready mark in the page without Playwright observation", () => {
    const marks: string[] = [];
    vi.spyOn(performance, "getEntriesByName").mockImplementation((name) => marks.includes(String(name)) ? [{} as PerformanceEntry] : []);
    vi.spyOn(performance, "mark").mockImplementation((name) => {
      marks.push(name);
      return {} as PerformanceMark;
    });
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const heading = document.createElement("h1");
    heading.textContent = "Live Dashboard";
    heading.getBoundingClientRect = () => ({ width: 300, height: 50 } as DOMRect);
    document.body.append(heading);

    installVisibleReadyObserver({ markName: "bp-visible-dashboard-ready", headingText: "Live Dashboard" });

    expect(marks).toEqual(["bp-visible-dashboard-ready"]);
  });

  it.each([
    [Number.NaN, 20, 0],
    [Number.POSITIVE_INFINITY, 20, 0],
    [-1, 20, 0],
    [10, Number.NaN, 0],
    [10, Number.POSITIVE_INFINITY, 0],
    [20, 10, 0],
    [10, 20, Number.NaN],
    [10, 20, Number.POSITIVE_INFINITY],
    [10, 20, -1]
  ])("fails closed on invalid resource timing or transfer evidence (%s, %s, %s)", (startTime, responseEnd, transferSize) => {
    const selected = selectCriticalEvidence([
      resource({ requestKey: "invalid", path: "staging/rest/v1/sessions", startTime, responseEnd, transferSize })
    ], [response("invalid", "staging/rest/v1/sessions")], 100);

    expect(selected.criticalResources).toEqual([]);
    expect(selected.criticalResponses).toEqual([]);
    expect(selected.errors).toEqual(["Resource invalid has invalid browser timing or transfer evidence."]);
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

  it("fails closed when a request known to start before readiness has no resource timing", () => {
    const selected = selectCriticalEvidence([], [response("api:0", "staging/rest/v1/sessions")], 40, new Set(["api:0"]));

    expect(selected.criticalResources).toEqual([]);
    expect(selected.criticalResponses).toEqual([]);
    expect(selected.errors).toEqual(["Expected critical request api:0 has 0 correlated resources."]);
  });

  it("fails closed when resource correlation is duplicated", () => {
    const duplicate = resource({ requestKey: "api:0", path: "staging/rest/v1/sessions", startTime: 10, responseEnd: 20 });
    const selected = selectCriticalEvidence([duplicate, { ...duplicate }], [response("api:0", duplicate.path)], 40, new Set(["api:0"]));

    expect(selected.errors).toEqual([
      "Resource correlation key api:0 is duplicated 2 times.",
      "Expected critical request api:0 has 2 correlated resources."
    ]);
  });

  it("keeps identical URL occurrences on opposite sides of readiness distinct", () => {
    const path = "staging/rest/v1/bills";
    const before = resource({ requestKey: "urlhash:0", path, startTime: 39, responseEnd: 45 });
    const after = resource({ requestKey: "urlhash:1", path, startTime: 41, responseEnd: 50 });

    const selected = selectCriticalEvidence(
      [before, after],
      [response(before.requestKey, path), response(after.requestKey, path)],
      40,
      new Set([before.requestKey])
    );

    expect(selected.errors).toEqual([]);
    expect(selected.criticalResources).toEqual([before]);
    expect(selected.criticalResponses).toEqual([response(before.requestKey, path)]);
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
