import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  browserDateTimeLocal,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  captureRpcEvidence,
  createObserver,
  credentials,
  interceptSingleRpcCommand,
  openManagedSession,
  readApiResponseBody,
  readRestRows,
  signIn,
  stationCard,
  type AuthoritativeOrganizationIdentity,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const root = process.cwd();
const organizationId = "org-primary";
const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const selectedCase = process.env.E2E_PRICING_CASE ?? "missing-case";
const allowedCases = ["discount_rounding_positive", "ltp_zero", "bill_discount_zero", "true_zero_price_guard"] as const;
if (!allowedCases.includes(selectedCase as (typeof allowedCases)[number])) throw new Error("E2E_PRICING_CASE is not an exact allowed case.");
const customerName = process.env.E2E_PRICING_CUSTOMER_NAME ?? `QA Pricing ${selectedCase.replaceAll("_", " ")} ${runId}`;
const timedStation = process.env.E2E_PRICING_TIMED_STATION ?? "8 Ball Pool";
const unitStation = process.env.E2E_PRICING_UNIT_STATION ?? "missing-unit-station";
const zeroItemName = process.env.E2E_PRICING_ZERO_ITEM_NAME ?? `QA Zero Arcade ${runId}`;
const zeroItemBarcode = process.env.E2E_PRICING_ZERO_ITEM_BARCODE ?? `QA-ZERO-${runId}`;
const preflightVersion = Number(process.env.E2E_PRICING_PREFLIGHT_VERSION);
const preflightHash = process.env.E2E_PRICING_PREFLIGHT_HASH ?? "missing-preflight-hash";
const evidenceDirectory = path.join(root, "test-artifacts", "evidence");

type FinancialEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    payload: {
      primary_bill: Record<string, any> & { id: string; billNumber: string; lines: Array<Record<string, any>>; lineDiscounts: Array<Record<string, any>>; billDiscount?: Record<string, any> };
      bill_updates: Array<Record<string, any>>;
      payments: Array<Record<string, any>>;
      audit_logs: Array<Record<string, any>>;
      stock_movements: Array<Record<string, any>>;
      source_session_ids: string[];
      session_updates: Array<Record<string, any>>;
    };
  };
};

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
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
  const evidence = { runId, selectedCase, stage, recordedAt: new Date().toISOString(), productionAllowed: false, safeForAutomaticRetry: false, ...value };
  assertNoSecrets(evidence);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const target = path.join(evidenceDirectory, `checkout-pricing-${selectedCase}-${stage}-${runId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.linkSync(temporary, target);
  } finally {
    fs.unlinkSync(temporary);
  }
  return path.relative(root, target);
}

async function appStateSnapshot(page: Page, identity: AuthoritativeOrganizationIdentity) {
  const rows = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" });
  expect(rows).toHaveLength(1);
  return { version: rows[0].version, hash: hash(rows[0].data) };
}

async function summaryAmount(checkout: Locator, label: string) {
  const text = await checkout.getByText(label, { exact: true }).locator("..").locator("strong").innerText();
  const amount = Number(text.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(amount)) throw new Error(`Unable to parse checkout ${label}: ${text}`);
  return amount;
}

async function startTimedCheckout(page: Page, playMode: "group" | "solo") {
  const card = stationCard(page, timedStation);
  await expect(card).toContainText("Available");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  const start = page.getByRole("dialog", { name: "Start New Session", exact: true });
  await start.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const mode = start.getByRole("combobox", { name: "Play Mode", exact: true });
  await expect(mode).toBeVisible();
  await mode.selectOption(playMode);
  const started = await submitCaptured(page, "**/rest/v1/rpc/start_session", () => start.getByRole("button", { name: "Start Session", exact: true }).click(), "setup-session-start");
  expect(started.response.status()).toBe(200);
  await expect(start).toBeHidden();
  await waitForSynced(page);

  const managed = await openManagedSession(page, timedStation);
  await managed.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
  const expectedStart = await browserDateTimeLocal(page, -11);
  await managed.getByLabel("Session Start Time", { exact: true }).fill(expectedStart);
  const saved = await submitCaptured(page, "**/rest/v1/rpc/save_live_session_details", () => managed.getByRole("button", { name: "Save Session Details", exact: true }).click(), "setup-session-edit");
  expect(saved.response.status()).toBe(200);
  await waitForSynced(page);
  await managed.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
  await expect(managed.getByLabel("Session Start Time", { exact: true })).toHaveValue(expectedStart);
  await managed.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSynced(page);
  const reloadedManaged = await openManagedSession(page, timedStation);
  await reloadedManaged.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
  await expect(reloadedManaged.getByLabel("Session Start Time", { exact: true })).toHaveValue(expectedStart);
  await reloadedManaged.getByRole("button", { name: "Cancel", exact: true }).click();
  await reloadedManaged.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
  const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
  await expect(checkout.getByLabel("Session Start Time", { exact: true })).toHaveValue(expectedStart);
  const expectedEnd = await browserDateTimeLocal(page, -1);
  await checkout.getByLabel("Session End Time", { exact: true }).fill(expectedEnd);
  await checkout.getByLabel("Session End Time", { exact: true }).blur();
  await expect(checkout.getByLabel("Session End Time", { exact: true })).toHaveValue(expectedEnd);
  await expect.poll(() => summaryAmount(checkout, "Subtotal")).toBeGreaterThan(0);
  return checkout;
}

async function submitCaptured(page: Page, route: string, trigger: () => Promise<void>, stage: string, context: Record<string, unknown> = {}) {
  const command = await interceptSingleRpcCommand(page, route);
  const triggerPromise = trigger();
  const captured = await command.captured;
  expect(command.captureCount()).toBe(1);
  expect(command.wasSubmitted()).toBe(false);
  const preparedPath = writeEvidence(`${stage}-prepared`, { status: "captured-not-submitted", request: captured.body, captureCount: 1, submissionCount: 0, ...context });
  try {
    const responsePromise = command.submit(captured.body);
    const submittedPath = writeEvidence(`${stage}-submitted`, { status: "submitted-once-response-pending", preparedPath, request: captured.body, captureCount: 1, submissionCount: 1, ...context });
    const response = await responsePromise;
    const body = await readApiResponseBody(response);
    const responsePath = writeEvidence(`${stage}-response`, { status: "response-received", preparedPath, submittedPath, request: captured.body, captureCount: 1, submissionCount: 1, response: { status: response.status(), body }, ...context });
    await triggerPromise;
    return { captured, response, body, preparedPath, submittedPath, responsePath };
  } finally {
    await command.dispose();
  }
}

async function createZeroItem(page: Page) {
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Catalog", exact: true }).click();
  const form = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
  await form.getByLabel("Item Name", { exact: true }).fill(zeroItemName);
  await form.locator("select").first().selectOption({ label: "Arcade" });
  await form.getByLabel("Price", { exact: true }).fill("0");
  await form.getByLabel("Opening Stock", { exact: true }).fill("5");
  await form.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
  await form.getByLabel("Barcode", { exact: true }).fill(zeroItemBarcode);
  const result = await submitCaptured(page, "**/rest/v1/rpc/commit_admin_data_change", () => form.getByRole("button", { name: "Create Item", exact: true }).click(), "fixture-create");
  expect(result.response.status()).toBe(200);
  await waitForSynced(page);
  return result;
}

async function startZeroUnitSale(page: Page) {
  await page.getByRole("button", { name: "Live Dashboard", exact: true }).click();
  const card = stationCard(page, unitStation);
  await expect(card).toContainText("Available");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Start New Session", exact: true });
  await modal.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const coinPack = modal.getByRole("combobox", { name: "Coin Pack", exact: true });
  const zeroOption = coinPack.locator("option").filter({ hasText: zeroItemName });
  await expect(zeroOption).toHaveCount(1);
  const zeroOptionValue = await zeroOption.getAttribute("value");
  expect(zeroOptionValue).toBeTruthy();
  await coinPack.selectOption(zeroOptionValue!);
  const result = await submitCaptured(page, "**/rest/v1/rpc/start_session", () => modal.getByRole("button", { name: "Start Session", exact: true }).click(), "fixture-session-start");
  expect(result.response.status()).toBe(200);
  await expect(modal).toBeHidden();
  await waitForSynced(page);
  return result;
}

test("pricing, discount, LTP, and true-zero boundaries remain exact", async ({ browser, page }, testInfo) => {
  test.skip(!Number.isInteger(preflightVersion) || preflightHash.startsWith("missing-"), "An exact reviewed pricing preflight is required.");
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
    await assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", organizationId);
    expect(await appStateSnapshot(page, identity)).toEqual({ version: preflightVersion, hash: preflightHash });

    if (selectedCase === "true_zero_price_guard") {
      const create = await createZeroItem(page);
      const started = await startZeroUnitSale(page);
      const beforeGuard = await appStateSnapshot(page, identity);
      const guardPreparedPath = writeEvidence("guard-prepared", {
        status: "zero-source-ready-before-guard-assertion", customerName, actorId: identity.actorId, unitStation, zeroItemName, zeroItemBarcode,
        adminCreate: { request: create.captured.body, response: create.body }, sessionStart: { request: started.captured.body, response: started.body }, beforeGuard
      });
      const financialRequests: string[] = [];
      page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/rest/v1/rpc/commit_checkout_bill_v2")) financialRequests.push(request.url()); });
      const managed = await openManagedSession(page, unitStation);
      await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await expect(checkout).toContainText(zeroItemName);
      expect(await summaryAmount(checkout, "Subtotal")).toBe(0);
      expect(await summaryAmount(checkout, "Total")).toBe(0);
      const issue = checkout.getByRole("button", { name: "Issue Bill", exact: true });
      await expect(issue).toBeDisabled();
      await expect(issue).toHaveAttribute("title", "Bill total is Rs 0 - add items or remove discounts");
      await page.waitForTimeout(1_000);
      expect(financialRequests).toEqual([]);
      expect(await appStateSnapshot(page, identity)).toEqual(beforeGuard);
      const terminalPath = writeEvidence("terminal", {
        status: "guard-proved-cleanup-required", customerName, actorId: identity.actorId, unitStation, zeroItemName, zeroItemBarcode,
        guardPreparedPath, adminCreate: { request: create.captured.body, response: create.body }, sessionStart: { request: started.captured.body, response: started.body },
        financialRequests, beforeGuard, rpcEvidence, cleanupRequired: { rejectExactSession: true, archiveExactItem: true }
      });
      terminalWritten = true;
      await attachJson(testInfo, "checkout-pricing-terminal", { terminalPath, selectedCase, customerName });
      assertNoPageErrors(originErrors, observerErrors);
      return;
    }

    const checkout = await startTimedCheckout(page, selectedCase === "ltp_zero" ? "solo" : "group");
    if (selectedCase === "discount_rounding_positive") {
      const row = checkout.locator("tbody tr").filter({ hasText: timedStation }).first();
      const discountValue = row.locator("input").first();
      await discountValue.fill("1");
      await discountValue.blur();
      await expect(discountValue).toHaveValue("1");
      await row.getByPlaceholder("required if used", { exact: true }).fill(`QA positive line discount ${runId}`);
      const billDiscount = checkout.getByLabel("Bill Discount Value", { exact: true });
      await billDiscount.fill("1");
      await billDiscount.blur();
      await expect(billDiscount).toHaveValue("1");
      await checkout.getByLabel("Bill Discount Reason", { exact: true }).fill(`QA positive bill discount ${runId}`);
      expect(await summaryAmount(checkout, "Line Discounts")).toBe(1);
      expect(await summaryAmount(checkout, "Bill Discount")).toBe(1);
      expect(Math.abs(await summaryAmount(checkout, "Round Off"))).toBeGreaterThan(0);
      expect(await summaryAmount(checkout, "Total")).toBeGreaterThan(0);
    } else if (selectedCase === "ltp_zero") {
      await checkout.getByRole("combobox", { name: "LTP Result", exact: true }).selectOption("won");
      await expect(checkout).toContainText("Auto LTP discount");
      await expect(checkout.locator('input[disabled][value="LTP win - game charge waived"]')).toHaveCount(1);
      expect(await summaryAmount(checkout, "Subtotal")).toBeGreaterThan(0);
      expect(await summaryAmount(checkout, "Total")).toBe(0);
    } else {
      await checkout.getByRole("combobox", { name: "Bill Discount Type", exact: true }).selectOption("percentage");
      const value = checkout.getByLabel("Bill Discount Value", { exact: true });
      await value.fill("100");
      await value.blur();
      await expect(value).toHaveValue("100");
      await checkout.getByLabel("Bill Discount Reason", { exact: true }).fill(`QA full bill discount ${runId}`);
      expect(await summaryAmount(checkout, "Subtotal")).toBeGreaterThan(0);
      expect(await summaryAmount(checkout, "Bill Discount")).toBeGreaterThan(0);
      expect(await summaryAmount(checkout, "Total")).toBe(0);
    }

    const authoritativePreSubmitSessions = await readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", {
      organization_id: `eq.${organizationId}`,
      customer_name: `eq.${customerName}`,
      select: "id,started_at,ended_at,customer_name,customer_phone"
    });
    expect(authoritativePreSubmitSessions).toHaveLength(1);
    const beforeFinancial = await appStateSnapshot(page, identity);
    const committed = await submitCaptured(page, "**/rest/v1/rpc/commit_checkout_bill_v2", () => checkout.getByRole("button", { name: "Issue Bill", exact: true }).click(), "financial", { beforeFinancial, authoritativePreSubmitSessions });
    expect(committed.response.status()).toBe(200);
    const envelope = structuredClone(committed.captured.body) as FinancialEnvelope;
    expect(envelope.payload.organization_id).toBe(organizationId);
    expect(envelope.payload.mutation_kind).toBe("commitCheckoutBill");
    expect(envelope.payload.payload.primary_bill.id).toBeTruthy();
    expect(envelope.payload.payload.primary_bill.billNumber).toBeTruthy();
    await expect(checkout).toBeHidden();
    await waitForSynced(page);
    const afterFinancial = await appStateSnapshot(page, identity);
    expect(afterFinancial).toEqual(beforeFinancial);
    const terminalPath = writeEvidence("terminal", {
      status: "browser-passed", customerName, actorId: identity.actorId, timedStation,
      command: envelope, response: committed.body, financialWindow: { before: beforeFinancial, after: afterFinancial }, rpcEvidence
    });
    terminalWritten = true;
    await attachJson(testInfo, "checkout-pricing-terminal", { terminalPath, selectedCase, customerName });
    assertNoPageErrors(originErrors, observerErrors);
  } catch (error) {
    primaryError = error;
    if (!terminalWritten) writeEvidence("failure", { status: "browser-failed", customerName, error: safeError(error), rpcEvidence });
    throw error;
  } finally {
    await attachFailureScreenshot(testInfo, page, "checkout-pricing-failure");
    await observer.context.close();
    void primaryError;
  }
});
