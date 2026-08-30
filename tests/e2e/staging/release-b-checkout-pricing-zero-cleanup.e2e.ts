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
  credentials,
  interceptSingleRpcCommand,
  readApiResponseBody,
  readRestRows,
  rejectSessionIfOpen,
  signIn,
  type CapturedRpcRequest,
  waitForSynced
} from "./support/app";

const root = process.cwd();
const organizationId = "org-primary";
const cleanupRunId = process.env.E2E_RUN_ID ?? "missing-cleanup-run";
const sourceRunId = process.env.E2E_PRICING_SOURCE_RUN_ID ?? "missing-source-run";
const recoveryPath = process.env.E2E_PRICING_RECOVERY_ARTIFACT ? path.resolve(process.env.E2E_PRICING_RECOVERY_ARTIFACT) : null;
const recoverySha = process.env.E2E_PRICING_RECOVERY_SHA256 ?? "missing-recovery-sha";
const customerName = process.env.E2E_PRICING_CUSTOMER_NAME ?? "missing-customer";
const stationName = process.env.E2E_PRICING_UNIT_STATION ?? "missing-station";
const sessionId = process.env.E2E_PRICING_CLEANUP_SESSION_ID ?? "missing-session";
const itemId = process.env.E2E_PRICING_ZERO_ITEM_ID ?? "missing-item";
const itemName = process.env.E2E_PRICING_ZERO_ITEM_NAME ?? "missing-item-name";
const itemBarcode = process.env.E2E_PRICING_ZERO_ITEM_BARCODE ?? "missing-barcode";
const baselineVersion = Number(process.env.E2E_PRICING_CLEANUP_BASE_VERSION);
const baselineHash = process.env.E2E_PRICING_CLEANUP_BASE_HASH ?? "missing-baseline-hash";
const expectedEffects = Number(process.env.E2E_PRICING_CLEANUP_EXPECTED_EFFECTS);

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
function sortedRows(rows: Array<Record<string, unknown>>) {
  return [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id))).map(stable);
}
function inFilter(ids: string[]) { return `in.(${ids.join(",")})`; }
function checkpoint(stage: string, value: Record<string, unknown>) {
  const directory = path.join(root, "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-pricing-zero-cleanup-${stage}-${cleanupRunId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ cleanupRunId, sourceRunId, stage, recordedAt: new Date().toISOString(), productionAllowed: false, safeForAutomaticRetry: false, ...value }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.linkSync(temporary, target);
  } finally {
    fs.unlinkSync(temporary);
  }
  return path.relative(root, target);
}
async function snapshot(page: Page, identity: { restBase: string; headers: Record<string, string> }) {
  const rows = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" });
  expect(rows).toHaveLength(1);
  return { version: rows[0].version, hash: hash(rows[0].data) };
}
async function submitCaptured(page: Page, route: string, trigger: () => Promise<unknown>, stage: string) {
  const command = await interceptSingleRpcCommand(page, route);
  const ui = trigger();
  const captured = await command.captured;
  expect(command.captureCount()).toBe(1);
  expect(command.wasSubmitted()).toBe(false);
  const preparedPath = checkpoint(`${stage}-prepared`, { status: "captured-not-submitted", request: captured.body, captureCount: 1, submissionCount: 0 });
  try {
    const responsePromise = command.submit(captured.body);
    const submittedPath = checkpoint(`${stage}-submitted`, { status: "submitted-once-response-pending", preparedPath, request: captured.body, captureCount: 1, submissionCount: 1 });
    const response = await responsePromise;
    const body = await readApiResponseBody(response);
    const responsePath = checkpoint(`${stage}-response`, { status: "response-received", preparedPath, submittedPath, request: captured.body, response: { status: response.status(), body }, captureCount: 1, submissionCount: 1 });
    await ui;
    return { response, body, preparedPath, submittedPath, responsePath };
  } finally {
    await command.dispose();
  }
}

test("applies only the exact reconciler-authorized pricing cleanup actions", async ({ page }, testInfo) => {
  test.skip(!recoveryPath || !Number.isInteger(baselineVersion) || ![1, 2].includes(expectedEffects) || recoverySha.startsWith("missing-"), "Exact SHA-bound recovery evidence is required.");
  const errors = capturePageErrors(page);
  const requests: CapturedRpcRequest[] = [];
  captureAuthenticatedRestRequests(page, requests);
  const evidence: Record<string, unknown> = { cleanupRunId, sourceRunId, sessionId, itemId, phase: "starting" };
  try {
    const recoveryRaw = fs.readFileSync(recoveryPath!);
    expect(createHash("sha256").update(recoveryRaw).digest("hex")).toBe(recoverySha);
    const recovery = JSON.parse(recoveryRaw.toString("utf8"));
    expect(recovery).toMatchObject({ runId: sourceRunId, status: "partial", safeForIdentityBoundCleanup: true, integrityFailures: [], ambiguities: [] });
    const sessionCandidate = recovery.snapshot.cleanupCandidates[0] ?? null;
    const itemCandidate = recovery.snapshot.itemCleanupCandidate ?? null;
    expect(recovery.snapshot.cleanupCandidates.length + (itemCandidate ? 1 : 0)).toBe(expectedEffects);
    if (sessionCandidate) expect(sessionCandidate).toEqual({ id: sessionId, customerName, stationName });
    if (itemCandidate) expect(itemCandidate).toEqual({ id: itemId, name: itemName, barcode: itemBarcode });

    await signIn(page, credentials("A"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, requests, "admin", organizationId);
    expect(await snapshot(page, identity)).toEqual({ version: baselineVersion, hash: baselineHash });
    const sourceSessionIds = recovery.snapshot.sessions.map((row: { id: string }) => row.id);
    const billIds = recovery.snapshot.bills.map((row: { id: string }) => row.id);
    const eventIds = recovery.snapshot.runEvents.map((row: { id: string }) => row.id);
    const expectedSourceAudits = [...recovery.snapshot.startAudits, ...recovery.snapshot.editAudits, ...recovery.snapshot.audits, ...recovery.snapshot.itemAudits]
      .filter((row: { id: string }, index: number, rows: Array<{ id: string }>) => rows.findIndex((candidate) => candidate.id === row.id) === index);
    const auditIds = expectedSourceAudits.map((row: { id: string }) => row.id);
    expect(recovery.snapshot.financialCanonical).toBeNull();
    const [sessions, bills, lines, payments, lineDiscounts, billDiscounts, financialMovements, sourceEvents, sourceAudits, sessionItems, itemMovements, items, openSessions, openTabs] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: `eq.${organizationId}`, customer_name: `eq.${customerName}`, select: "id,status,mode,customer_name,customer_phone,station_id,station_name_snapshot,started_at,ended_at,closed_bill_id,close_disposition,close_reason,play_mode,ltp_eligible,ltp_outcome,ltp_discount_applied,raw_data" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", { organization_id: `eq.${organizationId}`, customer_name: `eq.${customerName}`, select: "id,bill_number,status,payment_mode,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,issued_by_user_id,session_id,raw_data" }),
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_lines", { organization_id: `eq.${organizationId}`, bill_id: inFilter(billIds), select: "id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id,inventory_item_id" }) : [],
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "payments", { organization_id: `eq.${organizationId}`, bill_id: inFilter(billIds), select: "id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id" }) : [],
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_line_discounts", { organization_id: `eq.${organizationId}`, bill_id: inFilter(billIds), select: "id,bill_id,target_id,discount_type,value,amount,reason,applied_by_user_id" }) : [],
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_discounts", { organization_id: `eq.${organizationId}`, bill_id: inFilter(billIds), select: "id,bill_id,discount_type,value,amount,reason,applied_by_user_id" }) : [],
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, related_bill_id: inFilter(billIds), select: "id,item_id,type,quantity,reason,user_id,related_bill_id" }) : [],
      eventIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", { organization_id: `eq.${organizationId}`, id: inFilter(eventIds), select: "id,event_type,entity_type,entity_id,created_by,metadata" }) : [],
      auditIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", { organization_id: `eq.${organizationId}`, id: inFilter(auditIds), select: "id,action,entity_type,entity_id,message,user_id" }) : [],
      sourceSessionIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "session_items", { organization_id: `eq.${organizationId}`, session_id: inFilter(sourceSessionIds), select: "id,session_id,inventory_item_id,name,quantity,unit_price" }) : [],
      itemCandidate ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, item_id: `eq.${itemId}`, select: "id,item_id,type,quantity,related_bill_id" }) : [],
      itemCandidate ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,category,price,stock_qty,low_stock_threshold,active,is_reusable,barcode,sell_base_item" }) : [],
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,customer_name,station_name_snapshot,status" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,customer_name,status" })
    ]);
    expect(sortedRows(sessions)).toEqual(sortedRows(recovery.snapshot.sessions));
    expect(sortedRows(bills)).toEqual(sortedRows(recovery.snapshot.bills));
    expect(sortedRows(lines)).toEqual(sortedRows(recovery.snapshot.lines));
    expect(sortedRows(payments)).toEqual(sortedRows(recovery.snapshot.payments));
    expect(sortedRows(lineDiscounts)).toEqual(sortedRows(recovery.snapshot.lineDiscounts));
    expect(sortedRows(billDiscounts)).toEqual(sortedRows(recovery.snapshot.billDiscounts));
    expect(sortedRows(financialMovements)).toEqual(sortedRows(recovery.snapshot.movements));
    expect(sortedRows(sourceEvents)).toEqual(sortedRows(recovery.snapshot.runEvents));
    expect(sortedRows(sourceAudits)).toEqual(sortedRows(expectedSourceAudits));
    expect(sortedRows(sessionItems)).toEqual(sortedRows(recovery.snapshot.sessionItems));
    expect(sortedRows(itemMovements)).toEqual(sortedRows(recovery.snapshot.itemMovements));
    expect(sortedRows(items)).toEqual(sortedRows(itemCandidate ? [recovery.snapshot.item] : []));
    expect(sortedRows(openSessions)).toEqual(sortedRows(recovery.floor.openSessions));
    expect(sortedRows(openTabs)).toEqual(sortedRows(recovery.floor.openTabs));
    if (sessionCandidate) expect(sessions).toContainEqual(expect.objectContaining({ id: sessionId, status: "active", customer_name: customerName, station_name_snapshot: stationName, closed_bill_id: null }));
    if (itemCandidate) expect(items).toEqual([expect.objectContaining({ id: itemId, name: itemName, barcode: itemBarcode, category: "Arcade", price: 0, stock_qty: 5, active: true })]);
    evidence.prepared = checkpoint("prepared", { actorId: identity.actorId, appState: { version: baselineVersion, hash: baselineHash }, verifiedSnapshot: { sessions, bills, lines, payments, lineDiscounts, billDiscounts, financialMovements, sourceEvents, sourceAudits, sessionItems, itemMovements, items, openSessions, openTabs } });
    evidence.phase = "prepared";

    const reason = `Pricing identity-bound cleanup ${sourceRunId} via ${cleanupRunId}`;
    let rejected: Awaited<ReturnType<typeof submitCaptured>> | null = null;
    if (sessionCandidate) {
      rejected = await submitCaptured(page, "**/rest/v1/rpc/reject_session", () => rejectSessionIfOpen(page, stationName, customerName, reason), "session-reject");
      expect(rejected.response.status()).toBe(200);
      evidence.rejection = rejected.body;
      evidence.phase = "session-rejected";
      await waitForSynced(page);
    }

    let archived: Awaited<ReturnType<typeof submitCaptured>> | null = null;
    if (itemCandidate) {
      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Catalog", exact: true }).click();
      const row = page.locator(".inventory-table-wrap tbody tr").filter({ has: page.getByText(itemName, { exact: true }) });
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
      await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(reason);
      archived = await submitCaptured(page, "**/rest/v1/rpc/commit_admin_data_change", () => archive.getByRole("button", { name: "Archive Item", exact: true }).click(), "item-archive");
      expect(archived.response.status()).toBe(200);
      evidence.archive = archived.body;
      evidence.phase = "item-archived";
      await waitForSynced(page);
    }

    const finalState = await snapshot(page, identity);
    expect(finalState.version).toBe(baselineVersion + expectedEffects);
    const terminalPath = checkpoint("terminal", { status: "browser-passed", actorId: identity.actorId, reason, expectedEffects, rejection: rejected?.body ?? null, archive: archived?.body ?? null, finalState });
    evidence.terminalPath = terminalPath;
    evidence.phase = "terminal";
    assertNoPageErrors(errors);
    await attachJson(testInfo, "checkout-pricing-zero-cleanup", evidence);
  } finally {
    await attachFailureScreenshot(testInfo, page, "checkout-pricing-zero-cleanup-failure");
  }
});
