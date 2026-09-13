import fs from "node:fs";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import { attachJson, captureAuthenticatedRestRequests, credentials, signIn } from "./support/app";
import { parsePostgrestPageEvidence } from "../../../src/qa/operationalPerformancePageEvidence";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const mode = process.env.E2E_PERFORMANCE_MODE === "baseline" ? "baseline" : "candidate";
const sampleCount = Number(process.env.E2E_PERFORMANCE_SAMPLES ?? 30);

type ResourceEvidence = {
  path: string;
  initiatorType: string;
  startTime: number;
  responseEnd: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
};

type ResponseEvidence = {
  path: string;
  requestStartMs: number;
  responseEndMs: number;
  status: number;
  bodyBytes: number;
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
  safeInteractiveMs: number;
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
  inventoryRemoteErrorVisible: boolean | null;
};

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function summarize(loads: LoadEvidence[]) {
  const safe = loads.map((entry) => entry.safeInteractiveMs);
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
    samples: safe.length,
    p50: percentile(safe, 0.5),
    p75: percentile(safe, 0.75),
    p95: percentile(safe, 0.95),
    max: Math.max(...safe),
    mean: safe.reduce((total, value) => total + value, 0) / safe.length,
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
  if (baseline.mode !== "baseline" || baseline.sampleCount !== sampleCount || !baseline.summary?.p95 || !baseline.summary?.criticalApiBytesP95) {
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

function measureBootstrapDependencyDepth(responses: ResponseEvidence[]): number {
  const apiResponses = responses
    .filter((entry) => entry.api && entry.status < 400)
    .sort((left, right) => left.requestStartMs - right.requestStartMs);
  const organizationResponse = apiResponses.find((entry) => /\/rest\/v1\/organizations$/.test(entry.path));
  if (!organizationResponse) {
    throw new Error("Candidate bootstrap did not request the active organization.");
  }
  // The profile lookup precedes normalized bootstrap by design. Measure the
  // critical bootstrap graph from organization resolution onward so the gate
  // cannot be inflated by pre-bootstrap authentication, while every REST/RPC
  // request in the actual normalized graph remains included dynamically.
  const bootstrapResponses = apiResponses.filter(
    (entry) => entry.requestStartMs + 2 >= organizationResponse.requestStartMs
  );
  const depths: number[] = [];
  bootstrapResponses.forEach((_entry, index) => {
    let depth = 1;
    for (let previous = 0; previous < index; previous += 1) {
      if (bootstrapResponses[previous].responseEndMs <= bootstrapResponses[index].requestStartMs + 2) {
        depth = Math.max(depth, depths[previous] + 1);
      }
    }
    depths.push(depth);
  });
  return depths.length > 0 ? Math.max(...depths) : 0;
}

async function resourceEvidence(page: Page): Promise<{ marks: Record<string, number>; resources: ResourceEvidence[] }> {
  return page.evaluate(() => {
    const allowedMarks = ["bp-bootstrap-requested", "bp-realtime-ready", "bp-critical-snapshot-ready", "bp-critical-catchup-ready", "bp-safe-interactive"];
    const marks = Object.fromEntries(allowedMarks.map((name) => [name, performance.getEntriesByName(name, "mark").at(-1)?.startTime ?? -1]));
    const resources = performance.getEntriesByType("resource").map((raw) => {
      const entry = raw as PerformanceResourceTiming;
      const url = new URL(entry.name);
      return {
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
}

async function collectResponseEvidence(response: Response, requestStarts: Map<Request, number>, started: number, baseOrigin: string, sink: ResponseEvidence[]) {
  const url = new URL(response.url());
  const api = /\/(?:rest|auth)\/v1\//.test(url.pathname);
  const shell = url.origin === baseOrigin && !api;
  if (!api && !shell) return;
  const headers = await response.allHeaders();
  const requestHeaders = response.request().headers();
  const contentLengthBytes = Number(headers["content-length"] ?? 0);
  let bodyBytes = 0;
  let gzipBytes = 0;
  let appStateVersion: number | undefined;
  let jsonRowCount: number | undefined;
  const javascript = shell && /\.js$/i.test(url.pathname);
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
    try {
      const body = await response.body();
      bodyBytes = body.byteLength;
      if (javascript) gzipBytes = gzipSync(body).byteLength;
      if (url.pathname.endsWith("/rest/v1/app_state")) {
        const parsed = JSON.parse(body.toString("utf8"));
        const row = Array.isArray(parsed) ? parsed[0] : parsed;
        if (Number.isInteger(row?.version)) appStateVersion = row.version;
      }
      if (url.pathname.endsWith("/rest/v1/stock_movements")) {
        const parsed = JSON.parse(body.toString("utf8"));
        if (Array.isArray(parsed)) jsonRowCount = parsed.length;
      }
    } catch {
      bodyBytes = contentLengthBytes;
    }
  }
  sink.push({
    path: `${url.hostname}${url.pathname}`,
    requestStartMs: requestStarts.get(response.request()) ?? performance.now() - started,
    responseEndMs: performance.now() - started,
    status: response.status(),
    bodyBytes,
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
      const target = globalThis as typeof globalThis & { __BP_WEB_VITALS__?: { largestContentfulPaintMs: number; cumulativeLayoutShift: number } };
      target.__BP_WEB_VITALS__ = { largestContentfulPaintMs: 0, cumulativeLayoutShift: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) target.__BP_WEB_VITALS__!.largestContentfulPaintMs = entry.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (!shift.hadRecentInput) target.__BP_WEB_VITALS__!.cumulativeLayoutShift += shift.value ?? 0;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    const coldPage = await context.newPage();
    const started = performance.now();
    const failedRequestPaths: string[] = [];
    const requests = new Map<Request, string>();
    const requestStarts = new Map<Request, number>();
    const responses: ResponseEvidence[] = [];
    const responseTasks = new Map<Request, Promise<void>>();
    const responseResolvers = new Map<Request, () => void>();
    let requestedFullAppStateData = false;
    let requestedExportChunk = false;

    coldPage.on("request", (request) => {
      const url = new URL(request.url());
      const path = `${url.hostname}${url.pathname}`;
      requests.set(request, path);
      requestStarts.set(request, performance.now() - started);
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
      const task = collectResponseEvidence(response, requestStarts, started, baseOrigin, responses);
      void task.finally(() => responseResolvers.get(response.request())?.());
    });
    coldPage.on("requestfailed", (request) => {
      failedRequestPaths.push(requests.get(request) ?? "unknown");
      responseResolvers.get(request)?.();
    });

    await coldPage.goto("/", { waitUntil: "domcontentloaded" });
    await expect(coldPage.getByRole("heading", { name: "Live Dashboard", exact: true })).toBeVisible();
    if (mode === "candidate") {
      await expect(coldPage.locator('[data-app-safe-interactive="true"]')).toBeVisible();
      await expect.poll(() => coldPage.evaluate(() => performance.getEntriesByName("bp-safe-interactive", "mark").length)).toBe(1);
    }
    const safeInteractiveMs = performance.now() - started;
    const browserCutoff = await coldPage.evaluate(() => performance.now());
    const criticalRequestTasks = [...responseTasks.entries()]
      .filter(([request]) => (requestStarts.get(request) ?? Number.POSITIVE_INFINITY) <= safeInteractiveMs)
      .map(([, completion]) => completion);
    await Promise.all(criticalRequestTasks);
    const { marks, resources } = await resourceEvidence(coldPage);
    const safeMark = mode === "candidate" ? marks["bp-safe-interactive"] : browserCutoff;
    if (mode === "candidate") {
      expect(safeMark).toBeGreaterThanOrEqual(0);
      for (const mark of ["bp-bootstrap-requested", "bp-realtime-ready", "bp-critical-snapshot-ready", "bp-critical-catchup-ready"]) {
        expect(marks[mark]).toBeGreaterThanOrEqual(0);
        expect(marks[mark]).toBeLessThanOrEqual(safeMark);
      }
    }
    const criticalResources = resources.filter((entry) => entry.startTime <= safeMark);
    const criticalResponses = responses.filter((entry) => entry.requestStartMs <= safeInteractiveMs);
    const criticalPaths = criticalResources.map((entry) => entry.path);
    const requestedHistoryBeforeSafeInteractive = criticalPaths.some((path) =>
      /\/rest\/v1\/(?:bills|bill_lines|payments|expenses|audit_logs|stock_movements|customers)(?:$|\/)/.test(path)
      || /\/rest\/v1\/rpc\/(?:.*report.*|.*customer.*history.*|.*customer.*search.*)(?:$|\/)/.test(path)
    );

    let renderEvidence: RenderEvidence | null = null;
    let activePanelCommitDurationsMs: number[] = [];
    let idleRootCommits: number | null = null;
    let inventoryStockMovementCount: number | null = null;
    let inventoryStockMovementPages: LoadEvidence["inventoryStockMovementPages"] = [];
    let inventoryHistoryReadyMs: number | null = null;
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
      }).toBe(expectedRecentStockMovements);
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
      await expect(recentMovementsSection.locator(".activity-row")).toHaveCount(Math.min(10, expectedRecentStockMovements));
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
    const webVitals = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_WEB_VITALS__?: { largestContentfulPaintMs: number; cumulativeLayoutShift: number } }).__BP_WEB_VITALS__ ?? { largestContentfulPaintMs: 0, cumulativeLayoutShift: 0 });

    const criticalApiBytes = criticalResponses.filter((entry) => entry.api).reduce((total, entry) => total + (entry.bodyBytes || entry.contentLengthBytes), 0);
    const coldShellBytes = criticalResponses.filter((entry) => entry.shell).reduce((total, entry) => total + (entry.contentLengthBytes || entry.bodyBytes), 0);
    const initialJavascriptBytes = criticalResponses.filter((entry) => entry.javascript).reduce((total, entry) => total + entry.bodyBytes, 0);
    const initialJavascriptGzipBytes = criticalResponses.filter((entry) => entry.javascript).reduce((total, entry) => total + entry.gzipBytes, 0);
    loads.push({
      sample,
      safeInteractiveMs,
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
      bootstrapDependencyDepth: mode === "candidate" ? measureBootstrapDependencyDepth(criticalResponses) : null,
      largestContentfulPaintMs: webVitals.largestContentfulPaintMs,
      cumulativeLayoutShift: webVitals.cumulativeLayoutShift,
      renderEvidence,
      activePanelCommitDurationsMs,
      idleRootCommits,
      inventoryStockMovementCount,
      inventoryStockMovementPages,
      inventoryHistoryReadyMs,
      inventoryRemoteErrorVisible
    });
    await context.close();
  }

  const summary = summarize(loads);
  const baseline = mode === "candidate" ? readBaseline(browser.version()) : undefined;
  const result = {
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

  expect(loads.every((entry) => entry.failedRequestPaths.length === 0)).toBe(true);
  expect(loads.every((entry) => !entry.requestedExportChunk)).toBe(true);
  const expectedAppStateVersion = Number(process.env.E2E_EXPECTED_APP_STATE_VERSION);
  expect(Number.isInteger(expectedAppStateVersion)).toBe(true);
  expect(loads.every((entry) => {
    const identities = entry.criticalResponses.filter((response) => response.path.endsWith("/rest/v1/app_state"));
    return identities.length > 0 && identities.every((response) => response.appStateVersion === expectedAppStateVersion);
  })).toBe(true);
  if (mode === "candidate") {
    expect(loads.every((entry) => !entry.requestedFullAppStateData)).toBe(true);
    expect(loads.every((entry) => !entry.requestedHistoryBeforeSafeInteractive)).toBe(true);
    expect(loads.every((entry) => entry.bootstrapDependencyDepth !== null && entry.bootstrapDependencyDepth <= 3)).toBe(true);
    expect(loads.every((entry) => entry.criticalApiBytes > 0)).toBe(true);
    expect(loads.every((entry) => entry.coldShellBytes > 0)).toBe(true);
    expect(loads.every((entry) => entry.criticalResponses.every((response) =>
      response.status === 204 || response.status === 304 || response.bodyBytes > 0 || response.contentLengthBytes > 0
    ))).toBe(true);
    expect(loads.every((entry) => entry.idleRootCommits === 0)).toBe(true);
    expect(loads.every((entry) => entry.inventoryStockMovementCount === Number(process.env.E2E_EXPECTED_RECENT_STOCK_MOVEMENTS))).toBe(true);
    expect(loads.every((entry) => entry.inventoryHistoryReadyMs !== null && entry.inventoryHistoryReadyMs <= 5_000)).toBe(true);
    expect(loads.every((entry) => entry.inventoryRemoteErrorVisible === false)).toBe(true);
    expect(summary.p95).toBeLessThanOrEqual(3_500);
    expect(summary.max).toBeLessThanOrEqual(5_000);
    expect(summary.p95).toBeLessThanOrEqual(baseline!.summary.p95 * 0.6);
    expect(summary.criticalApiBytesP95).toBeLessThanOrEqual(750 * 1024);
    expect(summary.criticalApiBytesP95).toBeLessThanOrEqual(baseline!.summary.criticalApiBytesP95 * 0.4);
    expect(summary.coldShellBytesP95).toBeLessThanOrEqual(450 * 1024);
    expect(summary.initialJavascriptBytesMax).toBeLessThanOrEqual(1_000 * 1024);
    expect(summary.initialJavascriptGzipBytesMax).toBeLessThanOrEqual(300 * 1024);
    expect(summary.lcpP75).toBeGreaterThan(0);
    expect(summary.lcpP75).toBeLessThanOrEqual(2_500);
    expect(summary.clsMax).toBeLessThanOrEqual(0.1);
    expect(summary.activePanelCommitP95Ms).toBeLessThan(16);
    expect(summary.activePanelCommitMaxMs).toBeLessThan(50);
    expect(summary.inventoryHistoryReadyP95Ms).toBeLessThanOrEqual(2_000);
    expect(summary.inventoryHistoryReadyMaxMs).toBeLessThanOrEqual(5_000);
  }
});
