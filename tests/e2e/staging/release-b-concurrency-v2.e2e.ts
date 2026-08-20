import { expect, test, type APIResponse } from "@playwright/test";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  browserDateTimeLocal,
  capturePageErrors,
  captureRpcEvidence,
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
const station = process.env.E2E_V2_CONCURRENCY_STATION?.trim() || "8 Ball Pool";

async function responseBody(response: APIResponse) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

test.describe.serial("Release B financial v2 concurrency", () => {
  test("two simultaneous copies of one mutation return one canonical bill", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA V2 Concurrent ${runId}`;
    let sessionStarted = false;
    let checkoutCommitted = false;
    let primaryError: unknown;
    let cleanupError: string | undefined;
    let concurrentEvidence: Record<string, unknown> | undefined;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      const currentStationText = await stationCard(page, station).innerText();
      if (currentStationText.includes(customerName)) {
        sessionStarted = true;
      } else {
        expect(currentStationText, "The selected concurrency station is occupied by a non-QA session.").toContain("Available");
        await startSession(page, station, customerName);
        sessionStarted = true;
      }
      if (process.env.E2E_V2_CONCURRENCY_CLEANUP_ONLY === "true") {
        await rejectSessionIfOpen(page, station, customerName, `Playwright Release B concurrency cleanup ${runId}`);
        sessionStarted = false;
        return;
      }
      await expect(stationCard(observer.page, station)).toContainText(customerName);

      const sessionDialog = await openManagedSession(page, station);
      await sessionDialog.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await sessionDialog.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await sessionDialog.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();

      type CapturedRequest = { url: string; headers: Record<string, string>; body: unknown };
      let resolveCaptured!: (value: CapturedRequest) => void;
      const capturedRequest = new Promise<CapturedRequest>((resolve) => { resolveCaptured = resolve; });
      await page.route("**/rest/v1/rpc/commit_checkout_bill_v2", async (route) => {
        const request = route.request();
        resolveCaptured({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
        // The UI attempt is intentionally prevented from reaching PostgREST.
        // The captured command is then sent through two independent API
        // contexts at the same instant, isolating database concurrency.
        await route.abort("aborted");
      });
      page.on("dialog", (dialog) => void dialog.dismiss());

      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      const captured = await capturedRequest;
      const requestHeaders = {
        apikey: captured.headers.apikey,
        authorization: captured.headers.authorization,
        "content-type": "application/json",
        prefer: captured.headers.prefer || "return=representation"
      };
      const invalidEnvelope = structuredClone(captured.body) as {
        payload: {
          organization_id: string;
          mutation_id: string;
          mutation_kind: string;
          payload: {
            primary_bill: { id: string; total: number };
            bill_updates: Array<{ id: string; total: number }>;
          };
        };
      };
      invalidEnvelope.payload.mutation_id = `financial-invalid-${runId}`;
      invalidEnvelope.payload.payload.primary_bill.total += 1;
      const invalidPrimaryUpdate = invalidEnvelope.payload.payload.bill_updates.find(
        (bill) => bill.id === invalidEnvelope.payload.payload.primary_bill.id
      );
      if (!invalidPrimaryUpdate) throw new Error("The captured checkout omitted its primary bill update.");
      invalidPrimaryUpdate.total += 1;
      const invalidResponse = await page.request.post(captured.url, {
        headers: requestHeaders,
        data: invalidEnvelope,
        timeout: 30_000
      });
      const invalidBody = await responseBody(invalidResponse);
      expect(invalidResponse.status()).toBeGreaterThanOrEqual(400);

      const [firstResponse, secondResponse] = await Promise.all([
        page.request.post(captured.url, { headers: requestHeaders, data: captured.body, timeout: 30_000 }),
        observer.context.request.post(captured.url, { headers: requestHeaders, data: captured.body, timeout: 30_000 })
      ]);
      const [firstBody, secondBody] = await Promise.all([responseBody(firstResponse), responseBody(secondResponse)]);
      concurrentEvidence = {
        firstStatus: firstResponse.status(),
        secondStatus: secondResponse.status(),
        invalidStatus: invalidResponse.status(),
        invalidBody,
        invalidMutationId: invalidEnvelope.payload.mutation_id,
        firstBody,
        secondBody
      };
      expect(firstResponse.status()).toBe(200);
      expect(secondResponse.status()).toBe(200);
      expect(firstBody.mutation_id).toBeTruthy();
      expect(secondBody.mutation_id).toBe(firstBody.mutation_id);
      expect(secondBody.bill_id).toBe(firstBody.bill_id);
      expect(secondBody.event_id).toBe(firstBody.event_id);

      const invalidStatusResponse = await page.request.post(
        captured.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
        {
          headers: requestHeaders,
          data: {
            payload: {
              organization_id: invalidEnvelope.payload.organization_id,
              mutation_id: invalidEnvelope.payload.mutation_id,
              mutation_kind: invalidEnvelope.payload.mutation_kind
            }
          }
        }
      );
      expect(invalidStatusResponse.status()).toBe(200);
      expect(await invalidStatusResponse.json()).toBeNull();
      concurrentEvidence.invalidMutationRolledBack = true;
      checkoutCommitted = true;

      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(stationCard(observer.page, station)).toContainText("Available");
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await expect(stationCard(observer.page, station)).toContainText("Available");
      expect(originErrors.consoleErrors).toEqual([]);
      expect(originErrors.pageErrors.length).toBeLessThanOrEqual(1);
      expect(originErrors.pageErrors.every((message) => message === "TypeError: Failed to fetch")).toBe(true);
      assertNoPageErrors(observerErrors);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (sessionStarted && !checkoutCommitted) {
        try {
          for (let index = 0; index < 3 && await page.getByRole("dialog").count(); index += 1) {
            const dialog = page.getByRole("dialog").last();
            const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
            const close = dialog.getByRole("button", { name: "Close", exact: true });
            if (await cancel.isVisible()) await cancel.click();
            else if (await close.isVisible()) await close.click();
            else break;
          }
          await rejectSessionIfOpen(page, station, customerName, `Playwright Release B concurrency cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown concurrency cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-concurrent-idempotency-evidence", {
        runId,
        customerName,
        station,
        checkoutCommitted,
        cleanupError,
        concurrentEvidence,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "concurrency-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "concurrency-observer-failure");
      await observer.context.close();
      if (!primaryError && !checkoutCommitted && cleanupError) throw new Error(cleanupError);
    }
  });

  test("two different mutations cannot bill the same session twice", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const customerName = `QA V2 Double ${runId}`;
    const mutationIds = [`financial-race-a-${runId}`, `financial-race-b-${runId}`];
    let sessionStarted = false;
    let checkoutCommitted = false;
    let cleanupError: string | undefined;
    let raceEvidence: Record<string, unknown> | undefined;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      expect(await stationCard(page, station).innerText(), "The selected double-checkout station is occupied.").toContain("Available");
      await startSession(page, station, customerName);
      sessionStarted = true;

      const sessionDialog = await openManagedSession(page, station);
      await sessionDialog.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await sessionDialog.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await sessionDialog.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();

      type CapturedRequest = { url: string; headers: Record<string, string>; body: unknown };
      let resolveCaptured!: (value: CapturedRequest) => void;
      const capturedRequest = new Promise<CapturedRequest>((resolve) => { resolveCaptured = resolve; });
      await page.route("**/rest/v1/rpc/commit_checkout_bill_v2", async (route) => {
        const request = route.request();
        resolveCaptured({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
        await route.abort("aborted");
      });
      page.on("dialog", (dialog) => void dialog.dismiss());

      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      const captured = await capturedRequest;
      const requestHeaders = {
        apikey: captured.headers.apikey,
        authorization: captured.headers.authorization,
        "content-type": "application/json",
        prefer: captured.headers.prefer || "return=representation"
      };
      const envelopes = mutationIds.map((mutationId) => {
        const envelope = structuredClone(captured.body) as { payload: { mutation_id: string } };
        envelope.payload.mutation_id = mutationId;
        return envelope;
      });
      const responses = await Promise.all([
        page.request.post(captured.url, { headers: requestHeaders, data: envelopes[0], timeout: 30_000 }),
        observer.context.request.post(captured.url, { headers: requestHeaders, data: envelopes[1], timeout: 30_000 })
      ]);
      const bodies = await Promise.all(responses.map(responseBody));
      const successes = responses.map((response, index) => ({ response, body: bodies[index], mutationId: mutationIds[index], envelope: envelopes[index] }))
        .filter(({ response }) => response.status() === 200);
      const failures = responses.map((response, index) => ({ response, body: bodies[index], mutationId: mutationIds[index] }))
        .filter(({ response }) => response.status() >= 400);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(successes[0].body.bill_id).toBeTruthy();
      expect(successes[0].body.event_id).toBeTruthy();

      const replay = await page.request.post(captured.url, {
        headers: requestHeaders,
        data: successes[0].envelope,
        timeout: 30_000
      });
      const replayBody = await responseBody(replay);
      expect(replay.status()).toBe(200);
      expect(replayBody.bill_id).toBe(successes[0].body.bill_id);
      expect(replayBody.event_id).toBe(successes[0].body.event_id);

      const loserStatus = await page.request.post(
        captured.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
        {
          headers: requestHeaders,
          data: {
            payload: {
              organization_id: (envelopes[0] as { payload: { organization_id: string } }).payload.organization_id,
              mutation_id: failures[0].mutationId,
              mutation_kind: "checkout"
            }
          }
        }
      );
      expect(loserStatus.status()).toBe(200);
      expect(await loserStatus.json()).toBeNull();
      checkoutCommitted = true;
      raceEvidence = {
        statuses: responses.map((response) => response.status()),
        bodies,
        winnerMutationId: successes[0].mutationId,
        loserMutationId: failures[0].mutationId,
        replayBody,
        loserMutationRolledBack: true
      };

      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await expect(stationCard(observer.page, station)).toContainText("Available");
    } finally {
      if (sessionStarted && !checkoutCommitted) {
        try {
          for (let index = 0; index < 3 && await page.getByRole("dialog").count(); index += 1) {
            const dialog = page.getByRole("dialog").last();
            const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
            const close = dialog.getByRole("button", { name: "Close", exact: true });
            if (await cancel.isVisible()) await cancel.click();
            else if (await close.isVisible()) await close.click();
            else break;
          }
          await rejectSessionIfOpen(page, station, customerName, `Playwright Release B double-checkout cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown double-checkout cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-double-checkout-v2-evidence", {
        runId,
        customerName,
        station,
        checkoutCommitted,
        cleanupError,
        raceEvidence
      });
      await attachFailureScreenshot(testInfo, page, "double-checkout-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "double-checkout-observer-failure");
      await observer.context.close();
    }
  });
});
