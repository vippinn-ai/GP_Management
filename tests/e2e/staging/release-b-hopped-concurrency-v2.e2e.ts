import { expect, test, type APIResponse } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  browserDateTimeLocal,
  captureRpcEvidence,
  changedRowIds,
  createObserver,
  credentials,
  openManagedSession,
  rejectSessionIfOpen,
  signIn,
  startSession,
  stationCard,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_HOP_STATION?.trim() || "Playstation";

async function responseBody(response: APIResponse) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

test.describe.serial("Release B hopped-session checkout concurrency", () => {
  test("one hopped session can enter only one bill", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA V2 Hopped Race ${runId}`;
    const mutationIds = [`financial-hop-a-${runId}`, `financial-hop-b-${runId}`] as const;
    let sessionStarted = false;
    let hopConfirmed = false;
    let checkoutAttempted = false;
    let checkoutCommitted = false;
    let hoppedSessionId: string | undefined;
    let raceEvidence: Record<string, unknown> | undefined;
    let cleanupError: string | undefined;
    let primaryError: unknown;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      expect(await stationCard(page, station).innerText(), "The hop-race station is occupied.").toContain("Available");
      await startSession(page, station, customerName);
      sessionStarted = true;

      const session = await openManagedSession(page, station);
      await session.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await session.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await session.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await session.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const close = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await close.getByLabel(/Game hop - close station without billing/).check();
      await close.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();
      const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
      await expect(continuation).toContainText(customerName);
      hopConfirmed = true;
      await expect.poll(() => rpcEvidence.findLast((entry) => entry.rpc === "hop_session" && entry.status < 300)?.entityId).toBeTruthy();
      hoppedSessionId = rpcEvidence.findLast((entry) => entry.rpc === "hop_session" && entry.status < 300)!.entityId;
      await continuation.getByRole("button", { name: "Bill & Done", exact: true }).click();

      type CapturedRequest = { url: string; headers: Record<string, string>; body: unknown };
      let resolveCaptured!: (value: CapturedRequest) => void;
      const capturedRequest = new Promise<CapturedRequest>((resolve) => { resolveCaptured = resolve; });
      await page.route("**/rest/v1/rpc/commit_checkout_bill_v2", async (route) => {
        const request = route.request();
        resolveCaptured({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
        await route.abort("aborted");
      });
      page.on("dialog", (dialog) => void dialog.dismiss());
      const checkout = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
      await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
      checkoutAttempted = true;
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      const captured = await capturedRequest;
      const headers = {
        apikey: captured.headers.apikey,
        authorization: captured.headers.authorization,
        "content-type": "application/json",
        prefer: captured.headers.prefer || "return=representation"
      };
      const envelopes = mutationIds.map((mutationId) => {
        const envelope = structuredClone(captured.body) as {
          payload: { mutation_id: string; organization_id: string; payload: { source_session_ids: string[] } };
        };
        envelope.payload.mutation_id = mutationId;
        return envelope;
      });
      expect(envelopes[0].payload.payload.source_session_ids).toContain(hoppedSessionId);
      expect(envelopes[1].payload.payload.source_session_ids).toContain(hoppedSessionId);

      const responses = await Promise.all([
        page.request.post(captured.url, { headers, data: envelopes[0], timeout: 30_000 }),
        observer.context.request.post(captured.url, { headers, data: envelopes[1], timeout: 30_000 })
      ]);
      const bodies = await Promise.all(responses.map(responseBody));
      const winnerIndexes = responses.map((response, index) => response.status() === 200 ? index : -1).filter((index) => index >= 0);
      const loserIndexes = responses.map((response, index) => response.status() >= 400 ? index : -1).filter((index) => index >= 0);
      expect(winnerIndexes).toHaveLength(1);
      expect(loserIndexes).toHaveLength(1);
      const winnerIndex = winnerIndexes[0];
      const loserIndex = loserIndexes[0];
      const loserDetails = JSON.parse(String(bodies[loserIndex].details)) as { code?: string };
      expect(loserDetails.code).toBe("session_not_billable");
      expect(changedRowIds({ changedRows: bodies[winnerIndex].changed_rows } as RpcEvidence, "sessions")).toContain(hoppedSessionId);

      const loserStatus = await page.request.post(
        captured.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
        {
          headers,
          data: {
            payload: {
              organization_id: envelopes[loserIndex].payload.organization_id,
              mutation_id: mutationIds[loserIndex],
              mutation_kind: "checkout"
            }
          }
        }
      );
      expect(loserStatus.status()).toBe(200);
      expect(await loserStatus.json()).toBeNull();

      const replay = await page.request.post(captured.url, {
        headers,
        data: envelopes[winnerIndex],
        timeout: 30_000
      });
      const replayBody = await responseBody(replay);
      expect(replay.status()).toBe(200);
      expect(replayBody.bill_id).toBe(bodies[winnerIndex].bill_id);
      expect(replayBody.event_id).toBe(bodies[winnerIndex].event_id);
      checkoutCommitted = true;
      raceEvidence = {
        hoppedSessionId,
        statuses: responses.map((response) => response.status()),
        bodies,
        winnerMutationId: mutationIds[winnerIndex],
        loserMutationId: mutationIds[loserIndex],
        loserMutationRolledBack: true,
        replayBody
      };

      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await expect(stationCard(observer.page, station)).toContainText("Available");
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (sessionStarted && !hopConfirmed) {
        try {
          await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click().catch(() => undefined);
          await rejectSessionIfOpen(page, station, customerName, `Release B hopped-race cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown pre-hop cleanup failure";
        }
      } else if (hopConfirmed && !checkoutCommitted) {
        cleanupError = checkoutAttempted
          ? "The hopped checkout had an ambiguous outcome; no automatic retry was issued."
          : "The detached hopped session still requires a cleanup bill.";
      }
      await attachJson(testInfo, "release-b-hopped-concurrency-v2-evidence", {
        runId,
        station,
        customerName,
        sessionStarted,
        hopConfirmed,
        checkoutAttempted,
        checkoutCommitted,
        hoppedSessionId,
        cleanupError,
        raceEvidence,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "hopped-race-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "hopped-race-observer-failure");
      await observer.context.close();
      if (!primaryError && cleanupError) throw new Error(cleanupError);
    }
  });
});
