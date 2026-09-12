import { expect, test, type Page, type Route } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  browserDateTimeLocal,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  captureRpcEvidence,
  credentials,
  createObserver,
  openManagedSession,
  readApiResponseBody,
  readPendingOperationalMutations,
  readRestRows,
  signIn,
  startSession,
  stationCard,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_HOP_STATION?.trim() || "Playstation";
const organizationId = "org-primary";

function restIdentity(captured: CapturedRpcRequest) {
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

async function billCurrentRecoverableHop(page: Page) {
  const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
  await expect(continuation).toBeVisible();
  await continuation.getByRole("button", { name: "Bill & Done", exact: true }).click();
  const bill = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
  await bill.getByRole("button", { name: "Issue Bill", exact: true }).click();
  await expect(bill).toBeHidden();
  await waitForSynced(page);
}

test.describe.serial("Operational v2 lost-response and realtime convergence", () => {
  test("a committed-but-lost hop response is manually replayed with the same ID and no automatic resend", async ({ browser, page }, testInfo) => {
    test.setTimeout(4 * 60_000);
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    const customerName = `QA Lost Hop ${runId}`;
    const pattern = "**/rest/v1/rpc/hop_session_v2";
    let captureCount = 0;
    let capturedRequest: CapturedRpcRequest | undefined;
    let firstServerBody: Record<string, unknown> | undefined;
    let firstServerResolved!: () => void;
    const firstServerCommitted = new Promise<void>((resolve) => { firstServerResolved = resolve; });
    let billId: string | undefined;
    let primaryError: unknown;
    let waiterStartedAt: number;
    let waiterFailureElapsedMs: number;
    const dialogs: string[] = [];

    const handler = async (route: Route) => {
      captureCount += 1;
      if (captureCount !== 1) {
        await route.continue();
        return;
      }
      const request = route.request();
      capturedRequest = { url: request.url(), headers: request.headers(), body: request.postDataJSON() };
      const serverResponse = await route.fetch({ timeout: 30_000 });
      firstServerBody = await readApiResponseBody(serverResponse);
      firstServerResolved();
      await new Promise((resolve) => setTimeout(resolve, 21_000));
      await route.abort("timedout").catch(() => undefined);
    };

    try {
      await page.addInitScript(() => {
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
          nativeSetTimeout(handler, timeout === 15_000 ? 60_000 : timeout, ...args)) as typeof window.setTimeout;
      });
      page.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await startSession(page, station, customerName);
      await expect(stationCard(observer.page, station)).toContainText(customerName);
      const managed = await openManagedSession(page, station);
      await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const close = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await close.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await close.getByLabel(/Game hop - close station without billing/).check();
      await page.route(pattern, handler);
      waiterStartedAt = Date.now();
      await close.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();

      await firstServerCommitted;
      expect(captureCount, "No automatic resend may occur before manual recovery.").toBe(1);
      await expect(stationCard(observer.page, station)).toContainText("Available");
      await expect(close.getByRole("button", { name: "Retry Game Hop", exact: true })).toBeVisible({ timeout: 30_000 });
      waiterFailureElapsedMs = Date.now() - waiterStartedAt;
      expect(waiterFailureElapsedMs, "The live critical acknowledgement waiter must expire at its configured 20-second boundary.").toBeGreaterThanOrEqual(20_000);
      await expect.poll(() => dialogs.some((message) => message.includes("server did not confirm this action in time"))).toBe(true);
      const pending = await readPendingOperationalMutations(page) as Array<{ id?: string; status?: string }>;
      const envelope = capturedRequest!.body as { payload: { mutation_id: string; payload: { audit_log_id: string } } };
      expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: envelope.payload.mutation_id, status: "failed" })]));
      expect(firstServerBody).toMatchObject({ mutation_id: envelope.payload.mutation_id, idempotent: false });
      expect(captureCount).toBe(1);

      const replayResponse = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/hop_session_v2") && response.request().method() === "POST" && response.status() === 200
      );
      await close.getByRole("button", { name: "Retry Game Hop", exact: true }).click();
      const replayBody = await (await replayResponse).json() as Record<string, unknown>;
      expect(replayBody).toMatchObject({
        mutation_id: envelope.payload.mutation_id,
        event_id: firstServerBody!.event_id,
        idempotent: true
      });
      expect(captureCount, "Exactly one manual same-ID replay is allowed.").toBe(2);
      expect(await readPendingOperationalMutations(page)).toEqual([]);

      const identity = restIdentity(capturedRequest!);
      const [events, audits] = await Promise.all([
        readRestRows<{ id: string; created_by: string }>(page, identity.restBase, identity.headers, "operational_events", {
          organization_id: `eq.${organizationId}`,
          "metadata->>mutation_id": `eq.${envelope.payload.mutation_id}`,
          select: "id,created_by"
        }),
        readRestRows<{ id: string; user_id: string }>(page, identity.restBase, identity.headers, "audit_logs", {
          organization_id: `eq.${organizationId}`,
          id: `eq.${envelope.payload.payload.audit_log_id}`,
          select: "id,user_id"
        })
      ]);
      expect(events).toEqual([{ id: firstServerBody!.event_id, created_by: identity.actorId }]);
      expect(audits).toEqual([{ id: envelope.payload.payload.audit_log_id, user_id: identity.actorId }]);
      await billCurrentRecoverableHop(page);
      billId = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)?.billId;
      expect(billId).toBeTruthy();
      expect(originErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      await attachJson(testInfo, "operational-v2-lost-response", {
        runId,
        mutationId: envelope.payload.mutation_id,
        captureCount,
        firstServerBody,
        replayBody,
        observerSawRealtimeBeforeOriginResponse: true,
        pendingBeforeReplay: pending,
        waiterFailureElapsedMs,
        dialogs,
        events,
        audits,
        billId,
        rpcEvidence
      });
    } catch (error) {
      primaryError = error;
    } finally {
      await page.unroute(pattern, handler).catch(() => undefined);
      await attachFailureScreenshot(testInfo, page, "lost-response-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "lost-response-observer-failure");
      await observer.context.close();
    }
    if (primaryError) throw primaryError;
    if (capturedRequest && !billId) throw new Error("Lost-response hop was not terminally billed; reconcile before another run.");
  });

  test("response-first, offline gap, duplicate delivery, and panel unmount converge after reconnect", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const requests: CapturedRpcRequest[] = [];
    captureAuthenticatedRestRequests(page, requests);
    const rpcEvidence: RpcEvidence[] = [];
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    const unresolvedSessionIds = new Set<string>();
    const customerName = `QA Reconnect Reject ${runId}`;
    const duplicateCustomerName = `QA Duplicate Event ${runId}`;
    let capturedReject: CapturedRpcRequest | undefined;
    let primaryError: unknown;
    try {
      await observer.page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        const control = { armed: false, duplicates: 0 };
        Object.defineProperty(window, "__bpRealtimeDuplicateControl", { value: control, configurable: true });
        class DuplicatingWebSocket extends NativeWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener("message", (event) => {
              if (!control.armed || typeof event.data !== "string" || !event.data.includes("postgres_changes")) return;
              control.armed = false;
              control.duplicates += 1;
              queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
                data: event.data,
                origin: event.origin,
                lastEventId: event.lastEventId
              })));
            });
          }
        }
        Object.defineProperty(window, "WebSocket", { value: DuplicatingWebSocket, configurable: true });
      });
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await startSession(page, station, customerName);
      const firstSessionId = rpcEvidence.findLast((entry) => entry.rpc === "start_session" && entry.status < 300)?.entityId;
      expect(firstSessionId).toBeTruthy();
      unresolvedSessionIds.add(firstSessionId!);
      await expect(stationCard(observer.page, station)).toContainText(customerName);
      await observer.context.setOffline(true);

      const managed = await openManagedSession(page, station);
      page.once("dialog", (dialog) => dialog.accept(`QA reconnect rejection ${runId}`));
      const requestPromise = page.waitForRequest((request) => request.url().includes("/rpc/reject_session_v2"));
      const responsePromise = page.waitForResponse((response) => response.url().includes("/rpc/reject_session_v2"));
      await managed.getByRole("button", { name: "Reject Session", exact: true }).click();
      const request = await requestPromise;
      capturedReject = { url: request.url(), headers: request.headers(), body: request.postDataJSON() };
      expect((await responsePromise).status()).toBe(200);
      unresolvedSessionIds.delete(firstSessionId!);
      const responseCompletedAt = new Date().toISOString();
      await expect(stationCard(page, station)).toContainText("Available");

      await page.getByRole("button", { name: "Bill Register", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Bill Register", exact: true })).toBeVisible();
      const reconnectStartedAt = new Date().toISOString();
      expect(Date.parse(reconnectStartedAt)).toBeGreaterThanOrEqual(Date.parse(responseCompletedAt));
      await observer.context.setOffline(false);
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(observer.page);
      await expect(stationCard(observer.page, station)).toContainText("Available");

      const identity = restIdentity(capturedReject);
      const envelope = capturedReject.body as { payload: { mutation_id: string; payload: { audit_log_id: string } } };
      const replay = await page.request.post(capturedReject.url, {
        headers: identity.headers,
        data: capturedReject.body
      });
      expect(replay.status()).toBe(200);
      expect(await readApiResponseBody(replay)).toMatchObject({ mutation_id: envelope.payload.mutation_id, idempotent: true });
      const events = await readRestRows<{ id: string }>(page, identity.restBase, identity.headers, "operational_events", {
        organization_id: `eq.${organizationId}`,
        "metadata->>mutation_id": `eq.${envelope.payload.mutation_id}`,
        select: "id"
      });
      expect(events).toHaveLength(1);

      await page.getByRole("button", { name: "Live Dashboard", exact: true }).click();
      await startSession(page, station, duplicateCustomerName);
      const duplicateSessionId = rpcEvidence.findLast((entry) => entry.rpc === "start_session" && entry.status < 300)?.entityId;
      expect(duplicateSessionId).toBeTruthy();
      unresolvedSessionIds.add(duplicateSessionId!);
      await expect(stationCard(observer.page, station)).toContainText(duplicateCustomerName);
      await observer.page.getByRole("button", { name: "Bill Register", exact: true }).click();
      await expect(observer.page.getByRole("heading", { name: "Bill Register", exact: true })).toBeVisible();
      await observer.page.evaluate(() => {
        const control = (window as unknown as { __bpRealtimeDuplicateControl?: { armed: boolean } }).__bpRealtimeDuplicateControl;
        if (!control) throw new Error("Realtime duplicate control was not installed.");
        control.armed = true;
      });
      const duplicateManaged = await openManagedSession(page, station);
      page.once("dialog", (dialog) => dialog.accept(`QA duplicate-event rejection ${runId}`));
      const duplicateRequestPromise = page.waitForRequest((request) => request.url().includes("/rpc/reject_session_v2"));
      const duplicateResponsePromise = page.waitForResponse((response) => response.url().includes("/rpc/reject_session_v2"));
      await duplicateManaged.getByRole("button", { name: "Reject Session", exact: true }).click();
      const duplicateRequest = await duplicateRequestPromise;
      expect((await duplicateResponsePromise).status()).toBe(200);
      unresolvedSessionIds.delete(duplicateSessionId!);
      const duplicateEnvelope = duplicateRequest.postDataJSON() as { payload: { mutation_id: string } };
      await expect.poll(() => observer.page.evaluate(() =>
        (window as unknown as { __bpRealtimeDuplicateControl?: { duplicates: number } }).__bpRealtimeDuplicateControl?.duplicates ?? 0
      )).toBe(1);
      await observer.page.getByRole("button", { name: "Live Dashboard", exact: true }).click();
      await expect(stationCard(observer.page, station)).toContainText("Available");
      await expect(observer.page.getByText(duplicateCustomerName, { exact: true })).toHaveCount(0);
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(observer.page);
      await expect(stationCard(observer.page, station)).toContainText("Available");
      const duplicateEvents = await readRestRows<{ id: string }>(page, identity.restBase, identity.headers, "operational_events", {
        organization_id: `eq.${organizationId}`,
        "metadata->>mutation_id": `eq.${duplicateEnvelope.payload.mutation_id}`,
        select: "id"
      });
      expect(duplicateEvents).toHaveLength(1);
      expect([...unresolvedSessionIds]).toEqual([]);
      expect(originErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      await attachJson(testInfo, "operational-v2-realtime-gap-reconnect", {
        runId,
        mutationId: envelope.payload.mutation_id,
        responseCompletedAt,
        reconnectStartedAt,
        responseBeforeRealtime: true,
        observerOfflineGapRecovered: true,
        duplicateSameIdWasIdempotent: true,
        duplicateRealtimeFrameDelivered: true,
        duplicateRealtimeMutationId: duplicateEnvelope.payload.mutation_id,
        duplicateRealtimeEventCount: duplicateEvents.length,
        observerPanelUnmountedDuringDuplicate: true,
        eventCount: events.length,
        rpcEvidence,
        originErrors,
        observerErrors
      });
    } catch (error) {
      primaryError = error;
    } finally {
      await observer.context.setOffline(false).catch(() => undefined);
      await attachJson(testInfo, "operational-v2-realtime-cleanup-ledger", {
        runId,
        unresolvedSessionIds: [...unresolvedSessionIds],
        failed: Boolean(primaryError)
      });
      await attachFailureScreenshot(testInfo, page, "realtime-gap-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "realtime-gap-observer-failure");
      await observer.context.close();
    }
    if (primaryError) throw primaryError;
    if (unresolvedSessionIds.size) throw new Error("Realtime recovery left exact unresolved staging sessions; reconcile before another run.");
  });
});
