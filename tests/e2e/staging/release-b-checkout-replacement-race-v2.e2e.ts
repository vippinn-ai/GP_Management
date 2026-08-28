import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  captureRpcEvidence,
  createObserver,
  credentials,
  interceptSingleRpcCommand,
  readApiResponseBody,
  readPendingOperationalMutations,
  readRestRows,
  signIn,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const organizationId = "org-primary";
const itemName = `QA Replacement Race ${runId}`;
const sourceCustomer = `QA Replacement Source ${runId}`;
const checkoutCustomer = `QA Replacement Checkout ${runId}`;

type CheckoutEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    payload: {
      mode: string;
      primary_bill: {
        id: string;
        billNumber: string;
        replacementOfBillId?: string;
        lines: Array<{ id: string; inventoryItemId?: string; quantity: number; unitPrice: number; total: number }>;
      };
      bill_updates: Array<{
        id: string;
        billNumber: string;
        status: string;
        replacedByBillId?: string;
        replacementOfBillId?: string;
      }>;
      payments: Array<{ id: string; billId: string; amount: number; mode: string }>;
      stock_movements: Array<{ id: string; itemId: string; quantity: number; relatedBillId: string }>;
      source_tab_ids: string[];
      audit_logs: Array<{ id: string; action: string; entityId: string }>;
    };
  };
};

function appStateHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function sanitizedErrorMessage(error: unknown) {
  if (error === undefined) return undefined;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/((?:api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .slice(0, 2_000);
}

function rpcHeaders(captured: CapturedRpcRequest) {
  return {
    apikey: captured.headers.apikey,
    authorization: captured.headers.authorization,
    "content-type": "application/json",
    prefer: captured.headers.prefer || "return=representation"
  };
}

function withBillNumber(captured: CapturedRpcRequest, suffix: "ORIGINAL" | "CHECKOUT" | "REPLACEMENT") {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const billNumber = `BILL-QA-REPLACE-RACE-${runId}-${suffix}`;
  envelope.payload.payload.primary_bill.billNumber = billNumber;
  const primary = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primary) throw new Error(`Captured ${suffix} command omitted its primary bill update.`);
  primary.billNumber = billNumber;
  return envelope;
}

function persistCheckpoint(
  phase: "setup-prepared" | "fixture-created" | "original-committed" | "reservation-created" |
    "source-tab-opened" | "source-item-added" | "checkout-tab-opened" | "checkout-item-added" |
    "original-prepared" |
    "race-prepared" | "race-responses" | "cleanup-acknowledged" | "final",
  value: unknown
) {
  const directory = path.join(process.cwd(), "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-replacement-race-${phase}-${runId}.json`);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path.relative(process.cwd(), target);
}

function inventoryRow(page: Page) {
  return page.locator(".inventory-table-wrap tbody tr").filter({ hasText: itemName }).first();
}

async function openInventory(page: Page) {
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("tablist", { name: "Inventory section", exact: true })
    .getByRole("button", { name: "Catalog", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Active Items", exact: true })).toBeVisible();
}

async function openCustomerTab(
  page: Page,
  customerName: string,
  onAcknowledged?: (result: Record<string, unknown>) => void
) {
  await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
  const chip = page.locator("button.tab-chip").filter({ hasText: customerName });
  if (await chip.isVisible()) {
    await chip.evaluate((button: HTMLButtonElement) => button.click());
    await expect(chip).toHaveClass(/is-active/);
    return;
  }
  await page.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const response = page.waitForResponse((candidate) =>
    candidate.url().includes("/rest/v1/rpc/open_customer_tab") && candidate.request().method() === "POST"
  );
  const form = page.getByRole("button", { name: "Open / Find Tab", exact: true }).locator("xpath=ancestor::form");
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  const acknowledged = await response;
  const result = await readApiResponseBody(acknowledged);
  expect(acknowledged.status()).toBe(200);
  onAcknowledged?.(result);
  await waitForSynced(page);
  await expect.poll(() => readPendingOperationalMutations(page)).toEqual([]);
  await expect(chip).toHaveClass(/is-active/);
}

async function addItem(
  page: Page,
  customerName: string,
  callbacks: {
    onTabOpened?: (result: Record<string, unknown>) => void;
    onItemAdded?: (result: Record<string, unknown>) => void;
  } = {}
) {
  await openCustomerTab(page, customerName, callbacks.onTabOpened);
  const added = page.waitForResponse((response) =>
    response.url().includes("/rest/v1/rpc/add_customer_tab_item") && response.request().method() === "POST"
  );
  const card = page.locator("button.catalog-card").filter({ hasText: itemName }).first();
  await expect(card).toBeEnabled();
  await card.evaluate((button: HTMLButtonElement) => button.click());
  const acknowledged = await added;
  const result = await readApiResponseBody(acknowledged);
  expect(acknowledged.status()).toBe(200);
  callbacks.onItemAdded?.(result);
  await waitForSynced(page);
  await expect(page.locator(".sale-current-tab-section")).toContainText(itemName);
}

async function prepareTabCheckout(page: Page, customerName: string) {
  await openCustomerTab(page, customerName);
  await page.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Finalize Customer Tab Bill", exact: true });
  await expect(dialog.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
  return dialog;
}

async function billRow(page: Page, billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  return row;
}

async function body(response: APIResponse) {
  return await readApiResponseBody(response) as Record<string, unknown>;
}

async function mutationStatus(page: Page, captured: CapturedRpcRequest, envelope: CheckoutEnvelope) {
  const response = await page.request.post(
    captured.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
    {
      headers: rpcHeaders(captured),
      data: {
        payload: {
          organization_id: envelope.payload.organization_id,
          mutation_id: envelope.payload.mutation_id,
          mutation_kind: envelope.payload.mutation_kind
        }
      }
    }
  );
  expect(response.status()).toBe(200);
  return await body(response);
}

test.describe.serial("Release B checkout versus replacement concurrency", () => {
  test("shared-inventory checkout and quantity-increasing replacement both commit without lost stock", async ({
    browser,
    page
  }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const authenticatedRequests: CapturedRpcRequest[] = [];
    const observerAuthenticatedRequests: CapturedRpcRequest[] = [];
    captureAuthenticatedRestRequests(page, authenticatedRequests);
    captureAuthenticatedRestRequests(observer.page, observerAuthenticatedRequests);
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    let originalCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let replacementCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let itemId: string | undefined;
    let itemCreated = false;
    let itemArchived = false;
    let raceSubmitted = false;
    let raceResolved = false;
    let primaryError: unknown;
    const disposalErrors: string[] = [];
    let quiescenceError: string | undefined;
    let finalEvidence: Record<string, unknown> = {};

    try {
      await signIn(page, credentials("A"));
      await signIn(observer.page, credentials("B"));
      const identity = await assertAuthoritativeOrganizationIdentity(page, authenticatedRequests, "admin", organizationId);
      const observerIdentity = await assertAuthoritativeOrganizationIdentity(
        observer.page,
        observerAuthenticatedRequests,
        "admin",
        organizationId
      );
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);

      const preflightState = await readRestRows<{ version: number; data: unknown }>(
        page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" }
      );
      expect(preflightState).toHaveLength(1);
      expect(preflightState[0].version).toBe(Number(process.env.E2E_REPLACEMENT_RACE_PREFLIGHT_VERSION));
      expect(appStateHash(preflightState[0].data)).toBe(process.env.E2E_REPLACEMENT_RACE_PREFLIGHT_HASH);
      const setupEvidence = {
        runId,
        actors: { origin: identity.actorId, observer: observerIdentity.actorId },
        itemName,
        sourceCustomer,
        checkoutCustomer,
        preflightAppState: { version: preflightState[0].version, hash: appStateHash(preflightState[0].data) }
      };
      const setupPreparedPath = persistCheckpoint("setup-prepared", setupEvidence);
      const setupLedger: Record<string, unknown> = { ...setupEvidence, setupPreparedPath };

      await openInventory(page);
      const createForm = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
      await createForm.getByLabel("Item Name", { exact: true }).fill(itemName);
      await createForm.locator("select").first().selectOption({ label: "Beverages" });
      await createForm.getByLabel("Price", { exact: true }).fill("50");
      await createForm.getByLabel("Opening Stock", { exact: true }).fill("3");
      await createForm.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
      const created = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await createForm.getByRole("button", { name: "Create Item", exact: true }).click();
      const createdResponse = await created;
      const itemResult = await body(createdResponse);
      expect(createdResponse.status()).toBe(200);
      itemCreated = true;
      itemId = (itemResult.changed_rows as Record<string, string[]>).inventory_items?.[0];
      const fixtureCreatedPath = persistCheckpoint("fixture-created", {
        ...setupLedger,
        itemId,
        itemResult
      });
      Object.assign(setupLedger, { fixtureCreatedPath, itemId, itemResult });
      expect(itemId).toBeTruthy();
      await waitForSynced(page);
      const itemRows = await readRestRows<{ id: string; stock_qty: number; active: boolean }>(
        page, identity.restBase, identity.headers, "inventory_items",
        { organization_id: `eq.${organizationId}`, name: `eq.${itemName}`, select: "id,stock_qty,active" }
      );
      expect(itemRows).toHaveLength(1);
      expect(itemRows[0].id).toBe(itemId);
      expect(Number(itemRows[0].stock_qty)).toBe(3);
      expect((itemResult.changed_rows as Record<string, string[]>).inventory_items).toEqual([itemId]);
      Object.assign(setupLedger, { item: itemRows[0] });
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(page);
      await expect.poll(() => readPendingOperationalMutations(page)).toEqual([]);

      let sourceTabOpenedPath: string | undefined;
      let sourceItemAddedPath: string | undefined;
      await addItem(page, sourceCustomer, {
        onTabOpened(result) {
          sourceTabOpenedPath = persistCheckpoint("source-tab-opened", { ...setupLedger, sourceTabResult: result });
          Object.assign(setupLedger, { sourceTabOpenedPath, sourceTabResult: result });
        },
        onItemAdded(result) {
          sourceItemAddedPath = persistCheckpoint("source-item-added", { ...setupLedger, sourceItemResult: result });
          Object.assign(setupLedger, { sourceItemAddedPath, sourceItemResult: result });
        }
      });
      const originalDialog = await prepareTabCheckout(page, sourceCustomer);
      originalCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
      await originalDialog.getByRole("button", { name: "Issue Bill", exact: true }).click();
      const originalCaptured = await originalCommand.captured;
      expect(originalCommand.captureCount()).toBe(1);
      const originalEnvelope = withBillNumber(originalCaptured, "ORIGINAL");
      const originalPreparedPath = persistCheckpoint("original-prepared", {
        ...setupLedger,
        originalCommand: originalEnvelope.payload,
        originalMutationId: originalEnvelope.payload.mutation_id,
        originalTabId: originalEnvelope.payload.entity_id,
        originalBillId: originalEnvelope.payload.payload.primary_bill.id,
        originalBillNumber: originalEnvelope.payload.payload.primary_bill.billNumber
      });
      Object.assign(setupLedger, {
        originalPreparedPath,
        originalCommand: originalEnvelope.payload,
        originalMutationId: originalEnvelope.payload.mutation_id,
        originalTabId: originalEnvelope.payload.entity_id,
        originalBillId: originalEnvelope.payload.payload.primary_bill.id,
        originalBillNumber: originalEnvelope.payload.payload.primary_bill.billNumber
      });
      const originalResponse = await originalCommand.submit(originalEnvelope);
      const originalBody = await body(originalResponse);
      expect(originalResponse.status()).toBe(200);
      const originalBillId = String(originalBody.bill_id);
      const originalBillNumber = String(originalBody.bill_number);
      const originalCommittedPath = persistCheckpoint("original-committed", {
        ...setupLedger,
        originalCommand: originalEnvelope.payload,
        originalResponse: originalBody,
        originalBillId,
        originalBillNumber
      });
      Object.assign(setupLedger, {
        originalCommittedPath,
        originalCommand: originalEnvelope.payload,
        originalResponse: originalBody,
        originalBillId,
        originalBillNumber
      });
      await originalCommand.dispose();
      originalCommand = undefined;
      await expect(originalDialog).toBeHidden();
      await waitForSynced(page);
      expect(originalBillNumber).toBe(`BILL-QA-REPLACE-RACE-${runId}-ORIGINAL`);

      let checkoutTabOpenedPath: string | undefined;
      let checkoutItemAddedPath: string | undefined;
      await addItem(page, checkoutCustomer, {
        onTabOpened(result) {
          checkoutTabOpenedPath = persistCheckpoint("checkout-tab-opened", { ...setupLedger, checkoutTabResult: result });
          Object.assign(setupLedger, { checkoutTabOpenedPath, checkoutTabResult: result });
        },
        onItemAdded(result) {
          checkoutItemAddedPath = persistCheckpoint("checkout-item-added", { ...setupLedger, checkoutItemResult: result });
          Object.assign(setupLedger, { checkoutItemAddedPath, checkoutItemResult: result });
        }
      });
      const [reservationTabs, reservationItems] = await Promise.all([
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", {
          organization_id: `eq.${organizationId}`,
          customer_name: `in.(\"${sourceCustomer}\",\"${checkoutCustomer}\")`,
          select: "id,customer_name,status,close_disposition,closed_bill_id"
        }),
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tab_items", {
          organization_id: `eq.${organizationId}`,
          inventory_item_id: `eq.${itemId}`,
          select: "id,customer_tab_id,inventory_item_id,name,quantity,unit_price,stock_units_per_sale"
        })
      ]);
      const openCheckoutTab = reservationTabs.find((entry) => entry.customer_name === checkoutCustomer);
      expect(openCheckoutTab?.status).toBe("open");
      expect(reservationItems).toHaveLength(2);
      const reservationCreatedPath = persistCheckpoint("reservation-created", {
        ...setupLedger,
        reservationTabs,
        reservationItems,
        checkoutTabId: openCheckoutTab?.id
      });
      Object.assign(setupLedger, { reservationCreatedPath, reservationTabs, reservationItems, checkoutTabId: openCheckoutTab?.id });
      const checkoutDialog = await prepareTabCheckout(page, checkoutCustomer);
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(observer.page);
      const originalRow = await billRow(observer.page, originalBillNumber);
      await originalRow.getByRole("button", { name: "Replace", exact: true }).click();
      const replacementDialog = observer.page.getByRole("dialog", { name: "Replace Issued Bill", exact: true });
      await replacementDialog.getByPlaceholder("Explain what was wrong in the original bill").fill(
        `Playwright shared-inventory replacement race ${runId}`
      );
      const replacementLine = replacementDialog.locator("tbody tr").filter({ hasText: itemName });
      const quantity = replacementLine.locator('input[inputmode="numeric"]');
      await expect(quantity).toHaveValue("1");
      await quantity.fill("2");
      await quantity.blur();
      await expect(quantity).toHaveValue("2");
      await expect(replacementDialog.getByRole("button", { name: "Issue Replacement Bill", exact: true })).toBeEnabled();

      checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
      replacementCommand = await interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/commit_checkout_bill_v2");
      await Promise.all([
        checkoutDialog.getByRole("button", { name: "Issue Bill", exact: true }).click(),
        replacementDialog.getByRole("button", { name: "Issue Replacement Bill", exact: true }).click()
      ]);
      const [checkoutCaptured, replacementCaptured] = await Promise.all([
        checkoutCommand.captured,
        replacementCommand.captured
      ]);
      expect(checkoutCommand.captureCount()).toBe(1);
      expect(replacementCommand.captureCount()).toBe(1);
      const checkoutEnvelope = withBillNumber(checkoutCaptured, "CHECKOUT");
      const replacementEnvelope = withBillNumber(replacementCaptured, "REPLACEMENT");
      expect(checkoutEnvelope.payload.payload.mode).toBe("customer_tab");
      expect(replacementEnvelope.payload.payload.mode).toBe("bill_replacement");
      expect(replacementEnvelope.payload.entity_id).toBe(originalBillId);
      expect(checkoutEnvelope.payload.mutation_id).not.toBe(replacementEnvelope.payload.mutation_id);
      expect(checkoutEnvelope.payload.payload.stock_movements).toHaveLength(1);
      expect(replacementEnvelope.payload.payload.stock_movements).toHaveLength(1);
      expect(checkoutEnvelope.payload.payload.stock_movements[0].itemId).toBe(itemId);
      expect(replacementEnvelope.payload.payload.stock_movements[0].itemId).toBe(itemId);
      expect(checkoutEnvelope.payload.payload.stock_movements[0].quantity).toBe(-1);
      expect(replacementEnvelope.payload.payload.stock_movements[0].quantity).toBe(-1);

      const stateBeforeRace = await readRestRows<{ version: number; data: unknown }>(
        page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" }
      );
      const preparedEvidence = {
        ...setupLedger,
        itemId,
        itemResult,
        originalBillId,
        originalBillNumber,
        originalMutationId: originalEnvelope.payload.mutation_id,
        originalTabId: originalEnvelope.payload.entity_id,
        originalPaymentIds: originalEnvelope.payload.payload.payments.map((entry) => entry.id),
        originalMovementIds: originalEnvelope.payload.payload.stock_movements.map((entry) => entry.id),
        originalAuditIds: originalEnvelope.payload.payload.audit_logs.map((entry) => entry.id),
        checkoutMutationId: checkoutEnvelope.payload.mutation_id,
        replacementMutationId: replacementEnvelope.payload.mutation_id,
        checkoutBillId: checkoutEnvelope.payload.payload.primary_bill.id,
        replacementBillId: replacementEnvelope.payload.payload.primary_bill.id,
        checkoutBillNumber: checkoutEnvelope.payload.payload.primary_bill.billNumber,
        replacementBillNumber: replacementEnvelope.payload.payload.primary_bill.billNumber,
        checkoutTabId: checkoutEnvelope.payload.entity_id,
        checkoutPaymentIds: checkoutEnvelope.payload.payload.payments.map((entry) => entry.id),
        replacementPaymentIds: replacementEnvelope.payload.payload.payments.map((entry) => entry.id),
        checkoutMovementIds: checkoutEnvelope.payload.payload.stock_movements.map((entry) => entry.id),
        replacementMovementIds: replacementEnvelope.payload.payload.stock_movements.map((entry) => entry.id),
        checkoutAuditIds: checkoutEnvelope.payload.payload.audit_logs.map((entry) => entry.id),
        replacementAuditIds: replacementEnvelope.payload.payload.audit_logs.map((entry) => entry.id),
        originalCommand: originalEnvelope.payload,
        originalResponse: originalBody,
        checkoutCommand: checkoutEnvelope.payload,
        replacementCommand: replacementEnvelope.payload,
        reservationTabs,
        reservationItems,
        appStateBeforeRace: { version: stateBeforeRace[0].version, hash: appStateHash(stateBeforeRace[0].data) }
      };
      const preparedPath = persistCheckpoint("race-prepared", preparedEvidence);

      raceSubmitted = true;
      const [checkoutResponse, replacementResponse] = await Promise.all([
        checkoutCommand.submit(checkoutEnvelope),
        replacementCommand.submit(replacementEnvelope)
      ]);
      const [checkoutBody, replacementBody] = await Promise.all([body(checkoutResponse), body(replacementResponse)]);
      const responsesPath = persistCheckpoint("race-responses", {
        ...preparedEvidence,
        responses: [
          { operation: "checkout", status: checkoutResponse.status(), body: checkoutBody },
          { operation: "replacement", status: replacementResponse.status(), body: replacementBody }
        ]
      });
      expect([checkoutResponse.status(), replacementResponse.status()]).toEqual([200, 200]);
      expect(checkoutBody.bill_id).toBe(preparedEvidence.checkoutBillId);
      expect(replacementBody.bill_id).toBe(preparedEvidence.replacementBillId);
      raceResolved = true;
      await Promise.all([checkoutCommand.dispose(), replacementCommand.dispose()]);
      checkoutCommand = undefined;
      replacementCommand = undefined;
      await Promise.all([expect(checkoutDialog).toBeHidden(), expect(replacementDialog).toBeHidden()]);
      await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);

      const [inventory, bills, lines, payments, movements, tabs, checkoutStatus, replacementStatus, stateAfterRace] = await Promise.all([
        readRestRows<{ id: string; stock_qty: number; active: boolean }>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,stock_qty,active" }),
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", { organization_id: `eq.${organizationId}`, id: `in.(${[originalBillId, preparedEvidence.checkoutBillId, preparedEvidence.replacementBillId].join(",")})`, select: "id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replaced_by_user_id,issued_by_user_id" }),
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_lines", { organization_id: `eq.${organizationId}`, bill_id: `in.(${[originalBillId, preparedEvidence.checkoutBillId, preparedEvidence.replacementBillId].join(",")})`, select: "id,bill_id,type,inventory_item_id,quantity,unit_price,total" }),
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "payments", { organization_id: `eq.${organizationId}`, bill_id: `in.(${[originalBillId, preparedEvidence.checkoutBillId, preparedEvidence.replacementBillId].join(",")})`, select: "id,bill_id,mode,amount,received_by_user_id" }),
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, related_bill_id: `in.(${[originalBillId, preparedEvidence.checkoutBillId, preparedEvidence.replacementBillId].join(",")})`, select: "id,item_id,type,quantity,related_bill_id,user_id" }),
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, customer_name: `in.(\"${sourceCustomer}\",\"${checkoutCustomer}\")`, select: "id,customer_name,status,close_disposition,closed_bill_id" }),
        mutationStatus(page, checkoutCaptured, checkoutEnvelope),
        mutationStatus(observer.page, replacementCaptured, replacementEnvelope),
        readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" })
      ]);
      expect(inventory).toEqual([{ id: itemId, stock_qty: 0, active: true }]);
      expect(bills).toHaveLength(3);
      const original = bills.find((entry) => entry.id === originalBillId)!;
      const checkout = bills.find((entry) => entry.id === preparedEvidence.checkoutBillId)!;
      const replacement = bills.find((entry) => entry.id === preparedEvidence.replacementBillId)!;
      expect(original.status).toBe("replaced");
      expect(original.replaced_by_bill_id).toBe(preparedEvidence.replacementBillId);
      expect(original.issued_by_user_id).toBe(identity.actorId);
      expect(original.replaced_by_user_id).toBe(observerIdentity.actorId);
      expect(replacement.status).toBe("issued");
      expect(replacement.replacement_of_bill_id).toBe(originalBillId);
      expect(replacement.issued_by_user_id).toBe(observerIdentity.actorId);
      expect(Number(replacement.total)).toBe(100);
      expect(checkout.status).toBe("issued");
      expect(checkout.issued_by_user_id).toBe(identity.actorId);
      expect(Number(checkout.total)).toBe(50);
      expect(lines.filter((entry) => entry.inventory_item_id === itemId).map((entry) => Number(entry.quantity)).sort()).toEqual([1, 1, 2]);
      expect(payments).toHaveLength(3);
      expect(movements).toHaveLength(3);
      expect(movements.map((entry) => Number(entry.quantity)).sort()).toEqual([-1, -1, -1]);
      expect(new Set(movements.map((entry) => entry.id)).size).toBe(3);
      expect(tabs).toHaveLength(2);
      expect(tabs.every((entry) => entry.status === "closed" && entry.close_disposition === "billed")).toBe(true);
      expect(checkoutStatus?.mutation_id).toBe(checkoutEnvelope.payload.mutation_id);
      expect(checkoutStatus?.bill_id).toBe(preparedEvidence.checkoutBillId);
      expect(replacementStatus?.mutation_id).toBe(replacementEnvelope.payload.mutation_id);
      expect(replacementStatus?.bill_id).toBe(preparedEvidence.replacementBillId);
      expect(stateAfterRace[0].version).toBe(stateBeforeRace[0].version);
      expect(appStateHash(stateAfterRace[0].data)).toBe(appStateHash(stateBeforeRace[0].data));

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(page);
      const checkoutRow = await billRow(page, String(checkout.bill_number));
      await expect(checkoutRow).toContainText("Issued");
      const replacementRow = await billRow(page, String(replacement.bill_number));
      await expect(replacementRow).toContainText("Issued");
      const replacedRow = await billRow(page, originalBillNumber);
      await expect(replacedRow).toContainText("Replaced");

      await openInventory(page);
      const row = inventoryRow(page);
      await expect(row.locator("td").nth(4)).toContainText("0");
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
      await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(
        `Release B replacement-race fixture cleanup ${runId}`
      );
      const archived = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
      const archiveResponse = await archived;
      const archiveResult = await body(archiveResponse);
      expect(archiveResponse.status()).toBe(200);
      const cleanupAcknowledgedPath = persistCheckpoint("cleanup-acknowledged", {
        ...preparedEvidence,
        preparedPath,
        responsesPath,
        responses: { checkout: checkoutBody, replacement: replacementBody },
        archiveResult
      });
      await waitForSynced(page);
      itemArchived = true;
      const postArchiveState = await readRestRows<{ version: number; data: { inventoryItems?: Array<Record<string, unknown>> } }>(
        page,
        identity.restBase,
        identity.headers,
        "app_state",
        { id: "eq.primary", select: "version,data" }
      );
      expect(postArchiveState).toHaveLength(1);
      expect(postArchiveState[0].version).toBe(stateAfterRace[0].version + 1);
      const compatibilityItem = postArchiveState[0].data.inventoryItems?.find((entry) => entry.id === itemId);
      expect(compatibilityItem).toMatchObject({ id: itemId, name: itemName, stockQty: 0, active: false });

      finalEvidence = {
        ...preparedEvidence,
        preparedPath,
        responsesPath,
        cleanupAcknowledgedPath,
        actors: { origin: identity.actorId, observer: observerIdentity.actorId },
        responses: { checkout: checkoutBody, replacement: replacementBody },
        inventory,
        bills,
        lines,
        payments,
        movements,
        tabs,
        mutationStatuses: { checkout: checkoutStatus, replacement: replacementStatus },
        archiveResult,
        appStateAfterRace: { version: stateAfterRace[0].version, hash: appStateHash(stateAfterRace[0].data) },
        appStateAfterArchive: {
          version: postArchiveState[0].version,
          hash: appStateHash(postArchiveState[0].data),
          compatibilityItem
        },
        fixtureArchived: true
      };
      assertNoPageErrors(originErrors, observerErrors);
      const finalPath = persistCheckpoint("final", finalEvidence);
      await attachJson(testInfo, "release-b-checkout-replacement-race-v2-evidence", { ...finalEvidence, finalPath });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const commands = [originalCommand, checkoutCommand, replacementCommand].filter(
        (command): command is NonNullable<typeof command> => Boolean(command)
      );
      for (const command of commands) {
        if (!command.wasSubmitted()) command.cancel();
      }
      await Promise.allSettled(commands.filter((command) => command.captureCount() > 0).map((command) => command.settled));
      if (!raceResolved && commands.some((command) => command.captureCount() > 0)) {
        const targets = [page, observer.page].filter((target) => !target.isClosed());
        const quiescence = await Promise.allSettled(targets.map(async (target) => {
          await target.reload({ waitUntil: "domcontentloaded" });
          await waitForSynced(target);
        }));
        const failures = quiescence
          .map((result, index) => ({ result, target: targets[index] }))
          .filter((entry): entry is { result: PromiseRejectedResult; target: Page } => entry.result.status === "rejected");
        if (failures.length > 0) {
          quiescenceError = failures.map(({ result }) => sanitizedErrorMessage(result.reason)).join("; ");
          await Promise.all(failures.map(({ target }) => target.isClosed() ? Promise.resolve() : target.close({ runBeforeUnload: false })));
        }
      }
      for (const command of commands) {
        if (!command) continue;
        try {
          await command.dispose();
        } catch (error) {
          disposalErrors.push(sanitizedErrorMessage(error) ?? "Unknown interceptor disposal failure");
        }
      }
      await attachJson(testInfo, "release-b-checkout-replacement-race-v2-lifecycle", {
        runId,
        itemId,
        itemCreated,
        itemArchived,
        raceSubmitted,
        raceResolved,
        ambiguous: raceSubmitted && !raceResolved,
        quiescenceError,
        disposalErrors,
        primaryError: sanitizedErrorMessage(primaryError),
        finalEvidence
      });
      await attachFailureScreenshot(testInfo, page, "checkout-replacement-race-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "checkout-replacement-race-observer-failure");
      await observer.context.close();
      if (!primaryError && (quiescenceError || disposalErrors.length > 0)) {
        throw new Error([quiescenceError, ...disposalErrors].filter(Boolean).join(" | "));
      }
    }
  });
});
