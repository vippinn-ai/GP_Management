import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { captureRpcEvidence } from "../../tests/e2e/staging/support/app";
import {
  createRpcEvidenceCollector,
  type RpcEvidence,
  type RpcEvidenceResponseLike
} from "./rpcEvidenceCollector";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(
  body: Promise<unknown>,
  options: { url?: string; method?: string; status?: number } = {}
): RpcEvidenceResponseLike {
  return {
    url: () => options.url ?? "https://staging.example.test/rest/v1/rpc/hop_session_v2",
    request: () => ({ method: () => options.method ?? "POST" }),
    status: () => options.status ?? 200,
    json: () => body
  };
}

class FakePage {
  private readonly responseListeners = new Set<(value: RpcEvidenceResponseLike) => void>();

  on(event: string, listener: (value: RpcEvidenceResponseLike) => void) {
    if (event === "response") this.responseListeners.add(listener);
    return this;
  }

  off(event: string, listener: (value: RpcEvidenceResponseLike) => void) {
    if (event === "response") this.responseListeners.delete(listener);
    return this;
  }

  emitResponse(value: RpcEvidenceResponseLike) {
    for (const listener of [...this.responseListeners]) listener(value);
  }

  listenerCount() {
    return this.responseListeners.size;
  }
}

describe("RPC evidence collection", () => {
  it("registers delayed response work synchronously and settles the complete mapped evidence", async () => {
    const body = deferred<unknown>();
    const target: RpcEvidence[] = [];
    const collector = createRpcEvidenceCollector("origin", target);

    collector.onResponse(response(body.promise));
    expect(target).toEqual([]);
    const settlement = collector.settle(100);
    body.resolve({
      entity_id: "session-1",
      bill_id: "bill-1",
      bill_number: "BILL-1",
      event_id: "event-1",
      mutation_id: "mutation-1",
      server_time: "2026-09-28T00:00:00Z",
      server_duration_ms: 12.5,
      changed_rows: { sessions: ["session-1"] }
    });
    await settlement;

    expect(target).toEqual([{
      page: "origin",
      rpc: "hop_session_v2",
      status: 200,
      entityId: "session-1",
      billId: "bill-1",
      billNumber: "BILL-1",
      eventId: "event-1",
      mutationId: "mutation-1",
      serverTime: "2026-09-28T00:00:00Z",
      serverDurationMs: 12.5,
      changedRows: { sessions: ["session-1"] }
    }]);
  });

  it("settles every admitted response and retains status when a body is not readable JSON", async () => {
    const first = deferred<unknown>();
    const target: RpcEvidence[] = [];
    const collector = createRpcEvidenceCollector("observer", target);

    collector.onResponse(response(first.promise, { status: 400 }));
    collector.onResponse(response(Promise.reject(new Error("private body failure")), {
      url: "https://staging.example.test/rest/v1/rpc/reject_session_v2",
      status: 503
    }));
    first.resolve({ entity_id: "session-2" });
    await collector.settle(100);

    expect(target).toHaveLength(2);
    expect(target).toEqual(expect.arrayContaining([
      expect.objectContaining({ page: "observer", rpc: "hop_session_v2", status: 400, entityId: "session-2" }),
      expect.objectContaining({ page: "observer", rpc: "reject_session_v2", status: 503, entityId: undefined })
    ]));
  });

  it("ignores non-RPC, non-POST, and malformed URLs", async () => {
    const target: RpcEvidence[] = [];
    const collector = createRpcEvidenceCollector("origin", target);

    collector.onResponse(response(Promise.resolve({}), { url: "https://staging.example.test/rest/v1/sessions" }));
    collector.onResponse(response(Promise.resolve({}), { method: "GET" }));
    collector.onResponse(response(Promise.resolve({}), { url: "not a url" }));
    await collector.settle(100);

    expect(target).toEqual([]);
  });
  it("drains new responses admitted while settlement is already waiting", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const target: RpcEvidence[] = [];
    const collector = createRpcEvidenceCollector("origin", target);
    collector.onResponse(response(first.promise));
    let settled = false;
    const waiting = collector.settle(500).then(() => { settled = true; });
    collector.onResponse(response(second.promise));
    first.resolve({entity_id:"first"});
    // Allow the first task and initial Promise.all snapshot to complete.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(target.map(entry => entry.entityId)).toEqual(["first"]);
    second.resolve({entity_id:"second"});
    await waiting;
    expect(target.map(entry => entry.entityId)).toEqual(["first", "second"]);
  });

  it("fails settlement within a bound without creating an unhandled listener rejection", async () => {
    const body = deferred<unknown>();
    const target: RpcEvidence[] = [];
    const collector = createRpcEvidenceCollector("origin", target);
    collector.onResponse(response(body.promise));

    await expect(collector.settle(10)).rejects.toThrow(
      "RPC evidence collection did not settle within the configured timeout."
    );
    body.resolve({ entity_id: "late-session" });
    await collector.settle(100);
    expect(target[0]?.entityId).toBe("late-session");
  });

  it("returns a callable detach control and disposal detaches before draining admitted work", async () => {
    const page = new FakePage();
    const target: RpcEvidence[] = [];
    const body = deferred<unknown>();
    const control = captureRpcEvidence(page as unknown as Page, "origin", target);

    expect(typeof control).toBe("function");
    expect(page.listenerCount()).toBe(1);
    page.emitResponse(response(body.promise));
    const disposal = control.dispose(100);
    expect(page.listenerCount()).toBe(0);
    page.emitResponse(response(Promise.resolve({ entity_id: "must-not-be-admitted" })));
    body.resolve({ entity_id: "admitted-before-dispose" });
    await disposal;

    expect(target.map((entry) => entry.entityId)).toEqual(["admitted-before-dispose"]);
    control();
    expect(page.listenerCount()).toBe(0);
  });

  it("reports collector-side failures through a fixed sanitized settlement error", async () => {
    const target = [] as RpcEvidence[];
    target.push = (() => {
      throw new Error("sensitive implementation detail");
    }) as typeof target.push;
    const collector = createRpcEvidenceCollector("origin", target);
    collector.onResponse(response(Promise.resolve({ entity_id: "session-3" })));

    await expect(collector.settle(100)).rejects.toThrow("RPC evidence collection failed.");
  });
});
