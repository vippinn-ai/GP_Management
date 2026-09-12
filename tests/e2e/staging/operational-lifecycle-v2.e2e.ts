import { expect, test, type APIResponse } from "@playwright/test";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  browserDateTimeLocal,
  capturePageErrors,
  captureRpcEvidence,
  createObserver,
  credentials,
  interceptSingleRpcCommand,
  openManagedSession,
  readApiResponseBody,
  readRestRows,
  rpcRejectionCode,
  signIn,
  startSession,
  stationCard,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const hopStation = process.env.E2E_HOP_STATION?.trim() || "Playstation";
const rejectStation = process.env.E2E_PAUSE_STATION?.trim() || "8 Ball Pool";

function restIdentity(captured: { url: string; headers: Record<string, string> }) {
  return {
    restBase: captured.url.replace(/\/rpc\/[^/]+$/, ""),
    headers: {
      apikey: captured.headers.apikey,
      authorization: captured.headers.authorization,
      "content-type": "application/json",
      prefer: captured.headers.prefer || "return=representation"
    }
  };
}

async function appStateSnapshot(page: Parameters<typeof readRestRows>[0], restBase: string, headers: Record<string, string>) {
  const rows = await readRestRows<{ version: number; data: unknown; updated_at: string; updated_by: string | null }>(
    page,
    restBase,
    headers,
    "app_state",
    { id: "eq.primary", select: "version,data,updated_at,updated_by" }
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

test.describe.serial("Operational lifecycle v2 staging gate", () => {
  test("hop is canonical, idempotent, actor-safe, realtime-visible, and app_state-invariant", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `normops ${runId} hop`;
    let cleanupBillId: string | undefined;
    let hopCommitted = false;
    let primaryError: unknown;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await startSession(page, hopStation, customerName);
      const modal = await openManagedSession(page, hopStation);
      await modal.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await checkout.getByLabel(/Game hop - close station without billing/).check();
      const command = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/hop_session_v2");
      await checkout.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();
      const captured = await command.captured;
      expect(command.captureCount()).toBe(1);
      const envelope = structuredClone(captured.body) as {
        payload: {
          organization_id: string;
          mutation_id: string;
          entity_id: string;
          payload: { effective_ended_at: string; audit_log_id: string };
        };
      };
      const { restBase, headers } = restIdentity(captured);
      const before = await appStateSnapshot(page, restBase, headers);
      const actorId = authenticatedJwtSubject(captured.headers);
      const startedAt = performance.now();
      const firstResponse = await command.submit(captured.body);
      const acknowledgementMs = performance.now() - startedAt;
      const firstBody = await readApiResponseBody(firstResponse);
      expect(firstResponse.status()).toBe(200);
      expect(firstBody).toMatchObject({
        mutation_id: envelope.payload.mutation_id,
        entity_id: envelope.payload.entity_id,
        idempotent: false
      });
      expect(Number(firstBody.server_duration_ms)).toBeLessThan(2_000);
      expect(acknowledgementMs).toBeLessThan(5_000);
      hopCommitted = true;

      await expect(page.getByRole("dialog", { name: "Continue Customer", exact: true })).toBeVisible();
      await expect(stationCard(observer.page, hopStation)).toContainText("Available");
      const replay = await page.request.post(captured.url, { headers, data: captured.body });
      const replayBody = await readApiResponseBody(replay as APIResponse);
      expect(replay.status()).toBe(200);
      expect(replayBody).toMatchObject({ mutation_id: envelope.payload.mutation_id, event_id: firstBody.event_id, idempotent: true });

      const mismatched = structuredClone(envelope);
      mismatched.payload.payload.effective_ended_at = new Date(Date.parse(mismatched.payload.payload.effective_ended_at) - 60_000).toISOString();
      const mismatchResponse = await page.request.post(captured.url, { headers, data: mismatched });
      const mismatchBody = await readApiResponseBody(mismatchResponse as APIResponse);
      expect(mismatchResponse.status()).toBe(400);
      expect(rpcRejectionCode(mismatchBody)).toBe("mutation_identity_mismatch");

      const events = await readRestRows<{ id: string; created_by: string; metadata: Record<string, unknown> }>(
        page,
        restBase,
        headers,
        "operational_events",
        { "metadata->>mutation_id": `eq.${envelope.payload.mutation_id}`, select: "id,created_by,metadata" }
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: firstBody.event_id, created_by: actorId });
      const after = await appStateSnapshot(page, restBase, headers);
      expect(after).toEqual(before);

      const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
      await continuation.getByRole("button", { name: "Bill & Done", exact: true }).click();
      const billDialog = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
      await billDialog.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(billDialog).toBeHidden();
      await waitForSynced(page);
      cleanupBillId = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)?.billId;
      expect(cleanupBillId).toBeTruthy();
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await expect(stationCard(observer.page, hopStation)).toContainText("Available");
      assertNoPageErrors(originErrors, observerErrors);

      await attachJson(testInfo, "operational-v2-hop-evidence", {
        runId, customerName, mutationId: envelope.payload.mutation_id, sessionId: envelope.payload.entity_id,
        actorId, eventId: firstBody.event_id, serverDurationMs: firstBody.server_duration_ms,
        acknowledgementMs, appStateBefore: before, appStateAfter: after, cleanupBillId, rpcEvidence
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await commandCleanup(page);
      await attachJson(testInfo, "operational-v2-hop-final-state", {
        runId, customerName, hopCommitted, cleanupBillId, failed: Boolean(primaryError), rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "operational-v2-hop-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "operational-v2-hop-observer-failure");
      await observer.context.close();
      if (!primaryError && hopCommitted && !cleanupBillId) throw new Error("Committed hop cleanup bill was not confirmed; no retry was issued.");
    }
  });

  test("paused-session rejection closes the canonical pause and remains stable after refresh", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `normops ${runId} paused reject`;
    let rejected = false;
    let rejectionEvidence: Record<string, unknown> = {};

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await startSession(page, rejectStation, customerName);
      const modal = await openManagedSession(page, rejectStation);
      await modal.getByRole("button", { name: /Pause Session/ }).click();
      await expect(stationCard(observer.page, rejectStation)).toContainText("Paused");
      const command = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/reject_session_v2");
      page.once("dialog", (dialog) => dialog.accept(`normops paused rejection ${runId}`));
      await modal.getByRole("button", { name: "Reject Session", exact: true }).click();
      const captured = await command.captured;
      expect(command.captureCount()).toBe(1);
      const envelope = structuredClone(captured.body) as {
        payload: { mutation_id: string; entity_id: string; payload: { reason: string } };
      };
      const { restBase, headers } = restIdentity(captured);
      const before = await appStateSnapshot(page, restBase, headers);
      const actorId = authenticatedJwtSubject(captured.headers);
      const startedAt = performance.now();
      const response = await command.submit(captured.body);
      const acknowledgementMs = performance.now() - startedAt;
      const body = await readApiResponseBody(response);
      expect(response.status()).toBe(200);
      expect(body).toMatchObject({ mutation_id: envelope.payload.mutation_id, entity_id: envelope.payload.entity_id, idempotent: false });
      expect(Number(body.server_duration_ms)).toBeLessThan(2_000);
      expect(acknowledgementMs).toBeLessThan(5_000);
      await expect(modal).toBeHidden();
      await waitForSynced(page);
      rejected = true;
      await expect(stationCard(observer.page, rejectStation)).toContainText("Available");
      const rejection = rpcEvidence.findLast((entry) => entry.rpc === "reject_session_v2" && entry.status < 300);
      expect(rejection?.mutationId).toBeTruthy();
      expect(rejection?.serverDurationMs).toBeLessThan(2_000);
      const replay = await page.request.post(captured.url, { headers, data: captured.body });
      expect(replay.status()).toBe(200);
      expect(await readApiResponseBody(replay)).toMatchObject({ mutation_id: envelope.payload.mutation_id, event_id: body.event_id, idempotent: true });
      const mismatched = structuredClone(envelope);
      mismatched.payload.payload.reason = `${mismatched.payload.payload.reason} changed`;
      const mismatch = await page.request.post(captured.url, { headers, data: mismatched });
      expect(mismatch.status()).toBe(400);
      expect(rpcRejectionCode(await readApiResponseBody(mismatch))).toBe("mutation_identity_mismatch");
      const events = await readRestRows<{ id: string; created_by: string }>(page, restBase, headers, "operational_events", {
        "metadata->>mutation_id": `eq.${envelope.payload.mutation_id}`,
        select: "id,created_by"
      });
      expect(events).toEqual([{ id: body.event_id, created_by: actorId }]);
      const after = await appStateSnapshot(page, restBase, headers);
      expect(after).toEqual(before);
      rejectionEvidence = {
        mutationId: envelope.payload.mutation_id,
        sessionId: envelope.payload.entity_id,
        actorId,
        eventId: body.event_id,
        serverDurationMs: body.server_duration_ms,
        acknowledgementMs,
        appStateBefore: before,
        appStateAfter: after
      };
      await Promise.all([
        page.reload({ waitUntil: "domcontentloaded" }),
        observer.page.reload({ waitUntil: "domcontentloaded" })
      ]);
      await expect(stationCard(page, rejectStation)).toContainText("Available");
      await expect(stationCard(observer.page, rejectStation)).toContainText("Available");
      assertNoPageErrors(originErrors, observerErrors);
      await attachJson(testInfo, "operational-v2-paused-reject-evidence", { runId, customerName, rejection, ...rejectionEvidence, rpcEvidence });
    } finally {
      await commandCleanup(page);
      await page.unroute("**/rest/v1/rpc/reject_session_v2").catch(() => undefined);
      await attachJson(testInfo, "operational-v2-paused-reject-final-state", {
        runId, customerName, rejected, rejectionEvidence, rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "operational-v2-reject-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "operational-v2-reject-observer-failure");
      await observer.context.close();
      if (!rejected) throw new Error("The paused QA session was not confirmed rejected; reconcile before another run.");
    }
  });
});

async function commandCleanup(page: Parameters<typeof stationCard>[0]) {
  await page.unroute("**/rest/v1/rpc/hop_session_v2").catch(() => undefined);
}
