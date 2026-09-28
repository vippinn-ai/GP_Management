export interface RpcEvidence {
  page: "origin" | "observer";
  rpc: string;
  status: number;
  entityId?: string;
  billId?: string;
  billNumber?: string;
  eventId?: string;
  mutationId?: string;
  serverTime?: string;
  serverDurationMs?: number;
  changedRows?: Record<string, unknown>;
}

export interface RpcEvidenceResponseLike {
  url(): string;
  request(): { method(): string };
  status(): number;
  json(): Promise<unknown>;
}

export interface RpcEvidenceCollector {
  onResponse(response: RpcEvidenceResponseLike): void;
  settle(timeoutMs?: number): Promise<void>;
}

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 5_000;

function rpcName(response: RpcEvidenceResponseLike) {
  try {
    const url = new URL(response.url());
    const marker = "/rest/v1/rpc/";
    const markerAt = url.pathname.indexOf(marker);
    if (markerAt < 0 || response.request().method() !== "POST") return null;
    return url.pathname.slice(markerAt + marker.length);
  } catch {
    return null;
  }
}

function recordFromBody(
  page: RpcEvidence["page"],
  rpc: string,
  status: number,
  body: Record<string, unknown>
): RpcEvidence {
  return {
    page,
    rpc,
    status,
    entityId: typeof body.entity_id === "string" ? body.entity_id : undefined,
    billId: typeof body.bill_id === "string" ? body.bill_id : undefined,
    billNumber: typeof body.bill_number === "string" ? body.bill_number : undefined,
    eventId: typeof body.event_id === "string" ? body.event_id : undefined,
    mutationId: typeof body.mutation_id === "string" ? body.mutation_id : undefined,
    serverTime: typeof body.server_time === "string" ? body.server_time : undefined,
    serverDurationMs: typeof body.server_duration_ms === "number" ? body.server_duration_ms : undefined,
    changedRows: body.changed_rows && typeof body.changed_rows === "object"
      ? body.changed_rows as Record<string, unknown>
      : undefined
  };
}

export function createRpcEvidenceCollector(
  page: RpcEvidence["page"],
  target: RpcEvidence[]
): RpcEvidenceCollector {
  const pending = new Set<Promise<void>>();
  let collectionFailed = false;

  const onResponse = (response: RpcEvidenceResponseLike) => {
    const rpc = rpcName(response);
    if (!rpc) return;

    // Register the task before the response listener returns. Callers can
    // therefore await settle() immediately after Playwright observes the same
    // response without racing the asynchronous response-body read.
    const task = (async () => {
      let body: Record<string, unknown> = {};
      try {
        const value = await response.json();
        if (value && typeof value === "object" && !Array.isArray(value)) {
          body = value as Record<string, unknown>;
        }
      } catch {
        // A non-JSON or unreadable response still contributes status evidence.
      }
      target.push(recordFromBody(page, rpc, response.status(), body));
    })()
      .catch(() => {
        // Never leak a listener-task rejection into the Playwright process.
        // settle() reports a fixed, sanitized failure instead.
        collectionFailed = true;
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  const settle = async (timeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("RPC evidence settlement timeout must be a positive finite number.");
    }
    const deadline = Date.now() + timeoutMs;
    while (pending.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("RPC evidence collection did not settle within the configured timeout.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.all([...pending]).then(() => false),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), remainingMs);
        })
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) throw new Error("RPC evidence collection did not settle within the configured timeout.");
    }
    if (collectionFailed) throw new Error("RPC evidence collection failed.");
  };

  return { onResponse, settle };
}
