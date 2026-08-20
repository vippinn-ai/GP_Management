import { expect, test } from "@playwright/test";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
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
const station = process.env.E2E_V2_REFUND_STATION?.trim() || "Arcade 3";

async function openBillRegisterRow(page: Parameters<typeof capturePageErrors>[0], searchValue: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(searchValue);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: searchValue });
  await expect(row).toBeVisible();
  return row;
}

test.describe.serial("Release B refund v2", () => {
  test("refund restores stock and propagates canonical bill state", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA V2 Refund ${runId}`;
    let sessionStarted = false;
    let checkoutCommitted = false;
    let refundCommitted = false;
    let billNumber: string | undefined;
    let cleanupError: string | undefined;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      expect(await stationCard(page, station).innerText(), "The selected refund station is occupied.").toContain("Available");
      await startSession(page, station, customerName);
      sessionStarted = true;
      const sessionDialog = await openManagedSession(page, station);
      await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(checkout).toBeHidden();
      await waitForSynced(page);
      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300).length).toBe(1);
      const checkoutResult = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)!;
      billNumber = checkoutResult.billNumber;
      expect(billNumber).toBeTruthy();
      expect(checkoutResult.changedRows?.stock_movements).toHaveLength(1);
      checkoutCommitted = true;

      const observerRow = await openBillRegisterRow(observer.page, billNumber!);
      await expect(observerRow).toContainText("Issued");
      const originRow = await openBillRegisterRow(page, billNumber!);
      await originRow.getByRole("button", { name: "Void", exact: true }).click();
      const refundDialog = page.getByRole("dialog", { name: `Void or Refund - ${billNumber}`, exact: true });
      await refundDialog.getByLabel("Void or refund action", { exact: true }).selectOption("refund");
      await refundDialog.getByPlaceholder("Reason for refunding this bill").fill(`Playwright Release B refund ${runId}`);
      await refundDialog.getByRole("button", { name: "Confirm Refund", exact: true }).click();
      await expect(refundDialog).toBeHidden();
      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_financial_adjustment_v2" && entry.status < 300).length).toBe(1);
      const refundResult = rpcEvidence.findLast((entry) => entry.rpc === "commit_financial_adjustment_v2" && entry.status < 300)!;
      expect(refundResult.changedRows?.bills).toEqual([checkoutResult.billId]);
      // Existing refund behavior reverses revenue through bill lifecycle
      // status; it does not fabricate a second/negative payment row.
      expect(refundResult.changedRows?.payments).toEqual([]);
      expect(refundResult.changedRows?.stock_movements).toHaveLength(1);
      expect(refundResult.changedRows?.audit_logs).toHaveLength(1);
      refundCommitted = true;

      await expect(observerRow).toContainText("Refunded");
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      const refreshedObserverRow = await openBillRegisterRow(observer.page, billNumber!);
      await expect(refreshedObserverRow).toContainText("Refunded");
      await observer.page.getByRole("button", { name: "Live Dashboard", exact: true }).click();
      await expect(stationCard(observer.page, station)).toContainText("Available");
      assertNoPageErrors(originErrors, observerErrors);

      await attachJson(testInfo, "release-b-refund-v2-evidence", {
        runId,
        station,
        customerName,
        billNumber,
        checkoutResult,
        refundResult,
        rpcEvidence
      });
    } finally {
      if (sessionStarted && !checkoutCommitted) {
        try {
          await rejectSessionIfOpen(page, station, customerName, `Playwright Release B refund cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown refund cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-refund-v2-cleanup", {
        runId,
        station,
        customerName,
        billNumber,
        checkoutCommitted,
        refundCommitted,
        cleanupError
      });
      await attachFailureScreenshot(testInfo, page, "refund-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "refund-observer-failure");
      await observer.context.close();
    }
  });
});
