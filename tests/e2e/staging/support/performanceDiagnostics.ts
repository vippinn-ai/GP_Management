import fs from "node:fs";
import type { Page, Request } from "@playwright/test";

const MAX_EVENTS = 512;
const MAX_ARTIFACT_BYTES = 1_000_000;
const STAGING_HOST = "tkbdyzxwwbhkpztgjjxh.supabase.co";
const APP_HOST = "gp-management-staging-pages.breakperfectgaminglounge.workers.dev";

// Never retain URLs, headers, bodies, console text, error messages or frame payloads.
export function endpointClass(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === STAGING_HOST) {
      if (url.pathname === "/rest/v1/rpc/load_operational_bootstrap_v2") return "bootstrap-rpc";
      if (url.pathname.startsWith("/realtime/v1/")) return "supabase-realtime";
      if (url.pathname.startsWith("/auth/v1/")) return "auth";
      if (url.pathname.startsWith("/rest/v1/")) return "rest";
    }
    if (url.hostname === APP_HOST) return "app-asset";
  } catch { /* Malformed URLs are classified, never copied. */ }
  return "other";
}

export function errorClass(value: unknown) {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  if (/timeout|timed.out|did not become ready/i.test(message)) return "timeout";
  if (/websocket/i.test(message)) return "websocket";
  if (/network|net::|fetch/i.test(message)) return "network";
  return "other";
}

type EventKind = "http-request" | "http-response" | "http-failed" | "console" | "page-error" | "page-crash"
  | "websocket-created" | "websocket-sent-bytes" | "websocket-received-bytes" | "websocket-error" | "websocket-closed";
type Category = ReturnType<typeof endpointClass> | ReturnType<typeof errorClass> | "crash";
type RequestDetail = { requestId: number; failureClass?: ReturnType<typeof errorClass> };
type DiagnosticEvent = { sequence: number; elapsedMs: number; kind: EventKind; category: Category; value?: number; connection?: number } & Partial<RequestDetail>;

export function createDiagnosticRecorder(now = () => performance.now()) {
  const started = now();
  const events: DiagnosticEvent[] = [];
  let sequence = 0;
  let droppedEvents = 0;
  let invalidTimings = 0;
  let bootstrapRequests = 0;
  return {
    record(kind: EventKind, category: Category, value?: number, connection?: number, request?: RequestDetail) {
      const elapsedMs = now() - started;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || (value !== undefined && (!Number.isFinite(value) || value < 0))) {
        invalidTimings += 1;
        return;
      }
      if (kind === "http-request" && category === "bootstrap-rpc") bootstrapRequests += 1;
      sequence += 1;
      if (events.length >= MAX_EVENTS) { droppedEvents += 1; return; }
      events.push({ sequence, elapsedMs, kind, category, ...(value === undefined ? {} : { value }), ...(connection === undefined ? {} : { connection }), ...request });
    },
    snapshot() { return { events: [...events], droppedEvents, invalidTimings, bootstrapRequests }; }
  };
}

export function writeExclusiveEvidence(file: string, value: unknown) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new Error("Diagnostic artifact exceeds its bounded size.");
  fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
}

async function bounded<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Diagnostic operation timeout")), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

// Response collectors are asynchronous event callbacks. Always consume rejection;
// teardown can interrupt headers/body reads after an unrelated assertion fails.
export type EvidenceStage = "headers" | "request-metadata" | "body" | "request-completion" | "timing" | "status";
export function createEvidenceTaskTracker() {
  const pending = new Set<Promise<void>>();
  const failures: Record<ReturnType<typeof errorClass>, number> = { timeout: 0, websocket: 0, network: 0, other: 0 };
  const failureDetails: { endpoint: ReturnType<typeof endpointClass>; stage: EvidenceStage; failureClass: ReturnType<typeof errorClass> }[] = [];
  let droppedFailures = 0;
  return {
    track(action: (setStage: (stage: EvidenceStage) => void) => Promise<void>, endpoint: ReturnType<typeof endpointClass> = "other") {
      let stage: EvidenceStage = "headers";
      const task = Promise.resolve().then(() => action((value) => { stage = value; })).catch((error: unknown) => {
        const failureClass = errorClass(error);
        failures[failureClass] += 1;
        if (failureDetails.length < 128) failureDetails.push({ endpoint, stage, failureClass });
        else droppedFailures += 1;
      });
      pending.add(task);
      void task.then(() => { pending.delete(task); });
    },
    async settle() {
      let timedOut = false;
      try { await bounded(() => Promise.all([...pending]), 750); }
      catch { timedOut = true; }
      return {
        complete: !timedOut && pending.size === 0 && Object.values(failures).every((count) => count === 0),
        timedOut, pending: pending.size, failures: { ...failures }, failureDetails: [...failureDetails], droppedFailures
      };
    }
  };
}

export function observePerformancePage(page: Page) {
  const recorder = createDiagnosticRecorder();
  let connectionSequence = 0;
  let requestSequence = 0;
  const requestIds = new WeakMap<Request, number>();
  const requestId = (request: Request) => {
    let id = requestIds.get(request);
    if (id === undefined) { id = ++requestSequence; requestIds.set(request, id); }
    return id;
  };
  page.on("request", (request) => recorder.record("http-request", endpointClass(request.url()), undefined, undefined, { requestId: requestId(request) }));
  page.on("response", (response) => recorder.record("http-response", endpointClass(response.url()), response.status(), undefined, { requestId: requestId(response.request()) }));
  page.on("requestfailed", (request) => recorder.record("http-failed", endpointClass(request.url()), undefined, undefined, {
    requestId: requestId(request), failureClass: errorClass(request.failure()?.errorText)
  }));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") recorder.record("console", errorClass(message.text()));
  });
  page.on("pageerror", (error) => recorder.record("page-error", errorClass(error)));
  page.on("crash", () => recorder.record("page-crash", "crash"));
  page.on("websocket", (socket) => {
    const category = endpointClass(socket.url());
    const connection = ++connectionSequence;
    // Playwright's websocket event means created, not an acknowledged connection.
    recorder.record("websocket-created", category, undefined, connection);
    socket.on("framesent", ({ payload }) => recorder.record("websocket-sent-bytes", category, Buffer.byteLength(payload), connection));
    socket.on("framereceived", ({ payload }) => recorder.record("websocket-received-bytes", category, Buffer.byteLength(payload), connection));
    socket.on("socketerror", (error) => recorder.record("websocket-error", errorClass(error), undefined, connection));
    socket.on("close", () => recorder.record("websocket-closed", category, undefined, connection));
  });
  return async () => {
    let browser: { marks: { name: string; startTimeMs: number }[]; droppedMarks: number; invalidTimings: number } | null = null;
    let browserCapture: "captured" | "unavailable" = "captured";
    try {
      browser = await bounded(() => page.evaluate(() => {
        const allowed = new Set([
          "bp-session-requested", "bp-session-ready", "bp-realtime-requested",
          "bp-realtime-channel-subscribe-called", "bp-realtime-status-subscribed",
          "bp-realtime-status-timed-out", "bp-realtime-status-channel-error", "bp-realtime-status-closed",
          "bp-realtime-ready", "bp-bootstrap-requested", "bp-bootstrap-rpc-requested",
          "bp-bootstrap-rpc-response", "bp-critical-catchup-ready", "bp-safe-interactive", "bp-visible-dashboard-ready"
        ]);
        const all = performance.getEntriesByType("mark").filter((entry) => allowed.has(entry.name) || entry.name.startsWith("bp-realtime-status-"));
        const invalid = all.filter((entry) => !Number.isFinite(entry.startTime) || entry.startTime < 0).length;
        return {
          marks: all.slice(0, 128).filter((entry) => Number.isFinite(entry.startTime) && entry.startTime >= 0)
            .map((entry) => ({ name: allowed.has(entry.name) ? entry.name : "realtime-status-other", startTimeMs: entry.startTime })),
          droppedMarks: Math.max(0, all.length - 128), invalidTimings: invalid
        };
      }), 1_000);
    } catch { browserCapture = "unavailable"; }
    const transport = recorder.snapshot();
    const complete = browserCapture === "captured" && browser !== null
      && browser.droppedMarks === 0 && browser.invalidTimings === 0
      && transport.droppedEvents === 0 && transport.invalidTimings === 0;
    return { complete, browserCapture, browser, transport };
  };
}

// Persist before teardown, and record teardown separately. Neither evidence nor cleanup
// failures may mask the primary assertion. No retries or navigation replays occur here.
export async function runDiagnosticSample<T>(options: {
  body: () => Promise<T>;
  capture: () => Promise<unknown>;
  validate?: (evidence: unknown) => void;
  persist: (value: { status: "completed" | "failed"; evidence: unknown }) => void | Promise<void>;
  close: () => Promise<void>;
  persistTerminal: (value: { bodyFailed: boolean; evidenceFailed: boolean; evidenceFailureStage: "capture" | "persist" | "validate" | null; closeFailed: boolean }) => void | Promise<void>;
}): Promise<T> {
  let result: T | undefined;
  let bodyFailed = false;
  let evidenceFailed = false;
  let evidenceFailureStage: "capture" | "persist" | "validate" | null = null;
  let closeFailed = false;
  const failures: unknown[] = [];
  try { result = await options.body(); }
  catch (error) { bodyFailed = true; failures.push(error); }
  finally {
    try {
      evidenceFailureStage = "capture";
      const evidence = await bounded(options.capture, 2_000);
      evidenceFailureStage = "persist";
      await options.persist({ status: bodyFailed ? "failed" : "completed", evidence });
      evidenceFailureStage = "validate";
      options.validate?.(evidence);
      evidenceFailureStage = null;
    } catch (error) { evidenceFailed = true; failures.push(error); }
    finally {
      try { await bounded(options.close, 5_000); }
      catch (error) { closeFailed = true; failures.push(error); }
    }
    try { await options.persistTerminal({ bodyFailed, evidenceFailed, evidenceFailureStage, closeFailed }); }
    catch {
      failures.push(Object.assign(new Error("Diagnostic lifecycle terminal write failed."), { stage: "terminal-write" }));
    }
  }
  if (failures.length) throw failures[0];
  return result as T;
}
