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
const disposition = process.env.E2E_CHECKOUT_REFUND_RACE_DISPOSITION ?? "refund";
if (disposition !== "refund" && disposition !== "void") {
  throw new Error("E2E_CHECKOUT_REFUND_RACE_DISPOSITION must be exactly refund or void.");
}
const fixtureLabel = disposition === "void" ? "Void" : "Refund";
const artifactPrefix = disposition === "void" ? "checkout-void-race" : "checkout-refund-race";
const adjustmentMutationKind = disposition === "void" ? "voidBill" : "refundBill";
const adjustedBillStatus = disposition === "void" ? "voided" : "refunded";
const adjustedBillUiStatus = disposition === "void" ? "Voided" : "Refunded";
const itemName = `QA ${fixtureLabel} Race ${runId}`;
const sourceCustomer = `QA ${fixtureLabel} Source ${runId}`;
const checkoutCustomer = `QA ${fixtureLabel} Checkout ${runId}`;
const adjustmentReason = `Playwright shared-inventory ${disposition} race ${runId}`;

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
        lines: Array<{ id: string; inventoryItemId?: string; quantity: number; unitPrice: number; total: number }>;
      };
      bill_updates: Array<{ id: string; billNumber: string }>;
      payments: Array<{ id: string; billId: string; amount: number; mode: string }>;
      stock_movements: Array<{ id: string; itemId: string; quantity: number; relatedBillId: string }>;
      audit_logs: Array<{ id: string; action: string; entityId: string }>;
    };
  };
};

type AdjustmentEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_type: string;
    entity_id: string;
    payload: {
      bill_updates: Array<{ id: string; billNumber: string; status: string }>;
      payments: Array<{ id: string }>;
      stock_movements: Array<{ id: string; itemId: string; quantity: number; relatedBillId: string }>;
      audit_logs: Array<{ id: string; action: string; entityId: string }>;
      bill_expectations: Array<{ billId: string; expectedStatus: string }>;
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

function withBillNumber(captured: CapturedRpcRequest, suffix: "ORIGINAL" | "CHECKOUT") {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const billNumber = `BILL-QA-${fixtureLabel.toUpperCase()}-RACE-${runId}-${suffix}`;
  envelope.payload.payload.primary_bill.billNumber = billNumber;
  const primary = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primary) throw new Error(`Captured ${suffix} command omitted its primary bill update.`);
  primary.billNumber = billNumber;
  return envelope;
}

function persistCheckpoint(
  phase:
    | "setup-prepared"
    | "fixture-created"
    | "source-tab-opened"
    | "source-item-added"
    | "original-prepared"
    | "original-committed"
    | "checkout-tab-opened"
    | "checkout-item-added"
    | "race-prepared"
    | "race-responses"
    | "cleanup-acknowledged"
    | "final",
  value: unknown
) {
  const directory = path.join(process.cwd(), "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${artifactPrefix}-${phase}-${runId}.json`);
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

async function mutationStatus(
  page: Page,
  captured: CapturedRpcRequest,
  envelope: CheckoutEnvelope | AdjustmentEnvelope
) {
  const response = await page.request.post(
    captured.url.replace(/commit_(?:checkout_bill|financial_adjustment)_v2/, "get_financial_mutation_result"),
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

test.describe.serial(`Release B checkout versus ${disposition} concurrency`, () => {
  test(`shared-inventory checkout and ${disposition} both commit without lost stock`, async ({ browser, page }, testInfo) => {
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
    let adjustmentCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
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
      if (disposition === "void") {
        expect(identity.actorId).not.toBe(observerIdentity.actorId);
        expect(observerIdentity.actorId).toBe(process.env.E2E_SESSION_ITEM_ADMIN_EXPECTED_ACTOR_ID);
      }
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);

      const preflightState = await readRestRows<{ version: number; data: unknown }>(
        page,
        identity.restBase,
        identity.headers,
        "app_state",
        { id: "eq.primary", select: "version,data" }
      );
      expect(preflightState).toHaveLength(1);
      expect(preflightState[0].version).toBe(Number(process.env.E2E_REFUND_RACE_PREFLIGHT_VERSION));
      expect(appStateHash(preflightState[0].data)).toBe(process.env.E2E_REFUND_RACE_PREFLIGHT_HASH);
      const setupEvidence = {
        runId,
        disposition,
        actors: { origin: identity.actorId, observer: observerIdentity.actorId },
        itemName,
        sourceCustomer,
        checkoutCustomer,
        adjustmentReason,
        preflightAppState: { version: preflightState[0].version, hash: appStateHash(preflightState[0].data) }
      };
      const setupPreparedPath = persistCheckpoint("setup-prepared", setupEvidence);
      const setupLedger: Record<string, unknown> = { ...setupEvidence, setupPreparedPath };

      await openInventory(page);
      const createForm = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
      await createForm.getByLabel("Item Name", { exact: true }).fill(itemName);
      await createForm.locator("select").first().selectOption({ label: "Beverages" });
      await createForm.getByLabel("Price", { exact: true }).fill("50");
      await createForm.getByLabel("Opening Stock", { exact: true }).fill("2");
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
      expect(itemId).toBeTruthy();
      const fixtureCreatedPath = persistCheckpoint("fixture-created", { ...setupLedger, itemId, itemResult });
      Object.assign(setupLedger, { fixtureCreatedPath, itemId, itemResult });
      await waitForSynced(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(page);
      await expect.poll(() => readPendingOperationalMutations(page)).toEqual([]);

      await addItem(page, sourceCustomer, {
        onTabOpened(result) {
          const sourceTabOpenedPath = persistCheckpoint("source-tab-opened", {
            ...setupLedger,
            sourceTabResult: result
          });
          Object.assign(setupLedger, { sourceTabOpenedPath, sourceTabResult: result });
        },
        onItemAdded(result) {
          const sourceItemAddedPath = persistCheckpoint("source-item-added", {
            ...setupLedger,
            sourceItemResult: result
          });
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
      Object.assign(setupLedger, { originalPreparedPath, originalCommand: originalEnvelope.payload });
      const originalResponse = await originalCommand.submit(originalEnvelope);
      const originalBody = await body(originalResponse);
      expect(originalResponse.status()).toBe(200);
      const originalBillId = String(originalBody.bill_id);
      const originalBillNumber = String(originalBody.bill_number);
      expect(originalBillNumber).toBe(`BILL-QA-${fixtureLabel.toUpperCase()}-RACE-${runId}-ORIGINAL`);
      const originalCommittedPath = persistCheckpoint("original-committed", {
        ...setupLedger,
        originalResponse: originalBody,
        originalBillId,
        originalBillNumber
      });
      Object.assign(setupLedger, { originalCommittedPath, originalResponse: originalBody, originalBillId, originalBillNumber });
      await originalCommand.dispose();
      originalCommand = undefined;
      await expect(originalDialog).toBeHidden();
      await waitForSynced(page);

      await addItem(page, checkoutCustomer, {
        onTabOpened(result) {
          const checkoutTabOpenedPath = persistCheckpoint("checkout-tab-opened", {
            ...setupLedger,
            checkoutTabResult: result
          });
          Object.assign(setupLedger, { checkoutTabOpenedPath, checkoutTabResult: result });
        },
        onItemAdded(result) {
          const checkoutItemAddedPath = persistCheckpoint("checkout-item-added", {
            ...setupLedger,
            checkoutItemResult: result
          });
          Object.assign(setupLedger, { checkoutItemAddedPath, checkoutItemResult: result });
        }
      });

      const [reservationTabs, reservationItems, itemBeforeRace] = await Promise.all([
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", {
          organization_id: `eq.${organizationId}`,
          customer_name: `in.("${sourceCustomer}","${checkoutCustomer}")`,
          select: "id,customer_name,status,close_disposition,closed_bill_id"
        }),
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tab_items", {
          organization_id: `eq.${organizationId}`,
          inventory_item_id: `eq.${itemId}`,
          select: "id,customer_tab_id,inventory_item_id,name,quantity,unit_price,stock_units_per_sale"
        }),
        readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", {
          organization_id: `eq.${organizationId}`,
          id: `eq.${itemId}`,
          select: "id,stock_qty,active"
        })
      ]);
      expect(reservationTabs).toHaveLength(2);
      expect(reservationItems).toHaveLength(2);
      expect(itemBeforeRace).toEqual([{ id: itemId, stock_qty: 1, active: true }]);

      const checkoutDialog = await prepareTabCheckout(page, checkoutCustomer);
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(observer.page);
      const originalRow = await billRow(observer.page, originalBillNumber);
      await originalRow.getByRole("button", { name: "Void", exact: true }).click();
      const adjustmentDialog = observer.page.getByRole("dialog", {
        name: `Void or Refund - ${originalBillNumber}`,
        exact: true
      });
      await adjustmentDialog.getByLabel("Void or refund action", { exact: true }).selectOption(disposition);
      await adjustmentDialog.getByPlaceholder(`Reason for ${disposition === "void" ? "voiding" : "refunding"} this bill`)
        .fill(adjustmentReason);
      const confirmAdjustment = adjustmentDialog.getByRole("button", { name: `Confirm ${fixtureLabel}`, exact: true });
      await expect(confirmAdjustment).toBeEnabled();

      checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
      adjustmentCommand = await interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/commit_financial_adjustment_v2");
      await Promise.all([
        checkoutDialog.getByRole("button", { name: "Issue Bill", exact: true }).click(),
        confirmAdjustment.click()
      ]);
      const [checkoutCaptured, adjustmentCaptured] = await Promise.all([
        checkoutCommand.captured,
        adjustmentCommand.captured
      ]);
      expect(checkoutCommand.captureCount()).toBe(1);
      expect(adjustmentCommand.captureCount()).toBe(1);
      const checkoutEnvelope = withBillNumber(checkoutCaptured, "CHECKOUT");
      const adjustmentEnvelope = structuredClone(adjustmentCaptured.body) as AdjustmentEnvelope;
      expect(checkoutEnvelope.payload.payload.mode).toBe("customer_tab");
      expect(adjustmentEnvelope.payload.mutation_kind).toBe(adjustmentMutationKind);
      expect(adjustmentEnvelope.payload.entity_id).toBe(originalBillId);
      expect(adjustmentEnvelope.payload.payload.bill_expectations).toEqual([
        expect.objectContaining({ billId: originalBillId, expectedStatus: "issued" })
      ]);
      expect(adjustmentEnvelope.payload.payload.payments).toEqual([]);
      expect(checkoutEnvelope.payload.mutation_id).not.toBe(adjustmentEnvelope.payload.mutation_id);
      expect(checkoutEnvelope.payload.payload.stock_movements).toEqual([
        expect.objectContaining({ itemId, quantity: -1 })
      ]);
      expect(adjustmentEnvelope.payload.payload.stock_movements).toEqual([
        expect.objectContaining({ itemId, quantity: 1, relatedBillId: originalBillId })
      ]);

      const stateBeforeRace = await readRestRows<{ version: number; data: unknown }>(
        page,
        identity.restBase,
        identity.headers,
        "app_state",
        { id: "eq.primary", select: "version,data" }
      );
      expect(stateBeforeRace).toHaveLength(1);
      const preparedEvidence = {
        ...setupLedger,
        actors: { origin: identity.actorId, observer: observerIdentity.actorId },
        itemId,
        itemResult,
        originalBillId,
        originalBillNumber,
        originalMutationId: originalEnvelope.payload.mutation_id,
        originalTabId: originalEnvelope.payload.entity_id,
        originalPaymentIds: originalEnvelope.payload.payload.payments.map((entry) => entry.id),
        originalLineIds: originalEnvelope.payload.payload.primary_bill.lines.map((entry) => entry.id),
        originalMovementIds: originalEnvelope.payload.payload.stock_movements.map((entry) => entry.id),
        originalAuditIds: originalEnvelope.payload.payload.audit_logs.map((entry) => entry.id),
        checkoutMutationId: checkoutEnvelope.payload.mutation_id,
        adjustmentMutationId: adjustmentEnvelope.payload.mutation_id,
        adjustmentMutationKind,
        checkoutBillId: checkoutEnvelope.payload.payload.primary_bill.id,
        checkoutBillNumber: checkoutEnvelope.payload.payload.primary_bill.billNumber,
        checkoutTabId: checkoutEnvelope.payload.entity_id,
        checkoutPaymentIds: checkoutEnvelope.payload.payload.payments.map((entry) => entry.id),
        checkoutLineIds: checkoutEnvelope.payload.payload.primary_bill.lines.map((entry) => entry.id),
        checkoutMovementIds: checkoutEnvelope.payload.payload.stock_movements.map((entry) => entry.id),
        checkoutAuditIds: checkoutEnvelope.payload.payload.audit_logs.map((entry) => entry.id),
        adjustmentMovementIds: adjustmentEnvelope.payload.payload.stock_movements.map((entry) => entry.id),
        adjustmentAuditIds: adjustmentEnvelope.payload.payload.audit_logs.map((entry) => entry.id),
        originalCommand: originalEnvelope.payload,
        originalResponse: originalBody,
        checkoutCommand: checkoutEnvelope.payload,
        adjustmentCommand: adjustmentEnvelope.payload,
        reservationTabs,
        reservationItems,
        itemBeforeRace,
        appStateBeforeRace: {
          version: stateBeforeRace[0].version,
          hash: appStateHash(stateBeforeRace[0].data)
        }
      };
      const preparedPath = persistCheckpoint("race-prepared", preparedEvidence);

      raceSubmitted = true;
      const [checkoutResponse, adjustmentResponse] = await Promise.all([
        checkoutCommand.submit(checkoutEnvelope),
        adjustmentCommand.submit(adjustmentEnvelope)
      ]);
      const [checkoutBody, adjustmentBody] = await Promise.all([body(checkoutResponse), body(adjustmentResponse)]);
      const responsesPath = persistCheckpoint("race-responses", {
        ...preparedEvidence,
        responses: [
          { operation: "checkout", status: checkoutResponse.status(), body: checkoutBody },
          { operation: disposition, status: adjustmentResponse.status(), body: adjustmentBody }
        ]
      });
      expect([checkoutResponse.status(), adjustmentResponse.status()]).toEqual([200, 200]);
      expect(checkoutBody.bill_id).toBe(preparedEvidence.checkoutBillId);
      expect(adjustmentBody.changed_rows).toEqual(expect.objectContaining({
        bills: [originalBillId],
        payments: [],
        stock_movements: preparedEvidence.adjustmentMovementIds,
        audit_logs: preparedEvidence.adjustmentAuditIds,
        inventory_items: [itemId]
      }));
      raceResolved = true;
      await Promise.all([checkoutCommand.dispose(), adjustmentCommand.dispose()]);
      checkoutCommand = undefined;
      adjustmentCommand = undefined;
      await Promise.all([expect(checkoutDialog).toBeHidden(), expect(adjustmentDialog).toBeHidden()]);
      await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);

      const [inventory, bills, lines, payments, movements, tabs, checkoutStatus, adjustmentStatus, stateAfterRace] =
        await Promise.all([
          readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", {
            organization_id: `eq.${organizationId}`,
            id: `eq.${itemId}`,
            select: "id,stock_qty,active"
          }),
          readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", {
            organization_id: `eq.${organizationId}`,
            id: `in.(${[originalBillId, preparedEvidence.checkoutBillId].join(",")})`,
            select: "id,bill_number,status,total,amount_paid,amount_due,void_reason,voided_at,voided_by_user_id,issued_by_user_id"
          }),
          readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_lines", {
            organization_id: `eq.${organizationId}`,
            bill_id: `in.(${[originalBillId, preparedEvidence.checkoutBillId].join(",")})`,
            select: "id,bill_id,type,inventory_item_id,quantity,unit_price,total"
          }),
          readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "payments", {
            organization_id: `eq.${organizationId}`,
            bill_id: `in.(${[originalBillId, preparedEvidence.checkoutBillId].join(",")})`,
            select: "id,bill_id,mode,amount,received_by_user_id"
          }),
          readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", {
            organization_id: `eq.${organizationId}`,
            related_bill_id: `in.(${[originalBillId, preparedEvidence.checkoutBillId].join(",")})`,
            select: "id,item_id,type,quantity,reason,related_bill_id,user_id"
          }),
          readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", {
            organization_id: `eq.${organizationId}`,
            customer_name: `in.("${sourceCustomer}","${checkoutCustomer}")`,
            select: "id,customer_name,status,close_disposition,closed_bill_id"
          }),
          mutationStatus(page, checkoutCaptured, checkoutEnvelope),
          mutationStatus(observer.page, adjustmentCaptured, adjustmentEnvelope),
          readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
            id: "eq.primary",
            select: "version,data"
          })
        ]);

      expect(inventory).toEqual([{ id: itemId, stock_qty: 1, active: true }]);
      expect(bills).toHaveLength(2);
      const original = bills.find((entry) => entry.id === originalBillId)!;
      const checkout = bills.find((entry) => entry.id === preparedEvidence.checkoutBillId)!;
      expect(original).toEqual(expect.objectContaining({
        status: adjustedBillStatus,
        issued_by_user_id: identity.actorId,
        voided_by_user_id: observerIdentity.actorId,
        void_reason: adjustmentReason
      }));
      expect(checkout).toEqual(expect.objectContaining({ status: "issued", issued_by_user_id: identity.actorId }));
      expect(lines).toHaveLength(2);
      expect(lines.every((entry) => entry.inventory_item_id === itemId && Number(entry.quantity) === 1)).toBe(true);
      expect(payments).toHaveLength(2);
      expect(movements).toHaveLength(3);
      expect(movements.map((entry) => Number(entry.quantity)).sort()).toEqual([-1, -1, 1]);
      expect(tabs).toHaveLength(2);
      expect(tabs.every((entry) => entry.status === "closed" && entry.close_disposition === "billed")).toBe(true);
      expect(checkoutStatus?.mutation_id).toBe(checkoutEnvelope.payload.mutation_id);
      expect(adjustmentStatus?.mutation_id).toBe(adjustmentEnvelope.payload.mutation_id);
      expect(stateAfterRace[0].version).toBe(stateBeforeRace[0].version);
      expect(appStateHash(stateAfterRace[0].data)).toBe(appStateHash(stateBeforeRace[0].data));

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(page);
      await expect(await billRow(page, originalBillNumber)).toContainText(adjustedBillUiStatus);
      await expect(await billRow(page, String(checkout.bill_number))).toContainText("Issued");

      await openInventory(page);
      const row = inventoryRow(page);
      await expect(row.locator("td").nth(4)).toContainText("1");
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const archiveReason = `Release B ${disposition}-race fixture cleanup ${runId}`;
      const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
      await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(archiveReason);
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
        responses: { checkout: checkoutBody, adjustment: adjustmentBody },
        archiveReason,
        archiveResult
      });
      await waitForSynced(page);
      itemArchived = true;

      const postArchiveState = await readRestRows<{
        version: number;
        data: { inventoryItems?: Array<Record<string, unknown>> };
      }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" });
      expect(postArchiveState).toHaveLength(1);
      expect(postArchiveState[0].version).toBe(stateAfterRace[0].version + 1);
      const compatibilityItem = postArchiveState[0].data.inventoryItems?.find((entry) => entry.id === itemId);
      expect(compatibilityItem).toMatchObject({ id: itemId, name: itemName, stockQty: 1, active: false });

      finalEvidence = {
        ...preparedEvidence,
        preparedPath,
        responsesPath,
        cleanupAcknowledgedPath,
        responses: { original: originalBody, checkout: checkoutBody, adjustment: adjustmentBody },
        inventory,
        bills,
        lines,
        payments,
        movements,
        tabs,
        mutationStatuses: { checkout: checkoutStatus, adjustment: adjustmentStatus },
        archiveReason,
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
      await attachJson(testInfo, `release-b-${artifactPrefix}-v2-evidence`, { ...finalEvidence, finalPath, rpcEvidence });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const commands = [originalCommand, checkoutCommand, adjustmentCommand].filter(
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
          await Promise.all(failures.map(({ target }) =>
            target.isClosed() ? Promise.resolve() : target.close({ runBeforeUnload: false })
          ));
        }
      }
      for (const command of commands) {
        try {
          await command.dispose();
        } catch (error) {
          disposalErrors.push(sanitizedErrorMessage(error) ?? "Unknown interceptor disposal failure");
        }
      }
      await attachJson(testInfo, `release-b-${artifactPrefix}-v2-lifecycle`, {
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
      await attachFailureScreenshot(testInfo, page, `${artifactPrefix}-origin-failure`);
      await attachFailureScreenshot(testInfo, observer.page, `${artifactPrefix}-observer-failure`);
      await observer.context.close();
      if (!primaryError && (quiescenceError || disposalErrors.length > 0)) {
        throw new Error([quiescenceError, ...disposalErrors].filter(Boolean).join(" | "));
      }
    }
  });
});
