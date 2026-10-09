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
  errorCode?: string;
  sqlState?: string;
  bodyReadFailed?: boolean;
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
  // Retain structured codes only, not arbitrary error text, hints or payloads.
  let details: Record<string, unknown> = {};
  try {
    const parsed = typeof body.details === "string" ? JSON.parse(body.details) : body.details;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed;
  } catch { /* Non-JSON details are intentionally excluded. */ }
  const safeCode = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
  const errorIdentity = details.details && typeof details.details === "object" && !Array.isArray(details.details)
    ? details.details as Record<string, unknown> : {};
  const safeId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined;
  if (status >= 400) {
    // Error envelopes are untrusted. Do not carry success-only fields or arbitrary objects.
    const errorId = (value: unknown, prefix: RegExp) => {
      const id = safeId(value);
      return id && prefix.test(id) ? id : undefined;
    };
    return {
      page, rpc, status,
      errorCode: safeCode(details.code) ?? safeCode(body.code),
      sqlState: typeof body.code === "string" && /^[0-9A-Z]{5}$/.test(body.code) ? body.code : undefined,
      billId: errorId(errorIdentity.bill_id ?? body.bill_id, /^bill-/),
      entityId: errorId(errorIdentity.entity_id ?? errorIdentity.session_id ?? errorIdentity.customer_tab_id ?? body.entity_id, /^(?:session|tab|customer-tab|normops)-/),
      mutationId: errorId(errorIdentity.mutation_id ?? body.mutation_id, /^(?:financial|mutation|op|normops)-/)
    };
  }
  return {
    page,
    rpc,
    status,
    errorCode: safeCode(details.code) ?? safeCode(body.code),
    sqlState: typeof body.code === "string" && /^[0-9A-Z]{5}$/.test(body.code) ? body.code : undefined,
    entityId: typeof body.entity_id === "string" ? body.entity_id : safeId(errorIdentity.entity_id ?? errorIdentity.session_id ?? errorIdentity.customer_tab_id),
    billId: typeof body.bill_id === "string" ? body.bill_id : safeId(errorIdentity.bill_id),
    billNumber: typeof body.bill_number === "string" ? body.bill_number : undefined,
    eventId: typeof body.event_id === "string" ? body.event_id : undefined,
    mutationId: typeof body.mutation_id === "string" ? body.mutation_id : safeId(errorIdentity.mutation_id),
    serverTime: typeof body.server_time === "string" ? body.server_time : undefined,
    serverDurationMs: typeof body.server_duration_ms === "number" ? body.server_duration_ms : undefined,
    changedRows: body.changed_rows && typeof body.changed_rows === "object"
      ? body.changed_rows as Record<string, unknown>
      : undefined
  };
}

/** Retain diagnostic status/codes before a caller asserts success, even for an unreadable body. */
export async function captureRpcResponse(response: RpcEvidenceResponseLike, page: RpcEvidence["page"], target: RpcEvidence[], timeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS): Promise<Record<string, unknown>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid RPC body timeout.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let body: Record<string, unknown> = {};
  let bodyReadFailed = false;
  try {
    const value = await Promise.race([
      response.json(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("RPC body timeout.")), timeoutMs); })
    ]);
    if (value && typeof value === "object" && !Array.isArray(value)) body = value as Record<string, unknown>;
    else bodyReadFailed = true;
  } catch { bodyReadFailed = true; }
  finally { if (timer) clearTimeout(timer); }
  target.push({ ...recordFromBody(page, rpcName(response) ?? "unknown", response.status(), body), ...(bodyReadFailed ? { bodyReadFailed: true } : {}) });
  return body;
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
