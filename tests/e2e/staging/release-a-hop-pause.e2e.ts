import { expect, test } from "@playwright/test";
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
const pauseStation = process.env.E2E_PAUSE_STATION?.trim() || "8 Ball Pool";
const hopStation = process.env.E2E_HOP_STATION?.trim() || "Playstation";

test.describe.serial("Release A staging two-browser operational maintenance", () => {
  test("pause edit propagates to an independent browser and survives refresh", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA PW Pause ${runId}`;
    let sessionStarted = false;
    let cleanupRejected = false;
    let cleanupError: string | undefined;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await startSession(page, pauseStation, customerName);
      sessionStarted = true;
      await expect(stationCard(observer.page, pauseStation)).toContainText(customerName);

      let modal = await openManagedSession(page, pauseStation);
      await modal.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      const earlierStart = await browserDateTimeLocal(page, -10);
      await modal.getByLabel("Session Start Time", { exact: true }).fill(earlierStart);
      await modal.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);

      await modal.getByRole("button", { name: /Pause Session/ }).click();
      await expect(stationCard(observer.page, pauseStation)).toContainText("Paused");
      await modal.getByRole("button", { name: /Resume Session/ }).click();
      await expect(stationCard(observer.page, pauseStation)).toContainText("Running");

      const editedPausedAt = await browserDateTimeLocal(page, -2);
      const editedResumedAt = await browserDateTimeLocal(page, -1);
      await modal.getByRole("button", { name: "Edit", exact: true }).click();
      await modal.getByLabel("Paused At", { exact: true }).fill(editedPausedAt);
      await modal.getByLabel("Resumed At", { exact: true }).fill(editedResumedAt);
      await modal.getByRole("button", { name: "Save", exact: true }).click();
      await waitForSynced(page);

      const observerModal = await openManagedSession(observer.page, pauseStation);
      await expect(observerModal.getByRole("heading", { name: "Pause History", exact: true })).toBeVisible();
      const expectedPausedLabel = await observer.page.evaluate((value) => new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(value)), editedPausedAt);
      await expect(observerModal.getByText(expectedPausedLabel, { exact: true })).toBeVisible();
      await observerModal.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(observerModal.getByLabel("Paused At", { exact: true })).toHaveValue(editedPausedAt);
      await expect(observerModal.getByLabel("Resumed At", { exact: true })).toHaveValue(editedResumedAt);
      await observerModal.getByRole("button", { name: "Cancel", exact: true }).click();
      await observerModal.getByRole("button", { name: "Close", exact: true }).click();

      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await expect(stationCard(observer.page, pauseStation)).toContainText(customerName);
      const refreshedModal = await openManagedSession(observer.page, pauseStation);
      await refreshedModal.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(refreshedModal.getByLabel("Paused At", { exact: true })).toHaveValue(editedPausedAt);
      await expect(refreshedModal.getByLabel("Resumed At", { exact: true })).toHaveValue(editedResumedAt);
      await refreshedModal.getByRole("button", { name: "Cancel", exact: true }).click();
      await refreshedModal.getByRole("button", { name: "Close", exact: true }).click();

      expect(rpcEvidence.some((entry) => entry.rpc === "edit_pause_log" && entry.status < 300)).toBe(true);
      assertNoPageErrors(originErrors, observerErrors);
    } finally {
      sessionStarted = sessionStarted || rpcEvidence.some((entry) => entry.rpc === "start_session" && entry.status < 300);
      if (sessionStarted) {
        try {
          await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click().catch(() => undefined);
          cleanupRejected = await rejectSessionIfOpen(page, pauseStation, customerName, `Playwright Release A pause cleanup ${runId}`);
          await expect(stationCard(observer.page, pauseStation)).toContainText("Available");
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown pause cleanup failure";
        }
      }
      await attachJson(testInfo, "release-a-pause-edit-evidence", {
        runId,
        customerName,
        station: pauseStation,
        cleanupRejected,
        cleanupError,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "observer-failure");
      await observer.context.close();
      if (cleanupError || (sessionStarted && !cleanupRejected)) {
        throw new Error(`Pause test cleanup was not confirmed. ${cleanupError ?? "Session remained open."}`);
      }
    }
  });

  test("hop and detach propagate, then the newest hopped session is billed for cleanup", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA PW Hop ${runId}`;
    let sessionStarted = false;
    let hopConfirmed = false;
    let cleanupBillingAttempted = false;
    let cleanupBilled = false;
    let cleanupRejected = false;
    let hopSessionId: string | undefined;
    let cleanupBillId: string | undefined;
    let cleanupError: string | undefined;

    async function billNewestHoppedSession() {
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click().catch(() => undefined);
      await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
      await expect(continuation).toContainText(customerName);
      await continuation.getByRole("button", { name: "Bill & Done", exact: true }).click();
      const checkout = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
      await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
      cleanupBillingAttempted = true;
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(checkout).toBeHidden();
      await waitForSynced(page);

      await expect.poll(() => {
        const checkout = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill" && entry.status < 300);
        return Boolean(checkout?.billId && hopSessionId && changedRowIds(checkout, "sessions").includes(hopSessionId));
      }).toBe(true);
      const checkoutEvidence = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill" && entry.status < 300);
      cleanupBillId = checkoutEvidence!.billId;
      cleanupBilled = true;
    }

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await startSession(page, hopStation, customerName);
      sessionStarted = true;
      await expect(stationCard(observer.page, hopStation)).toContainText(customerName);

      let modal = await openManagedSession(page, hopStation);
      await modal.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await modal.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await modal.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await modal.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();

      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByLabel(/Game hop - close station without billing/).check();
      await checkout.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();
      const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
      await expect(continuation).toBeVisible();
      hopConfirmed = true;
      await expect(stationCard(observer.page, hopStation)).toContainText("Available");
      await expect(observer.page.getByText(new RegExp(`Game hop: closed ${hopStation}`)).first()).toBeVisible();

      await continuation.getByRole("button", { name: "Change Customer", exact: true }).click();
      await expect(continuation).toBeHidden();
      await waitForSynced(page);
      await expect(page.getByText(new RegExp(`Detached post-hop continuation.*${hopStation}`)).first()).toBeVisible();
      await expect(observer.page.getByText(new RegExp(`Detached post-hop continuation.*${hopStation}`)).first()).toBeVisible();

      await expect.poll(() => rpcEvidence.findLast((entry) => entry.rpc === "hop_session" && entry.status < 300)?.entityId).toBeTruthy();
      const hopEvidence = rpcEvidence.findLast((entry) => entry.rpc === "hop_session" && entry.status < 300);
      hopSessionId = hopEvidence!.entityId;
      expect(rpcEvidence.some((entry) => entry.rpc === "record_session_audit" && entry.status < 300)).toBe(true);
      await billNewestHoppedSession();
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await expect(stationCard(observer.page, hopStation)).toContainText("Available");
      assertNoPageErrors(originErrors, observerErrors);
    } finally {
      sessionStarted = sessionStarted || rpcEvidence.some((entry) => entry.rpc === "start_session" && entry.status < 300);
      hopSessionId ??= rpcEvidence.findLast((entry) => entry.rpc === "hop_session" && entry.status < 300)?.entityId;
      const committedCheckout = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill" && entry.status < 300);
      if (hopSessionId && committedCheckout?.billId && changedRowIds(committedCheckout, "sessions").includes(hopSessionId)) {
        cleanupBillId = committedCheckout.billId;
        cleanupBilled = true;
      }
      try {
        if (hopConfirmed && !cleanupBilled && !cleanupBillingAttempted) {
          await billNewestHoppedSession();
        } else if (hopConfirmed && cleanupBillingAttempted && !cleanupBilled) {
          cleanupError = "The cleanup bill attempt had an ambiguous outcome; no automatic retry was issued.";
        } else if (sessionStarted && !hopConfirmed) {
          await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click().catch(() => undefined);
          cleanupRejected = await rejectSessionIfOpen(page, hopStation, customerName, `Playwright Release A hop cleanup ${runId}`);
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : "Unknown hop cleanup failure";
      }
      await attachJson(testInfo, "release-a-hop-detach-evidence", {
        runId,
        customerName,
        station: hopStation,
        hopConfirmed,
        cleanupBillingAttempted,
        cleanupBilled,
        cleanupRejected,
        hopSessionId,
        cleanupBillId,
        cleanupError,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "observer-failure");
      await observer.context.close();
      if (cleanupError || (sessionStarted && !cleanupBilled && !cleanupRejected)) {
        throw new Error(`Hop test cleanup was not confirmed. ${cleanupError ?? "Session remained unresolved."}`);
      }
    }
  });
});
