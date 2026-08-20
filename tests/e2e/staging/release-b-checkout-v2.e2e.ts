import { expect, test, type Dialog, type Request } from "@playwright/test";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  browserDateTimeLocal,
  capturePageErrors,
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
const station = process.env.E2E_V2_STATION?.trim() || "8 Ball Pool";

test.describe.serial("Release B financial v2 staging", () => {
  test("checkout commits once, replays canonically, propagates, and survives refresh", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA V2 Checkout ${runId}`;
    let sessionStarted = false;
    let checkoutCommitted = false;
    let v2Request: Request | undefined;
    let replayEvidence: Record<string, unknown> | undefined;
    let cleanupError: string | undefined;
    let primaryError: unknown;
    let visibleRemoteErrors: string[] = [];
    const dialogMessages: string[] = [];
    const captureDialog = async (dialog: Dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    };

    page.on("dialog", captureDialog);

    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/rest/v1/rpc/commit_checkout_bill_v2")) {
        v2Request = request;
      }
    });

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      // The dashboard can render its initial normalized snapshot just before the
      // Realtime channel join acknowledgement arrives. Give both independent
      // contexts a bounded subscription-settle window before the first write.
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      const currentStationText = await stationCard(page, station).innerText();
      if (currentStationText.includes(customerName)) {
        sessionStarted = true;
      } else {
        expect(currentStationText, "The selected v2 station is occupied by a non-QA session.").toContain("Available");
        await startSession(page, station, customerName);
        sessionStarted = true;
      }
      await expect(stationCard(observer.page, station)).toContainText(customerName);

      const sessionDialog = await openManagedSession(page, station);
      await sessionDialog.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await sessionDialog.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await sessionDialog.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();

      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(checkout).toBeHidden();
      await waitForSynced(page);

      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300).length).toBe(1);
      const committed = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)!;
      expect(committed.billId).toBeTruthy();
      expect(committed.billNumber).toBeTruthy();
      expect(committed.mutationId).toBeTruthy();
      expect(committed.eventId).toBeTruthy();
      expect(changedRowIds(committed, "sessions")).toHaveLength(1);
      checkoutCommitted = true;

      await expect(stationCard(observer.page, station)).toContainText("Available");
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await expect(stationCard(observer.page, station)).toContainText("Available");

      if (!v2Request) throw new Error("The committed checkout request was not captured.");
      const originalBody = v2Request.postDataJSON() as { payload?: Record<string, unknown> };
      const requestHeaders = v2Request.headers();
      const replay = await page.request.post(v2Request.url(), {
        headers: {
          apikey: requestHeaders.apikey,
          authorization: requestHeaders.authorization,
          "content-type": "application/json",
          prefer: requestHeaders.prefer || "return=representation"
        },
        data: originalBody
      });
      expect(replay.ok()).toBe(true);
      const replayBody = await replay.json() as Record<string, unknown>;
      expect(replayBody.mutation_id).toBe(committed.mutationId);
      expect(replayBody.bill_id).toBe(committed.billId);
      expect(replayBody.event_id).toBe(committed.eventId);

      const envelope = originalBody.payload ?? {};
      const status = await page.request.post(v2Request.url().replace("commit_checkout_bill_v2", "get_financial_mutation_result"), {
        headers: {
          apikey: requestHeaders.apikey,
          authorization: requestHeaders.authorization,
          "content-type": "application/json",
          prefer: "return=representation"
        },
        data: {
          payload: {
            organization_id: envelope.organization_id,
            mutation_id: envelope.mutation_id,
            mutation_kind: envelope.mutation_kind
          }
        }
      });
      expect(status.ok()).toBe(true);
      const statusBody = await status.json() as Record<string, unknown>;
      expect(statusBody.mutation_id).toBe(committed.mutationId);
      expect(statusBody.bill_id).toBe(committed.billId);
      replayEvidence = {
        mutationId: committed.mutationId,
        billId: committed.billId,
        billNumber: committed.billNumber,
        eventId: committed.eventId,
        serverTime: committed.serverTime,
        exactReplayMatched: true,
        statusLookupMatched: true
      };
      assertNoPageErrors(originErrors, observerErrors);
    } catch (error) {
      primaryError = error;
      visibleRemoteErrors = await page.locator(".remote-error-banner").allTextContents().catch(() => []);
      throw error;
    } finally {
      page.off("dialog", captureDialog);
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
          await rejectSessionIfOpen(page, station, customerName, `Playwright Release B cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown Release B cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-checkout-v2-evidence", {
        runId,
        customerName,
        station,
        checkoutCommitted,
        cleanupError,
        v2RequestCaptured: Boolean(v2Request),
        visibleRemoteErrors,
        originErrors,
        observerErrors,
        dialogMessages,
        replayEvidence,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "release-b-checkout-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "release-b-checkout-observer-failure");
      await observer.context.close();
      if (!primaryError && !checkoutCommitted && cleanupError) throw new Error(cleanupError);
    }
  });
});
