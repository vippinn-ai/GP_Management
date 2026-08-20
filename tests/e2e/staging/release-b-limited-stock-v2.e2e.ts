import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  capturePageErrors,
  createObserver,
  credentials,
  signIn,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";

type CapturedRequest = { url: string; headers: Record<string, string>; body: unknown };

async function responseBody(response: APIResponse) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function inventoryRow(page: Page, itemName: string) {
  return page.locator(".inventory-table-wrap tbody tr").filter({ hasText: itemName }).first();
}

async function openInventoryCatalog(page: Page) {
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("tablist", { name: "Inventory section", exact: true })
    .getByRole("button", { name: "Catalog", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Active Items", exact: true })).toBeVisible();
}

async function readAvailableStock(page: Page, itemName: string) {
  const row = inventoryRow(page, itemName);
  await expect(row).toBeVisible();
  const text = await row.locator("td").nth(4).innerText();
  const stock = Number(text.match(/^-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(stock)) throw new Error(`Unable to parse ${itemName} stock from: ${text}`);
  return { stock, text };
}

async function openCustomerTab(page: Page, customerName: string) {
  await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
  const tabChip = page.locator("button.tab-chip").filter({ hasText: customerName });
  if (await tabChip.isVisible() && await tabChip.evaluate((element) => element.classList.contains("is-active"))) return;
  if (await tabChip.isVisible()) {
    await tabChip.evaluate((button: HTMLButtonElement) => button.click());
    await expect(tabChip).toHaveClass(/is-active/);
    return;
  }
  await page.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const openForm = page.getByRole("button", { name: "Open / Find Tab", exact: true }).locator("xpath=ancestor::form");
  const opened = page.waitForResponse((response) =>
    response.url().includes("/rest/v1/rpc/open_customer_tab") && response.request().method() === "POST"
  );
  await openForm.evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect((await opened).status()).toBeLessThan(300);
  await waitForSynced(page);
  await expect(page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveClass(/is-active/);
}

async function rejectCustomerTab(page: Page, customerName: string) {
  await openCustomerTab(page, customerName);
  page.once("dialog", (dialog) => dialog.accept(`Playwright Release B limited-stock cleanup ${runId}`));
  await page.getByRole("button", { name: "Reject Tab", exact: true }).click();
  await waitForSynced(page);
  await expect(page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveCount(0);
}

async function captureCheckout(
  page: Page,
  customerName: string,
  onCapture: () => void = () => undefined
): Promise<CapturedRequest> {
  await openCustomerTab(page, customerName);
  await page.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
  let resolveCaptured!: (value: CapturedRequest) => void;
  const capturedRequest = new Promise<CapturedRequest>((resolve) => { resolveCaptured = resolve; });
  await page.route("**/rest/v1/rpc/commit_checkout_bill_v2", async (route) => {
    onCapture();
    const request = route.request();
    resolveCaptured({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
    await route.abort("aborted");
  });
  const checkout = page.getByRole("dialog", { name: "Finalize Customer Tab Bill", exact: true });
  await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
  await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
  return capturedRequest;
}

function makeUniqueBillNumber(captured: CapturedRequest, suffix: "A" | "B") {
  const envelope = structuredClone(captured.body) as {
    payload: {
      payload: {
        primary_bill: { id: string; billNumber: string };
        bill_updates: Array<{ id: string; billNumber: string }>;
      };
    };
  };
  const number = `BILL-QA-STOCK-${runId}-${suffix}`;
  envelope.payload.payload.primary_bill.billNumber = number;
  const primaryUpdate = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primaryUpdate) throw new Error("Captured limited-stock checkout omitted its primary bill update.");
  primaryUpdate.billNumber = number;
  return envelope;
}

test.describe.serial("Release B limited-stock checkout concurrency", () => {
  test("two exact reservations commit concurrently without negative stock", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const pages = [page, observer.page] as const;
    const itemName = `QA Limited Stock ${runId}`;
    const customers = [`QA Stock A ${runId}`, `QA Stock B ${runId}`] as const;
    const tabOpened = [false, false];
    const committed = [false, false];
    const errors = pages.map(capturePageErrors);
    const cleanupErrors: string[] = [];
    let itemCreated = false;
    let itemArchived = false;
    let concurrencyEvidence: Record<string, unknown> | undefined;
    let primaryError: unknown;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all(pages.map((currentPage) => currentPage.waitForTimeout(1_200)));

      await openInventoryCatalog(page);
      if (!await inventoryRow(page, itemName).isVisible()) {
        const createForm = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
        await createForm.getByLabel("Item Name", { exact: true }).fill(itemName);
        await createForm.locator("select").first().selectOption({ label: "Beverages" });
        await createForm.getByLabel("Price", { exact: true }).fill("1");
        await createForm.getByLabel("Opening Stock", { exact: true }).fill("2");
        await createForm.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
        const created = page.waitForResponse((response) =>
          response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
        );
        await createForm.getByRole("button", { name: "Create Item", exact: true }).click();
        expect((await created).status()).toBeLessThan(300);
        await waitForSynced(page);
      }
      itemCreated = true;
      if (process.env.E2E_V2_LIMITED_STOCK_CLEANUP_ONLY === "true") return;

      for (let index = 0; index < pages.length; index += 1) {
        await openCustomerTab(pages[index], customers[index]);
        tabOpened[index] = true;
        const currentTab = pages[index].locator(".sale-current-tab-section");
        if (!await currentTab.getByText(itemName, { exact: false }).isVisible()) {
          const item = pages[index].locator("button.catalog-card").filter({ hasText: itemName }).first();
          await expect(item).toBeEnabled();
          const added = pages[index].waitForResponse((response) =>
            response.url().includes("/rest/v1/rpc/add_customer_tab_item") && response.request().method() === "POST"
          );
          await item.evaluate((button: HTMLButtonElement) => button.click());
          expect((await added).status()).toBeLessThan(300);
          await waitForSynced(pages[index]);
        }
        await expect(currentTab).toContainText(itemName);
      }

      const captures = [
        await captureCheckout(page, customers[0]),
        await captureCheckout(observer.page, customers[1])
      ];
      const envelopes = [makeUniqueBillNumber(captures[0], "A"), makeUniqueBillNumber(captures[1], "B")];
      const requestHeaders = captures.map((capture) => ({
        apikey: capture.headers.apikey,
        authorization: capture.headers.authorization,
        "content-type": "application/json",
        prefer: capture.headers.prefer || "return=representation"
      }));
      const responses = await Promise.all([
        page.request.post(captures[0].url, { headers: requestHeaders[0], data: envelopes[0], timeout: 30_000 }),
        observer.context.request.post(captures[1].url, { headers: requestHeaders[1], data: envelopes[1], timeout: 30_000 })
      ]);
      const bodies = await Promise.all(responses.map(responseBody));
      expect(responses.map((response) => response.status())).toEqual([200, 200]);
      expect(new Set(bodies.map((body) => body.bill_id)).size).toBe(2);
      expect(new Set(bodies.map((body) => body.mutation_id)).size).toBe(2);
      expect(new Set(bodies.map((body) => body.event_id)).size).toBe(2);
      committed[0] = true;
      committed[1] = true;

      const inventoryIds = bodies.map((body) => (body.changed_rows as Record<string, string[]>).inventory_items);
      const movementIds = bodies.map((body) => (body.changed_rows as Record<string, string[]>).stock_movements);
      expect(inventoryIds[0]).toHaveLength(1);
      expect(inventoryIds[1]).toEqual(inventoryIds[0]);
      expect(movementIds[0]).toHaveLength(1);
      expect(movementIds[1]).toHaveLength(1);
      expect(new Set([...movementIds[0], ...movementIds[1]]).size).toBe(2);

      await Promise.all(pages.map((currentPage) => currentPage.unroute("**/rest/v1/rpc/commit_checkout_bill_v2")));
      await Promise.all(pages.map((currentPage) => currentPage.reload({ waitUntil: "domcontentloaded" })));
      for (let index = 0; index < pages.length; index += 1) {
        await expect(pages[index].locator("button.tab-chip").filter({ hasText: customers[index] })).toHaveCount(0);
        await openInventoryCatalog(pages[index]);
        const finalStock = await readAvailableStock(pages[index], itemName);
        expect(finalStock.stock).toBe(0);
        expect(finalStock.text).not.toMatch(/in sessions/);
        expect(errors[index].consoleErrors).toEqual([]);
        expect(errors[index].pageErrors).toEqual(["TypeError: Failed to fetch"]);
      }

      concurrencyEvidence = {
        itemName,
        customers,
        statuses: responses.map((response) => response.status()),
        billIds: bodies.map((body) => body.bill_id),
        mutationIds: bodies.map((body) => body.mutation_id),
        eventIds: bodies.map((body) => body.event_id),
        inventoryItemId: inventoryIds[0][0],
        movementIds: movementIds.flat(),
        finalStock: 0,
        finalReservations: 0
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      for (let index = 0; index < pages.length; index += 1) {
        if (!tabOpened[index] || committed[index]) continue;
        try {
          await pages[index].unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
          await pages[index].reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          await rejectCustomerTab(pages[index], customers[index]);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : `Unknown tab cleanup failure for ${customers[index]}`);
        }
      }
      if (itemCreated && cleanupErrors.length === 0) {
        try {
          await page.reload({ waitUntil: "domcontentloaded" });
          await openInventoryCatalog(page);
          const row = inventoryRow(page, itemName);
          if (await row.isVisible()) {
            await row.getByRole("button", { name: "Archive", exact: true }).click();
            const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
            await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(`Release B limited-stock QA ${runId}`);
            const archived = page.waitForResponse((response) =>
              response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
            );
            await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
            expect((await archived).status()).toBeLessThan(300);
            await waitForSynced(page);
            await expect(row).toHaveCount(0);
          }
          itemArchived = true;
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : "Unknown inventory-item cleanup failure");
        }
      }
      await attachJson(testInfo, "release-b-limited-stock-v2-evidence", {
        runId,
        itemName,
        customers,
        tabOpened,
        committed,
        itemCreated,
        itemArchived,
        cleanupErrors,
        concurrencyEvidence,
        pageErrors: errors
      });
      await attachFailureScreenshot(testInfo, page, "limited-stock-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "limited-stock-observer-failure");
      await observer.context.close();
      if (!primaryError && cleanupErrors.length) throw new Error(cleanupErrors.join(" | "));
    }
  });

  test("over-capacity stale commands both roll back without negative stock", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const admin = await createObserver(browser);
    const pages = [page, observer.page] as const;
    const itemName = `QA Oversubscribed Stock ${runId}`;
    const customers = [`QA Over Stock A ${runId}`, `QA Over Stock B ${runId}`] as const;
    const tabOpened = [false, false];
    const errors = pages.map(capturePageErrors);
    const adminErrors = capturePageErrors(admin.page);
    const cleanupErrors: string[] = [];
    let itemCreated = false;
    let itemArchived = false;
    let overCapacityEvidence: Record<string, unknown> | undefined;
    let primaryError: unknown;

    try {
      await Promise.all([
        signIn(page, credentials("A")),
        signIn(observer.page, credentials("B")),
        signIn(admin.page, credentials("A"))
      ]);
      await Promise.all([...pages, admin.page].map((currentPage) => currentPage.waitForTimeout(1_200)));

      await openInventoryCatalog(admin.page);
      const createForm = admin.page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
      await createForm.getByLabel("Item Name", { exact: true }).fill(itemName);
      await createForm.locator("select").first().selectOption({ label: "Beverages" });
      await createForm.getByLabel("Price", { exact: true }).fill("1");
      await createForm.getByLabel("Opening Stock", { exact: true }).fill("2");
      await createForm.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
      const created = admin.page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await createForm.getByRole("button", { name: "Create Item", exact: true }).click();
      expect((await created).status()).toBeLessThan(300);
      await waitForSynced(admin.page);
      itemCreated = true;

      for (let index = 0; index < pages.length; index += 1) {
        await openCustomerTab(pages[index], customers[index]);
        tabOpened[index] = true;
        const item = pages[index].locator("button.catalog-card").filter({ hasText: itemName }).first();
        await expect(item).toBeEnabled();
        const added = pages[index].waitForResponse((response) =>
          response.url().includes("/rest/v1/rpc/add_customer_tab_item") && response.request().method() === "POST"
        );
        await item.evaluate((button: HTMLButtonElement) => button.click());
        expect((await added).status()).toBeLessThan(300);
        await waitForSynced(pages[index]);
      }

      const captures = [
        await captureCheckout(page, customers[0]),
        await captureCheckout(observer.page, customers[1])
      ];
      const envelopes = [makeUniqueBillNumber(captures[0], "A"), makeUniqueBillNumber(captures[1], "B")];
      const rpcEnvelopes = envelopes as Array<{
        payload: { organization_id: string; mutation_id: string };
      }>;

      await admin.page.reload({ waitUntil: "domcontentloaded" });
      await openInventoryCatalog(admin.page);
      const movementPanel = admin.page.locator("div.panel").filter({
        has: admin.page.getByRole("heading", { name: "Stock Movements", exact: true })
      });
      await movementPanel.locator("select").selectOption({ label: itemName });
      await movementPanel.getByLabel("Quantity", { exact: true }).fill("1");
      await movementPanel.getByPlaceholder("damage, expiry, correction, opening stock...").fill(`Release B oversubscription ${runId}`);
      const adjusted = admin.page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await movementPanel.getByRole("button", { name: "Deduct / Adjust", exact: true }).click();
      expect((await adjusted).status()).toBeLessThan(300);
      await waitForSynced(admin.page);
      await admin.page.reload({ waitUntil: "domcontentloaded" });
      await openInventoryCatalog(admin.page);
      const constrainedStock = await readAvailableStock(admin.page, itemName);
      expect(constrainedStock.stock).toBe(0);
      expect(constrainedStock.text).toMatch(/1 in sessions/);

      const requestHeaders = captures.map((capture) => ({
        apikey: capture.headers.apikey,
        authorization: capture.headers.authorization,
        "content-type": "application/json",
        prefer: capture.headers.prefer || "return=representation"
      }));
      const responses = await Promise.all([
        page.request.post(captures[0].url, { headers: requestHeaders[0], data: envelopes[0], timeout: 30_000 }),
        observer.context.request.post(captures[1].url, { headers: requestHeaders[1], data: envelopes[1], timeout: 30_000 })
      ]);
      const bodies = await Promise.all(responses.map(responseBody));
      expect(responses.map((response) => response.status())).toEqual([400, 400]);
      const rejectionCodes = bodies.map((body) => JSON.parse(String(body.details)) as { code?: string }).map((detail) => detail.code);
      expect(rejectionCodes).toEqual(["inventory_conflict", "inventory_conflict"]);

      const mutationStatusUrl = captures[0].url.replace("commit_checkout_bill_v2", "get_financial_mutation_result");
      const mutationStatuses = await Promise.all(rpcEnvelopes.map(async (envelope, index) => {
        const response = await pages[index].request.post(mutationStatusUrl, {
          headers: requestHeaders[index],
          data: {
            payload: {
              organization_id: envelope.payload.organization_id,
              mutation_id: envelope.payload.mutation_id,
              mutation_kind: "checkout"
            }
          }
        });
        expect(response.status()).toBe(200);
        return response.json();
      }));
      expect(mutationStatuses).toEqual([null, null]);

      await Promise.all(pages.map((currentPage) => currentPage.unroute("**/rest/v1/rpc/commit_checkout_bill_v2")));
      for (let index = 0; index < pages.length; index += 1) {
        await pages[index].reload({ waitUntil: "domcontentloaded" });
        await pages[index].getByRole("button", { name: "Consumables Tab", exact: true }).click();
        await expect(pages[index].locator("button.tab-chip").filter({ hasText: customers[index] })).toBeVisible();
        await openInventoryCatalog(pages[index]);
        const stock = await readAvailableStock(pages[index], itemName);
        expect(stock.stock).toBe(0);
        expect(stock.text).toMatch(/in sessions/);
        expect(errors[index].consoleErrors).toEqual([]);
        expect(errors[index].pageErrors).toEqual(["TypeError: Failed to fetch"]);
      }
      expect(adminErrors.consoleErrors).toEqual([]);
      expect(adminErrors.pageErrors).toEqual([]);

      overCapacityEvidence = {
        itemName,
        customers,
        statuses: responses.map((response) => response.status()),
        rejectionCodes,
        mutationIds: rpcEnvelopes.map((envelope) => envelope.payload.mutation_id),
        mutationStatuses,
        availableStock: 0,
        normalizedStockExpected: 1,
        openReservations: 2
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      for (let index = 0; index < pages.length; index += 1) {
        if (!tabOpened[index]) continue;
        try {
          await pages[index].unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
          await pages[index].reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          await rejectCustomerTab(pages[index], customers[index]);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : `Unknown tab cleanup failure for ${customers[index]}`);
        }
      }
      if (itemCreated && cleanupErrors.length === 0) {
        try {
          await admin.page.reload({ waitUntil: "domcontentloaded" });
          await openInventoryCatalog(admin.page);
          const row = inventoryRow(admin.page, itemName);
          if (await row.isVisible()) {
            await row.getByRole("button", { name: "Archive", exact: true }).click();
            const archive = admin.page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
            await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(`Release B oversubscription QA ${runId}`);
            const archived = admin.page.waitForResponse((response) =>
              response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
            );
            await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
            expect((await archived).status()).toBeLessThan(300);
            await waitForSynced(admin.page);
            await expect(row).toHaveCount(0);
          }
          itemArchived = true;
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : "Unknown oversubscribed-item cleanup failure");
        }
      }
      await attachJson(testInfo, "release-b-over-capacity-stock-v2-evidence", {
        runId,
        itemName,
        customers,
        itemCreated,
        itemArchived,
        cleanupErrors,
        overCapacityEvidence,
        primaryError: primaryError instanceof Error ? primaryError.message : primaryError,
        pageErrors: errors,
        adminErrors
      });
      await attachFailureScreenshot(testInfo, page, "over-capacity-stock-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "over-capacity-stock-observer-failure");
      await observer.context.close().catch(() => undefined);
      await admin.context.close().catch(() => undefined);
      if (!primaryError && cleanupErrors.length) throw new Error(cleanupErrors.join(" | "));
    }
  });

  test("concurrent admin metadata save cannot restore checkout-consumed stock", async ({ browser, page }, testInfo) => {
    const admin = await createObserver(browser);
    const itemName = `QA Admin Stock Race ${runId}`;
    const customerName = `QA Admin Race ${runId}`;
    const originErrors = capturePageErrors(page);
    const adminErrors = capturePageErrors(admin.page);
    const cleanupErrors: string[] = [];
    let itemCreated = false;
    let checkoutCommitted = false;
    let tabOpened = false;
    let itemArchived = false;
    let checkoutCaptureCount = 0;
    let adminCaptureCount = 0;
    let raceEvidence: Record<string, unknown> | undefined;
    let primaryError: unknown;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(admin.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), admin.page.waitForTimeout(1_200)]);

      await openInventoryCatalog(admin.page);
      const createForm = admin.page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
      await createForm.getByLabel("Item Name", { exact: true }).fill(itemName);
      await createForm.locator("select").first().selectOption({ label: "Beverages" });
      await createForm.getByLabel("Price", { exact: true }).fill("1");
      await createForm.getByLabel("Opening Stock", { exact: true }).fill("2");
      await createForm.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
      const created = admin.page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await createForm.getByRole("button", { name: "Create Item", exact: true }).click();
      expect((await created).status()).toBeLessThan(300);
      await waitForSynced(admin.page);
      itemCreated = true;

      await openCustomerTab(page, customerName);
      tabOpened = true;
      const item = page.locator("button.catalog-card").filter({ hasText: itemName }).first();
      await expect(item).toBeEnabled();
      const added = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/add_customer_tab_item") && response.request().method() === "POST"
      );
      await item.evaluate((button: HTMLButtonElement) => button.click());
      expect((await added).status()).toBeLessThan(300);
      await waitForSynced(page);

      const capturedCheckout = await captureCheckout(page, customerName, () => {
        checkoutCaptureCount += 1;
      });
      const checkoutEnvelope = makeUniqueBillNumber(capturedCheckout, "A");

      await admin.page.reload({ waitUntil: "domcontentloaded" });
      await openInventoryCatalog(admin.page);
      const row = inventoryRow(admin.page, itemName);
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      const edit = admin.page.getByRole("dialog", { name: `Edit Inventory Item - ${itemName}`, exact: true });
      await edit.getByLabel("Price", { exact: true }).fill("2");

      let resolveAdminCapture!: (value: CapturedRequest) => void;
      const capturedAdminPromise = new Promise<CapturedRequest>((resolve) => { resolveAdminCapture = resolve; });
      await admin.page.route("**/rest/v1/rpc/commit_admin_data_change", async (route) => {
        adminCaptureCount += 1;
        const request = route.request();
        resolveAdminCapture({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
        await route.abort("aborted");
      });
      await edit.getByRole("button", { name: "Update Item", exact: true }).click();
      const capturedAdmin = await capturedAdminPromise;

      const adminEnvelope = capturedAdmin.body as {
        payload: { payload: { inventoryItems: Array<{ id: string; stockQty: number; expectedStockQty?: number }> } };
      };
      const changedItem = adminEnvelope.payload.payload.inventoryItems.find((entry) => entry.id);
      expect(changedItem?.stockQty).toBe(2);
      expect(changedItem?.expectedStockQty).toBe(2);

      const checkoutHeaders = {
        apikey: capturedCheckout.headers.apikey,
        authorization: capturedCheckout.headers.authorization,
        "content-type": "application/json",
        prefer: capturedCheckout.headers.prefer || "return=representation"
      };
      const adminHeaders = {
        apikey: capturedAdmin.headers.apikey,
        authorization: capturedAdmin.headers.authorization,
        "content-type": "application/json",
        prefer: capturedAdmin.headers.prefer || "return=representation"
      };
      const [checkoutResponse, adminResponse] = await Promise.all([
        page.request.post(capturedCheckout.url, {
          headers: checkoutHeaders,
          data: checkoutEnvelope,
          timeout: 30_000
        }),
        admin.context.request.post(capturedAdmin.url, {
          headers: adminHeaders,
          data: capturedAdmin.body,
          timeout: 30_000
        })
      ]);
      const [checkoutBody, adminBody] = await Promise.all([
        responseBody(checkoutResponse),
        responseBody(adminResponse)
      ]);
      expect(checkoutResponse.status()).toBe(200);
      expect([200, 400]).toContain(adminResponse.status());
      let adminRejectionCode: string | null = null;
      if (adminResponse.status() === 400) {
        adminRejectionCode = (JSON.parse(String(adminBody.details)) as { code?: string }).code ?? null;
        expect(adminRejectionCode).toBe("inventory_conflict");
      }
      checkoutCommitted = true;

      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
      await admin.page.unroute("**/rest/v1/rpc/commit_admin_data_change");
      expect(checkoutCaptureCount).toBe(1);
      expect(adminCaptureCount).toBe(1);
      await Promise.all([
        page.reload({ waitUntil: "domcontentloaded" }),
        admin.page.reload({ waitUntil: "domcontentloaded" })
      ]);
      await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
      await expect(page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveCount(0);
      for (const currentPage of [page, admin.page]) {
        await openInventoryCatalog(currentPage);
        const finalStock = await readAvailableStock(currentPage, itemName);
        expect(finalStock.stock).toBe(1);
        expect(finalStock.text).not.toMatch(/in sessions/);
      }
      raceEvidence = {
        itemName,
        customerName,
        checkoutStatus: checkoutResponse.status(),
        adminStatus: adminResponse.status(),
        adminRejectionCode,
        checkoutMutationId: checkoutBody.mutation_id,
        checkoutBillId: checkoutBody.bill_id,
        checkoutEventId: checkoutBody.event_id,
        adminEventId: adminBody.event_id ?? null,
        expectedStockQty: changedItem?.expectedStockQty,
        finalStock: 1,
        captureCounts: { checkout: checkoutCaptureCount, admin: adminCaptureCount }
      };
      expect(originErrors.consoleErrors).toEqual([]);
      expect(originErrors.pageErrors.length).toBeLessThanOrEqual(1);
      expect(originErrors.pageErrors.every((message) => message === "TypeError: Failed to fetch")).toBe(true);
      expect(adminErrors.consoleErrors).toEqual([]);
      expect(adminErrors.pageErrors.length).toBeLessThanOrEqual(1);
      expect(adminErrors.pageErrors.every((message) => message === "TypeError: Failed to fetch")).toBe(true);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
      await admin.page.unroute("**/rest/v1/rpc/commit_admin_data_change").catch(() => undefined);
      if (tabOpened && !checkoutCommitted) {
        try {
          await page.reload({ waitUntil: "domcontentloaded" });
          await rejectCustomerTab(page, customerName);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : "Unknown admin-race tab cleanup failure");
        }
      }
      if (itemCreated && cleanupErrors.length === 0) {
        try {
          await admin.page.reload({ waitUntil: "domcontentloaded" });
          await openInventoryCatalog(admin.page);
          const row = inventoryRow(admin.page, itemName);
          if (await row.isVisible()) {
            await row.getByRole("button", { name: "Archive", exact: true }).click();
            const archive = admin.page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
            await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...")
              .fill(`Release B admin inventory race QA ${runId}`);
            const archived = admin.page.waitForResponse((response) =>
              response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
            );
            await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
            expect((await archived).status()).toBeLessThan(300);
            await waitForSynced(admin.page);
            await expect(row).toHaveCount(0);
          }
          itemArchived = true;
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : "Unknown admin-race item cleanup failure");
        }
      }
      await attachJson(testInfo, "release-b-admin-inventory-race-v2-evidence", {
        runId,
        itemName,
        customerName,
        itemCreated,
        itemArchived,
        tabOpened,
        checkoutCommitted,
        cleanupErrors,
        raceEvidence,
        primaryError: primaryError instanceof Error ? primaryError.message : primaryError,
        originErrors,
        adminErrors
      });
      await attachFailureScreenshot(testInfo, page, "admin-inventory-race-origin-failure");
      await attachFailureScreenshot(testInfo, admin.page, "admin-inventory-race-admin-failure");
      await admin.context.close().catch(() => undefined);
      if (!primaryError && cleanupErrors.length) throw new Error(cleanupErrors.join(" | "));
    }
  });

  test("admin inventory lifecycle preserves stock and authenticated writes", async ({ page }, testInfo) => {
    const itemName = `QA Admin Lifecycle ${runId}`;
    const errors = capturePageErrors(page);
    const eventIds: string[] = [];
    const appStateVersions: number[] = [];
    const cleanupErrors: string[] = [];
    let itemCreated = false;
    let itemArchived = false;
    let primaryError: unknown;

    async function recordAdminResponse(response: APIResponse) {
      expect(response.status()).toBeLessThan(300);
      const body = await responseBody(response);
      expect(typeof body.event_id).toBe("string");
      expect(typeof body.app_state_version).toBe("number");
      eventIds.push(String(body.event_id));
      appStateVersions.push(Number(body.app_state_version));
      return body;
    }

    try {
      await signIn(page, credentials("A"));
      await page.waitForTimeout(1_200);
      await openInventoryCatalog(page);

      const createForm = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
      await createForm.getByLabel("Item Name", { exact: true }).fill(itemName);
      await createForm.locator("select").first().selectOption({ label: "Beverages" });
      await createForm.getByLabel("Price", { exact: true }).fill("1");
      await createForm.getByLabel("Opening Stock", { exact: true }).fill("3");
      await createForm.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
      const createResponse = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await createForm.getByRole("button", { name: "Create Item", exact: true }).click();
      await recordAdminResponse(await createResponse);
      await waitForSynced(page);
      itemCreated = true;
      expect((await readAvailableStock(page, itemName)).stock).toBe(3);

      let row = inventoryRow(page, itemName);
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      const edit = page.getByRole("dialog", { name: `Edit Inventory Item - ${itemName}`, exact: true });
      await edit.getByLabel("Price", { exact: true }).fill("2");
      const editResponse = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await edit.getByRole("button", { name: "Update Item", exact: true }).click();
      await recordAdminResponse(await editResponse);
      await waitForSynced(page);
      expect((await readAvailableStock(page, itemName)).stock).toBe(3);

      const movementPanel = page.locator("div.panel").filter({
        has: page.getByRole("heading", { name: "Stock Movements", exact: true })
      });
      await movementPanel.locator("select").selectOption({ label: itemName });
      await movementPanel.getByLabel("Quantity", { exact: true }).fill("2");
      await movementPanel.getByPlaceholder("damage, expiry, correction, opening stock...")
        .fill(`Release B lifecycle restock ${runId}`);
      const restockResponse = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await movementPanel.getByRole("button", { name: "Restock", exact: true }).click();
      await recordAdminResponse(await restockResponse);
      await waitForSynced(page);
      expect((await readAvailableStock(page, itemName)).stock).toBe(5);

      await movementPanel.locator("select").selectOption({ label: itemName });
      await movementPanel.getByLabel("Quantity", { exact: true }).fill("1");
      await movementPanel.getByPlaceholder("damage, expiry, correction, opening stock...")
        .fill(`Release B lifecycle adjustment ${runId}`);
      const adjustmentResponse = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await movementPanel.getByRole("button", { name: "Deduct / Adjust", exact: true }).click();
      await recordAdminResponse(await adjustmentResponse);
      await waitForSynced(page);
      expect((await readAvailableStock(page, itemName)).stock).toBe(4);

      row = inventoryRow(page, itemName);
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      let archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
      await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...")
        .fill(`Release B lifecycle archive ${runId}`);
      const archiveResponse = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
      await recordAdminResponse(await archiveResponse);
      await waitForSynced(page);
      itemArchived = true;

      const statusTabs = page.getByRole("tablist", { name: "Inventory item status", exact: true });
      await statusTabs.getByRole("button", { name: /Archived/ }).click();
      row = inventoryRow(page, itemName);
      await expect(row).toBeVisible();
      const restoreResponse = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await row.getByRole("button", { name: "Restore", exact: true }).click();
      await recordAdminResponse(await restoreResponse);
      await waitForSynced(page);
      itemArchived = false;

      await statusTabs.getByRole("button", { name: /Active Items/ }).click();
      expect((await readAvailableStock(page, itemName)).stock).toBe(4);
      expect(new Set(eventIds).size).toBe(6);
      expect(appStateVersions).toEqual([...appStateVersions].sort((left, right) => left - right));
      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (itemCreated && !itemArchived) {
        try {
          await page.reload({ waitUntil: "domcontentloaded" });
          await openInventoryCatalog(page);
          const activeTabs = page.getByRole("tablist", { name: "Inventory item status", exact: true });
          await activeTabs.getByRole("button", { name: /Active Items/ }).click();
          const activeRow = inventoryRow(page, itemName);
          if (await activeRow.isVisible()) {
            await activeRow.getByRole("button", { name: "Archive", exact: true }).click();
            const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
            await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...")
              .fill(`Release B lifecycle final cleanup ${runId}`);
            const archived = page.waitForResponse((response) =>
              response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
            );
            await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
            await recordAdminResponse(await archived);
            await waitForSynced(page);
          }
          itemArchived = true;
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : "Unknown admin lifecycle cleanup failure");
        }
      }
      await attachJson(testInfo, "release-b-admin-inventory-lifecycle-evidence", {
        runId,
        itemName,
        itemCreated,
        itemArchived,
        eventIds,
        appStateVersions,
        cleanupErrors,
        primaryError: primaryError instanceof Error ? primaryError.message : primaryError,
        errors
      });
      await attachFailureScreenshot(testInfo, page, "admin-inventory-lifecycle-failure");
      if (!primaryError && cleanupErrors.length) throw new Error(cleanupErrors.join(" | "));
    }
  });
});
