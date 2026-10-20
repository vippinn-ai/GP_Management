import { readFileSync } from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import { createRpcPhaseTiming } from "./rpcPhaseTiming";
import { readApiResponseBody } from "../../tests/e2e/staging/support/app";

interface ExtractedEvidence {
  status: number | null;
  response?: unknown;
  request?: unknown;
  requestPostAwaitMs: number | null;
  bodyReadAndParseMs: number | null;
  phaseOutcome: string;
}

type ExtractedPostRpc = (
  request: { post: (...args: unknown[]) => Promise<unknown> },
  identity: { restBase: string; headers: Record<string, string> },
  rpc: string,
  payload: unknown,
  evidence?: ExtractedEvidence[],
  client?: "origin" | "observer"
) => Promise<{ response: unknown; body: unknown }>;

function loadExtractedPostRpc(): ExtractedPostRpc {
  const source = readFileSync("tests/e2e/staging/operational-lifecycle-v2-concurrency.e2e.ts", "utf8");
  const functionSource = `async function postRpc(${source
    .split("async function postRpc(")[1]
    .split("async function appStateSnapshot")[0]}\nexport { postRpc };`;
  const compiled = transpileModule(functionSource, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} as { postRpc?: ExtractedPostRpc } };
  const evaluate = new Function(
    "exports", "module", "createRpcPhaseTiming", "readApiResponseBody", compiled
  );
  evaluate(module.exports, module, createRpcPhaseTiming, readApiResponseBody);
  if (!module.exports.postRpc) throw new Error("Extracted postRpc did not export.");
  return module.exports.postRpc;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function observedRequest<TResponse, TBody>(
  request: () => Promise<TResponse>,
  readBody: (response: TResponse) => Promise<TBody>,
  timing: ReturnType<typeof createRpcPhaseTiming>
) {
  try {
    const response = await request();
    timing.buffered();
    const body = await readBody(response);
    timing.complete();
    return body;
  } catch (error) {
    timing.fail();
    throw error;
  }
}

describe("RPC diagnostic phase timing", () => {
  it("records deterministic buffered and body phases in execution order", async () => {
    let now = 10;
    const timing = createRpcPhaseTiming(() => now);
    const request = deferred<{ text: string }>();
    const body = deferred<string>();
    const order: string[] = [];
    const result = observedRequest(
      () => { order.push("request"); return request.promise; },
      response => { order.push(`body:${response.text}`); return body.promise; },
      timing
    );

    expect(timing.snapshot()).toEqual({
      requestPostAwaitMs: null,
      bodyReadAndParseMs: null,
      phaseOutcome: "incomplete"
    });
    now = 14;
    request.resolve({ text: "buffered" });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["request", "body:buffered"]);
    expect(timing.snapshot()).toEqual({
      requestPostAwaitMs: 4,
      bodyReadAndParseMs: null,
      phaseOutcome: "incomplete"
    });
    now = 17;
    body.resolve("ok");
    await expect(result).resolves.toBe("ok");
    expect(timing.snapshot()).toEqual({
      requestPostAwaitMs: 4,
      bodyReadAndParseMs: 3,
      phaseOutcome: "complete"
    });
  });

  it("treats zero-duration checkpoints as valid measurements", () => {
    const timing = createRpcPhaseTiming(() => 25);
    timing.buffered();
    timing.complete();
    expect(timing.snapshot()).toEqual({
      requestPostAwaitMs: 0,
      bodyReadAndParseMs: 0,
      phaseOutcome: "complete"
    });
  });

  it("preserves the original request error and records no invented buffered phase", async () => {
    const secret = "authorization-secret-request-body";
    const primary = new Error(secret);
    const timing = createRpcPhaseTiming(() => 5);
    await expect(observedRequest(
      async () => { throw primary; },
      async () => "unreachable",
      timing
    )).rejects.toBe(primary);
    const snapshot = timing.snapshot();
    expect(snapshot).toEqual({
      requestPostAwaitMs: null,
      bodyReadAndParseMs: null,
      phaseOutcome: "request-failed"
    });
    expect(Object.keys(snapshot).sort()).toEqual(
      ["requestPostAwaitMs", "bodyReadAndParseMs", "phaseOutcome"].sort()
    );
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it("preserves the original body error and retains only the completed request phase", async () => {
    let now = 100;
    const primary = new Error("private response body and token");
    const timing = createRpcPhaseTiming(() => now);
    await expect(observedRequest(
      async () => { now = 106; return { status: 200 }; },
      async () => { now = 109; throw primary; },
      timing
    )).rejects.toBe(primary);
    const snapshot = timing.snapshot();
    expect(snapshot).toEqual({
      requestPostAwaitMs: 6,
      bodyReadAndParseMs: null,
      phaseOutcome: "body-failed"
    });
    expect(JSON.stringify(snapshot)).not.toContain(primary.message);
  });

  it("remains compatible with malformed-JSON text fallback", async () => {
    let now = 0;
    const timing = createRpcPhaseTiming(() => now);
    const body = await observedRequest(
      async () => { now = 2; return "not-json"; },
      async text => {
        now = 5;
        try { return JSON.parse(text) as unknown; } catch { return { raw: text }; }
      },
      timing
    );
    expect(body).toEqual({ raw: "not-json" });
    expect(timing.snapshot()).toEqual({
      requestPostAwaitMs: 2,
      bodyReadAndParseMs: 3,
      phaseOutcome: "complete"
    });
  });

  it("keeps the calibrated acceptance numerator, denominator and limits unchanged", () => {
    const source = readFileSync("tests/e2e/staging/operational-lifecycle-v2-concurrency.e2e.ts", "utf8");
    const body = source
      .split('test("ten calibrated unrelated pairs overlap instead of using one global queue"')[1]
      .split('test("50 reload-versus')[0];
    expect(body).toContain("test.setTimeout(8 * 60_000)");
    expect(body).toContain("iteration <= 10");
    expect(body).toContain("const concurrentStarted = performance.now()");
    expect(body).toContain("const concurrentWallMs = performance.now() - concurrentStarted");
    expect(body).toContain("const sequentialStarted = performance.now()");
    expect(body).toContain("const sequentialWallMs = performance.now() - sequentialStarted");
    expect(body).toContain("wallRatio: concurrentWallMs / sequentialWallMs");
    expect(body).toContain('expect(percentile(wallRatios, 0.95)');
    expect(body).toContain(".toBeLessThan(0.85)");
    expect(body).toContain(".toBeLessThan(100)");
    expect(body).toContain("const concurrentResults = await Promise.all([");
    expect(body.indexOf("const sequentialFirst = await postRpc")).toBeLessThan(
      body.indexOf("const sequentialSecond = await postRpc")
    );
  });

  it("wires checkpoints around the buffered response and body parser without masking failures", () => {
    const source = readFileSync("tests/e2e/staging/operational-lifecycle-v2-concurrency.e2e.ts", "utf8");
    const postRpc = source
      .split("async function postRpc(")[1]
      .split("async function appStateSnapshot")[0];

    const requestAt = postRpc.indexOf("response = await request.post");
    const bufferedAt = postRpc.indexOf("phases.buffered()");
    const readBodyAt = postRpc.indexOf("body = await readApiResponseBody(response)");
    const completeAt = postRpc.indexOf("phases.complete()");
    const catchAt = postRpc.indexOf("} catch (error) {");
    const failAt = postRpc.indexOf("phases.fail()", catchAt);
    const failureEvidenceAt = postRpc.indexOf("evidence?.push({", catchAt);
    const rethrowAt = postRpc.indexOf("throw error", catchAt);
    const successEvidenceAt = postRpc.indexOf("evidence?.push({", rethrowAt);

    expect(requestAt).toBeGreaterThan(-1);
    expect(requestAt).toBeLessThan(bufferedAt);
    expect(bufferedAt).toBeLessThan(readBodyAt);
    expect(readBodyAt).toBeLessThan(completeAt);
    expect(completeAt).toBeLessThan(catchAt);
    expect(catchAt).toBeLessThan(failAt);
    expect(failAt).toBeLessThan(failureEvidenceAt);
    expect(failureEvidenceAt).toBeLessThan(rethrowAt);
    expect(rethrowAt).toBeLessThan(successEvidenceAt);
    expect(postRpc.slice(catchAt, rethrowAt)).toContain("status: null, ...phases.snapshot()");
    expect(postRpc.slice(catchAt, rethrowAt)).not.toContain("request: { payload }");
    expect(postRpc.slice(catchAt, rethrowAt)).not.toContain("response: body");
    expect(postRpc.slice(successEvidenceAt)).toContain("status: response.status()");
    expect(postRpc.slice(successEvidenceAt)).toContain("...phases.snapshot()");
    expect(postRpc.match(/evidence\?\.push\(\{/g)).toHaveLength(2);
  });

  it("executes the extracted postRpc success path with the real malformed-body reader", async () => {
    const postRpc = loadExtractedPostRpc();
    const evidence: ExtractedEvidence[] = [];
    const response = {
      text: async () => "not-json",
      status: () => 200
    };
    const result = await postRpc(
      { post: async () => response },
      { restBase: "https://example.invalid/rest/v1", headers: {} },
      "safe_read_rpc",
      { mutation_id: "mutation-test" },
      evidence
    );

    expect(result).toEqual({ response, body: { raw: "not-json" } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      status: 200,
      response: { raw: "not-json" },
      request: { payload: { mutation_id: "mutation-test" } },
      phaseOutcome: "complete"
    });
    expect(evidence[0].requestPostAwaitMs).toEqual(expect.any(Number));
    expect(evidence[0].bodyReadAndParseMs).toEqual(expect.any(Number));
  });

  it.each(["request", "body"] as const)(
    "executes the extracted postRpc %s-failure path, preserving identity and one sanitized record",
    async stage => {
      const postRpc = loadExtractedPostRpc();
      const primary = new Error(`private-${stage}-failure`);
      const evidence: ExtractedEvidence[] = [];
      const response = {
        text: async () => { throw primary; },
        status: () => 599
      };
      const request = {
        post: async () => {
          if (stage === "request") throw primary;
          return response;
        }
      };

      await expect(postRpc(
        request,
        { restBase: "https://example.invalid/rest/v1", headers: {} },
        "safe_read_rpc",
        { mutation_id: "mutation-private", secret: "must-not-persist" },
        evidence
      )).rejects.toBe(primary);

      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toEqual(expect.objectContaining({
        status: null,
        requestPostAwaitMs: stage === "request" ? null : expect.any(Number),
        bodyReadAndParseMs: null,
        phaseOutcome: stage === "request" ? "request-failed" : "body-failed"
      }));
      expect(evidence[0]).not.toHaveProperty("request");
      expect(evidence[0]).not.toHaveProperty("response");
      expect(JSON.stringify(evidence[0])).not.toContain(primary.message);
      expect(JSON.stringify(evidence[0])).not.toContain("must-not-persist");
    }
  );
});
