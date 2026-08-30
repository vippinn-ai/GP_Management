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
  createObserver,
  credentials,
  readApiResponseBody,
  readRestRows,
  signIn,
  type AuthoritativeOrganizationIdentity,
  type CapturedRpcRequest,
  waitForSynced
} from "./support/app";

const root = process.cwd();
const resumeRunId = process.env.E2E_RUN_ID ?? "missing-resume-run";
const sourceRunId = process.env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID ?? "missing-source-run";
const recoveryPath = path.resolve(process.env.E2E_REPLACEMENT_PARITY_RECOVERY_ARTIFACT ?? "");
const preflightPath = path.resolve(process.env.E2E_REPLACEMENT_PARITY_PREFLIGHT_ARTIFACT ?? "");
const hasBoundArtifacts = fs.existsSync(recoveryPath) && fs.statSync(recoveryPath).isFile() && fs.existsSync(preflightPath) && fs.statSync(preflightPath).isFile();
const recoveryRaw = hasBoundArtifacts ? fs.readFileSync(recoveryPath) : Buffer.from("{}");
const preflightRaw = hasBoundArtifacts ? fs.readFileSync(preflightPath) : Buffer.from("{}");
const recovery = JSON.parse(recoveryRaw.toString("utf8"));
const preflight = JSON.parse(preflightRaw.toString("utf8"));
const expectedRecoverySha = process.env.E2E_REPLACEMENT_PARITY_RECOVERY_SHA256;
const readOnlyRpcAllowlist = new Set(["current_user_org_role", "get_financial_mutation_result", "load_analytics_summary", "load_inventory_report_summary"]);

function sha(value: Buffer | string) { return createHash("sha256").update(value).digest("hex"); }
function dataHash(value: unknown) { return sha(JSON.stringify(value)); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
function sorted(rows: Array<Record<string, unknown>>) {
  return [...rows].sort((left, right) => `${left.id}|${left.bill_id ?? ""}`.localeCompare(`${right.id}|${right.bill_id ?? ""}`)).map(stable);
}
function parseMoney(value: string) {
  const amount = Number(value.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(amount)) throw new Error(`Unable to parse currency value: ${value}`);
  return Number(amount.toFixed(2));
}
function assertNoSecrets(value: unknown) {
  const raw = JSON.stringify(value);
  expect(raw).not.toMatch(/"(?:authorization|apikey|password|access_token|refresh_token)"\s*:/i);
  expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
}
function checkpoint(stage: string, value: Record<string, unknown>) {
  const evidence = { resumeRunId, sourceRunId, stage, recordedAt: new Date().toISOString(), readOnly: true, productionAllowed: false, safeForAutomaticRetry: false, recoveryArtifact: path.relative(root, recoveryPath), recoverySha256: sha(recoveryRaw), ...value };
  assertNoSecrets(evidence);
  const directory = path.join(root, "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-replacement-parity-resume-${stage}-${resumeRunId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { fs.linkSync(temporary, target); } finally { fs.unlinkSync(temporary); }
  return path.relative(root, target);
}
async function appStateSnapshot(page: Page, identity: AuthoritativeOrganizationIdentity) {
  const rows = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" });
  expect(rows).toHaveLength(1);
  return { version: rows[0].version, hash: dataHash(rows[0].data) };
}
async function billRow(page: Page, billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  return row;
}
async function installReadOnlyRpcGuard(page: Page, blocked: Array<{ method: string; rpc: string }>, allowed: Array<{ method: string; rpc: string }>) {
  await page.route("**/rest/v1/rpc/**", async (route) => {
    const request = route.request();
    const rpc = new URL(request.url()).pathname.split("/").pop() ?? "unknown";
    if (request.method() === "POST" && readOnlyRpcAllowlist.has(rpc)) {
      allowed.push({ method: request.method(), rpc });
      await route.continue();
      return;
    }
    blocked.push({ method: request.method(), rpc });
    await route.abort("blockedbyclient");
  });
}

test("resumes only downstream read parity for the SHA-bound committed replacement", async ({ browser, page }, testInfo) => {
  test.skip(!hasBoundArtifacts, "Exact SHA-bound reanalysis and preflight artifacts are required.");
  const originRequests: CapturedRpcRequest[] = [];
  const observerRequests: CapturedRpcRequest[] = [];
  const blockedRpcRequests: Array<{ method: string; rpc: string }> = [];
  const allowedReadRpcRequests: Array<{ method: string; rpc: string }> = [];
  await installReadOnlyRpcGuard(page, blockedRpcRequests, allowedReadRpcRequests);
  const observer = await createObserver(browser);
  await installReadOnlyRpcGuard(observer.page, blockedRpcRequests, allowedReadRpcRequests);
  captureAuthenticatedRestRequests(page, originRequests);
  captureAuthenticatedRestRequests(observer.page, observerRequests);
  const originErrors = capturePageErrors(page);
  const observerErrors = capturePageErrors(observer.page);
  let terminalWritten = false;
  try {
    expect(sha(recoveryRaw)).toBe(expectedRecoverySha);
    expect(recovery).toMatchObject({ runId: sourceRunId, projectRef: "tkbdyzxwwbhkpztgjjxh", status: "partial", productionAllowed: false, safeForAutomaticRetry: false, integrityFailures: [], ambiguities: [], safeForIdentityBoundCleanup: true });
    expect(recovery.completionFailures).toEqual(["Browser terminal evidence is missing."]);
    expect(sha(preflightRaw)).toBe(recovery.evidence.preflight.sha256);
    const pending = preflight.pendingReceivable;
    expect(pending).toMatchObject({ status: "pending" });
    expect(Number(pending.amount_due)).toBeGreaterThan(0);

    await signIn(page, credentials("A"));
    await signIn(observer.page, credentials("B"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, originRequests, "admin", "org-primary");
    const observerIdentity = await assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", "org-primary");
    expect(identity.actorId).toBe(recovery.actors.origin);
    expect(observerIdentity.actorId).toBe(recovery.actors.observer);
    const snapshot = recovery.snapshot as Record<string, any>;
    const ids = recovery.identities as Record<string, string>;
    const billIds = snapshot.bills.map((row: Record<string, unknown>) => String(row.id));
    const eventIds = snapshot.events.map((row: Record<string, unknown>) => String(row.id));
    const auditIds = snapshot.audits.map((row: Record<string, unknown>) => String(row.id));
    const exact = async (table: string, expected: Array<Record<string, unknown>>, query: Record<string, string>) => {
      const actual = await readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, table, query);
      expect(sorted(actual), `${table} drifted from SHA-bound recovery.`).toEqual(sorted(expected));
      return actual;
    };
    const readCanonical = async (actorPage: Page, actorIdentity: AuthoritativeOrganizationIdentity, expected: Record<string, any>) => {
      const response = await actorPage.request.post(`${actorIdentity.restBase}/rpc/get_financial_mutation_result`, { headers: actorIdentity.headers, data: { payload: { organization_id: "org-primary", mutation_id: expected.mutation_id, mutation_kind: "commitCheckoutBill" } } });
      expect(response.status()).toBe(200);
      return readApiResponseBody(response);
    };
    const [items, tabs, bills, pendingBills, lines, payments, movements, events, audits, openSessions, openTabs, canonical] = await Promise.all([
      exact("inventory_items", snapshot.items, { organization_id: "eq.org-primary", id: `eq.${ids.itemId}`, select: "id,name,barcode,category,price,stock_qty,active,archived_by_user_id,archive_reason" }),
      exact("customer_tabs", snapshot.tabs, { organization_id: "eq.org-primary", id: `eq.${ids.tabId}`, select: "id,status,close_disposition,closed_bill_id,customer_id,customer_name,close_reason" }),
      exact("bills", snapshot.bills, { organization_id: "eq.org-primary", id: `in.(${billIds.join(",")})`, select: "id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,issued_by_user_id,customer_id,customer_name" }),
      exact("bills", [pending], { organization_id: "eq.org-primary", id: `eq.${pending.id}`, select: "id,bill_number,status,customer_name,customer_phone,amount_due" }),
      exact("bill_lines", snapshot.lines, { organization_id: "eq.org-primary", bill_id: `in.(${billIds.join(",")})`, select: "id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,linked_session_id" }),
      exact("payments", snapshot.payments, { organization_id: "eq.org-primary", bill_id: `in.(${billIds.join(",")})`, select: "id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id" }),
      exact("stock_movements", snapshot.movements, { organization_id: "eq.org-primary", related_bill_id: `in.(${billIds.join(",")})`, select: "id,item_id,type,quantity,reason,related_bill_id,user_id" }),
      exact("operational_events", snapshot.events, { organization_id: "eq.org-primary", id: `in.(${eventIds.join(",")})`, select: "id,event_type,entity_type,entity_id,created_by,metadata,created_at" }),
      exact("audit_logs", snapshot.audits, { organization_id: "eq.org-primary", id: `in.(${auditIds.join(",")})`, select: "id,action,entity_type,entity_id,message,user_id,created_at" }),
      exact("sessions", snapshot.openSessions, { organization_id: "eq.org-primary", status: "neq.closed", select: "id,status,customer_name" }),
      exact("customer_tabs", snapshot.openTabs, { organization_id: "eq.org-primary", status: "eq.open", select: "id,status,customer_name" }),
      Promise.all(snapshot.mutationStatuses.map((expected: Record<string, any>, index: number) => readCanonical(index === 0 ? page : observer.page, index === 0 ? identity : observerIdentity, expected)))
    ]);
    expect(canonical.map(stable)).toEqual(snapshot.mutationStatuses.map(stable));
    const financialState = await appStateSnapshot(page, identity);
    expect(financialState).toEqual(snapshot.appState);
    expect(items).toEqual([expect.objectContaining({ id: ids.itemId, stock_qty: 4, active: true })]);
    expect(tabs).toEqual([expect.objectContaining({ id: ids.tabId, status: "closed", close_disposition: "billed", closed_bill_id: ids.originalBillId })]);
    checkpoint("prepared", { status: "sha-bound-source-revalidated", actors: { origin: identity.actorId, observer: observerIdentity.actorId }, source: { items, tabs, bills, pendingBills, lines, payments, movements, events, audits, canonical, openSessions, openTabs, appState: financialState } });

    await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), observer.page.reload({ waitUntil: "domcontentloaded" })]);
    await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
    const originalRow = await billRow(page, ids.originalBillNumber);
    await expect(originalRow).toContainText("Replaced");
    const replacementRow = await billRow(page, ids.replacementBillNumber);
    await expect(replacementRow).toContainText("Issued");
    await replacementRow.click();
    const preview = page.locator(".bill-register-preview-pane");
    await expect(preview.getByRole("heading", { name: ids.replacementBillNumber, exact: true })).toBeVisible();
    await expect(preview.getByText("Replaces", { exact: true }).locator("..")).toContainText(ids.originalBillNumber);
    await expect(preview.getByText(ids.itemName, { exact: true })).toBeVisible();
    await expect(preview.getByText("₹50.00", { exact: true }).first()).toBeVisible();
    const paymentMeta = await preview.getByText("Payment", { exact: true }).locator("..").innerText();
    expect(paymentMeta).toContain("CASH");
    const replacementPayment = payments.find((payment) => payment.bill_id === ids.replacementBillId)!;
    expect(replacementPayment).toMatchObject({ id: expect.any(String), mode: "cash", amount: 50, received_by_user_id: observerIdentity.actorId });

    await page.getByRole("button", { name: /^Receivables \(\d+\)$/ }).click();
    await page.getByPlaceholder("Search customer, phone or pending bill #...").fill(pending.bill_number);
    const receivableGroupRow = page.locator("tr.receivable-row").filter({ hasText: pending.customer_name });
    await expect(receivableGroupRow).toBeVisible();
    await receivableGroupRow.getByRole("button", { name: "View", exact: true }).click();
    const receivableDetailRow = page.locator("tr.receivable-detail-row").filter({ hasText: pending.bill_number });
    await expect(receivableDetailRow).toBeVisible();
    const receivableText = `${await receivableGroupRow.innerText()}\n${await receivableDetailRow.innerText()}`;
    expect(receivableText).toContain(String(pending.customer_name));
    expect(receivableText).toContain(String(pending.bill_number));

    const analyticsPromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/load_analytics_summary") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    const analyticsResponse = await analyticsPromise;
    expect(analyticsResponse.status()).toBe(200);
    const analyticsPayload = await readApiResponseBody(analyticsResponse) as Record<string, any>;
    const renderedGross = parseMoney(await page.getByText("Gross Revenue", { exact: true }).first().locator("..").locator("strong").innerText());
    const backendGross = Number(Number(analyticsPayload.summary?.gross_revenue ?? 0).toFixed(2));
    expect(renderedGross).toBe(backendGross);
    const analyticsPending = analyticsPayload.pending_receivables?.find((entry: Record<string, unknown>) => entry.bill_number === pending.bill_number);
    expect(analyticsPending).toMatchObject({ bill_id: pending.id, bill_number: pending.bill_number, customer_name: pending.customer_name });
    expect(Number(analyticsPending.amount_due)).toBe(Number(pending.amount_due));
    const analyticsPendingRow = page.getByRole("heading", { name: "Pending Receivables", exact: true }).locator("xpath=../..").locator("tbody tr").filter({ hasText: pending.bill_number });
    await expect(analyticsPendingRow).toBeVisible();

    await observer.page.getByRole("button", { name: "Customer Profiles", exact: true }).click();
    await observer.page.getByPlaceholder("Search by name or phone").fill(ids.customerName);
    const customerChip = observer.page.locator("button.tab-chip").filter({ hasText: ids.customerName });
    await expect(customerChip).toContainText("1 visits");
    await expect(customerChip).toContainText("₹50.00");
    const customerChipText = await customerChip.innerText();
    await customerChip.click();
    const recentVisits = observer.page.getByRole("heading", { name: "Recent Billed Visits", exact: true }).locator("xpath=../..");
    await expect(recentVisits).toContainText(ids.replacementBillNumber);
    await expect(recentVisits).not.toContainText(ids.originalBillNumber);

    await observer.page.getByRole("button", { name: "Inventory", exact: true }).click();
    const initialReport = observer.page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/load_inventory_report_summary") && response.request().method() === "POST");
    await observer.page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Inventory Report", exact: true }).click();
    expect((await initialReport).status()).toBe(200);
    const filteredReport = observer.page.waitForResponse((response) => {
      if (!response.url().includes("/rest/v1/rpc/load_inventory_report_summary") || response.request().method() !== "POST") return false;
      try { return response.request().postDataJSON()?.p_search_query === ids.itemName; } catch { return false; }
    });
    await observer.page.getByPlaceholder("Item, category, bill, reason").fill(ids.itemName);
    const inventoryResponse = await filteredReport;
    expect(inventoryResponse.status()).toBe(200);
    const inventoryPayload = await readApiResponseBody(inventoryResponse) as Record<string, any>;
    const backendInventoryRow = inventoryPayload.rows?.find((entry: Record<string, unknown>) => entry.item_id === ids.itemId);
    expect(backendInventoryRow).toMatchObject({ item_id: ids.itemId, item_name: ids.itemName, category: "Beverages", active: true, added: 0, deducted: 2, manual_adjustments: 0, reversals: 1, net_change: -1, current_stock: 4, reserved: 0 });
    const backendDetails = (inventoryPayload.details ?? []).filter((entry: Record<string, unknown>) => entry.item_id === ids.itemId);
    expect(backendDetails.map((entry: Record<string, unknown>) => [entry.related_bill_number, entry.type, Number(entry.quantity)]).sort()).toEqual([[ids.originalBillNumber, "sale", -2], [ids.replacementBillNumber, "void_refund_reversal", 1]].sort());
    const itemSummary = observer.page.getByRole("heading", { name: "Item Summary", exact: true }).locator("xpath=../..").locator("table tbody tr").filter({ hasText: ids.itemName });
    await expect(itemSummary).toBeVisible();
    const renderedInventory = (await itemSummary.locator("td").allInnerTexts()).map((text) => text.trim());
    expect(renderedInventory).toEqual([ids.itemName, "Beverages", "Active", "0", "2", "0", "1", "-1", "4", "0"]);
    const movementDetails = observer.page.getByRole("heading", { name: "Movement Details", exact: true }).locator("xpath=../..").locator("table tbody tr").filter({ hasText: ids.itemName });
    await expect(movementDetails).toHaveCount(2);
    const originalMovementRow = movementDetails.filter({ has: observer.page.getByRole("cell", { name: "Sale", exact: true }) });
    const replacementMovementRow = movementDetails.filter({ has: observer.page.getByRole("cell", { name: "Void/Refund Restore", exact: true }) });
    await expect(originalMovementRow).toHaveCount(1);
    await expect(replacementMovementRow).toHaveCount(1);
    await expect(originalMovementRow.locator("td").nth(4)).toHaveText("-2");
    await expect(originalMovementRow.locator("td").nth(6)).toHaveText(ids.originalBillNumber);
    await expect(replacementMovementRow.locator("td").nth(4)).toHaveText("+1");
    await expect(replacementMovementRow.locator("td").nth(6)).toHaveText(ids.replacementBillNumber);

    expect(await appStateSnapshot(page, identity)).toEqual(financialState);
    expect(blockedRpcRequests).toEqual([]);
    expect(allowedReadRpcRequests.some((entry) => entry.rpc === "load_analytics_summary")).toBe(true);
    expect(allowedReadRpcRequests.some((entry) => entry.rpc === "load_inventory_report_summary")).toBe(true);
    const terminalPath = checkpoint("terminal", {
      status: "passed",
      actors: { origin: identity.actorId, observer: observerIdentity.actorId },
      fixture: { ...ids, pendingBillNumber: pending.bill_number },
      financialState,
      sourceSnapshot: { items, tabs, bills, pendingBills, lines, payments, movements, events, audits, canonical, openSessions, openTabs },
      uiParity: {
        hardRefreshContexts: 2,
        billRegister: { original: { id: ids.originalBillId, number: ids.originalBillNumber, status: "Replaced" }, replacement: { id: ids.replacementBillId, number: ids.replacementBillNumber, status: "Issued" } },
        receipt: { billId: ids.replacementBillId, billNumber: ids.replacementBillNumber, replacesBillId: ids.originalBillId, replacesBillNumber: ids.originalBillNumber, payment: replacementPayment, renderedPayment: paymentMeta, renderedTotal: 50 },
        pendingReceivable: { billNumber: pending.bill_number, renderedRow: receivableText, backend: analyticsPending },
        analytics: { renderedGross, backendGross, response: analyticsPayload },
        customerAnalytics: { customerName: ids.customerName, renderedDirectoryEntry: customerChipText, visitCount: 1, totalSpend: 50, recentBillNumber: ids.replacementBillNumber },
        inventoryReport: { renderedRow: renderedInventory, backendRow: backendInventoryRow, backendDetails }
      },
      blockedRpcRequests,
      allowedReadRpcRequests
    });
    terminalWritten = true;
    await attachJson(testInfo, "release-b-checkout-replacement-parity-resume", { terminalPath });
    assertNoPageErrors(originErrors, observerErrors);
  } finally {
    if (!terminalWritten) checkpoint("failure", { status: "failed", blockedRpcRequests, allowedReadRpcRequests });
    await attachFailureScreenshot(testInfo, page, "replacement-parity-resume-origin-failure");
    await attachFailureScreenshot(testInfo, observer.page, "replacement-parity-resume-observer-failure");
    await observer.context.close();
  }
});
