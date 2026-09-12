import fs from "node:fs";
import crypto from "node:crypto";
import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import { attachJson, credentials, signIn } from "./support/app";

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
  const lcp = loads.map((entry) => entry.largestContentfulPaintMs).filter((value) => value > 0);
  const cls = loads.map((entry) => entry.cumulativeLayoutShift);
  const updateDurations = loads.flatMap((entry) => entry.activePanelCommitDurationsMs);
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
    lcpP75: percentile(lcp, 0.75),
    clsMax: Math.max(...cls),
    activePanelCommitP95Ms: percentile(updateDurations, 0.95),
    activePanelCommitMaxMs: updateDurations.length > 0 ? Math.max(...updateDurations) : 0
  };
}

function readBaseline() {
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
  return { path: baselinePath, sha256: actualSha, summary: baseline.summary };
}

function tableName(path: string) {
  return path.match(/\/rest\/v1\/([^/?]+)/)?.[1];
}

function measureBootstrapDependencyDepth(responses: ResponseEvidence[]): number {
  const apiResponses = responses.filter((entry) => entry.api && entry.status < 400);
  const organization = apiResponses.find((entry) => tableName(entry.path) === "organizations");
  if (!organization) throw new Error("Candidate bootstrap did not request the active organization.");
  const phaseTwoTables = new Set([
    "inventory_categories", "stations", "pricing_rules", "inventory_items", "sale_variants",
    "combos", "combo_station_targets", "combo_fixed_items", "combo_choice_groups", "combo_choice_options",
    "sessions", "customer_tabs"
  ]);
  const phaseThreeParents: Record<string, string> = {
    session_pause_logs: "sessions",
    session_items: "sessions",
    session_combo_applications: "sessions",
    customer_tab_items: "customer_tabs",
    customer_tab_combo_applications: "customer_tabs"
  };
  const byTable = new Map<string, ResponseEvidence[]>();
  for (const response of apiResponses) {
    const table = tableName(response.path);
    if (!table) continue;
    const rows = byTable.get(table) ?? [];
    rows.push(response);
    byTable.set(table, rows);
  }
  for (const table of phaseTwoTables) {
    for (const response of byTable.get(table) ?? []) {
      expect(response.requestStartMs).toBeGreaterThanOrEqual(organization.responseEndMs - 10);
    }
  }
  let depth = Array.from(phaseTwoTables).some((table) => byTable.has(table)) ? 2 : 1;
  for (const [child, parent] of Object.entries(phaseThreeParents)) {
    for (const response of byTable.get(child) ?? []) {
      const parentEnd = Math.max(...(byTable.get(parent) ?? []).map((entry) => entry.responseEndMs));
      if (!Number.isFinite(parentEnd)) throw new Error(`Bootstrap requested ${child} without its ${parent} parent.`);
      expect(response.requestStartMs).toBeGreaterThanOrEqual(parentEnd - 10);
      depth = 3;
    }
  }
  return depth;
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
  const contentLengthBytes = Number(headers["content-length"] ?? 0);
  let bodyBytes = 0;
  if (api || (shell && contentLengthBytes === 0)) {
    try {
      bodyBytes = (await response.body()).byteLength;
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
    shell
  });
}

test("30 cold authenticated loads meet the safe-interactive and critical-path budget", async ({ browser, page }, testInfo) => {
  test.setTimeout(12 * 60_000);
  expect(sampleCount).toBe(30);
  await signIn(page, credentials("A"));
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
    const responseTasks = new Set<Promise<void>>();
    let requestedFullAppStateData = false;
    let requestedExportChunk = false;

    coldPage.on("request", (request) => {
      const url = new URL(request.url());
      const path = `${url.hostname}${url.pathname}`;
      requests.set(request, path);
      requestStarts.set(request, performance.now() - started);
      if (url.pathname.includes("/rest/v1/app_state")) {
        const select = url.searchParams.get("select") ?? "";
        requestedFullAppStateData ||= select === "*" || select.split(",").includes("data");
      }
      requestedExportChunk ||= /(?:xlsx|jspdf)-[^/]+\.js$/i.test(url.pathname);
    });
    coldPage.on("response", (response) => {
      const task = collectResponseEvidence(response, requestStarts, started, baseOrigin, responses);
      responseTasks.add(task);
      void task.then(() => responseTasks.delete(task), () => responseTasks.delete(task));
    });
    coldPage.on("requestfailed", (request) => failedRequestPaths.push(requests.get(request) ?? "unknown"));

    await coldPage.goto("/", { waitUntil: "domcontentloaded" });
    await expect(coldPage.getByRole("heading", { name: "Live Dashboard", exact: true })).toBeVisible();
    if (mode === "candidate") {
      await expect(coldPage.locator('[data-app-safe-interactive="true"]')).toBeVisible();
      await expect.poll(() => coldPage.evaluate(() => performance.getEntriesByName("bp-safe-interactive", "mark").length)).toBe(1);
    }
    const safeInteractiveMs = performance.now() - started;
    const browserCutoff = await coldPage.evaluate(() => performance.now());
    await Promise.all([...responseTasks]);
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
    const requestedHistoryBeforeSafeInteractive = criticalPaths.some((path) => /\/rest\/v1\/(?:bills|bill_lines|payments|expenses|audit_logs|stock_movements)(?:$|\/)/.test(path));

    await coldPage.waitForTimeout(500);
    const webVitals = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_WEB_VITALS__?: { largestContentfulPaintMs: number; cumulativeLayoutShift: number } }).__BP_WEB_VITALS__ ?? { largestContentfulPaintMs: 0, cumulativeLayoutShift: 0 });
    let renderEvidence: RenderEvidence | null = null;
    let activePanelCommitDurationsMs: number[] = [];
    let idleRootCommits: number | null = null;
    if (mode === "candidate") {
      renderEvidence = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence }).__BP_RENDER_EVIDENCE__ ?? null);
      expect(renderEvidence, "Candidate staging build must enable VITE_PERFORMANCE_EVIDENCE=true.").not.toBeNull();
      await coldPage.waitForLoadState("networkidle");
      const panelCommitOffset = renderEvidence!.updateActualDurationsMs.length;
      await coldPage.getByRole("button", { name: "Inventory", exact: true }).click();
      await expect(coldPage.getByRole("heading", { name: "Inventory Catalog", exact: true })).toBeVisible();
      activePanelCommitDurationsMs = await coldPage.evaluate((offset) => (
        globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence }
      ).__BP_RENDER_EVIDENCE__?.updateActualDurationsMs.slice(offset) ?? [], panelCommitOffset);
      expect(activePanelCommitDurationsMs.length).toBeGreaterThan(0);
      await coldPage.waitForLoadState("networkidle");
      const beforeIdle = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence }).__BP_RENDER_EVIDENCE__?.commits ?? 0);
      await coldPage.waitForTimeout(1_200);
      const afterIdle = await coldPage.evaluate(() => (globalThis as typeof globalThis & { __BP_RENDER_EVIDENCE__?: RenderEvidence }).__BP_RENDER_EVIDENCE__?.commits ?? 0);
      idleRootCommits = afterIdle - beforeIdle;
    }

    const criticalApiBytes = criticalResponses.filter((entry) => entry.api).reduce((total, entry) => total + (entry.bodyBytes || entry.contentLengthBytes), 0);
    const coldShellBytes = criticalResponses.filter((entry) => entry.shell).reduce((total, entry) => total + (entry.contentLengthBytes || entry.bodyBytes), 0);
    loads.push({
      sample,
      safeInteractiveMs,
      bootstrapMarks: marks,
      criticalResources,
      criticalResponses,
      criticalRequestCount: criticalResources.length,
      criticalApiBytes,
      coldShellBytes,
      failedRequestPaths,
      requestedFullAppStateData,
      requestedExportChunk,
      requestedHistoryBeforeSafeInteractive,
      bootstrapDependencyDepth: mode === "candidate" ? measureBootstrapDependencyDepth(criticalResponses) : null,
      largestContentfulPaintMs: webVitals.largestContentfulPaintMs,
      cumulativeLayoutShift: webVitals.cumulativeLayoutShift,
      renderEvidence,
      activePanelCommitDurationsMs,
      idleRootCommits
    });
    await context.close();
  }

  const summary = summarize(loads);
  const baseline = mode === "candidate" ? readBaseline() : undefined;
  const result = {
    runId,
    mode,
    sampleCount,
    datasetManifestSha256: process.env.E2E_PERFORMANCE_DATASET_MANIFEST_SHA256?.toLowerCase(),
    browserVersion: browser.version(),
    viewport: { width: 1440, height: 900 },
    cachePolicy: "new-context-cold-cache-service-workers-blocked",
    networkProfile: process.env.E2E_PERFORMANCE_PROFILE_ID,
    summary,
    baseline,
    loads
  };
  await attachJson(testInfo, "operational-performance-evidence", result);

  expect(loads.every((entry) => entry.failedRequestPaths.length === 0)).toBe(true);
  expect(loads.every((entry) => !entry.requestedExportChunk)).toBe(true);
  if (mode === "candidate") {
    expect(loads.every((entry) => !entry.requestedFullAppStateData)).toBe(true);
    expect(loads.every((entry) => !entry.requestedHistoryBeforeSafeInteractive)).toBe(true);
    expect(loads.every((entry) => entry.bootstrapDependencyDepth !== null && entry.bootstrapDependencyDepth <= 3)).toBe(true);
    expect(loads.every((entry) => entry.criticalApiBytes > 0)).toBe(true);
    expect(loads.every((entry) => entry.coldShellBytes > 0)).toBe(true);
    expect(loads.every((entry) => entry.idleRootCommits === 0)).toBe(true);
    expect(summary.p95).toBeLessThanOrEqual(3_500);
    expect(summary.max).toBeLessThanOrEqual(5_000);
    expect(summary.p95).toBeLessThanOrEqual(baseline!.summary.p95 * 0.6);
    expect(summary.criticalApiBytesP95).toBeLessThanOrEqual(750 * 1024);
    expect(summary.criticalApiBytesP95).toBeLessThanOrEqual(baseline!.summary.criticalApiBytesP95 * 0.4);
    expect(summary.coldShellBytesP95).toBeLessThanOrEqual(450 * 1024);
    expect(summary.lcpP75).toBeGreaterThan(0);
    expect(summary.lcpP75).toBeLessThanOrEqual(2_500);
    expect(summary.clsMax).toBeLessThanOrEqual(0.1);
    expect(summary.activePanelCommitP95Ms).toBeLessThan(16);
    expect(summary.activePanelCommitMaxMs).toBeLessThan(50);
  }
});
