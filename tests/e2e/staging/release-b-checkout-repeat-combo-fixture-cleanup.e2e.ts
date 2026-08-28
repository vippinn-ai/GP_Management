import { createHash } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  credentials,
  readApiResponseBody,
  readRestRows,
  signIn,
  waitForSynced
} from "./support/app";

const fixtureRunId = process.env.E2E_FIXTURE_RUN_ID ?? "missing-fixture-run-id";
const cleanupRunId = process.env.E2E_FIXTURE_CLEANUP_RUN_ID ?? "missing-cleanup-run-id";
const itemName = process.env.E2E_FIXTURE_ITEM_NAME ?? "missing-fixture-item";
const comboName = process.env.E2E_FIXTURE_COMBO_NAME ?? "missing-fixture-combo";
const itemId = process.env.E2E_FIXTURE_ITEM_ID ?? "missing-fixture-item-id";
const comboId = process.env.E2E_FIXTURE_COMBO_ID ?? "missing-fixture-combo-id";
const expectedStockQty = Number(process.env.E2E_FIXTURE_CLEANUP_STOCK_QTY);
const expectedEffects = Number(process.env.E2E_FIXTURE_CLEANUP_EFFECTS);
const baselineVersion = Number(process.env.E2E_FIXTURE_CLEANUP_BASELINE_VERSION);
const baselineHash = process.env.E2E_FIXTURE_CLEANUP_BASELINE_HASH ?? "missing-cleanup-hash";
const organizationId = "org-primary";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function checkpoint(stage: "prepared" | "combo-archived" | "item-archived" | "final", value: object) {
  const directory = path.join(process.cwd(), "test-artifacts", "checkpoints");
  await mkdir(directory, { recursive: true });
  const outputPath = path.join(directory, `checkout-repeat-combo-fixture-cleanup-${cleanupRunId}-${stage}.json`);
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ fixtureRunId, cleanupRunId, stage, recordedAt: new Date().toISOString(), ...value }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await link(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return path.relative(process.cwd(), outputPath);
}

test("archives only the identity-bound staging fixture after separate authorization", async ({ page }, testInfo) => {
  test.skip(![1, 2].includes(expectedEffects) || !Number.isInteger(baselineVersion), "An authorized fixture cleanup report is required.");
  const errors = capturePageErrors(page);
  const requests: Parameters<typeof captureAuthenticatedRestRequests>[1] = [];
  captureAuthenticatedRestRequests(page, requests);
  const evidence: Record<string, unknown> = { fixtureRunId, cleanupRunId, itemName, comboName, expectedEffects, phase: "starting", checkpoints: {} };
  try {
    await signIn(page, credentials("A"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, requests, "admin", organizationId);
    const [baseline, beforeItems, beforeCombos, movementsBefore, sessionsBefore, tabsBefore] = await Promise.all([
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,active,stock_qty" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "combos", { organization_id: `eq.${organizationId}`, id: `eq.${comboId}`, select: "id,name,active" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, item_id: `eq.${itemId}`, select: "id,item_id,type,quantity" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, status: "eq.open", select: "id" })
    ]);
    expect({ version: baseline[0].version, hash: hash(baseline[0].data) }).toEqual({ version: baselineVersion, hash: baselineHash });
    expect(beforeItems).toEqual([{ id: itemId, name: itemName, active: true, stock_qty: expectedStockQty }]);
    expect(beforeCombos).toEqual([{ id: comboId, name: comboName, active: true }]);
    expect(sessionsBefore).toEqual([]);
    expect(tabsBefore).toEqual([]);
    (evidence.checkpoints as Record<string, string>).prepared = await checkpoint("prepared", { actorId: identity.actorId, appState: { version: baselineVersion, hash: baselineHash }, expectedEffects, itemName, comboName });
    evidence.phase = "prepared";
    const results: Record<string, unknown>[] = [];

    await page.getByRole("button", { name: "Inventory", exact: true }).click();
    if (expectedEffects === 2) {
      await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Combos", exact: true }).click();
      const comboRow = page.locator(".combo-list-row").filter({ has: page.getByText(comboName, { exact: true }) });
      await expect(comboRow).toHaveCount(1);
      const responsePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST");
      await comboRow.getByRole("button", { name: "Archive", exact: true }).click();
      const response = await responsePromise;
      const result = await readApiResponseBody(response);
      results.push(result);
      (evidence.checkpoints as Record<string, string>)["combo-archived"] = await checkpoint("combo-archived", { actorId: identity.actorId, result });
      evidence.phase = "combo-archived";
      expect(response.status()).toBe(200);
      await waitForSynced(page);
    }

    await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Catalog", exact: true }).click();
    const itemRow = page.locator(".inventory-table-wrap tbody tr").filter({ has: page.getByText(itemName, { exact: true }) });
    await expect(itemRow).toHaveCount(1);
    await itemRow.getByRole("button", { name: "Archive", exact: true }).click();
    const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
    await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(`Authorized QA fixture cleanup ${fixtureRunId}`);
    const itemResponsePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST");
    await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
    const itemResponse = await itemResponsePromise;
    const itemResult = await readApiResponseBody(itemResponse);
    results.push(itemResult);
    (evidence.checkpoints as Record<string, string>)["item-archived"] = await checkpoint("item-archived", { actorId: identity.actorId, result: itemResult });
    evidence.phase = "item-archived";
    expect(itemResponse.status()).toBe(200);
    await waitForSynced(page);

    expect(results).toHaveLength(expectedEffects);
    expect(new Set(results.map((result) => result.mutation_id)).size).toBe(expectedEffects);
    const auditIds = results.flatMap((result) => (result.changed_rows as Record<string, string[]> | undefined)?.audit_logs ?? []);
    const eventIds = results.map((result) => String(result.event_id));
    const [items, combos, audits, events, movements, finalState, sessions, tabs] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,active,stock_qty,archived_by_user_id,archive_reason" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "combos", { organization_id: `eq.${organizationId}`, id: `eq.${comboId}`, select: "id,name,active" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", { organization_id: `eq.${organizationId}`, id: `in.(${auditIds.join(",")})`, select: "id,action,entity_id,user_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", { organization_id: `eq.${organizationId}`, id: `in.(${eventIds.join(",")})`, select: "id,event_type,created_by,metadata" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, item_id: `eq.${itemId}`, select: "id,item_id,type,quantity" }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, status: "eq.open", select: "id" })
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: itemId, name: itemName, active: false, stock_qty: expectedStockQty, archived_by_user_id: identity.actorId, archive_reason: `Authorized QA fixture cleanup ${fixtureRunId}` });
    expect(combos).toHaveLength(expectedEffects === 2 ? 1 : 0);
    if (combos.length) expect(combos[0]).toMatchObject({ name: comboName, active: false });
    expect(audits).toHaveLength(expectedEffects);
    expect(audits.every((audit) => audit.user_id === identity.actorId)).toBe(true);
    expect(audits.map((audit) => audit.action).sort()).toEqual(expectedEffects === 2 ? ["combo_archived", "inventory_archived"] : ["inventory_archived"]);
    expect(events).toHaveLength(expectedEffects);
    expect(events.every((event) => event.event_type === "admin_data_committed" && event.created_by === identity.actorId)).toBe(true);
    expect(movements.sort((left, right) => String(left.id).localeCompare(String(right.id)))).toEqual(
      movementsBefore.sort((left, right) => String(left.id).localeCompare(String(right.id)))
    );
    expect(finalState[0].version).toBe(baselineVersion + expectedEffects);
    expect(sessions).toEqual([]);
    expect(tabs).toEqual([]);
    assertNoPageErrors(errors);
    Object.assign(evidence, { phase: "final", actorId: identity.actorId, results, items, combos, audits, events, stockMovements: movements, appState: { version: finalState[0].version, hash: hash(finalState[0].data) }, errors });
    (evidence.checkpoints as Record<string, string>).final = await checkpoint("final", evidence);
  } finally {
    await attachJson(testInfo, "checkout-repeat-combo-fixture-cleanup-evidence", evidence);
    await attachFailureScreenshot(testInfo, page, "checkout-repeat-combo-fixture-cleanup-failure");
  }
});
