import fs from "node:fs";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import { attachJson, captureAuthenticatedRestRequests, credentials, signIn } from "./support/app";
import { parsePostgrestPageEvidence } from "../../../src/qa/operationalPerformancePageEvidence";
import { readDecodedResponseBody } from "../../../src/qa/operationalPerformanceResponseEvidence";
import {
  measureBootstrapDependencyDepth,
  installVisibleReadyObserver,
  INVENTORY_RENDER_POLL_INTERVAL_MS,
  requestStartedByBrowserMark,
  selectCriticalEvidence,
  sumCriticalShellTransferBytes
} from "../../../src/qa/operationalPerformanceCriticalPath";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const mode = process.env.E2E_PERFORMANCE_MODE === "baseline" ? "baseline" : "candidate";
const sampleCount = Number(process.env.E2E_PERFORMANCE_SAMPLES ?? 30);
const PERFORMANCE_METRIC_VERSION = 2;

type ResourceEvidence = {
  requestKey: string;
  path: string;
  api: boolean;
  shell: boolean;
  javascript: boolean;
  initiatorType: string;
  startTime: number;
  responseEnd: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
};

type ResponseEvidence = {
  requestKey: string;
  path: string;
  requestStartMs: number;
  responseEndMs: number;
  startMinusSafeMs?: number;
  status: number;
  bodyBytes: number;
  evidenceError?: string;
  contentLengthBytes: number;
  api: boolean;
  shell: boolean;
  appStateVersion?: number;
  jsonRowCount?: number;
  stockMovementHistoryPage?: boolean;
  requestOffset?: string;
  requestLimit?: string;
  contentRange?: string;
  exactCountRequested?: boolean;
  javascript: boolean;
  gzipBytes: number;
};

type RenderEvidence = {
  commits: number;
  mountCommits: number;
  updateCommits: number;
  totalActualDurationMs: number;
  maxActualDurationMs: number;
  updateActualDurationsMs: number[];
};

type LoadEvidence = {
  sample: number;
  visibleReadyMs: number;
  safeInteractiveMs: number;
  playwrightObservedSafeInteractiveMs: number;
  bootstrapMarks: Record<string, number>;
  criticalResources: ResourceEvidence[];
  criticalResponses: ResponseEvidence[];
  criticalRequestCount: number;
  criticalApiBytes: number;
  coldShellBytes: number;
  initialJavascriptBytes: number;
  initialJavascriptGzipBytes: number;
  failedRequestPaths: string[];
  requestedFullAppStateData: boolean;
  requestedExportChunk: boolean;
  requestedHistoryBeforeSafeInteractive: boolean;
  bootstrapDependencyDepth: number | null;
  largestContentfulPaintMs: number;
  largestContentfulPaintElement: string;
  largestContentfulPaintResourcePath: string;
  cumulativeLayoutShift: number;
  renderEvidence: RenderEvidence | null;
  activePanelCommitDurationsMs: number[];
  idleRootCommits: number | null;
  inventoryStockMovementCount: number | null;
  inventoryStockMovementPages: Array<{
    status: number;
    rowCount: number | null;
    requestOffset: string | null;
    requestLimit: string | null;
    contentRange: string | null;
    exactCountRequested: boolean;
  }>;
  inventoryHistoryReadyMs: number | null;
  inventoryNetworkCompleteMs: number | null;
  inventoryRemoteErrorVisible: boolean | null;
  criticalEvidenceErrors: string[];
  postSafeResponses: Array<{ path: string; startMinusSafeMs: number; status: number }>;
};

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function summarize(loads: LoadEvidence[]) {
  const visibleReady = loads.map((entry) => entry.visibleReadyMs);
  const safe = loads.map((entry) => entry.safeInteractiveMs).filter((value) => value >= 0);
  const payloads = loads.map((entry) => entry.criticalApiBytes);
  const shells = loads.map((entry) => entry.coldShellBytes);
  const initialJs = loads.map((entry) => entry.initialJavascriptBytes);
  const initialJsGzip = loads.map((entry) => entry.initialJavascriptGzipBytes);
  const lcp = loads.map((entry) => entry.largestContentfulPaintMs).filter((value) => value > 0);
  const cls = loads.map((entry) => entry.cumulativeLayoutShift);
  const updateDurations = loads.flatMap((entry) => entry.activePanelCommitDurationsMs);
  const inventoryHistoryDurations = loads
    .map((entry) => entry.inventoryHistoryReadyMs)
    .filter((value): value is number => value !== null);
  return {
    samples: visibleReady.length,
    p50: percentile(visibleReady, 0.5),
    p75: percentile(visibleReady, 0.75),
    p95: percentile(visibleReady, 0.95),
    max: Math.max(...visibleReady),
    mean: visibleReady.reduce((total, value) => total + value, 0) / visibleReady.length,
    safeInteractiveP95: percentile(safe, 0.95),
    safeInteractiveMax: safe.length > 0 ? Math.max(...safe) : 0,
    criticalApiBytesP95: percentile(payloads, 0.95),
    criticalApiBytesMax: Math.max(...payloads),
    coldShellBytesP95: percentile(shells, 0.95),
    initialJavascriptBytesMax: Math.max(...initialJs),
    initialJavascriptGzipBytesMax: Math.max(...initialJsGzip),
    lcpP75: percentile(lcp, 0.75),
    clsMax: Math.max(...cls),
    activePanelCommitP95Ms: percentile(updateDurations, 0.95),
    activePanelCommitMaxMs: updateDurations.length > 0 ? Math.max(...updateDurations) : 0,
    inventoryHistoryReadyP95Ms: percentile(inventoryHistoryDurations, 0.95),
    inventoryHistoryReadyMaxMs: inventoryHistoryDurations.length > 0 ? Math.max(...inventoryHistoryDurations) : 0
  };
}

function readBaseline(browserVersion: string) {
  const baselinePath = process.env.E2E_PERFORMANCE_BASELINE_PATH?.trim();
  const expectedSha = process.env.E2E_PERFORMANCE_BASELINE_SHA256?.trim().toLowerCase();
  if (!baselinePath || !expectedSha) throw new Error("Candidate performance requires an immutable baseline path and SHA-256.");
  const bytes = fs.readFileSync(baselinePath);
  const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== expectedSha) throw new Error("Performance baseline SHA-256 does not match.");
  const baseline = JSON.parse(bytes.toString("utf8"));
  if (baseline.metricVersion !== PERFORMANCE_METRIC_VERSION || baseline.mode !== "baseline" || baseline.sampleCount !== sampleCount || !baseline.summary?.p95 || !baseline.summary?.criticalApiBytesP95) {
    throw new Error("Performance baseline shape or sample count is incompatible.");
  }
  if (baseline.datasetManifestSha256 !== process.env.E2E_PERFORMANCE_DATASET_MANIFEST_SHA256?.toLowerCase()) {
    throw new Error("Candidate and baseline are not bound to the same staging dataset manifest.");
  }
  const expectedViewport = { width: 1440, height: 900 };
  if (
    baseline.browserVersion !== browserVersion
    || baseline.browserVersion !== process.env.E2E_EXPECTED_BROWSER_VERSION
    || JSON.stringify(baseline.viewport) !== JSON.stringify(expectedViewport)
    || baseline.cachePolicy !== "new-context-cold-cache-service-workers-blocked"
    || baseline.profileId !== process.env.E2E_PERFORMANCE_PROFILE_ID
    || baseline.networkProfile !== process.env.E2E_NETWORK_PROFILE
    || baseline.profileManifestSha256 !== process.env.E2E_PERFORMANCE_PROFILE_MANIFEST_SHA256?.toLowerCase()
  ) throw new Error("Candidate and baseline browser, viewport, cache, or network environment differs.");
  if (baseline.deployedBundleSha256 !== process.env.E2E_EXPECTED_BASELINE_BUNDLE_SHA256?.toLowerCase()) {
    throw new Error("Performance baseline is not bound to the approved deployed baseline bundle.");
  }
  return { path: baselinePath, sha256: actualSha, summary: baseline.summary };
}

function nextCorrelationKey(url: string, occurrences: Map<string, number>) {
  const occurrence = occurrences.get(url) ?? 0;
  occurrences.set(url, occurrence + 1);
  return `${crypto.createHash("sha256").update(url).digest("hex")}:${occurrence}`;
}

async function resourceEvidence(page: Page, baseOrigin: string): Promise<{ marks: Record<string, number>; resources: ResourceEvidence[] }> {
  const rawEvidence = await page.evaluate(() => {
    const allowedMarks = ["bp-bootstrap-requested", "bp-realtime-ready", "bp-critical-snapshot-ready", "bp-critical-catchup-ready", "bp-safe-interactive", "bp-visible-dashboard-ready"];
    const marks = Object.fromEntries(allowedMarks.map((name) => [name, performance.getEntriesByName(name, "mark").at(-1)?.startTime ?? -1]));
    const resources = [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")].map((raw) => {
      const entry = raw as PerformanceResourceTiming | PerformanceNavigationTiming;
      const url = new URL(entry.name);
      return {
        url: entry.name,
        path: `${url.hostname}${url.pathname}`,
        initiatorType: entry.initiatorType,
        startTime: entry.startTime,
        responseEnd: entry.responseEnd,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize
      };
    });
    return { marks, resources };
  });
  const occurrences = new Map<string, number>();
  return {
    marks: rawEvidence.marks,
    resources: rawEvidence.resources.map(({ url, ...entry }) => {
      const parsed = new URL(url);
      const api = /\/(?:rest|auth)\/v1\//.test(parsed.pathname);
      const shell = parsed.origin === baseOrigin && !api;
      return {
        ...entry,
        requestKey: nextCorrelationKey(url, occurrences),
        api,
        shell,
        javascript: shell && /\.js$/i.test(parsed.pathname)
      };
    })
  };
}

async function collectResponseEvidence(response: Response, requestKeys: Map<Request, string>, baseOrigin: string, sink: ResponseEvidence[]) {
  const url = new URL(response.url());
  const api = /\/(?:rest|auth)\/v1\//.test(url.pathname);
  const shell = url.origin === baseOrigin && !api;
  if (!api && !shell) return;
  const headers = await response.allHeaders();
  const requestHeaders = response.request().headers();
  const contentLengthBytes = Number(headers["content-length"] ?? 0);
  let bodyBytes = 0;
  let gzipBytes = 0;
  let evidenceError: string | undefined;
  let appStateVersion: number | undefined;
  let jsonRowCount: number | undefined;
  const javascript = shell && /\.js$/i.test(url.pathname);
  const requestTiming = response.request().timing();
  const movementAtFilters = url.searchParams.getAll("movement_at");
  const stockMovementHistoryPage = url.pathname.endsWith("/rest/v1/stock_movements")
    && url.searchParams.get("organization_id") === "eq.org-primary"
    && url.searchParams.get("order") === "movement_at.desc.nullslast,id.desc"
    && movementAtFilters.some((value) => value.startsWith("gte."))
    && movementAtFilters.some((value) => value.startsWith("lt."))
    && !url.searchParams.has("id");
  const stockMovementPageEvidence = stockMovementHistoryPage
    ? parsePostgrestPageEvidence(response.url(), requestHeaders.prefer, headers["content-range"])
    : undefined;
  if (api || javascript || (shell && contentLengthBytes === 0)) {
    const requiresJson = url.pathname.endsWith("/rest/v1/app_state") || url.pathname.endsWith("/rest/v1/stock_movements");
    const decoded = await readDecodedResponseBody(() => response.body(), requiresJson);
    bodyBytes = decoded.bodyBytes;
    evidenceError = decoded.error;
    if (!decoded.error && decoded.body) {
      if (javascript) gzipBytes = gzipSync(decoded.body).byteLength;
      if (url.pathname.endsWith("/rest/v1/app_state")) {
        const parsed = decoded.parsedJson;
        const row = Array.isArray(parsed) ? parsed[0] : parsed;
        if (row && typeof row === "object" && Number.isInteger((row as { version?: unknown }).version)) {
          appStateVersion = (row as { version: number }).version;
        }
      }
      if (url.pathname.endsWith("/rest/v1/stock_movements")) {
        const parsed = decoded.parsedJson;
        if (Array.isArray(parsed)) jsonRowCount = parsed.length;
      }
    }
  }
  sink.push({
    requestKey: requestKeys.get(response.request()) ?? "missing-request-correlation",
    path: `${url.hostname}${url.pathname}`,
    requestStartMs: requestTiming.startTime,
    responseEndMs: requestTiming.responseEnd >= 0 ? requestTiming.startTime + requestTiming.responseEnd : Number.NaN,
    status: response.status(),
    bodyBytes,
    evidenceError,
    contentLengthBytes,
    api,
    shell,
    javascript,
    gzipBytes,
    appStateVersion,
    jsonRowCount,
    stockMovementHistoryPage,
    requestOffset: stockMovementPageEvidence?.requestOffset ?? undefined,
    requestLimit: stockMovementPageEvidence?.requestLimit ?? undefined,
    contentRange: stockMovementPageEvidence?.contentRange ?? undefined,
    exactCountRequested: stockMovementPageEvidence?.exactCountRequested
  });
}

test("30 cold authenticated loads meet the safe-interactive and critical-path budget", async ({ browser, page }, testInfo) => {
  test.setTimeout(12 * 60_000);
  expect(sampleCount).toBe(30);
  expect(browser.version()).toBe(process.env.E2E_EXPECTED_BROWSER_VERSION);
  expect(process.env.E2E_NETWORK_PROFILE?.trim()).toBeTruthy();
  const authenticatedRequests: import("./support/app").CapturedRpcRequest[] = [];
  captureAuthenticatedRestRequests(page, authenticatedRequests);
  await signIn(page, credentials("A"));
  const captured = authenticatedRequests.find((entry) => new URL(entry.url).pathname.includes("/rest/v1/"));
  if (!captured) throw new Error("Unable to capture an authenticated REST identity for dataset verification.");
  const capturedUrl = new URL(captured.url);
  const restMarker = "/rest/v1";
  const restBase = `${capturedUrl.origin}${capturedUrl.pathname.slice(0, capturedUrl.pathname.indexOf(restMarker))}${restMarker}`;
  const expectedDatasetIdentity = JSON.parse(process.env.E2E_EXPECTED_DATASET_IDENTITY ?? "null") as Record<string, unknown> | null;
  if (!expectedDatasetIdentity) throw new Error("Performance dataset identity is missing.");
  const identityRpc = process.env.E2E_PERFORMANCE_DATASET_RPC?.trim() || "get_operational_performance_dataset_identity";
  const identityResponse = await page.request.post(`${restBase}/rpc/${identityRpc}`, {
    headers: { apikey: captured.headers.apikey, authorization: captured.headers.authorization, "content-type": "application/json" },
    data: { payload: { organization_id: "org-primary" } }
  });
  expect(identityResponse.status()).toBe(200);
  const observedDatasetIdentity = await identityResponse.json();
  expect(observedDatasetIdentity, "Live normalized content fingerprints drifted from the immutable dataset snapshot.").toEqual(expectedDatasetIdentity);
  const storageState = await page.context().storageState();
  const loads: LoadEvidence[] = [];
  const baseOrigin = new URL(process.env.E2E_BASE_URL!).origin;

  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const context = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL,
      storageState,
      locale: "en-IN",
      timezoneId: "Asia/Calcutta",
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block"
    });
    await context.addInitScript(() => {
      const target = globalThis as typeof globalThis & { __BP_WEB_VITALS__?: { largestContentfulPaintMs: number; largestContentfulPaintElement: string; largestContentfulPaintResourcePath: string; cumulativeLayoutShift: number } };
      target.__BP_WEB_VITALS__ = { largestContentfulPaintMs: 0, largestContentfulPaintElement: "", largestContentfulPaintResourcePath: "", cumulativeLayoutShift: 0 };
      new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const entry = raw as PerformanceEntry & { element?: Element; url?: string };
          target.__BP_WEB_VITALS__!.largestContentfulPaintMs = entry.startTime;
          target.__BP_WEB_VITALS__!.largestContentfulPaintElement = entry.element
            ? `${entry.element.tagName.toLowerCase()}${entry.element.id ? `#${entry.element.id}` : ""}${[...entry.element.classList].slice(0, 3).map((value) => `.${value}`).join("")}`
            : "";
          if (entry.url) {
            const url = new URL(entry.url);
            target.__BP_WEB_VITALS__!.largestContentfulPaintResourcePath = `${url.hostname}${url.pathname}`;
          }
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (!shift.hadRecentInput) target.__BP_WEB_VITALS__!.cumulativeLayoutShift += shift.value ?? 0;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await context.addInitScript(installVisibleReadyObserver, {
      markName: "bp-visible-dashboard-ready",
      headingText: "Live Dashboard"
    });
    const coldPage = await context.newPage();
    const started = performance.now();
    const failedRequestPaths: string[] = [];
    const requests = new Map<Request, string>();
    const requestKeys = new Map<Request, string>();
    const requestUrlOccurrences = new Map<string, number>();
    const responses: ResponseEvidence[] = [];
    const responseTasks = new Map<Request, Promise<void>>();
    const responseResolvers = new Map<Request, () => void>();
    let requestedFullAppStateData = false;
    let requestedExportChunk = false;

    coldPage.on("request", (request) => {
      const url = new URL(request.url());
      const path = `${url.hostname}${url.pathname}`;
      requests.set(request, path);
      requestKeys.set(request, nextCorrelationKey(request.url(), requestUrlOccurrences));
      if (/\/(?:rest|auth)\/v1\//.test(url.pathname) || url.origin === baseOrigin) {
        responseTasks.set(request, new Promise<void>((resolve) => responseResolvers.set(request, resolve)));
      }
      if (url.pathname.includes("/rest/v1/app_state")) {
        const select = url.searchParams.get("select") ?? "";
        requestedFullAppStateData ||= !select || select === "*" || select.split(",").includes("data");
      }
      requestedExportChunk ||= /(?:xlsx|jspdf)[^/]*-[^/]+\.js$/i.test(url.pathname);
    });
    coldPage.on("response", (response) => {
      const task = collectResponseEvidence(response, requestKeys, baseOrigin, responses);
      void task.finally(() => responseResolvers.get(response.request())?.());
    });
    coldPage.on("requestfailed", (request) => {
      failedRequestPaths.push(requests.get(request) ?? "unknown");
      responseResolvers.get(request)?.();
    });

    await coldPage.goto("/", { waitUntil: "domcontentloaded" });
    await expect(coldPage.getByRole("heading", { name: "Live Dashboard", exact: true })).toBeVisible();
    await expect.poll(() => coldPage.evaluate(() => performance.getEntriesByName("bp-visible-dashboard-ready", "mark").length)).toBe(1);
    if (mode === "candidate") {
      await expect(coldPage.locator('[data-app-safe-interactive="true"]')).toBeVisible();
      await expect.poll(() => coldPage.evaluate(() => performance.getEntriesByName("bp-safe-interactive", "mark").length)).toBe(1);
    }
    const playwrightObservedSafeInteractiveMs = performance.now() - started;
    const browserBoundary = await coldPage.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      visibleReadyMark: performance.getEntriesByName("bp-visible-dashboard-ready", "mark").at(-1)?.startTime ?? -1,
      safeMark: performance.getEntriesByName("bp-safe-interactive", "mark").at(-1)?.startTime ?? -1
    }));
    const visibleReadyMs = browserBoundary.visibleReadyMark;
    const safeInteractiveMs = mode === "candidate" ? browserBoundary.safeMark : -1;
    const timingErrors: string[] = [];
    const expectedCriticalRequestKeys = new Set<string>();
    const criticalRequestTasks = [...responseTasks.entries()].flatMap(([request, completion]) => {
      const startedByReady = requestStartedByBrowserMark(request.timing().startTime, browserBoundary.timeOrigin, visibleReadyMs);
      if (startedByReady === null) {
        timingErrors.push(`Request ${requestKeys.get(request) ?? "missing-request-correlation"} has invalid browser timing.`);
        return [completion];
      }
      if (!startedByReady) return [];
      expectedCriticalRequestKeys.add(requestKeys.get(request) ?? "missing-request-correlation");
      return [completion];
    });
    await Promise.all(criticalRequestTasks);
    const { marks, resources } = await resourceEvidence(coldPage, baseOrigin);
    const comparisonReadyMark = visibleReadyMs;
    if (mode === "candidate") {
      expect(safeInteractiveMs).toBeGreaterThanOrEqual(0);
      for (const mark of ["bp-bootstrap-requested", "bp-realtime-ready", "bp-critical-snapshot-ready", "bp-critical-catchup-ready"]) {
        expect(marks[mark]).toBeGreaterThanOrEqual(0);
        expect(marks[mark]).toBeLessThanOrEqual(safeInteractiveMs);
      }
    }
    const criticalSelection = selectCriticalEvidence(resources, responses, comparisonReadyMark, expectedCriticalRequestKeys);
    const criticalResources = criticalSelection.criticalResources;
    const resourceByKey = new Map(criticalResources.map((entry) => [entry.requestKey, entry]));
    const criticalResponses = criticalSelection.criticalResponses.map((entry) => {
      const resource = resourceByKey.get(entry.requestKey)!;
      return {
        ...entry,
        requestStartMs: resource.startTime,
        responseEndMs: resource.responseEnd,
        startMinusSafeMs: resource.startTime - comparisonReadyMark
      };
    });
    const deferredHistoryPath = (path: string) =>
      /\/rest\/v1\/(?:bills|bill_lines|bill_discounts|bill_line_discounts|payments|expenses|audit_logs|stock_movements|customers)(?:$|\/)/.test(path)
      || /\/rest\/v1\/rpc\/(?:.*report.*|.*customer.*history.*|.*customer.*search.*)(?:$|\/)/.test(path);
    const deferralBoundary = mode === "candidate" ? safeInteractiveMs : comparisonReadyMark;
    const requestedHistoryBeforeSafeInteractive = resources.some((entry) =>
      entry.startTime <= deferralBoundary && deferredHistoryPath(entry.path)
    );

    let renderEvidence: RenderEvidence | null = null;
    let activePanelCommitDurationsMs: number[] = [];
    let idleRootCommits: number | null = null;
    let inventoryStockMovementCount: number | null = null;
    let inventoryStockMovementPages: LoadEvidence["inventoryStockMovementPages"] = [];
    let inventoryHistoryReadyMs: number | null = null;
    let inventoryNetworkCompleteMs: number | null = null;
    let inventoryRemoteErrorVisible: boolean | null = null;
    if (mode === "candidate") {
      await coldPage.waitForLoadState("networkidle");
      await coldPage.waitForTimeout(500);
      renderEvidence = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence }).__BP_RENDER_EVIDENCE__ ?? null);
      expect(renderEvidence, "Candidate staging build must enable VITE_PERFORMANCE_EVIDENCE=true.").not.toBeNull();
      const panelCommitOffset = renderEvidence!.updateActualDurationsMs.length;
      const inventoryResponseOffset = responses.length;
      const inventoryHistoryStarted = performance.now();
      await coldPage.getByRole("button", { name: "Inventory", exact: true }).click();
      await expect(coldPage.getByRole("heading", { name: "Inventory Catalog", exact: true })).toBeVisible();
      const expectedRecentStockMovements = Number(process.env.E2E_EXPECTED_RECENT_STOCK_MOVEMENTS);
      expect(Number.isInteger(expectedRecentStockMovements) && expectedRecentStockMovements >= 0 && expectedRecentStockMovements < 5_000).toBe(true);
      expect(expectedRecentStockMovements, "The frozen scale candidate requires its exact 1,506-row Inventory history shape.").toBe(1_506);
      const inventoryMovementResponses = () => responses.slice(inventoryResponseOffset).filter((response) => response.stockMovementHistoryPage === true);
       await expect.poll(() => {
         const movementResponses = inventoryMovementResponses();
         if (movementResponses.length === 0 || movementResponses.some((response) => !Number.isInteger(response.jsonRowCount))) return -1;
         return movementResponses.reduce((total, response) => total + (response.jsonRowCount ?? 0), 0);
       }, { intervals: [INVENTORY_RENDER_POLL_INTERVAL_MS], timeout: 5_000 }).toBe(expectedRecentStockMovements);
       inventoryNetworkCompleteMs = performance.now() - inventoryHistoryStarted;
      const movementResponses = inventoryMovementResponses().sort((left, right) =>
        Number(left.requestOffset ?? Number.MAX_SAFE_INTEGER) - Number(right.requestOffset ?? Number.MAX_SAFE_INTEGER));
      const expectedPageRows = expectedRecentStockMovements === 0
        ? [0]
        : Array.from({ length: Math.ceil(expectedRecentStockMovements / 1_000) }, (_, index) =>
          Math.min(1_000, expectedRecentStockMovements - index * 1_000));
      const expectedRequestOffsets = expectedPageRows.map((_, index) => String(index * 1_000));
      const expectedRequestLimits = expectedPageRows.map(() => "1000");
      const expectedContentRanges = expectedPageRows.map((rowCount, index) => rowCount === 0
        ? `*/${expectedRecentStockMovements}`
        : `${index * 1_000}-${index * 1_000 + rowCount - 1}/${expectedRecentStockMovements}`);
      expect(movementResponses).toHaveLength(expectedPageRows.length);
      expect(movementResponses.map((response) => response.jsonRowCount)).toEqual(expectedPageRows);
      expect(movementResponses.every((response) => [200, 206].includes(response.status))).toBe(true);
      expect(movementResponses.every((response) => response.exactCountRequested === true)).toBe(true);
      expect(movementResponses.map((response) => response.requestOffset)).toEqual(expectedRequestOffsets);
      expect(movementResponses.map((response) => response.requestLimit)).toEqual(expectedRequestLimits);
      expect(movementResponses.map((response) => response.contentRange)).toEqual(expectedContentRanges);
      inventoryStockMovementCount = movementResponses.reduce((total, response) => total + (response.jsonRowCount ?? 0), 0);
      inventoryStockMovementPages = movementResponses.map((response) => ({
        status: response.status,
        rowCount: response.jsonRowCount ?? null,
        requestOffset: response.requestOffset ?? null,
        requestLimit: response.requestLimit ?? null,
        contentRange: response.contentRange ?? null,
        exactCountRequested: response.exactCountRequested === true
      }));
      const recentMovementsSection = coldPage.getByRole("heading", { name: "Recent Movements", exact: true }).locator("..").locator("..");
      await expect.poll(
        () => recentMovementsSection.locator(".activity-row").count(),
        { intervals: [INVENTORY_RENDER_POLL_INTERVAL_MS], timeout: 5_000 }
      ).toBe(Math.min(10, expectedRecentStockMovements));
      inventoryHistoryReadyMs = performance.now() - inventoryHistoryStarted;
      await coldPage.waitForLoadState("networkidle");
      await coldPage.waitForTimeout(500);
      inventoryRemoteErrorVisible = await coldPage.locator(".remote-error-banner").isVisible();
      expect(inventoryRemoteErrorVisible, "Deferred Inventory history must load without a remote error banner.").toBe(false);
      activePanelCommitDurationsMs = await coldPage.evaluate((offset) => (
        globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence }
      ).__BP_RENDER_EVIDENCE__?.updateActualDurationsMs.slice(offset) ?? [], panelCommitOffset);
      expect(activePanelCommitDurationsMs.length).toBeGreaterThan(0);
      const beforeIdle = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence }).__BP_RENDER_EVIDENCE__?.commits ?? 0);
      await coldPage.waitForTimeout(1_200);
      const afterIdle = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence }).__BP_RENDER_EVIDENCE__?.commits ?? 0);
      idleRootCommits = afterIdle - beforeIdle;
    } else {
      await coldPage.waitForLoadState("networkidle");
      await coldPage.waitForTimeout(500);
    }
    await Promise.all(responseTasks.values());
    const postSafeResponses = responses.flatMap((entry) => {
      const postSafeBoundary = mode === "candidate" ? safeInteractiveMs : comparisonReadyMark;
      const startMinusSafeMs = entry.requestStartMs - browserBoundary.timeOrigin - postSafeBoundary;
      return Number.isFinite(startMinusSafeMs) && startMinusSafeMs > 0
        ? [{ path: entry.path, startMinusSafeMs, status: entry.status }]
        : [];
    });
    const webVitals = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_WEB_VITALS__?: { largestContentfulPaintMs: number; largestContentfulPaintElement: string; largestContentfulPaintResourcePath: string; cumulativeLayoutShift: number } }).__BP_WEB_VITALS__ ?? { largestContentfulPaintMs: 0, largestContentfulPaintElement: "", largestContentfulPaintResourcePath: "", cumulativeLayoutShift: 0 });

    const responseEvidenceErrors = criticalResponses.flatMap((entry) => entry.evidenceError
      ? [`Critical response ${entry.requestKey} has invalid decoded-body evidence (${entry.evidenceError}).`]
      : []);
    const criticalApiBytes = criticalResponses.filter((entry) => entry.api).reduce((total, entry) => total + entry.bodyBytes, 0);
    const coldShellBytes = sumCriticalShellTransferBytes(criticalResources);
    const initialJavascriptBytes = criticalResponses.filter((entry) => entry.javascript).reduce((total, entry) => total + entry.bodyBytes, 0);
    const initialJavascriptGzipBytes = criticalResponses.filter((entry) => entry.javascript).reduce((total, entry) => total + entry.gzipBytes, 0);
    loads.push({
      sample,
      visibleReadyMs,
      safeInteractiveMs,
      playwrightObservedSafeInteractiveMs,
      bootstrapMarks: marks,
      criticalResources,
      criticalResponses,
      criticalRequestCount: criticalResources.length,
      criticalApiBytes,
      coldShellBytes,
      initialJavascriptBytes,
      initialJavascriptGzipBytes,
      failedRequestPaths,
      requestedFullAppStateData,
      requestedExportChunk,
      requestedHistoryBeforeSafeInteractive,
      bootstrapDependencyDepth: mode === "candidate" ? measureBootstrapDependencyDepth(criticalResources, criticalResponses) : null,
      largestContentfulPaintMs: webVitals.largestContentfulPaintMs,
      largestContentfulPaintElement: webVitals.largestContentfulPaintElement,
      largestContentfulPaintResourcePath: webVitals.largestContentfulPaintResourcePath,
      cumulativeLayoutShift: webVitals.cumulativeLayoutShift,
      renderEvidence,
      activePanelCommitDurationsMs,
      idleRootCommits,
      inventoryStockMovementCount,
      inventoryStockMovementPages,
      inventoryHistoryReadyMs,
      inventoryNetworkCompleteMs,
      inventoryRemoteErrorVisible,
      criticalEvidenceErrors: [...timingErrors, ...criticalSelection.errors, ...responseEvidenceErrors],
      postSafeResponses
    });
    await context.close();
  }

  const summary = summarize(loads);
  const baseline = mode === "candidate" ? readBaseline(browser.version()) : undefined;
  const result = {
    metricVersion: PERFORMANCE_METRIC_VERSION,
    runId,
    mode,
    sampleCount,
    datasetManifestSha256: process.env.E2E_PERFORMANCE_DATASET_MANIFEST_SHA256?.toLowerCase(),
    profileManifestSha256: process.env.E2E_PERFORMANCE_PROFILE_MANIFEST_SHA256?.toLowerCase(),
    deployedBundleSha256: process.env.E2E_DEPLOYED_BUNDLE_SHA256?.toLowerCase(),
    browserVersion: browser.version(),
    viewport: { width: 1440, height: 900 },
    cachePolicy: "new-context-cold-cache-service-workers-blocked",
    profileId: process.env.E2E_PERFORMANCE_PROFILE_ID,
    networkProfile: process.env.E2E_NETWORK_PROFILE,
    datasetIdentity: observedDatasetIdentity,
    summary,
    baseline,
    loads
  };
  await attachJson(testInfo, "operational-performance-evidence", result);

  expect.soft(loads.every((entry) => entry.failedRequestPaths.length === 0)).toBe(true);
  expect.soft(loads.every((entry) => entry.criticalEvidenceErrors.length === 0)).toBe(true);
  expect.soft(loads.every((entry) => !entry.requestedExportChunk)).toBe(true);
  const expectedAppStateVersion = Number(process.env.E2E_EXPECTED_APP_STATE_VERSION);
  expect.soft(Number.isInteger(expectedAppStateVersion)).toBe(true);
  expect.soft(loads.every((entry) => {
    const identities = entry.criticalResponses.filter((response) => response.path.endsWith("/rest/v1/app_state"));
    return identities.length > 0 && identities.every((response) => response.appStateVersion === expectedAppStateVersion);
  })).toBe(true);
  if (mode === "candidate") {
    expect.soft(loads.every((entry) => !entry.requestedFullAppStateData)).toBe(true);
    expect.soft(loads.every((entry) => !entry.requestedHistoryBeforeSafeInteractive)).toBe(true);
    expect.soft(loads.every((entry) => entry.postSafeResponses.some((response) =>
      response.status >= 200
      && response.status < 400
      && /\/rest\/v1\/(?:bills|payments|expenses|audit_logs)(?:$|\/)/.test(response.path)
    ))).toBe(true);
    expect.soft(loads.every((entry) => entry.postSafeResponses.some((response) =>
      response.status >= 200
      && response.status < 400
      && /\/assets\/InventoryPanel-[^/]+\.js$/.test(response.path)
    ))).toBe(true);
    expect.soft(loads.every((entry) => entry.bootstrapDependencyDepth !== null && entry.bootstrapDependencyDepth <= 3)).toBe(true);
    expect.soft(loads.every((entry) => entry.criticalApiBytes > 0)).toBe(true);
    expect.soft(loads.every((entry) => entry.coldShellBytes > 0)).toBe(true);
    expect.soft(loads.every((entry) => entry.criticalResponses.every((response) =>
      response.status >= 200
      && response.status < 400
      && (response.status === 204 || response.status === 304 || response.bodyBytes > 0)
    ))).toBe(true);
    expect.soft(loads.every((entry) => entry.idleRootCommits === 0)).toBe(true);
    expect.soft(loads.every((entry) => entry.inventoryStockMovementCount === Number(process.env.E2E_EXPECTED_RECENT_STOCK_MOVEMENTS))).toBe(true);
    expect.soft(loads.every((entry) => entry.inventoryHistoryReadyMs !== null && entry.inventoryHistoryReadyMs <= 5_000)).toBe(true);
    expect.soft(loads.every((entry) => entry.inventoryRemoteErrorVisible === false)).toBe(true);
    expect.soft(summary.safeInteractiveP95).toBeLessThanOrEqual(3_500);
    expect.soft(summary.safeInteractiveMax).toBeLessThanOrEqual(5_000);
    expect.soft(summary.p95).toBeLessThanOrEqual(baseline!.summary.p95 * 0.6);
    expect.soft(summary.criticalApiBytesP95).toBeLessThanOrEqual(750 * 1024);
    expect.soft(summary.criticalApiBytesP95).toBeLessThanOrEqual(baseline!.summary.criticalApiBytesP95 * 0.4);
    expect.soft(summary.coldShellBytesP95).toBeLessThanOrEqual(450 * 1024);
    expect.soft(summary.initialJavascriptBytesMax).toBeLessThanOrEqual(1_000 * 1024);
    expect.soft(summary.initialJavascriptGzipBytesMax).toBeLessThanOrEqual(300 * 1024);
    expect.soft(summary.lcpP75).toBeGreaterThan(0);
    expect.soft(summary.lcpP75).toBeLessThanOrEqual(2_500);
    expect.soft(summary.clsMax).toBeLessThanOrEqual(0.1);
    expect.soft(summary.activePanelCommitP95Ms).toBeLessThan(16);
    expect.soft(summary.activePanelCommitMaxMs).toBeLessThan(50);
    expect.soft(summary.inventoryHistoryReadyP95Ms).toBeLessThanOrEqual(2_000);
    expect.soft(summary.inventoryHistoryReadyMaxMs).toBeLessThanOrEqual(5_000);
  }
});
