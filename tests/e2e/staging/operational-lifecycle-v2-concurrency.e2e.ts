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
  readApiResponseBody,
  readPendingOperationalMutations,
  readRestRows,
  rpcRejectionCode,
  signIn,
  waitForSynced,
  type CapturedRpcRequest,
  type RpcEvidence
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const organizationId = "org-primary";

interface RestIdentity {
  actorId: string;
  restBase: string;
  headers: Record<string, string>;
}

interface StationRow {
  id: string;
  name: string;
  mode: string;
}

interface Target {
  type: "session" | "customer_tab";
  id: string;
  displayName: string;
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

function identityFrom(requests: CapturedRpcRequest[]): RestIdentity {
  const captured = [...requests].reverse().find((entry) => entry.headers.apikey && entry.headers.authorization);
  if (!captured) throw new Error("No authenticated staging REST request was captured.");
  const url = new URL(captured.url);
  const marker = "/rest/v1";
  const markerAt = url.pathname.indexOf(marker);
  if (markerAt < 0) throw new Error("Captured request is not a Supabase REST request.");
  return {
    actorId: authenticatedJwtSubject(captured.headers),
    restBase: `${url.origin}${url.pathname.slice(0, markerAt)}${marker}`,
    headers: {
      apikey: captured.headers.apikey,
      authorization: captured.headers.authorization,
      "content-type": "application/json"
    }
  };
}

async function postRpc(
  request: APIRequestContext,
  identity: RestIdentity,
  rpc: string,
  payload: unknown,
  evidence?: DirectRpcEvidence[],
  client: "origin" | "observer" = "origin"
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const response = await request.post(`${identity.restBase}/rpc/${rpc}`, {
    headers: identity.headers,
    data: { payload }
  });
  const body = await readApiResponseBody(response);
  evidence?.push({
    client,
    rpc,
    mutationId: typeof payload === "object" && payload !== null && "mutation_id" in payload
      ? String((payload as { mutation_id?: unknown }).mutation_id ?? "") || null
      : null,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    status: response.status(),
    request: { payload },
    response: body
  });
  return { response, body };
}

async function appStateSnapshot(page: Page, identity: RestIdentity) {
  const rows = await readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "app_state", {
    id: "eq.primary",
    select: "version,data,updated_at,updated_by"
  });
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function createSession(
  request: APIRequestContext,
  identity: RestIdentity,
  station: StationRow,
  suffix: string,
  ageMinutes = 1,
  evidence?: DirectRpcEvidence[],
  client: "origin" | "observer" = "origin"
): Promise<Target> {
  const id = `${runId}-${suffix}`;
  const displayName = `QA ${suffix}`;
  const startedAt = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  const command = {
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
        startedAt,
        status: "active",
        customerName: displayName,
        customerPhone: "",
        playMode: "group",
        ltpEligible: false,
        pricingSnapshot: [],
        pauseLogIds: [],
        continuedFromSessionIds: [],
        items: [],
        comboApplications: []
      },
      stockMovements: [],
      auditLogs: []
    }
  };
  const created = await postRpc(request, identity, "start_session", command, evidence, client);
  expect(created.response.status(), `start_session ${suffix}`).toBe(200);
  expect(created.body).toMatchObject({ entity_id: id });
  return { type: "session", id, displayName };
}

async function createCustomerTab(
  request: APIRequestContext,
  identity: RestIdentity,
  suffix: string,
  evidence?: DirectRpcEvidence[],
  client: "origin" | "observer" = "origin"
): Promise<Target> {
  const id = `${runId}-${suffix}`;
  const displayName = `QA ${suffix}`;
  const createdAt = new Date().toISOString();
  const command = {
    organization_id: organizationId,
    mutation_id: `${id}-open`,
    mutation_kind: "openCustomerTab",
    user_id: identity.actorId,
    payload: {
      tab: {
        id,
        customerName: displayName,
        customerPhone: "",
        status: "open",
        createdAt,
        items: [],
        comboApplications: [],
        continuedFromSessionIds: []
      },
      auditLog: {
        id: `${id}-open-audit`,
        action: "customer_tab_opened",
        entityType: "customer_tab",
        entityId: id,
        message: `QA open ${suffix}`,
        createdAt,
        userId: identity.actorId
      }
    }
  };
  const created = await postRpc(request, identity, "open_customer_tab", command, evidence, client);
  expect(created.response.status(), `open_customer_tab ${suffix}`).toBe(200);
  expect(created.body).toMatchObject({ entity_id: id });
  return { type: "customer_tab", id, displayName };
}

function percentile(values: number[], percentileValue: number) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * percentileValue) - 1)];
}

async function expectTargetsVisible(page: Page, targets: Target[]) {
  for (const target of targets) {
    await expect(page.getByText(target.displayName, { exact: true }).first()).toBeVisible();
  }
}

async function expectTargetsAbsent(page: Page, targets: Target[]) {
  for (const target of targets) {
    await expect(page.getByText(target.displayName, { exact: true })).toHaveCount(0);
  }
}

function closeCommand(target: Target, suffix: string, operation: "hop" | "reject") {
  const at = new Date().toISOString();
  if (target.type === "session" && operation === "hop") {
    return {
      rpc: "hop_session_v2",
      payload: {
        organization_id: organizationId,
        mutation_id: `${runId}-${suffix}-hop`,
        mutation_kind: "hopSession",
        entity_type: "session",
        entity_id: target.id,
        payload: { effective_ended_at: at, audit_log_id: `${runId}-${suffix}-hop-audit` }
      }
    };
  }
  if (target.type === "session") {
    return {
      rpc: "reject_session_v2",
      payload: {
        organization_id: organizationId,
        mutation_id: `${runId}-${suffix}-reject`,
        mutation_kind: "rejectSession",
        entity_type: "session",
        entity_id: target.id,
        payload: { effective_ended_at: at, reason: `QA ${suffix}`, audit_log_id: `${runId}-${suffix}-reject-audit` }
      }
    };
  }
  return {
    rpc: "reject_customer_tab_v2",
    payload: {
      organization_id: organizationId,
      mutation_id: `${runId}-${suffix}-reject`,
      mutation_kind: "rejectCustomerTab",
      entity_type: "customer_tab",
      entity_id: target.id,
      payload: { effective_closed_at: at, reason: `QA ${suffix}`, audit_log_id: `${runId}-${suffix}-reject-audit` }
    }
  };
}

async function reconcileClosed(page: Page, identity: RestIdentity, target: Target) {
  const table = target.type === "session" ? "sessions" : "customer_tabs";
  const rows = await readRestRows<{ id: string; status: string; close_disposition: string; closed_bill_id?: string | null }>(
    page,
    identity.restBase,
    identity.headers,
    table,
    { organization_id: `eq.${organizationId}`, id: `eq.${target.id}`, select: "id,status,close_disposition,closed_bill_id" }
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: target.id, status: "closed" });
  return rows[0];
}

async function billRecoverableHop(page: Page, targetId: string) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSynced(page);
  const alert = page.getByRole("alert").filter({ hasText: "Game hop needs continuation" });
  await expect(alert).toContainText("Game hop needs continuation");
  await alert.getByRole("button", { name: "Continue", exact: true }).click();
  const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
  await expect(continuation).toBeVisible();
  await continuation.getByRole("button", { name: "Bill & Done", exact: true }).click();
  const bill = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
  await bill.getByRole("button", { name: "Issue Bill", exact: true }).click();
  await expect(bill).toBeHidden();
  await waitForSynced(page);
  return targetId;
}

test.describe.serial("Operational lifecycle v2 real two-client concurrency", () => {
  test("same-target hop/hop, reject/reject, and hop/reject races commit exactly one winner", async ({ browser, page }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const observer = await createObserver(browser);
    const originRequests: CapturedRpcRequest[] = [];
    const observerRequests: CapturedRpcRequest[] = [];
    const rpcEvidence: RpcEvidence[] = [];
    const directRpcEvidence: DirectRpcEvidence[] = [];
    captureAuthenticatedRestRequests(page, originRequests);
    captureAuthenticatedRestRequests(observer.page, observerRequests);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const pageErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    const results: Array<Record<string, unknown>> = [];

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      const origin = identityFrom(originRequests);
      const second = identityFrom(observerRequests);
      const stations = await readRestRows<StationRow>(page, origin.restBase, origin.headers, "stations", {
        organization_id: `eq.${organizationId}`,
        active: "eq.true",
        mode: "eq.timed",
        select: "id,name,mode",
        order: "id.asc"
      });
      expect(stations.length, "Same-target race requires one active timed staging station.").toBeGreaterThanOrEqual(1);
      const appStateBefore = await appStateSnapshot(page, origin);

      for (const [index, operations] of ([
        ["hop", "hop"],
        ["reject", "reject"],
        ["hop", "reject"]
      ] as const).entries()) {
        const target = await createSession(page.request, origin, stations[0], `same-${index + 1}`, 20, directRpcEvidence, "origin");
        const first = closeCommand(target, `same-${index + 1}-a`, operations[0]);
        const secondCommand = closeCommand(target, `same-${index + 1}-b`, operations[1]);
        const [firstResult, secondResult] = await Promise.all([
          postRpc(page.request, origin, first.rpc, first.payload, directRpcEvidence, "origin"),
          postRpc(observer.page.request, second, secondCommand.rpc, secondCommand.payload, directRpcEvidence, "observer")
        ]);
        const statuses = [firstResult.response.status(), secondResult.response.status()].sort((a, b) => a - b);
        expect(statuses).toEqual([200, 400]);
        const loser = firstResult.response.status() === 400 ? firstResult.body : secondResult.body;
        expect(rpcRejectionCode(loser)).toBe("session_not_open");
        const winnerOperation = firstResult.response.status() === 200 ? operations[0] : operations[1];
        const winnerCommand = firstResult.response.status() === 200 ? first : secondCommand;
        const loserCommand = firstResult.response.status() === 400 ? first : secondCommand;
        const winnerActorId = firstResult.response.status() === 200 ? origin.actorId : second.actorId;

        const events = await readRestRows<{ id: string; created_by: string; metadata: { mutation_id?: string } }>(page, origin.restBase, origin.headers, "operational_events", {
          organization_id: `eq.${organizationId}`,
          "metadata->>mutation_id": `in.(${first.payload.mutation_id},${secondCommand.payload.mutation_id})`,
          select: "id,created_by,metadata"
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ created_by: winnerActorId, metadata: { mutation_id: winnerCommand.payload.mutation_id } });
        const audits = await readRestRows<{ id: string; user_id: string; entity_id: string }>(page, origin.restBase, origin.headers, "audit_logs", {
          organization_id: `eq.${organizationId}`,
          id: `in.(${first.payload.payload.audit_log_id},${secondCommand.payload.payload.audit_log_id})`,
          select: "id,user_id,entity_id"
        });
        expect(audits).toEqual([expect.objectContaining({
          id: winnerCommand.payload.payload.audit_log_id,
          user_id: winnerActorId,
          entity_id: target.id
        })]);
        expect(audits.some((entry) => entry.id === loserCommand.payload.payload.audit_log_id)).toBe(false);
        let terminal = await reconcileClosed(page, origin, target);
        expect(terminal.close_disposition).toBe(winnerOperation === "hop" ? "hopped" : "rejected");
        if (winnerOperation === "hop") {
          await billRecoverableHop(page, target.id);
          terminal = await reconcileClosed(page, origin, target);
          expect(terminal.closed_bill_id).toBeTruthy();
        }
        results.push({
          case: operations.join("/"),
          targetId: target.id,
          statuses,
          winnerOperation,
          winnerMutationId: winnerCommand.payload.mutation_id,
          loserMutationId: loserCommand.payload.mutation_id,
          winnerActorId,
          event: events[0],
          audit: audits[0]
        });
      }

      expect(await appStateSnapshot(page, origin)).toEqual(appStateBefore);
      expect(await readPendingOperationalMutations(page)).toEqual([]);
      expect(await readPendingOperationalMutations(observer.page)).toEqual([]);
      expect(pageErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
    } finally {
      await attachJson(testInfo, "operational-v2-same-target-races", { runId, cases: results, rpcEvidence, directRpcEvidence });
      await attachFailureScreenshot(testInfo, page, "operational-v2-same-target-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "operational-v2-same-target-observer-failure");
      await observer.context.close();
    }
  });

  test("50 reload-versus-unrelated-mutation pairs preserve parity and write availability", async ({ browser, page }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const observer = await createObserver(browser);
    const originRequests: CapturedRpcRequest[] = [];
    const observerRequests: CapturedRpcRequest[] = [];
    const directRpcEvidence: DirectRpcEvidence[] = [];
    captureAuthenticatedRestRequests(page, originRequests);
    captureAuthenticatedRestRequests(observer.page, observerRequests);
    const pageErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    const cases: Array<Record<string, unknown>> = [];

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      const origin = identityFrom(originRequests);
      const second = identityFrom(observerRequests);
      const stations = await readRestRows<StationRow>(page, origin.restBase, origin.headers, "stations", {
        organization_id: `eq.${organizationId}`,
        active: "eq.true",
        mode: "eq.timed",
        select: "id,name,mode",
        order: "id.asc"
      });
      expect(stations.length, "The session/session matrix requires two active timed staging stations.").toBeGreaterThanOrEqual(2);
      const appStateBefore = await appStateSnapshot(page, origin);

      for (let iteration = 1; iteration <= 50; iteration += 1) {
        const label = `pair-${String(iteration).padStart(2, "0")}`;
        const matrixType = iteration <= 4 ? "session/session" : iteration <= 7 ? "session/tab" : "tab/tab";
        const firstTarget = matrixType === "tab/tab"
          ? await createCustomerTab(page.request, origin, `${label}-a-tab`, directRpcEvidence, "origin")
          : await createSession(page.request, origin, stations[0], `${label}-a-session`, 1, directRpcEvidence, "origin");
        const secondTarget = matrixType === "session/session"
          ? await createSession(observer.page.request, second, stations[1], `${label}-b-session`, 1, directRpcEvidence, "observer")
          : await createCustomerTab(observer.page.request, second, `${label}-b-tab`, directRpcEvidence, "observer");
        const first = closeCommand(firstTarget, `${label}-a`, "reject");
        const secondCommand = closeCommand(secondTarget, `${label}-b`, "reject");

        await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), observer.page.reload({ waitUntil: "domcontentloaded" })]);
        await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
        await Promise.all([
          expectTargetsVisible(page, [firstTarget, secondTarget]),
          expectTargetsVisible(observer.page, [firstTarget, secondTarget])
        ]);

        const pairStarted = performance.now();
        const [firstResult, secondResult] = await Promise.all([
          postRpc(page.request, origin, first.rpc, first.payload, directRpcEvidence, "origin"),
          postRpc(observer.page.request, second, secondCommand.rpc, secondCommand.payload, directRpcEvidence, "observer"),
          observer.page.reload({ waitUntil: "domcontentloaded" })
        ]);
        const pairWallMs = Math.round((performance.now() - pairStarted) * 100) / 100;
        expect(firstResult.response.status(), `${label} first mutation`).toBe(200);
        expect(secondResult.response.status(), `${label} second mutation`).toBe(200);
        expect(Number((firstResult.body as { server_duration_ms?: unknown }).server_duration_ms), `${label} first server duration`).toBeLessThan(2_000);
        expect(Number((secondResult.body as { server_duration_ms?: unknown }).server_duration_ms), `${label} second server duration`).toBeLessThan(2_000);
        await waitForSynced(observer.page);
        await Promise.all([reconcileClosed(page, origin, firstTarget), reconcileClosed(observer.page, second, secondTarget)]);
        await Promise.all([
          expectTargetsAbsent(page, [firstTarget, secondTarget]),
          expectTargetsAbsent(observer.page, [firstTarget, secondTarget])
        ]);

        const mutationIds = [String(first.payload.mutation_id), String(secondCommand.payload.mutation_id)];
        const events = await readRestRows<{ id: string; metadata: { mutation_id?: string } }>(page, origin.restBase, origin.headers, "operational_events", {
          organization_id: `eq.${organizationId}`,
          "metadata->>mutation_id": `in.(${mutationIds.join(",")})`,
          select: "id,metadata"
        });
        expect(events).toHaveLength(2);
        const mutationEvidence = directRpcEvidence.filter((entry) => mutationIds.includes(entry.mutationId ?? ""));
        expect(mutationEvidence).toHaveLength(2);
        cases.push({
          iteration,
          matrixType,
          targets: [firstTarget, secondTarget],
          mutationIds,
          pairWallMs,
          clientDurationsMs: mutationEvidence.map((entry) => entry.elapsedMs),
          serverDurationsMs: [
            Number((firstResult.body as { server_duration_ms: number }).server_duration_ms),
            Number((secondResult.body as { server_duration_ms: number }).server_duration_ms)
          ],
          eventIds: events.map((entry) => entry.id)
        });
      }

      const clientDurations = cases.flatMap((entry) => entry.clientDurationsMs as number[]);
      const serverDurations = cases.flatMap((entry) => entry.serverDurationsMs as number[]);
      const pairWalls = cases.map((entry) => Number(entry.pairWallMs));
      const latency = {
        clientP95Ms: percentile(clientDurations, 0.95),
        clientMaxMs: Math.max(...clientDurations),
        serverP95Ms: percentile(serverDurations, 0.95),
        serverMaxMs: Math.max(...serverDurations),
        pairWallP95Ms: percentile(pairWalls, 0.95),
        pairWallMaxMs: Math.max(...pairWalls)
      };
      expect(latency.serverP95Ms, "Unrelated concurrent operations DB p95").toBeLessThan(500);
      expect(latency.serverMaxMs, "Unrelated concurrent operations DB max").toBeLessThan(2_000);
      expect(latency.clientP95Ms, "Unrelated concurrent operations HTTP acknowledgement p95").toBeLessThan(2_000);
      expect(latency.clientMaxMs, "Unrelated concurrent operations HTTP acknowledgement max").toBeLessThan(5_000);
      expect(await appStateSnapshot(page, origin)).toEqual(appStateBefore);
      await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), observer.page.reload({ waitUntil: "domcontentloaded" })]);
      await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
      expect(await readPendingOperationalMutations(page)).toEqual([]);
      expect(await readPendingOperationalMutations(observer.page)).toEqual([]);
      expect(pageErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
    } finally {
      const completeClientDurations = directRpcEvidence
        .filter((entry) => /-(?:a|b)-reject$/.test(entry.mutationId ?? ""))
        .map((entry) => entry.elapsedMs);
      await attachJson(testInfo, "operational-v2-50-unrelated-reload-races", {
        runId,
        samples: cases.length,
        matrix: {
          sessionSession: cases.filter((entry) => entry.matrixType === "session/session").length,
          sessionTab: cases.filter((entry) => entry.matrixType === "session/tab").length,
          tabTab: cases.filter((entry) => entry.matrixType === "tab/tab").length
        },
        latency: cases.length === 50 ? {
          clientP95Ms: percentile(completeClientDurations, 0.95),
          clientMaxMs: Math.max(...completeClientDurations),
          serverP95Ms: percentile(cases.flatMap((entry) => entry.serverDurationsMs as number[]), 0.95),
          serverMaxMs: Math.max(...cases.flatMap((entry) => entry.serverDurationsMs as number[])),
          pairWallP95Ms: percentile(cases.map((entry) => Number(entry.pairWallMs)), 0.95),
          pairWallMaxMs: Math.max(...cases.map((entry) => Number(entry.pairWallMs)))
        } : null,
        cases,
        directRpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "operational-v2-50-pairs-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "operational-v2-50-pairs-observer-failure");
      await observer.context.close();
    }
  });
});
