import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticRecorder, createEvidenceTaskTracker, endpointClass, errorClass, observePerformancePage, runDiagnosticSample, writeExclusiveEvidence } from "../../tests/e2e/staging/support/performanceDiagnostics";
import { assessPerformanceSampleEvidence, collectPerformanceEvidenceFiles } from "../../scripts/operational-performance-evidence-files.mjs";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded private performance diagnostics", () => {
  it("consumes rejected response collectors and reports only safe failure counts", async () => {
    const tracker = createEvidenceTaskTracker();
    tracker.track(async () => { throw new Error("private network headers failed"); });
    tracker.track(async () => undefined);
    const result = await tracker.settle();
    expect(result).toEqual({ complete: false, timedOut: false, pending: 0, failures: { timeout: 0, websocket: 0, network: 1, other: 0 }, failureDetails: [{ endpoint: "other", stage: "headers", failureClass: "network" }], droppedFailures: 0 });
    expect(JSON.stringify(result)).not.toMatch(/private|headers failed/);
  });

  it("bounds pending response collectors and consumes later teardown rejection", async () => {
    vi.useFakeTimers();
    const tracker = createEvidenceTaskTracker();
    let reject!: (error: Error) => void;
    tracker.track(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const pending = tracker.settle();
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toMatchObject({ complete: false, timedOut: true, pending: 1 });
    reject(new Error("private interrupted body"));
    expect(await tracker.settle()).toMatchObject({ complete: false, pending: 0, failures: { other: 1 } });
  });

  it.each(["headers", "timing", "status"] as const)("records %s collector failure without an unhandled rejection", async (stage) => {
    const tracker = createEvidenceTaskTracker();
    const response = {
      allHeaders: async () => { if (stage === "headers") throw new Error("private headers"); },
      timing: () => { if (stage === "timing") throw new Error("private timing"); },
      status: () => { if (stage === "status") throw new Error("private status"); }
    };
    tracker.track(async (setStage) => {
      setStage("headers"); await response.allHeaders();
      setStage("timing"); response.timing();
      setStage("status"); response.status();
    }, "bootstrap-rpc");
    const result = await tracker.settle();
    expect(result.complete).toBe(false);
    expect(result.failureDetails).toEqual([{ endpoint: "bootstrap-rpc", stage, failureClass: "other" }]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("classifies endpoints and errors without retaining arbitrary input", () => {
    expect(endpointClass("https://tkbdyzxwwbhkpztgjjxh.supabase.co/rest/v1/rpc/load_operational_bootstrap_v2?apikey=secret")).toBe("bootstrap-rpc");
    expect(endpointClass("wss://tkbdyzxwwbhkpztgjjxh.supabase.co/realtime/v1/websocket?access_token=secret")).toBe("supabase-realtime");
    expect(endpointClass("https://tkbdyzxwwbhkpztgjjxh.supabase.co.evil.test/rest/v1/profiles")).toBe("other");
    expect(endpointClass("malformed-private-customer")).toBe("other");
    expect(errorClass(new Error("secret network failure"))).toBe("network");
    expect(errorClass("secret customer text")).toBe("other");
  });

  it("bounds events, preserves totals and rejects invalid numeric timing", () => {
    let now = 10;
    const recorder = createDiagnosticRecorder(() => now);
    now = 12;
    for (let i = 0; i < 520; i += 1) recorder.record("http-request", "bootstrap-rpc");
    now = Number.NaN;
    recorder.record("console", "other");
    const evidence = recorder.snapshot();
    expect(evidence.events).toHaveLength(512);
    expect(evidence.droppedEvents).toBe(8);
    expect(evidence.bootstrapRequests).toBe(520);
    expect(evidence.invalidTimings).toBe(1);
    expect(evidence.events[0]).toMatchObject({ sequence: 1, elapsedMs: 2 });
  });

  it("captures socket lifecycle/frame sizes and fixed classifications without private content", async () => {
    const page = new EventEmitter() as EventEmitter & { evaluate: ReturnType<typeof vi.fn> };
    page.evaluate = vi.fn().mockRejectedValue(new Error("private page unavailable"));
    const capture = observePerformancePage(page as unknown as Page);
    const secret = "sensitive-token-and-customer";
    const socket = new EventEmitter() as EventEmitter & { url: () => string };
    socket.url = () => `wss://tkbdyzxwwbhkpztgjjxh.supabase.co/realtime/v1/websocket?apikey=${secret}`;
    page.emit("websocket", socket);
    socket.emit("framesent", { payload: JSON.stringify({ access_token: secret, body: secret }) });
    socket.emit("framereceived", { payload: Buffer.from(secret) });
    socket.emit("socketerror", `WebSocket private ${secret}`);
    socket.emit("close");
    page.emit("console", { type: () => "error", text: () => secret, args: () => { throw new Error("Do not inspect args"); } });
    page.emit("pageerror", new Error(secret));
    page.emit("request", { url: () => `https://tkbdyzxwwbhkpztgjjxh.supabase.co/rest/v1/rpc/load_operational_bootstrap_v2?token=${secret}` });
    const result = await capture();
    expect(result.browserCapture).toBe("unavailable");
    expect(result.transport.bootstrapRequests).toBe(1);
    expect(result.transport.events.filter((event) => event.connection === 1)).toHaveLength(5);
    expect(result.transport.events.find((event) => event.kind === "websocket-received-bytes")?.value).toBe(Buffer.byteLength(secret));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toMatch(/access_token|apikey|wss:|https:|stack/);
  });

  it("bounds capture if the browser never answers", async () => {
    vi.useFakeTimers();
    const page = new EventEmitter() as EventEmitter & { evaluate: ReturnType<typeof vi.fn> };
    page.evaluate = vi.fn(() => new Promise(() => undefined));
    const pending = observePerformancePage(page as unknown as Page)();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).browserCapture).toBe("unavailable");
  });

  it("correlates concurrent HTTP failures to safe endpoint classes without URLs", async () => {
    const page = new EventEmitter() as EventEmitter & { evaluate: ReturnType<typeof vi.fn> };
    page.evaluate = vi.fn().mockRejectedValue(new Error("unavailable"));
    const capture = observePerformancePage(page as unknown as Page);
    const bootstrap = { url: () => "https://tkbdyzxwwbhkpztgjjxh.supabase.co/rest/v1/rpc/load_operational_bootstrap_v2?secret=private", failure: () => ({ errorText: "net::private" }) };
    const auth = { url: () => "https://tkbdyzxwwbhkpztgjjxh.supabase.co/auth/v1/token?secret=private", failure: () => ({ errorText: "timeout private" }) };
    page.emit("request", bootstrap);
    page.emit("request", auth);
    page.emit("response", { url: auth.url, request: () => auth, status: () => 503 });
    page.emit("requestfailed", auth);
    page.emit("requestfailed", bootstrap);
    const evidence = await capture();
    expect(evidence.transport.events.map(({ kind, category, requestId, failureClass, value }) => ({ kind, category, requestId, failureClass, value }))).toEqual([
      { kind: "http-request", category: "bootstrap-rpc", requestId: 1 },
      { kind: "http-request", category: "auth", requestId: 2 },
      { kind: "http-response", category: "auth", requestId: 2, value: 503 },
      { kind: "http-failed", category: "auth", requestId: 2, failureClass: "timeout" },
      { kind: "http-failed", category: "bootstrap-rpc", requestId: 1, failureClass: "network" }
    ]);
    expect(JSON.stringify(evidence)).not.toMatch(/private|secret|https:/);
  });

  it("allowlists browser marks, strips details and fails completeness on invalid or truncated timing", async () => {
    const page = new EventEmitter() as EventEmitter & { evaluate: ReturnType<typeof vi.fn> };
    page.evaluate = vi.fn(async (read: () => unknown) => read());
    const entries = vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { name: "bp-realtime-requested", startTime: 12, detail: "private" },
      { name: "customer-secret", startTime: 13, detail: "private" },
      { name: "bp-realtime-status-private-secret", startTime: 14, detail: "private" }
    ] as unknown as PerformanceEntry[]);
    const capture = observePerformancePage(page as unknown as Page);
    const success = await capture();
    expect(success.complete).toBe(true);
    expect(success.browser?.marks).toEqual([
      { name: "bp-realtime-requested", startTimeMs: 12 },
      { name: "realtime-status-other", startTimeMs: 14 }
    ]);
    expect(JSON.stringify(success)).not.toMatch(/private|customer-secret|detail/);
    entries.mockReturnValue(Array.from({ length: 130 }, (_, i) => ({
      name: "bp-realtime-requested", startTime: i === 0 ? Number.NaN : i
    })) as PerformanceEntry[]);
    const invalid = await capture();
    expect(invalid.complete).toBe(false);
    expect(invalid.browser).toMatchObject({ invalidTimings: 1, droppedMarks: 2 });
    expect(invalid.browser?.marks).toHaveLength(127);
  });

  it("uses exclusive creation and refuses oversized artifacts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-diagnostics-"));
    try {
      const file = path.join(dir, "sample.json");
      writeExclusiveEvidence(file, { sample: 1 });
      expect(() => writeExclusiveEvidence(file, { sample: 2 })).toThrow();
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ sample: 1 });
      expect(() => writeExclusiveEvidence(path.join(dir, "large.json"), "x".repeat(1_000_001))).toThrow(/bounded size/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("failure-preserving sample lifecycle", () => {
  it("retains a receipt when context creation fails before any page exists", async () => {
    const primary = new Error("context creation failed");
    const create = vi.fn().mockRejectedValue(primary);
    const close = vi.fn();
    let context: { close: () => Promise<void> } | undefined;
    const persist = vi.fn();
    const terminal = vi.fn();
    await expect(runDiagnosticSample({
      body: async () => { context = await create(); },
      capture: async () => ({ browserCapture: "not-created" }),
      persist, close: async () => { if (context) await close(); }, persistTerminal: terminal
    })).rejects.toBe(primary);
    expect(create).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith({ status: "failed", evidence: { browserCapture: "not-created" } });
    expect(terminal).toHaveBeenCalledWith({ bodyFailed: true, evidenceFailed: false, evidenceFailureStage: null, closeFailed: false });
  });

  it.each([1, 3])("preserves every attempted load and stops after failure at sample %s", async (failedSample) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-partial-loads-"));
    const attempted: number[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    try {
      const run = async () => {
        for (let sample = 1; sample <= 5; sample += 1) {
          await runDiagnosticSample({
            body: async () => {
              attempted.push(sample);
              if (sample === failedSample) throw new Error("load failed");
              writeExclusiveEvidence(path.join(dir, `sample-${sample}-measurement.json`), { sample });
            },
            capture: async () => ({ complete: true, sample }),
            persist: (value) => writeExclusiveEvidence(path.join(dir, `sample-${sample}-diagnostics.json`), value),
            close,
            persistTerminal: (value) => writeExclusiveEvidence(path.join(dir, `sample-${sample}-terminal.json`), value)
          });
        }
      };
      await expect(run()).rejects.toThrow("load failed");
      expect(attempted).toEqual(Array.from({ length: failedSample }, (_, i) => i + 1));
      expect(close).toHaveBeenCalledTimes(failedSample);
      for (const sample of attempted) {
        expect(fs.existsSync(path.join(dir, `sample-${sample}-measurement.json`))).toBe(sample < failedSample);
        const evidence = JSON.parse(fs.readFileSync(path.join(dir, `sample-${sample}-diagnostics.json`), "utf8"));
        expect(evidence.status).toBe(sample === failedSample ? "failed" : "completed");
        expect(fs.existsSync(path.join(dir, `sample-${sample}-terminal.json`))).toBe(true);
      }
      expect(fs.readdirSync(dir)).toHaveLength(failedSample * 3 - 1);
      const files = collectPerformanceEvidenceFiles(dir, [dir, path.join(dir, "missing-aggregate.json")]);
      expect(files.map((file: { path: string }) => file.path)).toEqual(fs.readdirSync(dir).sort());
      for (const file of files) {
        const bytes = fs.readFileSync(path.join(dir, file.path));
        expect(file.bytes).toBe(bytes.length);
        expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      const assessment = assessPerformanceSampleEvidence(files, 5);
      expect(assessment.complete).toBe(false);
      expect(assessment.missingTerminals).toEqual(Array.from({ length: 5 - failedSample }, (_, i) => i + failedSample + 1));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])("persists incomplete evidence but rejects acceptance, preserving body failure=%s", async (bodyFails) => {
    const primary = new Error("body");
    const invalid = new Error("incomplete");
    const order: string[] = [];
    const terminal = vi.fn();
    await expect(runDiagnosticSample({
      body: async () => { if (bodyFails) throw primary; },
      capture: async () => ({ complete: false }),
      persist: () => { order.push("persist"); },
      validate: () => { order.push("validate"); throw invalid; },
      close: async () => { order.push("close"); },
      persistTerminal: terminal
    })).rejects.toBe(bodyFails ? primary : invalid);
    expect(order).toEqual(["persist", "validate", "close"]);
    expect(terminal).toHaveBeenCalledWith({ bodyFailed: bodyFails, evidenceFailed: true, evidenceFailureStage: "validate", closeFailed: false });
  });

  it.each(["capture", "close"])("bounds an unresponsive %s and still records terminal state", async (step) => {
    vi.useFakeTimers();
    const close = vi.fn(() => step === "close" ? new Promise<void>(() => undefined) : Promise.resolve());
    const terminal = vi.fn();
    const pending = runDiagnosticSample({
      body: async () => 1,
      capture: () => step === "capture" ? new Promise(() => undefined) : Promise.resolve({}),
      persist: vi.fn(), close, persistTerminal: terminal
    });
    const checked = expect(pending).rejects.toThrow("Diagnostic operation timeout");
    await vi.advanceTimersByTimeAsync(7_001);
    await checked;
    expect(close).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith({ bodyFailed: false, evidenceFailed: step === "capture", evidenceFailureStage: step === "capture" ? "capture" : null, closeFailed: step === "close" });
  });

  it.each([false, true])("persists evidence before closing even when body fails=%s", async (fails) => {
    const order: string[] = [];
    const primary = new Error("assertion failed");
    const terminal = vi.fn();
    const promise = runDiagnosticSample({
      body: async () => { order.push("body"); if (fails) throw primary; return 7; },
      capture: async () => { order.push("capture"); return { marks: [] }; },
      persist: (value) => { order.push("persist"); expect(value.status).toBe(fails ? "failed" : "completed"); },
      close: async () => { order.push("close"); },
      persistTerminal: terminal
    });
    if (fails) await expect(promise).rejects.toBe(primary);
    else await expect(promise).resolves.toBe(7);
    expect(order).toEqual(["body", "capture", "persist", "close"]);
    expect(terminal).toHaveBeenCalledWith({ bodyFailed: fails, evidenceFailed: false, evidenceFailureStage: null, closeFailed: false });
  });

  it("preserves original assertion when evidence, close and terminal writes also fail", async () => {
    const primary = new Error("primary");
    const close = vi.fn().mockRejectedValue(new Error("close"));
    const terminal = vi.fn().mockRejectedValue(new Error("disk"));
    await expect(runDiagnosticSample({
      body: async () => { throw primary; }, capture: async () => { throw new Error("capture"); },
      persist: vi.fn(), close, persistTerminal: terminal
    })).rejects.toBe(primary);
    expect(close).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith({ bodyFailed: true, evidenceFailed: true, evidenceFailureStage: "capture", closeFailed: true });
  });

  it.each(["persist", "close", "terminal"])("does not accept a successful body when %s fails", async (step) => {
    const failure = new Error(step);
    const pending = runDiagnosticSample({
      body: async () => 1, capture: async () => ({}),
      persist: () => { if (step === "persist") throw failure; },
      close: async () => { if (step === "close") throw failure; },
      persistTerminal: () => { if (step === "terminal") throw failure; }
    });
    if (step === "terminal") await expect(pending).rejects.toMatchObject({ stage: "terminal-write", message: "Diagnostic lifecycle terminal write failed." });
    else await expect(pending).rejects.toBe(failure);
  });

  it("invalidates an otherwise complete run if a terminal is missing or duplicated", () => {
    const files = Array.from({ length: 30 }, (_, index) => ["measurement", "diagnostics", "terminal"].map((kind) => ({ path: `nested/sample-${index + 1}-${kind}.json` }))).flat();
    expect(assessPerformanceSampleEvidence(files, 30).complete).toBe(true);
    expect(assessPerformanceSampleEvidence(files.filter((entry) => !entry.path.endsWith("sample-7-terminal.json")), 30))
      .toMatchObject({ complete: false, missingTerminals: [7] });
    expect(assessPerformanceSampleEvidence([...files, { path: "duplicate/sample-7-terminal.json" }], 30).complete).toBe(false);
  });
});
