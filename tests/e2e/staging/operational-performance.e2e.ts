import fs from "node:fs";
import crypto from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
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

type LoadEvidence = {
  sample: number;
  safeInteractiveMs: number;
  bootstrapMarks: Record<string, number>;
  criticalResources: ResourceEvidence[];
  criticalRequestCount: number;
  criticalTransferBytes: number;
  criticalEncodedBytes: number;
  criticalDecodedBytes: number;
  failedRequestPaths: string[];
  requestedFullAppStateData: boolean;
  requestedExportChunk: boolean;
  requestedHistoryBeforeSafeInteractive: boolean;
  bootstrapDependencyDepth: number;
};

function percentile(values: number[], percentileValue: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function summarize(loads: LoadEvidence[]) {
  const values = loads.map((entry) => entry.safeInteractiveMs);
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    mean: values.reduce((total, value) => total + value, 0) / values.length
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
  if (baseline.mode !== "baseline" || baseline.sampleCount !== sampleCount || !baseline.summary?.p95) {
    throw new Error("Performance baseline shape or sample count is incompatible.");
  }
  return { path: baselinePath, sha256: actualSha, summary: baseline.summary };
}

async function resourceEvidence(page: Page): Promise<{ marks: Record<string, number>; resources: ResourceEvidence[] }> {
  return page.evaluate(() => {
    const allowedMarks = [
      "bp-bootstrap-requested",
      "bp-realtime-ready",
      "bp-critical-snapshot-ready",
      "bp-critical-catchup-ready",
      "bp-safe-interactive"
    ];
    const marks = Object.fromEntries(
      allowedMarks.map((name) => [name, performance.getEntriesByName(name, "mark").at(-1)?.startTime ?? -1])
    );
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

test("30 cold authenticated loads meet the safe-interactive and critical-path budget", async ({ browser, page }, testInfo) => {
  test.setTimeout(12 * 60_000);
  expect(sampleCount).toBe(30);
  await signIn(page, credentials("A"));
  const storageState = await page.context().storageState();
  const loads: LoadEvidence[] = [];

  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const context = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL,
      storageState,
      locale: "en-IN",
      timezoneId: "Asia/Calcutta"
    });
    const coldPage = await context.newPage();
    const started = performance.now();
    const failedRequestPaths: string[] = [];
    const requests = new Map<Request, string>();
    let requestedFullAppStateData = false;
    let requestedExportChunk = false;

    coldPage.on("request", (request) => {
      const url = new URL(request.url());
      const path = `${url.hostname}${url.pathname}`;
      requests.set(request, path);
      if (url.pathname.includes("/rest/v1/app_state")) {
        const select = url.searchParams.get("select") ?? "";
        requestedFullAppStateData ||= select === "*" || select.split(",").includes("data");
      }
      requestedExportChunk ||= /(?:xlsx|jspdf)-[^/]+\.js$/i.test(url.pathname);
    });
    coldPage.on("requestfailed", (request) => failedRequestPaths.push(requests.get(request) ?? "unknown"));

    await coldPage.goto("/", { waitUntil: "domcontentloaded" });
    await expect(coldPage.locator('[data-app-safe-interactive="true"]')).toBeVisible();
    const safeInteractiveMs = performance.now() - started;
    const { marks, resources } = await resourceEvidence(coldPage);
    const safeMark = marks["bp-safe-interactive"];
    expect(safeMark).toBeGreaterThanOrEqual(0);
    for (const mark of ["bp-bootstrap-requested", "bp-realtime-ready", "bp-critical-snapshot-ready", "bp-critical-catchup-ready"]) {
      expect(marks[mark]).toBeGreaterThanOrEqual(0);
      expect(marks[mark]).toBeLessThanOrEqual(safeMark);
    }
    const criticalResources = resources.filter((entry) => entry.startTime <= safeMark);
    const criticalPaths = criticalResources.map((entry) => entry.path);
    const requestedHistoryBeforeSafeInteractive = criticalPaths.some((path) =>
      /\/rest\/v1\/(?:bills|bill_lines|payments|expenses|audit_logs|stock_movements)(?:$|\/)/.test(path)
    );
    loads.push({
      sample,
      safeInteractiveMs,
      bootstrapMarks: marks,
      criticalResources,
      criticalRequestCount: criticalResources.length,
      criticalTransferBytes: criticalResources.reduce((total, entry) => total + entry.transferSize, 0),
      criticalEncodedBytes: criticalResources.reduce((total, entry) => total + entry.encodedBodySize, 0),
      criticalDecodedBytes: criticalResources.reduce((total, entry) => total + entry.decodedBodySize, 0),
      failedRequestPaths,
      requestedFullAppStateData,
      requestedExportChunk,
      requestedHistoryBeforeSafeInteractive,
      // The reviewed graph is realtime-ready -> organization -> parallel core rows/live parents -> live children.
      bootstrapDependencyDepth: 3
    });
    await context.close();
  }

  const summary = summarize(loads);
  const baseline = mode === "candidate" ? readBaseline() : undefined;
  const result = { runId, mode, sampleCount, summary, baseline, loads };
  await attachJson(testInfo, "operational-performance-evidence", result);

  expect(loads.every((entry) => entry.failedRequestPaths.length === 0)).toBe(true);
  expect(loads.every((entry) => !entry.requestedFullAppStateData)).toBe(true);
  expect(loads.every((entry) => !entry.requestedExportChunk)).toBe(true);
  expect(loads.every((entry) => !entry.requestedHistoryBeforeSafeInteractive)).toBe(true);
  expect(loads.every((entry) => entry.bootstrapDependencyDepth <= 3)).toBe(true);
  if (mode === "candidate") {
    expect(summary.p95).toBeLessThanOrEqual(3_500);
    expect(summary.max).toBeLessThanOrEqual(5_000);
    expect(summary.p95).toBeLessThanOrEqual(baseline!.summary.p95 * 0.6);
  }
});
