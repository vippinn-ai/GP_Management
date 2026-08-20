import { expect, test } from "@playwright/test";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  capturePageErrors,
  captureRpcEvidence,
  changedRowIds,
  createObserver,
  credentials,
  signIn,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";

function catalogRow(page: Parameters<typeof capturePageErrors>[0], itemName: string, extraText?: string) {
  let row = page.locator(".inventory-table-wrap tbody tr").filter({ hasText: itemName });
  if (extraText) row = row.filter({ hasText: extraText });
  return row.first();
}

async function readAvailableStock(page: Parameters<typeof capturePageErrors>[0], itemName: string, extraText?: string) {
  const row = catalogRow(page, itemName, extraText);
  await expect(row).toBeVisible();
  const stockText = await row.locator("td").nth(4).innerText();
  const stock = Number(stockText.match(/^-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(stock)) throw new Error(`Unable to parse ${itemName} stock from: ${stockText}`);
  return stock;
}

async function openQaTab(page: Parameters<typeof capturePageErrors>[0], customerName: string) {
  await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
  const selectedHeading = page.getByRole("heading", { name: `${customerName}'s Tab`, exact: true });
  if (await selectedHeading.isVisible()) return;
  const tabChip = page.locator("button.tab-chip").filter({ hasText: customerName });
  await expect(tabChip).toBeVisible();
  await tabChip.click({ force: true });
  await expect(selectedHeading).toBeVisible();
}

test.describe.serial("Release B inventory customer-tab checkout", () => {
  test("variant, cigarette pack, and combo commit through v2 with canonical stock", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA V2 Inventory ${runId}`;
    let tabOpened = false;
    let checkoutCommitted = false;
    let cleanupError: string | undefined;
    let baseline: Record<string, number> | undefined;

    async function rejectExactQaTab() {
      await openQaTab(page, customerName);
      page.once("dialog", (dialog) => dialog.accept(`Playwright Release B inventory cleanup ${runId}`));
      await page.getByRole("button", { name: "Reject Tab", exact: true }).click();
      await waitForSynced(page);
      await expect(page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveCount(0);
    }

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);

      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      baseline = {
        maggie: await readAvailableStock(page, "Maggie", "3 variants"),
        cigarettes: await readAvailableStock(page, "Malboro Compact"),
        thumsuyp: await readAvailableStock(page, "Thumsuyp")
      };

      await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
      await page.getByLabel("Customer Name", { exact: true }).fill(customerName);
      const openForm = page.getByRole("button", { name: "Open / Find Tab", exact: true }).locator("xpath=ancestor::form");
      await openForm.evaluate((form: HTMLFormElement) => form.requestSubmit());
      await waitForSynced(page);
      tabOpened = true;
      await openQaTab(page, customerName);

      const cheeseMaggie = page.locator("button.catalog-card").filter({ hasText: "Cheese Maggie" });
      await expect(cheeseMaggie).toBeEnabled();
      await cheeseMaggie.evaluate((button: HTMLButtonElement) => button.click());
      await waitForSynced(page);

      const cigarettes = page.locator("button.catalog-card").filter({ hasText: "Malboro Compact" });
      await expect(cigarettes).toBeEnabled();
      await cigarettes.evaluate((button: HTMLButtonElement) => button.click());
      const cigaretteDialog = page.getByRole("dialog", { name: "Add Malboro Compact", exact: true });
      await expect(cigaretteDialog).toBeVisible();
      await cigaretteDialog.getByRole("button", { name: /^Pack of 10/ }).click();
      await waitForSynced(page);

      const potCombo = page.locator(".combo-sale-card").filter({ hasText: "Pot 1" });
      await potCombo.getByRole("button", { name: "Apply", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      await waitForSynced(page);
      await expect(page.locator(".sale-current-tab-section")).toContainText("Cheese Maggie");
      await expect(page.locator(".sale-current-tab-section")).toContainText("Malboro Compact (Pack of 10)");
      await expect(page.locator(".sale-current-tab-section")).toContainText("Pot 1");

      await openQaTab(observer.page, customerName);
      await expect(observer.page.locator(".sale-current-tab-section")).toContainText("Malboro Compact (Pack of 10)");

      await page.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const checkout = page.getByRole("dialog", { name: "Finalize Customer Tab Bill", exact: true });
      await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(checkout).toBeHidden();
      await waitForSynced(page);

      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300).length).toBe(1);
      const committed = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)!;
      checkoutCommitted = true;
      expect(changedRowIds(committed, "customer_tabs")).toHaveLength(1);
      expect(changedRowIds(committed, "inventory_items")).toHaveLength(3);
      // Maggie appears once as a sale variant and once inside the combo, so the
      // three inventory rows intentionally produce four traceable movements.
      expect(changedRowIds(committed, "stock_movements")).toHaveLength(4);

      await expect(observer.page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveCount(0);
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await expect(observer.page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveCount(0);

      for (const currentPage of [page, observer.page]) {
        await currentPage.getByRole("button", { name: "Inventory", exact: true }).click();
        await expect.poll(() => readAvailableStock(currentPage, "Maggie", "3 variants")).toBe(baseline.maggie - 2);
        await expect.poll(() => readAvailableStock(currentPage, "Malboro Compact")).toBe(baseline.cigarettes - 10);
        await expect.poll(() => readAvailableStock(currentPage, "Thumsuyp")).toBe(baseline.thumsuyp - 1);
      }

      assertNoPageErrors(originErrors, observerErrors);
      await attachJson(testInfo, "release-b-inventory-tab-v2-evidence", {
        runId,
        customerName,
        baseline,
        expectedStockDeltas: { maggie: -2, cigarettes: -10, thumsuyp: -1 },
        committed,
        rpcEvidence
      });
    } finally {
      if (tabOpened && !checkoutCommitted) {
        try {
          await rejectExactQaTab();
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown inventory-tab cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-inventory-tab-v2-cleanup", {
        runId,
        customerName,
        checkoutCommitted,
        cleanupError,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "inventory-tab-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "inventory-tab-observer-failure");
      await observer.context.close();
      if (!checkoutCommitted && cleanupError) throw new Error(cleanupError);
    }
  });
});
