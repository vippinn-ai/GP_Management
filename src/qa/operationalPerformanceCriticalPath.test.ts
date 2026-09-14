import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCompatiblePerformanceMetricVersion,
  CRITICAL_RESOURCE_TIMING_SETTLE_TIMEOUT_MS,
  freezeStartupWebVitals,
  measureBootstrapDependencyDepth,
  measureResourceTimingPhases,
  installWebVitalsObserver,
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
  return { api: true, shell: false, javascript: false, transferSize: 0, responseStart: overrides.responseEnd, ...overrides };
}

function response(requestKey: string, path: string, status = 200): CriticalResponseTiming {
  return { requestKey, path, status };
}

describe("browser-domain operational performance evidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as typeof globalThis & { __BP_WEB_VITALS__?: unknown }).__BP_WEB_VITALS__;
    delete (globalThis as typeof globalThis & { __BP_STARTUP_WEB_VITALS__?: unknown }).__BP_STARTUP_WEB_VITALS__;
    delete (globalThis as typeof globalThis & { __BP_FREEZE_STARTUP_WEB_VITALS__?: unknown }).__BP_FREEZE_STARTUP_WEB_VITALS__;
  });

  it("uses the event-granularity Inventory render polling budget", () => {
    expect(INVENTORY_RENDER_POLL_INTERVAL_MS).toBe(25);
  });

  it("accepts only the current metric-v3 baseline contract", () => {
    expect(() => assertCompatiblePerformanceMetricVersion(3, 3)).not.toThrow();
    expect(() => assertCompatiblePerformanceMetricVersion(2, 3)).toThrow(/metric version 2 is incompatible.*version 3/i);
    expect(() => assertCompatiblePerformanceMetricVersion(undefined, 3)).toThrow(/incompatible/);
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
    let completed = false;
    let finishRequest!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishRequest = () => {
        completed = true;
        resolve();
      };
    });
    const readStart = vi.fn(() => completed ? 10_400 : 0);
    const classification = requestStartedByBrowserMarkAfterCompletion(
      readStart,
      completion,
      10_000,
      400
    );
    await Promise.resolve();
    expect(readStart).toHaveBeenCalledTimes(1);
    finishRequest();
    await expect(classification).resolves.toBe(true);
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

  it("freezes startup LCP at the readiness boundary so post-safe activity cannot replace it", () => {
    class FakePerformanceObserver {
      static instances: FakePerformanceObserver[] = [];
      readonly callback: (list: { getEntries: () => PerformanceEntry[] }) => void;
      observedType = "";
      pending: PerformanceEntry[] = [];

      constructor(callback: (list: { getEntries: () => PerformanceEntry[] }) => void) {
        this.callback = callback;
        FakePerformanceObserver.instances.push(this);
      }

      observe(options: { type?: string }) {
        this.observedType = options.type ?? "";
      }

      takeRecords(): PerformanceEntry[] {
        const entries = this.pending;
        this.pending = [];
        return entries;
      }

      emit(entries: PerformanceEntry[]) {
        this.callback({ getEntries: () => entries });
      }

      queue(entries: PerformanceEntry[]) {
        this.pending.push(...entries);
      }
    }
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    installWebVitalsObserver();
    const lcpObserver = FakePerformanceObserver.instances.find((entry) => entry.observedType === "largest-contentful-paint")!;
    const dashboard = document.createElement("h1");
    dashboard.className = "dashboard-title";
    lcpObserver.queue([{ startTime: 40, element: dashboard } as unknown as PerformanceEntry]);

    expect(freezeStartupWebVitals(50)).toMatchObject({
      largestContentfulPaintMs: 40,
      largestContentfulPaintElement: "h1.dashboard-title"
    });

    const activity = document.createElement("strong");
    activity.className = "activity-event-summary";
    lcpObserver.emit([{ startTime: 80, element: activity } as unknown as PerformanceEntry]);
    const delayedStartup = document.createElement("section");
    delayedStartup.className = "dashboard-grid";
    lcpObserver.emit([{ startTime: 45, element: delayedStartup } as unknown as PerformanceEntry]);
    const target = globalThis as typeof globalThis & {
      __BP_WEB_VITALS__?: { largestContentfulPaintMs: number };
      __BP_STARTUP_WEB_VITALS__?: { largestContentfulPaintMs: number; largestContentfulPaintElement: string };
    };
    expect(target.__BP_WEB_VITALS__?.largestContentfulPaintMs).toBe(80);
    expect(target.__BP_STARTUP_WEB_VITALS__).toMatchObject({
      largestContentfulPaintMs: 45,
      largestContentfulPaintElement: "section.dashboard-grid"
    });
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

  it("anchors atomic bootstrap depth on one matched successful RPC and measures later sequential work", () => {
    const rpcPath = "staging/rest/v1/rpc/load_operational_bootstrap_v2";
    const rpc = resource({ requestKey: "rpc", path: rpcPath, startTime: 10, responseStart: 15, responseEnd: 20 });
    const later = resource({ requestKey: "later", path: "staging/rest/v1/sessions", startTime: 21, responseEnd: 30 });
    expect(measureBootstrapDependencyDepth([rpc], [response("rpc", rpcPath)])).toBe(1);
    expect(measureBootstrapDependencyDepth([rpc, later], [response("rpc", rpcPath), response("later", later.path)])).toBe(2);
  });

  it("splits Resource Timing into total, TTFB, and download phases and rejects invalid ordering", () => {
    expect(measureResourceTimingPhases({ startTime: 10, responseStart: 25, responseEnd: 40 })).toEqual({
      totalMs: 30,
      fetchToFirstByteMs: 15,
      downloadMs: 15
    });
    expect(measureResourceTimingPhases({ startTime: 10, responseStart: 9, responseEnd: 40 })).toBeNull();
    expect(measureResourceTimingPhases({ startTime: 10, responseStart: 25, responseEnd: 24 })).toBeNull();
    expect(measureResourceTimingPhases({ startTime: Number.NaN, responseStart: 25, responseEnd: 40 })).toBeNull();
    expect(measureResourceTimingPhases({ startTime: 10, responseStart: Number.POSITIVE_INFINITY, responseEnd: 40 })).toBeNull();
    expect(measureResourceTimingPhases({ startTime: 10, responseStart: 25, responseEnd: Number.NaN })).toBeNull();
    expect(measureResourceTimingPhases({ startTime: 10, responseStart: 10, responseEnd: 10 })).toEqual({ totalMs: 0, fetchToFirstByteMs: 0, downloadMs: 0 });
  });

  it("fails atomic dependency depth closed for missing, duplicate, unmatched, failed, or invalid RPC evidence", () => {
    const rpcPath = "staging/rest/v1/rpc/load_operational_bootstrap_v2";
    const rpc = resource({ requestKey: "rpc", path: rpcPath, startTime: 10, responseStart: 15, responseEnd: 20 });
    expect(measureBootstrapDependencyDepth([rpc], [])).toBeNull();
    expect(measureBootstrapDependencyDepth([rpc, { ...rpc, requestKey: "rpc-2" }], [response("rpc", rpcPath)])).toBeNull();
    expect(measureBootstrapDependencyDepth([], [response("rpc", rpcPath)])).toBeNull();
    expect(measureBootstrapDependencyDepth([rpc], [response("rpc", rpcPath), response("rpc", rpcPath)])).toBeNull();
    expect(measureBootstrapDependencyDepth([rpc], [response("other", rpcPath)])).toBeNull();
    expect(measureBootstrapDependencyDepth([rpc], [response("rpc", rpcPath, 500)])).toBeNull();
    expect(measureBootstrapDependencyDepth([{ ...rpc, responseEnd: 9 }], [response("rpc", rpcPath)])).toBeNull();
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
