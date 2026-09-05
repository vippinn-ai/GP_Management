import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
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
  type AuthoritativeOrganizationIdentity,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const root = process.cwd();
const organizationId = "org-primary";
const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const replacementPaymentMode = process.env.E2E_REPLACEMENT_PAYMENT_MODE === "upi" ? "upi" : "cash";
const customerName = process.env.E2E_REPLACEMENT_PARITY_CUSTOMER ?? `QA Replacement Parity ${runId}`;
const itemName = process.env.E2E_REPLACEMENT_PARITY_ITEM ?? `QA Replacement Item ${runId}`;
const itemBarcode = process.env.E2E_REPLACEMENT_PARITY_BARCODE ?? `QA-REPLACE-${runId}`;
const originalBillNumber = process.env.E2E_REPLACEMENT_PARITY_ORIGINAL_BILL ?? `BILL-QA-REPLACE-PARITY-${runId}-ORIGINAL`;
const replacementBillNumber = process.env.E2E_REPLACEMENT_PARITY_REPLACEMENT_BILL ?? `BILL-QA-REPLACE-PARITY-${runId}-REPLACEMENT`;
const pendingBillNumber = process.env.E2E_REPLACEMENT_PARITY_PENDING_BILL ?? "";
const preflightVersion = Number(process.env.E2E_REPLACEMENT_PARITY_PREFLIGHT_VERSION);
const preflightHash = process.env.E2E_REPLACEMENT_PARITY_PREFLIGHT_HASH ?? "missing-preflight-hash";
const evidenceDirectory = path.join(root, "test-artifacts", "evidence");

type FinancialEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_type: string;
    entity_id: string;
    payload: {
      mode: string;
      primary_bill: Record<string, any> & { id: string; billNumber: string };
      bill_updates: Array<Record<string, any>>;
      payments: Array<Record<string, any>>;
      audit_logs: Array<Record<string, any>>;
      stock_movements: Array<Record<string, any>>;
    };
  };
};

type TimingPoint = { iso: string; monotonicMs: number };
type BrowserMutationTiming = {
  uiAction: TimingPoint;
  submission: TimingPoint;
  response: TimingPoint;
  triggerSettled: TimingPoint;
  uiTerminal?: TimingPoint;
  responseMs: number;
  browserCompletionMs?: number;
  uiActionToTerminalMs?: number;
};

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function timingPoint(): TimingPoint { return { iso: new Date().toISOString(), monotonicMs: performance.now() }; }
function elapsed(start: TimingPoint, end: TimingPoint) { return Number((end.monotonicMs - start.monotonicMs).toFixed(3)); }
function markUiTerminal(timings: BrowserMutationTiming) {
  const uiTerminal = timingPoint();
  timings.uiTerminal = uiTerminal;
  timings.browserCompletionMs = elapsed(timings.submission, uiTerminal);
  timings.uiActionToTerminalMs = elapsed(timings.uiAction, uiTerminal);
  expect(timings.responseMs).toBeGreaterThanOrEqual(0);
  expect(timings.browserCompletionMs).toBeGreaterThanOrEqual(timings.responseMs);
  expect(timings.browserCompletionMs).toBeLessThan(7_000);
}
function parseMoney(value: string) {
  const amount = Number(value.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(amount)) throw new Error(`Unable to parse currency value: ${value}`);
  return Number(amount.toFixed(2));
}
function safeError(error: unknown) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]").slice(0, 2_000);
}
function assertNoSecrets(value: unknown) {
  const raw = JSON.stringify(value);
  expect(raw).not.toMatch(/"(?:authorization|apikey|password|access_token|refresh_token)"\s*:/i);
  expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
}
function writeEvidence(stage: string, value: Record<string, unknown>) {
  const evidence = { runId, stage, recordedAt: new Date().toISOString(), productionAllowed: false, safeForAutomaticRetry: false, ...value };
  assertNoSecrets(evidence);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const target = path.join(evidenceDirectory, `checkout-replacement-parity-${stage}-${runId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { fs.linkSync(temporary, target); } finally { fs.unlinkSync(temporary); }
  return path.relative(root, target);
}
async function appStateSnapshot(page: Page, identity: AuthoritativeOrganizationIdentity) {
  const rows = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" });
  expect(rows).toHaveLength(1);
  return { version: rows[0].version, hash: hash(rows[0].data) };
}
function exactBill(captured: CapturedRpcRequest, billNumber: string) {
  const envelope = structuredClone(captured.body) as FinancialEnvelope;
  expect(envelope.payload.organization_id).toBe(organizationId);
  const previousBillNumber = envelope.payload.payload.primary_bill.billNumber;
  const primaryBillId = envelope.payload.payload.primary_bill.id;
  envelope.payload.payload.primary_bill.billNumber = billNumber;
  envelope.payload.payload.bill_updates = (envelope.payload.payload.bill_updates as Array<Record<string, any>>).map((bill) =>
    bill.id === primaryBillId ? { ...bill, billNumber } : bill
  );
  envelope.payload.payload.audit_logs = envelope.payload.payload.audit_logs.map((audit) => ({
    ...audit,
    message: typeof audit.message === "string" ? audit.message.replaceAll(previousBillNumber, billNumber) : audit.message
  }));
  envelope.payload.payload.stock_movements = envelope.payload.payload.stock_movements.map((movement) => ({
    ...movement,
    reason: typeof movement.reason === "string" ? movement.reason.replaceAll(previousBillNumber, billNumber) : movement.reason
  }));
  expect(envelope.payload.payload.bill_updates.filter((bill) => bill.id === primaryBillId && bill.billNumber === billNumber)).toHaveLength(1);
  return envelope;
}
async function submitCaptured(
  page: Page,
  route: string,
  trigger: () => Promise<void>,
  stage: string,
  transform: (captured: CapturedRpcRequest) => unknown = (captured) => captured.body,
  context: Record<string, unknown> = {}
) {
  const command = await interceptSingleRpcCommand(page, route);
  const uiAction = timingPoint();
  const triggerPromise = trigger();
  const captured = await command.captured;
  expect(command.captureCount()).toBe(1);
  expect(command.wasSubmitted()).toBe(false);
  const bodyToSubmit = transform(captured);
  const preparedPath = writeEvidence(`${stage}-prepared`, { status: "captured-not-submitted", request: bodyToSubmit, captureCount: 1, submissionCount: 0, ...context });
  try {
    const submission = timingPoint();
    const responsePromise = command.submit(bodyToSubmit);
    const submittedPath = writeEvidence(`${stage}-submitted`, { status: "submitted-once-response-pending", preparedPath, request: bodyToSubmit, captureCount: 1, submissionCount: 1, ...context });
    const response = await responsePromise;
    const responseBody = await readApiResponseBody(response);
    const responseReceived = timingPoint();
    const responsePath = writeEvidence(`${stage}-response`, { status: "response-received", preparedPath, submittedPath, request: bodyToSubmit, captureCount: 1, submissionCount: 1, response: { status: response.status(), body: responseBody }, timings: { uiAction, submission, response: responseReceived, responseMs: elapsed(submission, responseReceived) }, ...context });
    await triggerPromise;
    const triggerSettled = timingPoint();
    const timings: BrowserMutationTiming = { uiAction, submission, response: responseReceived, triggerSettled, responseMs: elapsed(submission, responseReceived) };
    return { captured, submitted: bodyToSubmit, response, body: responseBody, preparedPath, submittedPath, responsePath, captureCount: 1 as const, submissionCount: 1 as const, timings };
  } finally {
    await command.dispose();
  }
}
async function openInventoryCatalog(page: Page) {
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Catalog", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Active Items", exact: true })).toBeVisible();
}
async function createFixtureItem(page: Page) {
  await openInventoryCatalog(page);
  const form = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
  await form.getByLabel("Item Name", { exact: true }).fill(itemName);
  await form.locator("select").first().selectOption({ label: "Beverages" });
  await form.getByLabel("Price", { exact: true }).fill("50");
  await form.getByLabel("Opening Stock", { exact: true }).fill("5");
  await form.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
  await form.getByLabel("Barcode", { exact: true }).fill(itemBarcode);
  const result = await submitCaptured(page, "**/rest/v1/rpc/commit_admin_data_change", () => form.getByRole("button", { name: "Create Item", exact: true }).click(), "fixture-create");
  expect(result.response.status()).toBe(200);
  await waitForSynced(page);
  return result;
}
async function openCustomerTab(page: Page) {
  await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
  await page.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const form = page.getByRole("button", { name: "Open / Find Tab", exact: true }).locator("xpath=ancestor::form");
  const opened = await submitCaptured(page, "**/rest/v1/rpc/open_customer_tab", () => form.evaluate((element: HTMLFormElement) => element.requestSubmit()), "tab-open");
  expect(opened.response.status()).toBe(200);
  await waitForSynced(page);
  await expect.poll(() => readPendingOperationalMutations(page)).toEqual([]);
  await expect(page.locator("button.tab-chip").filter({ hasText: customerName })).toHaveClass(/is-active/);
  return opened;
}
async function addTwoItems(page: Page) {
  const card = page.locator("button.catalog-card").filter({ hasText: itemName }).first();
  await expect(card).toBeEnabled();
  const added = await submitCaptured(page, "**/rest/v1/rpc/add_customer_tab_item", () => card.evaluate((button: HTMLButtonElement) => button.click()), "tab-item-add");
  expect(added.response.status()).toBe(200);
  await waitForSynced(page);
  const line = page.locator(".sale-current-tab-section .line-item-row").filter({ hasText: itemName });
  const quantity = line.getByLabel("Qty", { exact: true });
  await expect(quantity).toHaveValue("1");
  const updated = await submitCaptured(page, "**/rest/v1/rpc/update_customer_tab_item_quantity", async () => {
    await quantity.fill("2");
    await quantity.blur();
  }, "tab-item-quantity");
  expect(updated.response.status()).toBe(200);
  await waitForSynced(page);
  await expect(quantity).toHaveValue("2");
  return { added, updated };
}
async function billRow(page: Page, billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  return row;
}

test("quantity-decreasing replacement remains exact across normalized hard-refresh consumers", async ({ browser, page }, testInfo) => {
  test.skip(!Number.isInteger(preflightVersion) || preflightHash.startsWith("missing-") || !pendingBillNumber, "An exact reviewed replacement-parity preflight with one pending receivable is required.");
  const observer = await createObserver(browser);
  const originRequests: CapturedRpcRequest[] = [];
  const observerRequests: CapturedRpcRequest[] = [];
  const rpcEvidence: RpcEvidence[] = [];
  const originErrors = capturePageErrors(page);
  const observerErrors = capturePageErrors(observer.page);
  captureAuthenticatedRestRequests(page, originRequests);
  captureAuthenticatedRestRequests(observer.page, observerRequests);
  captureRpcEvidence(page, "origin", rpcEvidence);
  captureRpcEvidence(observer.page, "observer", rpcEvidence);
  let terminalWritten = false;
  let primaryError: unknown;
  try {
    await signIn(page, credentials("A"));
    await signIn(observer.page, credentials("B"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, originRequests, "admin", organizationId);
    const observerIdentity = await assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", organizationId);
    expect(await appStateSnapshot(page, identity)).toEqual({ version: preflightVersion, hash: preflightHash });

    const created = await createFixtureItem(page);
    const itemId = String((created.body.changed_rows as Record<string, string[]>).inventory_items?.[0]);
    expect(itemId).toMatch(/^inventory-/);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSynced(page);
    const opened = await openCustomerTab(page);
    const tabId = String(opened.body.entity_id);
    const { added, updated } = await addTwoItems(page);
    const financialState = await appStateSnapshot(page, identity);
    expect(financialState.version).toBe(preflightVersion + 1);

    await page.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
    const checkout = page.getByRole("dialog", { name: "Finalize Customer Tab Bill", exact: true });
    const original = await submitCaptured(
      page,
      "**/rest/v1/rpc/commit_checkout_bill_v2",
      () => checkout.getByRole("button", { name: "Issue Bill", exact: true }).click(),
      "original-checkout",
      (captured) => exactBill(captured, originalBillNumber),
      { itemId, tabId, expectedQuantity: 2 }
    );
    expect(original.response.status()).toBe(200);
    await expect(checkout).toBeHidden();
    await waitForSynced(page);
    markUiTerminal(original.timings);
    expect(await appStateSnapshot(page, identity)).toEqual(financialState);

    await observer.page.reload({ waitUntil: "domcontentloaded" });
    await waitForSynced(observer.page);
    const originalRow = await billRow(observer.page, originalBillNumber);
    await expect(originalRow).toContainText("Issued");
    await originalRow.getByRole("button", { name: "Replace", exact: true }).click();
    const replacementDialog = observer.page.getByRole("dialog", { name: "Replace Issued Bill", exact: true });
    await replacementDialog.getByPlaceholder("Explain what was wrong in the original bill").fill(`Quantity correction ${runId}`);
    await replacementDialog.locator("label").filter({ hasText: "Payment Mode" }).locator("select").selectOption(replacementPaymentMode);
    const replacementLine = replacementDialog.locator("tbody tr").filter({ hasText: itemName });
    const replacementQuantity = replacementLine.locator('input[inputmode="numeric"]');
    await expect(replacementQuantity).toHaveValue("2");
    await replacementQuantity.fill("1");
    await replacementQuantity.blur();
    await expect(replacementQuantity).toHaveValue("1");
    const replacement = await submitCaptured(
      observer.page,
      "**/rest/v1/rpc/commit_checkout_bill_v2",
      () => replacementDialog.getByRole("button", { name: "Issue Replacement Bill", exact: true }).click(),
      "replacement-checkout",
      (captured) => exactBill(captured, replacementBillNumber),
      { itemId, originalBillNumber, expectedQuantity: 1, expectedStockDelta: 1 }
    );
    expect(replacement.response.status()).toBe(200);
    await expect(replacementDialog).toBeHidden();
    await waitForSynced(observer.page);
    markUiTerminal(replacement.timings);
    expect(await appStateSnapshot(observer.page, observerIdentity)).toEqual(financialState);

    const originalBillId = String(original.body.bill_id);
    const replacementBillId = String(replacement.body.bill_id);
    const [items, bills, lines, payments, movements, tabs] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,stock_qty,active" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", { organization_id: `eq.${organizationId}`, id: `in.(${originalBillId},${replacementBillId})`, select: "id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replaced_by_user_id,issued_by_user_id,customer_id,customer_name" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_lines", { organization_id: `eq.${organizationId}`, bill_id: `in.(${originalBillId},${replacementBillId})`, select: "id,bill_id,type,inventory_item_id,quantity,unit_price,subtotal,total" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "payments", { organization_id: `eq.${organizationId}`, bill_id: `in.(${originalBillId},${replacementBillId})`, select: "id,bill_id,mode,amount,received_by_user_id,related_checkout_bill_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, related_bill_id: `in.(${originalBillId},${replacementBillId})`, select: "id,item_id,type,quantity,reason,related_bill_id,user_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, id: `eq.${tabId}`, select: "id,status,close_disposition,closed_bill_id,customer_id,customer_name" })
    ]);
    expect(items).toEqual([{ id: itemId, name: itemName, stock_qty: 4, active: true }]);
    expect(bills).toHaveLength(2);
    const originalBill = bills.find((bill) => bill.id === originalBillId)!;
    const replacementBill = bills.find((bill) => bill.id === replacementBillId)!;
    expect(originalBill).toMatchObject({ bill_number: originalBillNumber, status: "replaced", replaced_by_bill_id: replacementBillId, issued_by_user_id: identity.actorId, replaced_by_user_id: observerIdentity.actorId });
    expect([Number(originalBill.total), Number(originalBill.amount_paid), Number(originalBill.amount_due)]).toEqual([100, 100, 0]);
    expect(replacementBill).toMatchObject({ bill_number: replacementBillNumber, status: "issued", replacement_of_bill_id: originalBillId, issued_by_user_id: observerIdentity.actorId });
    expect([Number(replacementBill.total), Number(replacementBill.amount_paid), Number(replacementBill.amount_due)]).toEqual([50, 50, 0]);
    expect(lines.map((line) => [line.bill_id, Number(line.quantity), Number(line.total)]).sort()).toEqual([[originalBillId, 2, 100], [replacementBillId, 1, 50]].sort());
    expect(payments.map((payment) => [payment.bill_id, payment.mode, Number(payment.amount)]).sort()).toEqual([[originalBillId, "cash", 100], [replacementBillId, replacementPaymentMode, 50]].sort());
    expect(movements.map((movement) => [movement.related_bill_id, movement.type, Number(movement.quantity)]).sort()).toEqual([[originalBillId, "sale", -2], [replacementBillId, "void_refund_reversal", 1]].sort());
    expect(tabs).toEqual([expect.objectContaining({ id: tabId, status: "closed", close_disposition: "billed", closed_bill_id: originalBillId })]);

    await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), observer.page.reload({ waitUntil: "domcontentloaded" })]);
    await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
    const refreshedOriginal = await billRow(page, originalBillNumber);
    await expect(refreshedOriginal).toContainText("Replaced");
    const refreshedReplacement = await billRow(page, replacementBillNumber);
    await expect(refreshedReplacement).toContainText("Issued");
    await refreshedReplacement.click();
    const preview = page.locator(".bill-register-preview-pane");
    await expect(preview.getByRole("heading", { name: replacementBillNumber, exact: true })).toBeVisible();
    await expect(preview.getByText("Replaces", { exact: true }).locator("..")).toContainText(originalBillNumber);
    await expect(preview.getByText(itemName, { exact: true })).toBeVisible();
    await expect(preview.getByText("₹50.00", { exact: true }).first()).toBeVisible();
    const paymentMeta = await preview.getByText("Payment", { exact: true }).locator("..").innerText();
    expect(paymentMeta).toContain(replacementPaymentMode.toUpperCase());
    const replacementPayment = payments.find((payment) => payment.bill_id === replacementBillId)!;
    expect(replacementPayment).toMatchObject({ id: expect.any(String), bill_id: replacementBillId, mode: replacementPaymentMode, received_by_user_id: observerIdentity.actorId });
    expect(Number(replacementPayment.amount)).toBe(50);

    await page.getByRole("button", { name: /^Receivables \(\d+\)$/ }).click();
    await page.getByPlaceholder("Search customer, phone or pending bill #...").fill(pendingBillNumber);
    const receivableGroupRow = page.locator("tr.receivable-row");
    await expect(receivableGroupRow).toHaveCount(1);
    await receivableGroupRow.getByRole("button", { name: "View", exact: true }).click();
    const receivableDetailRow = page.locator("tr.receivable-detail-row").filter({ hasText: pendingBillNumber });
    await expect(receivableDetailRow).toBeVisible();
    const receivableText = `${await receivableGroupRow.innerText()}\n${await receivableDetailRow.innerText()}`;

    const analyticsResponsePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/load_analytics_summary") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    const analyticsResponse = await analyticsResponsePromise;
    expect(analyticsResponse.status()).toBe(200);
    const analyticsPayload = await readApiResponseBody(analyticsResponse) as Record<string, any>;
    await expect(page.getByRole("heading", { name: "Operational Reports", exact: true })).toBeVisible();
    await expect(page.getByText("Report range is loaded from backend report data.", { exact: true })).toBeVisible();
    const renderedGrossText = await page.getByText("Gross Revenue", { exact: true }).first().locator("..").locator("strong").innerText();
    const renderedGross = parseMoney(renderedGrossText);
    const backendGross = Number(Number(analyticsPayload.summary?.gross_revenue ?? 0).toFixed(2));
    expect(renderedGross).toBe(backendGross);
    const analyticsReceivable = analyticsPayload.pending_receivables?.find((entry: Record<string, unknown>) => entry.bill_number === pendingBillNumber);
    expect(analyticsReceivable).toBeTruthy();
    const analyticsPendingRow = page.getByRole("heading", { name: "Pending Receivables", exact: true }).locator("xpath=../..").locator("tbody tr").filter({ hasText: pendingBillNumber });
    await expect(analyticsPendingRow).toBeVisible();

    await observer.page.getByRole("button", { name: "Customer Profiles", exact: true }).click();
    await expect(observer.page.getByRole("heading", { name: "Customer Analytics", exact: true })).toBeVisible();
    await observer.page.getByPlaceholder("Search by name or phone").fill(customerName);
    const customerChip = observer.page.locator("button.tab-chip").filter({ hasText: customerName });
    await expect(customerChip).toContainText("1 visits");
    await expect(customerChip).toContainText("₹50.00");
    const customerChipText = await customerChip.innerText();
    await customerChip.click();
    const recentVisits = observer.page.getByRole("heading", { name: "Recent Billed Visits", exact: true }).locator("xpath=../..");
    await expect(recentVisits).toContainText(replacementBillNumber);
    await expect(recentVisits).not.toContainText(originalBillNumber);

    await observer.page.getByRole("button", { name: "Inventory", exact: true }).click();
    const initialInventoryResponse = observer.page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/load_inventory_report_summary") && response.request().method() === "POST");
    await observer.page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Inventory Report", exact: true }).click();
    expect((await initialInventoryResponse).status()).toBe(200);
    await expect(observer.page.getByText("Inventory report range is loaded from backend report data.", { exact: true })).toBeVisible();
    const filteredInventoryResponse = observer.page.waitForResponse((response) => {
      if (!response.url().includes("/rest/v1/rpc/load_inventory_report_summary") || response.request().method() !== "POST") return false;
      try { return response.request().postDataJSON()?.p_search_query === itemName; } catch { return false; }
    });
    await observer.page.getByPlaceholder("Item, category, bill, reason").fill(itemName);
    const inventoryResponse = await filteredInventoryResponse;
    expect(inventoryResponse.status()).toBe(200);
    const inventoryPayload = await readApiResponseBody(inventoryResponse) as Record<string, any>;
    const backendInventoryRow = inventoryPayload.rows?.find((entry: Record<string, unknown>) => entry.item_id === itemId);
    expect(backendInventoryRow).toMatchObject({ item_id: itemId, item_name: itemName, category: "Beverages", active: true, added: 0, deducted: 2, manual_adjustments: 0, reversals: 1, net_change: -1, current_stock: 4, reserved: 0 });
    const backendInventoryDetails = (inventoryPayload.details ?? []).filter((entry: Record<string, unknown>) => entry.item_id === itemId);
    expect(backendInventoryDetails).toHaveLength(2);
    expect(backendInventoryDetails.map((entry: Record<string, unknown>) => [entry.related_bill_number, entry.type, Number(entry.quantity)]).sort()).toEqual([[originalBillNumber, "sale", -2], [replacementBillNumber, "void_refund_reversal", 1]].sort());
    const itemSummary = observer.page.getByRole("heading", { name: "Item Summary", exact: true }).locator("xpath=../..").locator("table tbody tr").filter({ hasText: itemName });
    await expect(itemSummary).toBeVisible();
    expect((await itemSummary.locator("td").allInnerTexts()).map((text) => text.trim())).toEqual([itemName, "Beverages", "Active", "0", "2", "0", "1", "-1", "4", "0"]);
    const movementDetails = observer.page.getByRole("heading", { name: "Movement Details", exact: true }).locator("xpath=../..").locator("table tbody tr").filter({ hasText: itemName });
    await expect(movementDetails).toHaveCount(2);
    const originalMovementRow = movementDetails.filter({ has: observer.page.getByRole("cell", { name: "Sale", exact: true }) });
    const replacementMovementRow = movementDetails.filter({ has: observer.page.getByRole("cell", { name: "Void/Refund Restore", exact: true }) });
    await expect(originalMovementRow).toHaveCount(1);
    await expect(replacementMovementRow).toHaveCount(1);
    await expect(originalMovementRow.locator("td").nth(4)).toHaveText("-2");
    await expect(originalMovementRow.locator("td").nth(6)).toHaveText(originalBillNumber);
    await expect(replacementMovementRow.locator("td").nth(4)).toHaveText("+1");
    await expect(replacementMovementRow.locator("td").nth(6)).toHaveText(replacementBillNumber);

    await openInventoryCatalog(page);
    await page.getByPlaceholder("Search active items by name or category").fill(itemName);
    const catalogRow = page.locator(".inventory-table-wrap tbody tr").filter({ hasText: itemName }).first();
    await catalogRow.getByRole("button", { name: "Archive", exact: true }).click();
    const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
    const archiveReason = `Replacement parity fixture cleanup ${runId}`;
    await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(archiveReason);
    const archived = await submitCaptured(page, "**/rest/v1/rpc/commit_admin_data_change", () => archive.getByRole("button", { name: "Archive Item", exact: true }).click(), "fixture-archive", undefined, { itemId, archiveReason });
    expect(archived.response.status()).toBe(200);
    await waitForSynced(page);
    const finalState = await appStateSnapshot(page, identity);
    expect(finalState.version).toBe(financialState.version + 1);
    const finalItem = await readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,stock_qty,active,archived_by_user_id,archive_reason" });
    expect(finalItem).toEqual([{ id: itemId, name: itemName, stock_qty: 4, active: false, archived_by_user_id: identity.actorId, archive_reason: archiveReason }]);

    const terminalPath = writeEvidence("terminal", {
      status: "passed",
      actors: { origin: identity.actorId, observer: observerIdentity.actorId },
      fixture: { customerName, itemId, itemName, itemBarcode, tabId, originalBillId, originalBillNumber, replacementBillId, replacementBillNumber, replacementPaymentMode, pendingBillNumber: pendingBillNumber || null },
      operations: {
        created: { request: created.submitted, response: created.body, evidence: [created.preparedPath, created.submittedPath, created.responsePath] },
        opened: { request: opened.submitted, response: opened.body, evidence: [opened.preparedPath, opened.submittedPath, opened.responsePath] },
        added: { request: added.submitted, response: added.body, evidence: [added.preparedPath, added.submittedPath, added.responsePath] },
        updated: { request: updated.submitted, response: updated.body, evidence: [updated.preparedPath, updated.submittedPath, updated.responsePath] },
        original: { request: original.submitted, response: original.body, captureCount: original.captureCount, submissionCount: original.submissionCount, timings: original.timings, evidence: [original.preparedPath, original.submittedPath, original.responsePath] },
        replacement: { request: replacement.submitted, response: replacement.body, captureCount: replacement.captureCount, submissionCount: replacement.submissionCount, timings: replacement.timings, evidence: [replacement.preparedPath, replacement.submittedPath, replacement.responsePath] },
        archived: { request: archived.submitted, response: archived.body, evidence: [archived.preparedPath, archived.submittedPath, archived.responsePath] }
      },
      financialState,
      finalState,
      snapshot: { items, bills, lines, payments, movements, tabs, finalItem },
      uiParity: {
        hardRefreshContexts: 2,
        billRegister: { original: { id: originalBillId, number: originalBillNumber, status: "Replaced" }, replacement: { id: replacementBillId, number: replacementBillNumber, status: "Issued" } },
        receipt: { billId: replacementBillId, billNumber: replacementBillNumber, replacesBillId: originalBillId, replacesBillNumber: originalBillNumber, payment: { id: replacementPayment.id, mode: replacementPayment.mode, amount: Number(replacementPayment.amount) }, renderedPayment: paymentMeta, renderedTotal: 50 },
        pendingReceivable: { billNumber: pendingBillNumber, renderedRow: receivableText, backend: analyticsReceivable },
        analytics: { renderedGross, backendGross, response: analyticsPayload },
        customerAnalytics: { customerName, renderedDirectoryEntry: customerChipText, visitCount: 1, totalSpend: 50, recentBillNumber: replacementBillNumber },
        inventoryReport: { renderedRow: await itemSummary.locator("td").allInnerTexts(), backendRow: backendInventoryRow, backendDetails: backendInventoryDetails }
      },
      rpcEvidence
    });
    terminalWritten = true;
    await attachJson(testInfo, "release-b-checkout-replacement-parity-v2", { terminalPath });
    assertNoPageErrors(originErrors, observerErrors);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!terminalWritten) {
      writeEvidence("failure", { status: "failed", error: safeError(primaryError), rpcEvidence });
    }
    await attachFailureScreenshot(testInfo, page, "replacement-parity-origin-failure");
    await attachFailureScreenshot(testInfo, observer.page, "replacement-parity-observer-failure");
    await observer.context.close();
  }
});
