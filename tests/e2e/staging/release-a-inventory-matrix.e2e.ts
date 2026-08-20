import { expect, test } from "@playwright/test";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  capturePageErrors,
  captureRpcEvidence,
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
  return { stock, stockText };
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

test.describe.serial("Release A staging inventory matrix", () => {
  test("catalog exposes a combo, sale variant, and cigarette pack fixture", async ({ page }, testInfo) => {
    const errors = capturePageErrors(page);

    try {
      await signIn(page, credentials("A"));
      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Inventory Catalog", exact: true })).toBeVisible();
      const catalogRows = await page.locator(".inventory-table-wrap tbody tr").allInnerTexts();

      await page.getByRole("button", { name: "Combos", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Configured Combos", exact: true })).toBeVisible();
      const combos = await page.locator(".combo-list-row").allInnerTexts();

      await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Consumables Catalog", exact: true })).toBeVisible();
      const saleOptions = await page.locator(".catalog-card").allInnerTexts();
      const saleCombos = await page.locator(".combo-sale-card").allInnerTexts();

      expect(catalogRows.some((row) => /Cigarettes/i.test(row) && /packs?\s*\+/i.test(row))).toBe(true);
      expect(saleOptions.some((option) => /· from /i.test(option))).toBe(true);
      expect(saleCombos.length).toBeGreaterThan(0);
      assertNoPageErrors(errors);

      await attachJson(testInfo, "release-a-inventory-fixtures", {
        catalogRows,
        combos,
        saleOptions,
        saleCombos
      });
    } finally {
      await attachFailureScreenshot(testInfo, page, "inventory-fixture-failure");
    }
  });

  test("combo, variant, and cigarette reservations agree in two browsers and after refresh", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = process.env.E2E_INVENTORY_CUSTOMER_NAME?.trim() || `QA PW Inventory ${runId}`;
    let tabOpened = false;
    let cleanupAttempted = false;
    let cleanupConfirmed = false;
    let cleanupError: string | undefined;
    let primaryError: unknown;

    async function rejectExactQaTab() {
      await openQaTab(page, customerName);
      page.once("dialog", (dialog) => dialog.accept(`Playwright Release A inventory cleanup ${runId}`));
      cleanupAttempted = true;
      await page.getByRole("button", { name: "Reject Tab", exact: true }).click();
      await waitForSynced(page);
      await expect(page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveCount(0);
      cleanupConfirmed = rpcEvidence.some((entry) => entry.rpc === "reject_customer_tab" && entry.status < 300);
    }

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);

      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      const baseline = {
        maggie: await readAvailableStock(page, "Maggie", "3 variants"),
        cigarettes: await readAvailableStock(page, "Malboro Compact"),
        thumsuyp: await readAvailableStock(page, "Thumsuyp")
      };

      await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
      const existingTab = page.locator("button.tab-chip").filter({ hasText: customerName });
      if (await existingTab.isVisible()) {
        await openQaTab(page, customerName);
        tabOpened = true;
      } else {
        await page.getByLabel("Customer Name", { exact: true }).fill(customerName);
        const openForm = page.getByRole("button", { name: "Open / Find Tab", exact: true }).locator("xpath=ancestor::form");
        await openForm.evaluate((form: HTMLFormElement) => form.requestSubmit());
        await waitForSynced(page);
        tabOpened = true;
      }
      await expect(page.getByRole("heading", { name: `${customerName}'s Tab`, exact: true })).toBeVisible();

      const cheeseMaggie = page.locator("button.catalog-card").filter({ hasText: "Cheese Maggie" });
      await expect(cheeseMaggie).toBeEnabled();
      await cheeseMaggie.evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.locator(".sale-current-tab-section")).toContainText("Cheese Maggie");
      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "add_customer_tab_item" && entry.status < 300).length).toBe(1);
      await waitForSynced(page);
      const malboroCompact = page.locator("button.catalog-card").filter({ hasText: "Malboro Compact" });
      await expect(malboroCompact).toBeEnabled();
      await malboroCompact.evaluate((button: HTMLButtonElement) => button.click());
      const cigaretteDialog = page.getByRole("dialog", { name: "Add Malboro Compact", exact: true });
      await expect(cigaretteDialog).toBeVisible();
      await cigaretteDialog.getByRole("button", { name: /^Pack of 10/ }).click();
      await expect(page.locator(".sale-current-tab-section")).toContainText("Malboro Compact (Pack of 10)");
      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "add_customer_tab_item" && entry.status < 300).length).toBe(2);
      await waitForSynced(page);
      const potCombo = page.locator(".combo-sale-card").filter({ hasText: "Pot 1" });
      const applyPotCombo = potCombo.getByRole("button", { name: "Apply", exact: true });
      await expect(applyPotCombo).toBeEnabled();
      await applyPotCombo.evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.locator(".sale-current-tab-section")).toContainText("Pot 1");
      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "apply_customer_tab_combo" && entry.status < 300).length).toBe(1);
      await waitForSynced(page);

      const originTab = page.locator(".sale-current-tab-section");
      await expect(originTab).toContainText("Cheese Maggie");
      await expect(originTab).toContainText("Malboro Compact (Pack of 10)");
      await expect(originTab).toContainText("Pot 1");
      await expect(originTab).toContainText("Masala Maggie");
      await expect(originTab).toContainText("Thumsuyp");

      await openQaTab(observer.page, customerName);
      const observerTab = observer.page.locator(".sale-current-tab-section");
      await expect(observerTab).toContainText("Cheese Maggie");
      await expect(observerTab).toContainText("Malboro Compact (Pack of 10)");
      await expect(observerTab).toContainText("Pot 1");

      for (const currentPage of [page, observer.page]) {
        await currentPage.getByRole("button", { name: "Inventory", exact: true }).click();
        await expect.poll(async () => (await readAvailableStock(currentPage, "Maggie", "3 variants")).stock)
          .toBe(baseline.maggie.stock - 2);
        await expect.poll(async () => (await readAvailableStock(currentPage, "Malboro Compact")).stock)
          .toBe(baseline.cigarettes.stock - 10);
        await expect.poll(async () => (await readAvailableStock(currentPage, "Thumsuyp")).stock)
          .toBe(baseline.thumsuyp.stock - 1);
      }

      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await openQaTab(observer.page, customerName);
      await expect(observer.page.locator(".sale-current-tab-section")).toContainText("Malboro Compact (Pack of 10)");
      await observer.page.getByRole("button", { name: "Inventory", exact: true }).click();
      await expect((await readAvailableStock(observer.page, "Maggie", "3 variants")).stock).toBe(baseline.maggie.stock - 2);
      await expect((await readAvailableStock(observer.page, "Malboro Compact")).stock).toBe(baseline.cigarettes.stock - 10);
      await expect((await readAvailableStock(observer.page, "Thumsuyp")).stock).toBe(baseline.thumsuyp.stock - 1);

      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await page.getByRole("button", { name: "Inventory Report", exact: true }).click();
      await expect(page.getByText("Inventory report range is loaded from backend report data.", { exact: true })).toBeVisible();
      const reportRows = await page.locator(".inventory-report-table-wrap").first().locator("tbody tr").allInnerTexts();
      expect(reportRows.some((row) => row.startsWith("Maggie\t") && row.endsWith("\t2"))).toBe(true);
      expect(reportRows.some((row) => row.startsWith("Malboro Compact\t") && row.endsWith("\t10"))).toBe(true);
      expect(reportRows.some((row) => row.startsWith("Thumsuyp\t") && row.endsWith("\t1"))).toBe(true);

      await rejectExactQaTab();
      await expect(observer.page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveCount(0);

      for (const currentPage of [page, observer.page]) {
        await currentPage.reload({ waitUntil: "domcontentloaded" });
        await currentPage.getByRole("button", { name: "Inventory", exact: true }).click();
        await expect((await readAvailableStock(currentPage, "Maggie", "3 variants")).stock).toBe(baseline.maggie.stock);
        await expect((await readAvailableStock(currentPage, "Malboro Compact")).stock).toBe(baseline.cigarettes.stock);
        await expect((await readAvailableStock(currentPage, "Thumsuyp")).stock).toBe(baseline.thumsuyp.stock);
      }

      expect(rpcEvidence.filter((entry) => entry.rpc === "add_customer_tab_item" && entry.status < 300)).toHaveLength(2);
      expect(rpcEvidence.filter((entry) => entry.rpc === "apply_customer_tab_combo" && entry.status < 300)).toHaveLength(1);
      expect(rpcEvidence.filter((entry) => entry.rpc === "reject_customer_tab" && entry.status < 300)).toHaveLength(1);
      assertNoPageErrors(originErrors, observerErrors);

      await attachJson(testInfo, "release-a-inventory-matrix-evidence", {
        runId,
        customerName,
        baseline,
        expectedReservations: { maggie: 2, cigarettes: 10, thumsuyp: 1 },
        reportRows,
        cleanupAttempted,
        cleanupConfirmed,
        rpcEvidence
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      tabOpened = tabOpened || rpcEvidence.some((entry) => entry.rpc === "open_customer_tab" && entry.status < 300);
      if (tabOpened && !cleanupAttempted) {
        try {
          await rejectExactQaTab();
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown inventory cleanup failure";
        }
      }
      await attachJson(testInfo, "release-a-inventory-cleanup", {
        runId,
        customerName,
        cleanupAttempted,
        cleanupConfirmed,
        cleanupError,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "inventory-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "inventory-observer-failure");
      await observer.context.close();
      if (!primaryError && (cleanupError || (tabOpened && !cleanupConfirmed))) {
        throw new Error(`Inventory test cleanup was not confirmed. ${cleanupError ?? "Customer tab remained open."}`);
      }
    }
  });
});
