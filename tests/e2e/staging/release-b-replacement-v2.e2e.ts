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
const station = process.env.E2E_V2_REPLACEMENT_STATION?.trim() || "Arcade 2";

async function openBillRegisterRow(page: Parameters<typeof capturePageErrors>[0], billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  return row;
}

test.describe.serial("Release B replacement v2", () => {
  test("unchanged replacement links both bills without changing stock", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA V2 Replace ${runId}`;
    let sessionStarted = false;
    let checkoutCommitted = false;
    let replacementCommitted = false;
    let originalBillNumber: string | undefined;
    let replacementBillNumber: string | undefined;
    let cleanupError: string | undefined;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      expect(await stationCard(page, station).innerText(), "The selected replacement station is occupied.").toContain("Available");
      await startSession(page, station, customerName);
      sessionStarted = true;
      const sessionDialog = await openManagedSession(page, station);
      await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(checkout).toBeHidden();
      await waitForSynced(page);
      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300).length).toBe(1);
      const originalResult = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)!;
      originalBillNumber = originalResult.billNumber;
      expect(originalBillNumber).toBeTruthy();
      checkoutCommitted = true;

      const observerOriginalRow = await openBillRegisterRow(observer.page, originalBillNumber!);
      await expect(observerOriginalRow).toContainText("Issued");
      const originOriginalRow = await openBillRegisterRow(page, originalBillNumber!);
      await originOriginalRow.getByRole("button", { name: "Replace", exact: true }).click();
      const replacement = page.getByRole("dialog", { name: "Replace Issued Bill", exact: true });
      await replacement.getByPlaceholder("Explain what was wrong in the original bill").fill(
        `Playwright unchanged replacement ${runId}`
      );
      await replacement.getByRole("button", { name: "Issue Replacement Bill", exact: true }).click();
      await expect(replacement).toBeHidden();
      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300).length).toBe(2);
      const replacementResult = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)!;
      replacementBillNumber = replacementResult.billNumber;
      expect(replacementBillNumber).toBeTruthy();
      expect(replacementBillNumber).not.toBe(originalBillNumber);
      expect(replacementResult.changedRows?.bills).toHaveLength(2);
      expect(replacementResult.changedRows?.stock_movements).toEqual([]);
      replacementCommitted = true;

      await expect(observerOriginalRow).toContainText("Replaced");
      const observerReplacementRow = await openBillRegisterRow(observer.page, replacementBillNumber!);
      await expect(observerReplacementRow).toContainText("Issued");
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      const refreshedOriginalRow = await openBillRegisterRow(observer.page, originalBillNumber!);
      await expect(refreshedOriginalRow).toContainText("Replaced");
      const refreshedReplacementRow = await openBillRegisterRow(observer.page, replacementBillNumber!);
      await expect(refreshedReplacementRow).toContainText("Issued");
      assertNoPageErrors(originErrors, observerErrors);

      await attachJson(testInfo, "release-b-replacement-v2-evidence", {
        runId,
        station,
        customerName,
        originalBillNumber,
        replacementBillNumber,
        originalResult,
        replacementResult,
        rpcEvidence
      });
    } finally {
      if (sessionStarted && !checkoutCommitted) {
        try {
          await rejectSessionIfOpen(page, station, customerName, `Playwright Release B replacement cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown replacement cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-replacement-v2-cleanup", {
        runId,
        station,
        customerName,
        originalBillNumber,
        replacementBillNumber,
        checkoutCommitted,
        replacementCommitted,
        cleanupError
      });
      await attachFailureScreenshot(testInfo, page, "replacement-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "replacement-observer-failure");
      await observer.context.close();
    }
  });
});
