import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createFailurePreservingCleanup } from "../../../src/qa/failurePreservingCleanup";
import {
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  captureRpcEvidence,
  credentials,
  createObserver,
  openManagedSession,
  readApiResponseBody,
  readPendingOperationalMutations,
  readRestRows,
  rpcRejectionCode,
  signIn,
  startSession,
  stationCard,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const organizationId = "org-primary";
const timedStationName = process.env.E2E_HOP_STATION?.trim() || "Playstation";
const unitStationName = process.env.E2E_OPERATIONAL_UNIT_STATION?.trim() || "Arcade 1";

interface Identity {
  actorId: string;
  restBase: string;
  headers: Record<string, string>;
}

interface StationRow { id: string; name: string; mode: string }
interface Target { type: "session" | "customer_tab"; id: string; customerName: string }
interface SessionItemRow {
  id: string;
  inventory_item_id: string | null;
  name: string;
  quantity: number | string;
  unit_price: number | string;
  sold_as_pack_of: number | string | null;
  stock_units_per_sale: number | string | null;
}
interface DirectRpcEvidence {
  client: "origin" | "observer";
  rpc: string;
  mutationId: string | null;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  status: number;
  request: { payload: unknown };
  response: unknown;
}

function identityFrom(requests: CapturedRpcRequest[]): Identity {
  const captured = [...requests].reverse().find((entry) => entry.headers.apikey && entry.headers.authorization);
  if (!captured) throw new Error("No authenticated staging REST request was captured.");
  const url = new URL(captured.url);
  const markerAt = url.pathname.indexOf("/rest/v1");
  if (markerAt < 0) throw new Error("Captured request is not a Supabase REST request.");
  return {
    actorId: authenticatedJwtSubject(captured.headers),
    restBase: `${url.origin}${url.pathname.slice(0, markerAt)}/rest/v1`,
    headers: {
      apikey: captured.headers.apikey,
      authorization: captured.headers.authorization,
      "content-type": "application/json"
    }
  };
}

async function rpc(
  request: APIRequestContext,
  identity: Identity,
  name: string,
  payload: Record<string, unknown>,
  evidence?: DirectRpcEvidence[],
  client: DirectRpcEvidence["client"] = "origin"
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const response = await request.post(`${identity.restBase}/rpc/${name}`, {
    headers: identity.headers,
    data: { payload }
  });
  const body = await readApiResponseBody(response);
  evidence?.push({
    client,
    rpc: name,
    mutationId: typeof payload.mutation_id === "string" ? payload.mutation_id : null,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    status: response.status(),
    request: { payload },
    response: body
  });
  return { status: response.status(), body, payload };
}

function canonicalItem(row: SessionItemRow) {
  return {
    inventoryItemId: row.inventory_item_id,
    name: row.name,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price)
  };
}

function stockUnits(row: SessionItemRow) {
  return Number(row.quantity) * Number(row.stock_units_per_sale ?? row.sold_as_pack_of ?? 1);
}

function mutationAuditIds(payload: Record<string, unknown>) {
  const nested = payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload)
    ? payload.payload as Record<string, unknown>
    : {};
  const ids: string[] = [];
  if (typeof nested.audit_log_id === "string") ids.push(nested.audit_log_id);
  const auditLog = nested.auditLog && typeof nested.auditLog === "object" && !Array.isArray(nested.auditLog)
    ? nested.auditLog as Record<string, unknown>
    : {};
  if (typeof auditLog.id === "string") ids.push(auditLog.id);
  if (Array.isArray(nested.auditLogs)) {
    for (const entry of nested.auditLogs) {
      if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { id?: unknown }).id === "string") {
        ids.push((entry as { id: string }).id);
      }
    }
  }
  return ids;
}

function sessionCommand(identity: Identity, station: StationRow, suffix: string, customerName: string, sources: string[] = []) {
  const id = `${runId}-${suffix}`;
  const createdAt = new Date().toISOString();
  return {
    organization_id: organizationId,
    mutation_id: `${id}-start`,
    mutation_kind: "startSession",
    user_id: identity.actorId,
    payload: {
      session: {
        id,
        stationId: station.id,
        stationNameSnapshot: station.name,
        mode: station.mode,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        status: "active",
        customerName,
        customerPhone: "",
        playMode: "group",
        ltpEligible: false,
        pricingSnapshot: [],
        pauseLogIds: [],
        continuedFromSessionIds: sources,
        items: [],
        comboApplications: []
      },
      customer: { id: `${id}-customer`, name: customerName, phone: "", visitAt: createdAt },
      stockMovements: [],
      auditLogs: []
    }
  };
}

function tabCommand(identity: Identity, suffix: string, customerName: string, sources: string[] = []) {
  const id = `${runId}-${suffix}`;
  const createdAt = new Date().toISOString();
  return {
    organization_id: organizationId,
    mutation_id: `${id}-open`,
    mutation_kind: "openCustomerTab",
    user_id: identity.actorId,
    payload: {
      tab: {
        id,
        customerName,
        customerPhone: "",
        status: "open",
        createdAt,
        items: [],
        comboApplications: [],
        continuedFromSessionIds: sources
      },
      customer: { id: `${id}-customer`, name: customerName, phone: "", visitAt: createdAt },
      auditLog: {
        id: `${id}-open-audit`,
        action: "customer_tab_opened",
        entityType: "customer_tab",
        entityId: id,
        message: `QA continuation tab ${suffix}`,
        createdAt,
        userId: identity.actorId
      }
    }
  };
}

function hopCommand(target: Target, suffix: string) {
  return {
    organization_id: organizationId,
    mutation_id: `${runId}-${suffix}-hop`,
    mutation_kind: "hopSession",
    entity_type: "session",
    entity_id: target.id,
    payload: {
      effective_ended_at: new Date().toISOString(),
      audit_log_id: `${runId}-${suffix}-hop-audit`
    }
  };
}

function rejectCommand(target: Target, suffix: string) {
  const tab = target.type === "customer_tab";
  return {
    rpc: tab ? "reject_customer_tab_v2" : "reject_session_v2",
    payload: {
      organization_id: organizationId,
      mutation_id: `${runId}-${suffix}-reject`,
      mutation_kind: tab ? "rejectCustomerTab" : "rejectSession",
      entity_type: target.type,
      entity_id: target.id,
      payload: {
        ...(tab ? { effective_closed_at: new Date().toISOString() } : { effective_ended_at: new Date().toISOString() }),
        reason: `QA continuation cleanup ${suffix}`,
        audit_log_id: `${runId}-${suffix}-reject-audit`
      }
    }
  };
}

function linkCommand(identity: Identity, targetTab: Target, sourceId: string, suffix: string) {
  const createdAt = new Date().toISOString();
  return {
    organization_id: organizationId,
    mutation_id: `${runId}-${suffix}-link`,
    mutation_kind: "linkCustomerTabContinuation",
    user_id: identity.actorId,
    payload: {
      customerTabId: targetTab.id,
      continuedFromSessionIds: [sourceId],
      auditLogs: [{
        id: `${runId}-${suffix}-link-audit`,
        action: "customer_tab_continuation_linked",
        entityType: "customer_tab",
        entityId: targetTab.id,
        message: `QA link continuation ${suffix}`,
        createdAt,
        userId: identity.actorId
      }]
    }
  };
}

async function billRecoverableSource(page: Page, identity: Identity, sourceId: string) {
  await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSynced(page);
  const alert = page.getByRole("alert").filter({ hasText: "Game hop needs continuation" });
  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Continue", exact: true }).click();
  const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
  await continuation.getByRole("button", { name: "Bill & Done", exact: true }).click();
  const bill = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
  const response = page.waitForResponse((candidate) =>
    candidate.url().includes("/rest/v1/rpc/commit_checkout_bill_v2") && candidate.request().method() === "POST"
  );
  await bill.getByRole("button", { name: "Issue Bill", exact: true }).click();
  const committed = await response;
  expect(committed.status()).toBe(200);
  const body = await committed.json() as { bill_id?: string };
  expect(body.bill_id).toBeTruthy();
  await expect(bill).toBeHidden();
  await waitForSynced(page);
  const sessions = await readRestRows<{ id: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(
    page, identity.restBase, identity.headers, "sessions",
    { organization_id: `eq.${organizationId}`, id: `eq.${sourceId}`, select: "id,status,close_disposition,closed_bill_id" }
  );
  expect(sessions).toEqual([{ id: sourceId, status: "closed", close_disposition: "hopped", closed_bill_id: body.bill_id }]);
  return body.bill_id!;
}

async function activeConsumers(page: Page, identity: Identity, sourceId: string) {
  const [sessions, tabs] = await Promise.all([
    readRestRows<{ id: string; status: string; continued_from_session_ids: string[] | null }>(page, identity.restBase, identity.headers, "sessions", {
      organization_id: `eq.${organizationId}`,
      select: "id,status,continued_from_session_ids"
    }),
    readRestRows<{ id: string; status: string; continued_from_session_ids: string[] | null }>(page, identity.restBase, identity.headers, "customer_tabs", {
      organization_id: `eq.${organizationId}`,
      select: "id,status,continued_from_session_ids"
    })
  ]);
  return [
    ...sessions.filter((row) => row.status !== "closed" && row.continued_from_session_ids?.includes(sourceId)).map((row) => ({ type: "session" as const, id: row.id })),
    ...tabs.filter((row) => row.status !== "closed" && row.continued_from_session_ids?.includes(sourceId)).map((row) => ({ type: "customer_tab" as const, id: row.id }))
  ];
}

test.describe.serial("Operational v2 continuation and unit-sale matrix", () => {
  test("unit-sale session can hop and bill without losing its server-owned items", async ({ browser, page }, testInfo) => {
    const finalization = createFailurePreservingCleanup();
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originRequests: CapturedRpcRequest[] = [];
    captureAuthenticatedRestRequests(page, originRequests);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    const customerName = `QA Unit Hop ${runId}`;
    let billId: string | undefined;
    let sourceId: string | undefined;
    let primaryError: unknown;
    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      const identity = identityFrom(originRequests);
      await startSession(page, unitStationName, customerName);
      const startRequest = [...originRequests].reverse().find((entry) => new URL(entry.url).pathname.endsWith("/rpc/start_session"));
      expect(startRequest, "The unit-sale start request must be captured.").toBeTruthy();
      const startEnvelope = startRequest!.body as {
        payload: { entity_id: string; payload: { session: { id: string; mode: string; items: unknown[] } } };
      };
      sourceId = startEnvelope.payload.entity_id || startEnvelope.payload.payload.session.id;
      expect(startEnvelope.payload.payload.session.mode).toBe("unit_sale");
      expect(startEnvelope.payload.payload.session.items.length).toBeGreaterThan(0);
      const [sessionAfterStart, itemsAfterStart] = await Promise.all([
        readRestRows<{ id: string; mode: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(
          page, identity.restBase, identity.headers, "sessions",
          { organization_id: `eq.${organizationId}`, id: `eq.${sourceId}`, select: "id,mode,status,close_disposition,closed_bill_id" }
        ),
        readRestRows<SessionItemRow>(page, identity.restBase, identity.headers, "session_items", {
          organization_id: `eq.${organizationId}`, session_id: `eq.${sourceId}`,
          select: "id,inventory_item_id,name,quantity,unit_price,sold_as_pack_of,stock_units_per_sale", order: "id.asc"
        })
      ]);
      expect(sessionAfterStart).toEqual([{ id: sourceId, mode: "unit_sale", status: "active", close_disposition: null, closed_bill_id: null }]);
      expect(itemsAfterStart.length, "Unit-sale start must persist at least one canonical item.").toBeGreaterThan(0);
      const inventoryIds = [...new Set(itemsAfterStart.map((row) => row.inventory_item_id).filter((id): id is string => Boolean(id)))];
      expect(inventoryIds.length, "Every unit-sale item must retain an inventory identity.").toBeGreaterThan(0);
      const inventoryAfterStart = await readRestRows<{ id: string; stock_qty: number | string; is_reusable: boolean }>(
        page, identity.restBase, identity.headers, "inventory_items",
        { organization_id: `eq.${organizationId}`, id: `in.(${inventoryIds.join(",")})`, select: "id,stock_qty,is_reusable", order: "id.asc" }
      );
      const managed = await openManagedSession(page, unitStationName);
      await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const close = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await close.getByLabel(/Game hop - close station without billing/).check();
      const hopResponse = page.waitForResponse((response) => response.url().includes("/rpc/hop_session_v2"));
      await close.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();
      expect((await hopResponse).status()).toBe(200);
      expect(rpcEvidence.findLast((entry) => entry.rpc === "hop_session_v2" && entry.status < 300)?.entityId).toBe(sourceId);
      const [sessionAfterHop, itemsAfterHop, inventoryAfterHop] = await Promise.all([
        readRestRows<{ id: string; mode: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(
          page, identity.restBase, identity.headers, "sessions",
          { organization_id: `eq.${organizationId}`, id: `eq.${sourceId}`, select: "id,mode,status,close_disposition,closed_bill_id" }
        ),
        readRestRows<SessionItemRow>(page, identity.restBase, identity.headers, "session_items", {
          organization_id: `eq.${organizationId}`, session_id: `eq.${sourceId}`,
          select: "id,inventory_item_id,name,quantity,unit_price,sold_as_pack_of,stock_units_per_sale", order: "id.asc"
        }),
        readRestRows<{ id: string; stock_qty: number | string; is_reusable: boolean }>(page, identity.restBase, identity.headers, "inventory_items", {
          organization_id: `eq.${organizationId}`, id: `in.(${inventoryIds.join(",")})`, select: "id,stock_qty,is_reusable", order: "id.asc"
        })
      ]);
      expect(sessionAfterHop).toEqual([{ id: sourceId, mode: "unit_sale", status: "closed", close_disposition: "hopped", closed_bill_id: null }]);
      expect(itemsAfterHop.map(canonicalItem)).toEqual(itemsAfterStart.map(canonicalItem));
      expect(inventoryAfterHop).toEqual(inventoryAfterStart);
      await expect(stationCard(observer.page, unitStationName)).toContainText("Available");
      const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
      await continuation.getByRole("button", { name: "Bill & Done", exact: true }).click();
      const bill = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
      await bill.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(bill).toBeHidden();
      await waitForSynced(page);
      billId = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)?.billId;
      expect(billId).toBeTruthy();
      const [sessionAfterBill, billLines, inventoryAfterBill, billStockMovements] = await Promise.all([
        readRestRows<{ id: string; mode: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(
          page, identity.restBase, identity.headers, "sessions",
          { organization_id: `eq.${organizationId}`, id: `eq.${sourceId}`, select: "id,mode,status,close_disposition,closed_bill_id" }
        ),
        readRestRows<{ description: string; quantity: number | string; unit_price: number | string; inventory_item_id: string | null; linked_session_id: string | null }>(
          page, identity.restBase, identity.headers, "bill_lines",
          { organization_id: `eq.${organizationId}`, bill_id: `eq.${billId}`, linked_session_id: `eq.${sourceId}`, select: "description,quantity,unit_price,inventory_item_id,linked_session_id", order: "id.asc" }
        ),
        readRestRows<{ id: string; stock_qty: number | string; is_reusable: boolean }>(page, identity.restBase, identity.headers, "inventory_items", {
          organization_id: `eq.${organizationId}`, id: `in.(${inventoryIds.join(",")})`, select: "id,stock_qty,is_reusable", order: "id.asc"
        }),
        readRestRows<{ id: string; item_id: string; quantity: number | string; related_bill_id: string | null }>(page, identity.restBase, identity.headers, "stock_movements", {
          organization_id: `eq.${organizationId}`, related_bill_id: `eq.${billId}`, item_id: `in.(${inventoryIds.join(",")})`, select: "id,item_id,quantity,related_bill_id", order: "id.asc"
        })
      ]);
      expect(sessionAfterBill).toEqual([{ id: sourceId, mode: "unit_sale", status: "closed", close_disposition: "hopped", closed_bill_id: billId }]);
      const billedItems = billLines
        .filter((line) => line.inventory_item_id)
        .map((line) => ({ inventoryItemId: line.inventory_item_id, name: line.description, quantity: Number(line.quantity), unitPrice: Number(line.unit_price) }));
      expect(billedItems).toEqual(itemsAfterStart.map(canonicalItem));
      for (const before of inventoryAfterHop) {
        const after = inventoryAfterBill.find((row) => row.id === before.id);
        expect(after, `Final inventory row ${before.id} must exist.`).toBeTruthy();
        const expectedDelta = before.is_reusable
          ? 0
          : itemsAfterStart.filter((row) => row.inventory_item_id === before.id).reduce((sum, row) => sum + stockUnits(row), 0);
        expect(Number(after!.stock_qty), `Final stock for ${before.id} must decrement exactly once.`).toBe(Number(before.stock_qty) - expectedDelta);
        const movementTotal = billStockMovements.filter((row) => row.item_id === before.id).reduce((sum, row) => sum + Number(row.quantity), 0);
        expect(movementTotal, `Bill stock movement for ${before.id} must match the one-time decrement.`).toBe(-expectedDelta);
      }
      const unitEvidence = {
        startEnvelope, sessionAfterStart, itemsAfterStart, inventoryAfterStart, sessionAfterHop, itemsAfterHop,
        inventoryAfterHop, sessionAfterBill, billLines, inventoryAfterBill, billStockMovements
      };
      expect(originErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      await attachJson(testInfo, "operational-v2-unit-sale-hop", { runId, customerName, sourceId, billId, unitEvidence, rpcEvidence });
    } catch (error) {
      primaryError = error;
    } finally {
      await finalization.run("origin failure screenshot", () => attachFailureScreenshot(testInfo, page, "unit-sale-hop-origin-failure"));
      await finalization.run("observer failure screenshot", () => attachFailureScreenshot(testInfo, observer.page, "unit-sale-hop-observer-failure"));
      await finalization.run("observer context close", () => observer.context.close());
    }
    if (primaryError) throw primaryError;
    finalization.throwIfFailed();
    if (sourceId && !billId) throw new Error("Unit-sale hop was not terminally billed; reconcile before another run.");
  });

  test("new-tab, existing-tab, double-consumer, and reject-versus-consumer flows consume each source at most once", async ({ browser, page }, testInfo) => {
    const finalization = createFailurePreservingCleanup();
    test.setTimeout(12 * 60_000);
    const observer = await createObserver(browser);
    const originRequests: CapturedRpcRequest[] = [];
    const observerRequests: CapturedRpcRequest[] = [];
    captureAuthenticatedRestRequests(page, originRequests);
    captureAuthenticatedRestRequests(observer.page, observerRequests);
    const evidence: Array<Record<string, unknown>> = [];
    const directRpcEvidence: DirectRpcEvidence[] = [];
    const rpcEvidence: RpcEvidence[] = [];
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    const unresolvedSourceIds = new Set<string>();
    const unresolvedConsumers = new Map<string, Target>();
    let primaryError: unknown;
    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      const origin = identityFrom(originRequests);
      const second = identityFrom(observerRequests);
      expect(second.actorId, "Continuation races require distinct actors.").not.toBe(origin.actorId);
      const originRpc = (name: string, payload: Record<string, unknown>) =>
        rpc(page.request, origin, name, payload, directRpcEvidence, "origin");
      const observerRpc = (name: string, payload: Record<string, unknown>) =>
        rpc(observer.page.request, second, name, payload, directRpcEvidence, "observer");
      const stations = await readRestRows<StationRow>(page, origin.restBase, origin.headers, "stations", {
        organization_id: `eq.${organizationId}`, active: "eq.true", mode: "eq.timed", select: "id,name,mode", order: "id.asc"
      });
      const station = stations.find((entry) => entry.name === timedStationName) ?? stations[0];
      expect(station).toBeTruthy();

      const prepareSource = async (suffix: string, customerName: string) => {
        const start = sessionCommand(origin, station, `${suffix}-source`, customerName);
        const started = await originRpc("start_session", start);
        expect(started.status).toBe(200);
        const target: Target = { type: "session", id: String((start.payload.session as { id: string }).id), customerName };
        const hopped = await originRpc("hop_session_v2", hopCommand(target, suffix));
        expect(hopped.status).toBe(200);
        unresolvedSourceIds.add(target.id);
        return target;
      };

      const rejectConsumer = async (target: Target, suffix: string) => {
        const rejected = rejectCommand(target, suffix);
        const result = await originRpc(rejected.rpc, rejected.payload);
        expect(result.status).toBe(200);
        unresolvedConsumers.delete(target.id);
        return result;
      };

      const billSource = async (sourceId: string) => {
        await billRecoverableSource(page, origin, sourceId);
        unresolvedSourceIds.delete(sourceId);
      };

      for (const mode of ["new-tab", "existing-tab"] as const) {
        const customerName = `QA ${mode} ${runId}`;
        let existing: Target | undefined;
        if (mode === "existing-tab") {
          const command = tabCommand(origin, `${mode}-target`, customerName);
          const opened = await originRpc("open_customer_tab", command);
          expect(opened.status).toBe(200);
          existing = { type: "customer_tab", id: String((command.payload.tab as { id: string }).id), customerName };
          unresolvedConsumers.set(existing.id, existing);
        }
        const source = await prepareSource(mode, customerName);
        const consumed = mode === "new-tab"
          ? await originRpc("open_customer_tab", tabCommand(origin, `${mode}-consumer`, customerName, [source.id]))
          : await originRpc("link_customer_tab_continuation", linkCommand(origin, existing!, source.id, mode));
        expect(consumed.status).toBe(200);
        const consumer: Target = existing ?? { type: "customer_tab", id: String((consumed.body as { entity_id: string }).entity_id), customerName };
        unresolvedConsumers.set(consumer.id, consumer);
        expect(await activeConsumers(page, origin, source.id)).toEqual([{ type: "customer_tab", id: consumer.id }]);
        await rejectConsumer(consumer, mode);
        expect(await activeConsumers(page, origin, source.id)).toEqual([]);
        await billSource(source.id);
        evidence.push({ mode, sourceId: source.id, consumerId: consumer.id, releasedAndBilled: true });
      }

      {
        const suffix = "triple-consumer";
        const customerName = `QA Triple Consumer ${runId}`;
        const existingCommand = tabCommand(origin, `${suffix}-existing`, customerName);
        expect((await originRpc("open_customer_tab", existingCommand)).status).toBe(200);
        const existing: Target = { type: "customer_tab", id: String((existingCommand.payload.tab as { id: string }).id), customerName };
        unresolvedConsumers.set(existing.id, existing);
        const source = await prepareSource(suffix, customerName);
        const session = sessionCommand(origin, station, `${suffix}-session`, customerName, [source.id]);
        const newTab = tabCommand(second, `${suffix}-new-tab`, customerName, [source.id]);
        const linked = linkCommand(origin, existing, source.id, suffix);
        const results = await Promise.all([
          originRpc("start_session", session),
          observerRpc("open_customer_tab", newTab),
          originRpc("link_customer_tab_continuation", linked)
        ]);
        if (results[0].status === 200) {
          const candidate: Target = { type: "session", id: String((session.payload.session as { id: string }).id), customerName };
          unresolvedConsumers.set(candidate.id, candidate);
        }
        if (results[1].status === 200) {
          const candidate: Target = { type: "customer_tab", id: String((newTab.payload.tab as { id: string }).id), customerName };
          unresolvedConsumers.set(candidate.id, candidate);
        }
        expect(results.filter((entry) => entry.status === 200)).toHaveLength(1);
        results.filter((entry) => entry.status !== 200).forEach((entry) => expect(rpcRejectionCode(entry.body)).toBe("hopped_session_unavailable"));
        const consumers = await activeConsumers(page, origin, source.id);
        expect(consumers).toHaveLength(1);
        const winner: Target = { ...consumers[0], customerName };
        unresolvedConsumers.set(winner.id, winner);
        await rejectConsumer(winner, `${suffix}-winner`);
        if (winner.id !== existing.id) await rejectConsumer(existing, `${suffix}-unused-existing`);
        await billSource(source.id);
        evidence.push({ mode: suffix, sourceId: source.id, statuses: results.map((entry) => entry.status), winner });
      }

      {
        const suffix = "reject-vs-consumer";
        const customerName = `QA Reject Consumer ${runId}`;
        const source = await prepareSource(suffix, customerName);
        const oldTabCommand = tabCommand(origin, `${suffix}-old`, customerName, [source.id]);
        expect((await originRpc("open_customer_tab", oldTabCommand)).status).toBe(200);
        const oldTab: Target = { type: "customer_tab", id: String((oldTabCommand.payload.tab as { id: string }).id), customerName };
        unresolvedConsumers.set(oldTab.id, oldTab);
        const rejection = rejectCommand(oldTab, suffix);
        const nextTabCommand = tabCommand(second, `${suffix}-next`, customerName, [source.id]);
        const [rejected, next] = await Promise.all([
          originRpc(rejection.rpc, rejection.payload),
          observerRpc("open_customer_tab", nextTabCommand)
        ]);
        expect(rejected.status).toBe(200);
        unresolvedConsumers.delete(oldTab.id);
        expect([200, 400]).toContain(next.status);
        if (next.status === 200) {
          const candidate: Target = { type: "customer_tab", id: String((nextTabCommand.payload.tab as { id: string }).id), customerName };
          unresolvedConsumers.set(candidate.id, candidate);
        }
        if (next.status === 400) expect(rpcRejectionCode(next.body)).toBe("hopped_session_unavailable");
        const consumers = await activeConsumers(page, origin, source.id);
        expect(consumers.length).toBeLessThanOrEqual(1);
        if (consumers[0]) {
          const nextConsumer = { ...consumers[0], customerName };
          unresolvedConsumers.set(nextConsumer.id, nextConsumer);
          await rejectConsumer(nextConsumer, `${suffix}-next`);
        }
        await billSource(source.id);
        evidence.push({ mode: suffix, sourceId: source.id, rejectStatus: rejected.status, nextStatus: next.status, consumerCount: consumers.length });
      }

      const mutationIds = directRpcEvidence.map((entry) => entry.mutationId).filter((id): id is string => Boolean(id));
      const events = await readRestRows<{ id: string; created_by: string; metadata: { mutation_id?: string } }>(
        page, origin.restBase, origin.headers, "operational_events",
        { organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `in.(${mutationIds.join(",")})`, select: "id,created_by,metadata" }
      );
      for (const entry of directRpcEvidence) {
        if (!entry.mutationId) continue;
        const matching = events.filter((event) => event.metadata.mutation_id === entry.mutationId);
        expect(matching, `${entry.rpc} ${entry.mutationId} event cardinality`).toHaveLength(entry.status === 200 ? 1 : 0);
        if (entry.status === 200) {
          expect(matching[0].created_by).toBe(entry.client === "origin" ? origin.actorId : second.actorId);
        }
        const command = entry.request.payload as Record<string, unknown>;
        for (const auditId of mutationAuditIds(command)) {
          const audits = await readRestRows<{ id: string; user_id: string }>(page, origin.restBase, origin.headers, "audit_logs", {
            organization_id: `eq.${organizationId}`, id: `eq.${auditId}`, select: "id,user_id"
          });
          expect(audits, `${entry.rpc} ${entry.mutationId} audit cardinality`).toHaveLength(entry.status === 200 ? 1 : 0);
          if (entry.status === 200) expect(audits[0].user_id).toBe(entry.client === "origin" ? origin.actorId : second.actorId);
        }
      }

      await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), observer.page.reload({ waitUntil: "domcontentloaded" })]);
      await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
      expect(await readPendingOperationalMutations(page)).toEqual([]);
      expect(await readPendingOperationalMutations(observer.page)).toEqual([]);
      expect([...unresolvedSourceIds]).toEqual([]);
      expect([...unresolvedConsumers.values()]).toEqual([]);
      expect(originErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      await attachJson(testInfo, "operational-v2-continuation-matrix", { runId, evidence, events, rpcEvidence, directRpcEvidence });
    } catch (error) {
      primaryError = error;
    } finally {
      await finalization.run("cleanup ledger evidence", () => attachJson(testInfo, "operational-v2-continuation-cleanup-ledger", {
        runId,
        unresolvedSourceIds: [...unresolvedSourceIds],
        unresolvedConsumers: [...unresolvedConsumers.values()],
        failed: Boolean(primaryError)
      }));
      await finalization.run("origin failure screenshot", () => attachFailureScreenshot(testInfo, page, "continuation-matrix-origin-failure"));
      await finalization.run("observer failure screenshot", () => attachFailureScreenshot(testInfo, observer.page, "continuation-matrix-observer-failure"));
      await finalization.run("observer context close", () => observer.context.close());
    }
    if (primaryError) throw primaryError;
    finalization.throwIfFailed();
    if (unresolvedSourceIds.size || unresolvedConsumers.size) {
      throw new Error("Continuation matrix left exact unresolved staging entities; reconcile before another run.");
    }
  });
});
