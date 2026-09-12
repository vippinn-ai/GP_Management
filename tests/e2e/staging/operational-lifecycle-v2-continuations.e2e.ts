import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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

async function rpc(request: APIRequestContext, identity: Identity, name: string, payload: Record<string, unknown>) {
  const response = await request.post(`${identity.restBase}/rpc/${name}`, {
    headers: identity.headers,
    data: { payload }
  });
  return { status: response.status(), body: await readApiResponseBody(response), payload };
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

async function billRecoverableSource(page: Page, sourceId: string) {
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
  expect((await response).status()).toBe(200);
  await expect(bill).toBeHidden();
  await waitForSynced(page);
  return sourceId;
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
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    const customerName = `QA Unit Hop ${runId}`;
    let billId: string | undefined;
    let sourceId: string | undefined;
    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await startSession(page, unitStationName, customerName);
      const managed = await openManagedSession(page, unitStationName);
      await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const close = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await close.getByLabel(/Game hop - close station without billing/).check();
      const hopResponse = page.waitForResponse((response) => response.url().includes("/rpc/hop_session_v2"));
      await close.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();
      expect((await hopResponse).status()).toBe(200);
      sourceId = rpcEvidence.findLast((entry) => entry.rpc === "hop_session_v2" && entry.status < 300)?.entityId;
      expect(sourceId).toBeTruthy();
      await expect(stationCard(observer.page, unitStationName)).toContainText("Available");
      const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
      await continuation.getByRole("button", { name: "Bill & Done", exact: true }).click();
      const bill = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
      await bill.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(bill).toBeHidden();
      await waitForSynced(page);
      billId = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)?.billId;
      expect(billId).toBeTruthy();
      expect(originErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      await attachJson(testInfo, "operational-v2-unit-sale-hop", { runId, customerName, sourceId, billId, rpcEvidence });
    } finally {
      await attachFailureScreenshot(testInfo, page, "unit-sale-hop-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "unit-sale-hop-observer-failure");
      await observer.context.close();
      if (sourceId && !billId) throw new Error("Unit-sale hop was not terminally billed; reconcile before another run.");
    }
  });

  test("new-tab, existing-tab, double-consumer, and reject-versus-consumer flows consume each source at most once", async ({ browser, page }, testInfo) => {
    test.setTimeout(12 * 60_000);
    const observer = await createObserver(browser);
    const originRequests: CapturedRpcRequest[] = [];
    const observerRequests: CapturedRpcRequest[] = [];
    captureAuthenticatedRestRequests(page, originRequests);
    captureAuthenticatedRestRequests(observer.page, observerRequests);
    const evidence: Array<Record<string, unknown>> = [];
    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      const origin = identityFrom(originRequests);
      const second = identityFrom(observerRequests);
      expect(second.actorId, "Continuation races require distinct actors.").not.toBe(origin.actorId);
      const stations = await readRestRows<StationRow>(page, origin.restBase, origin.headers, "stations", {
        organization_id: `eq.${organizationId}`, active: "eq.true", mode: "eq.timed", select: "id,name,mode", order: "id.asc"
      });
      const station = stations.find((entry) => entry.name === timedStationName) ?? stations[0];
      expect(station).toBeTruthy();

      const prepareSource = async (suffix: string, customerName: string) => {
        const start = sessionCommand(origin, station, `${suffix}-source`, customerName);
        const started = await rpc(page.request, origin, "start_session", start);
        expect(started.status).toBe(200);
        const target: Target = { type: "session", id: String((start.payload.session as { id: string }).id), customerName };
        const hopped = await rpc(page.request, origin, "hop_session_v2", hopCommand(target, suffix));
        expect(hopped.status).toBe(200);
        return target;
      };

      for (const mode of ["new-tab", "existing-tab"] as const) {
        const customerName = `QA ${mode} ${runId}`;
        let existing: Target | undefined;
        if (mode === "existing-tab") {
          const command = tabCommand(origin, `${mode}-target`, customerName);
          const opened = await rpc(page.request, origin, "open_customer_tab", command);
          expect(opened.status).toBe(200);
          existing = { type: "customer_tab", id: String((command.payload.tab as { id: string }).id), customerName };
        }
        const source = await prepareSource(mode, customerName);
        const consumed = mode === "new-tab"
          ? await rpc(page.request, origin, "open_customer_tab", tabCommand(origin, `${mode}-consumer`, customerName, [source.id]))
          : await rpc(page.request, origin, "link_customer_tab_continuation", linkCommand(origin, existing!, source.id, mode));
        expect(consumed.status).toBe(200);
        const consumer: Target = existing ?? { type: "customer_tab", id: String((consumed.body as { entity_id: string }).entity_id), customerName };
        expect(await activeConsumers(page, origin, source.id)).toEqual([{ type: "customer_tab", id: consumer.id }]);
        const rejected = rejectCommand(consumer, mode);
        expect((await rpc(page.request, origin, rejected.rpc, rejected.payload)).status).toBe(200);
        expect(await activeConsumers(page, origin, source.id)).toEqual([]);
        await billRecoverableSource(page, source.id);
        evidence.push({ mode, sourceId: source.id, consumerId: consumer.id, releasedAndBilled: true });
      }

      {
        const suffix = "triple-consumer";
        const customerName = `QA Triple Consumer ${runId}`;
        const existingCommand = tabCommand(origin, `${suffix}-existing`, customerName);
        expect((await rpc(page.request, origin, "open_customer_tab", existingCommand)).status).toBe(200);
        const existing: Target = { type: "customer_tab", id: String((existingCommand.payload.tab as { id: string }).id), customerName };
        const source = await prepareSource(suffix, customerName);
        const session = sessionCommand(origin, station, `${suffix}-session`, customerName, [source.id]);
        const newTab = tabCommand(second, `${suffix}-new-tab`, customerName, [source.id]);
        const linked = linkCommand(origin, existing, source.id, suffix);
        const results = await Promise.all([
          rpc(page.request, origin, "start_session", session),
          rpc(observer.page.request, second, "open_customer_tab", newTab),
          rpc(page.request, origin, "link_customer_tab_continuation", linked)
        ]);
        expect(results.filter((entry) => entry.status === 200)).toHaveLength(1);
        results.filter((entry) => entry.status !== 200).forEach((entry) => expect(rpcRejectionCode(entry.body)).toBe("hopped_session_unavailable"));
        const consumers = await activeConsumers(page, origin, source.id);
        expect(consumers).toHaveLength(1);
        const winner: Target = { ...consumers[0], customerName };
        const rejected = rejectCommand(winner, `${suffix}-winner`);
        expect((await rpc(page.request, origin, rejected.rpc, rejected.payload)).status).toBe(200);
        await billRecoverableSource(page, source.id);
        evidence.push({ mode: suffix, sourceId: source.id, statuses: results.map((entry) => entry.status), winner });
      }

      {
        const suffix = "reject-vs-consumer";
        const customerName = `QA Reject Consumer ${runId}`;
        const source = await prepareSource(suffix, customerName);
        const oldTabCommand = tabCommand(origin, `${suffix}-old`, customerName, [source.id]);
        expect((await rpc(page.request, origin, "open_customer_tab", oldTabCommand)).status).toBe(200);
        const oldTab: Target = { type: "customer_tab", id: String((oldTabCommand.payload.tab as { id: string }).id), customerName };
        const rejection = rejectCommand(oldTab, suffix);
        const nextTabCommand = tabCommand(second, `${suffix}-next`, customerName, [source.id]);
        const [rejected, next] = await Promise.all([
          rpc(page.request, origin, rejection.rpc, rejection.payload),
          rpc(observer.page.request, second, "open_customer_tab", nextTabCommand)
        ]);
        expect(rejected.status).toBe(200);
        expect([200, 400]).toContain(next.status);
        const consumers = await activeConsumers(page, origin, source.id);
        expect(consumers.length).toBeLessThanOrEqual(1);
        if (consumers[0]) {
          const cleanup = rejectCommand({ ...consumers[0], customerName }, `${suffix}-next`);
          expect((await rpc(page.request, origin, cleanup.rpc, cleanup.payload)).status).toBe(200);
        }
        await billRecoverableSource(page, source.id);
        evidence.push({ mode: suffix, sourceId: source.id, rejectStatus: rejected.status, nextStatus: next.status, consumerCount: consumers.length });
      }

      await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), observer.page.reload({ waitUntil: "domcontentloaded" })]);
      await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
      expect(await readPendingOperationalMutations(page)).toEqual([]);
      expect(await readPendingOperationalMutations(observer.page)).toEqual([]);
      await attachJson(testInfo, "operational-v2-continuation-matrix", { runId, evidence });
    } finally {
      await attachFailureScreenshot(testInfo, page, "continuation-matrix-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "continuation-matrix-observer-failure");
      await observer.context.close();
    }
  });
});
