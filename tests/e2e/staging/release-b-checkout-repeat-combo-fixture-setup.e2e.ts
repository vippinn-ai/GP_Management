import { createHash } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIResponse } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  captureRpcEvidence,
  credentials,
  readRestRows,
  signIn,
  waitForSynced,
  type RpcEvidence
} from "./support/app";

const runId = process.env.E2E_FIXTURE_RUN_ID ?? "missing-fixture-run-id";
const organizationId = "org-primary";
const itemName = process.env.E2E_FIXTURE_ITEM_NAME ?? "missing-fixture-item";
const comboName = process.env.E2E_FIXTURE_COMBO_NAME ?? "missing-fixture-combo";
const stationName = process.env.E2E_FIXTURE_STATION_NAME ?? "missing-fixture-station";
const stationId = process.env.E2E_FIXTURE_STATION_ID ?? "missing-fixture-station-id";
const preflightVersion = Number(process.env.E2E_FIXTURE_PREFLIGHT_VERSION);
const preflightHash = process.env.E2E_FIXTURE_PREFLIGHT_HASH ?? "missing-preflight-hash";

type AdminResult = {
  mutation_id: string;
  event_id: string;
  entity_id: string;
  app_state_version: number;
  changed_rows: Record<string, string[]>;
};

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function responseJson(response: APIResponse | import("@playwright/test").Response) {
  const body = await response.text();
  try {
    return JSON.parse(body) as AdminResult;
  } catch {
    throw new Error(`Admin-data RPC returned non-JSON: ${body.slice(0, 300)}`);
  }
}

function exactIds(result: AdminResult, collection: string) {
  const ids = result.changed_rows?.[collection] ?? [];
  return [...ids].sort();
}

async function checkpoint(stage: "prepared" | "item-created" | "combo-created" | "final", value: unknown) {
  const directory = path.join(process.cwd(), "test-artifacts", "checkpoints");
  await mkdir(directory, { recursive: true });
  const outputPath = path.join(directory, `checkout-repeat-combo-fixture-${runId}-${stage}.json`);
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ runId, stage, recordedAt: new Date().toISOString(), ...value as object }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  try {
    await link(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return path.relative(process.cwd(), outputPath);
}

test("creates the isolated repeat-combo staging fixture through two exact UI commits", async ({ page }, testInfo) => {
  test.skip(
    [itemName, comboName, stationName, stationId, preflightHash].some((value) => value.startsWith("missing-")) ||
      !Number.isInteger(preflightVersion),
    "The locked fixture preflight environment is required."
  );

  const pageErrors = capturePageErrors(page);
  const rpcEvidence: RpcEvidence[] = [];
  const restRequests: Parameters<typeof captureAuthenticatedRestRequests>[1] = [];
  captureRpcEvidence(page, "origin", rpcEvidence);
  captureAuthenticatedRestRequests(page, restRequests);
  const evidence: Record<string, unknown> = { runId, itemName, comboName, stationName, stationId, phase: "starting" };

  try {
    await signIn(page, credentials("A"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, restRequests, "admin", organizationId);
    const baselineState = await readRestRows<{ version: number; data: unknown }>(
      page,
      identity.restBase,
      identity.headers,
      "app_state",
      { id: "eq.primary", select: "version,data" }
    );
    expect(baselineState).toHaveLength(1);
    expect({ version: baselineState[0].version, hash: hash(baselineState[0].data) }).toEqual({
      version: preflightVersion,
      hash: preflightHash
    });
    evidence.actorId = identity.actorId;
    evidence.preflightAppState = { version: preflightVersion, hash: preflightHash };
    evidence.phase = "prepared";
    evidence.checkpoints = {
      prepared: await checkpoint("prepared", {
        actorId: identity.actorId,
        itemName,
        comboName,
        stationName,
        stationId,
        appState: evidence.preflightAppState
      })
    };

    await page.getByRole("button", { name: "Inventory", exact: true }).click();
    await page.getByRole("tablist", { name: "Inventory section", exact: true })
      .getByRole("button", { name: "Catalog", exact: true }).click();
    const createItemForm = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
    await createItemForm.getByLabel("Item Name", { exact: true }).fill(itemName);
    await createItemForm.locator("select").first().selectOption({ label: "Food" });
    await createItemForm.getByLabel("Price", { exact: true }).fill("0");
    await createItemForm.getByLabel("Opening Stock", { exact: true }).fill("20");
    await createItemForm.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
    await createItemForm.getByLabel("Barcode", { exact: true }).fill(`QA-${runId}`);
    await expect(createItemForm.getByLabel("Reusable item", { exact: true })).not.toBeChecked();
    const itemResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
    );
    await createItemForm.getByRole("button", { name: "Create Item", exact: true }).click();
    const itemResponse = await itemResponsePromise;
    expect(itemResponse.status()).toBe(200);
    const itemResult = await responseJson(itemResponse);
    evidence.itemResult = itemResult;
    evidence.phase = "item-response-acknowledged";
    const itemId = exactIds(itemResult, "inventory_items")[0] ?? null;
    (evidence.checkpoints as Record<string, string>)["item-created"] = await checkpoint("item-created", {
      actorId: identity.actorId,
      itemName,
      itemId,
      result: itemResult
    });
    expect(itemResult.app_state_version).toBe(preflightVersion + 1);
    expect(exactIds(itemResult, "inventory_items")).toHaveLength(1);
    expect(exactIds(itemResult, "sale_variants")).toEqual(exactIds(itemResult, "inventory_items"));
    expect(exactIds(itemResult, "audit_logs")).toHaveLength(1);
    expect(exactIds(itemResult, "stock_movements")).toEqual([]);
    expect(Object.keys(itemResult.changed_rows).sort()).toEqual(["audit_logs", "inventory_items", "sale_variants"]);
    evidence.phase = "item-created";
    await waitForSynced(page);

    const itemRows = await readRestRows<Record<string, unknown>>(
      page,
      identity.restBase,
      identity.headers,
      "inventory_items",
      { organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,category,price,stock_qty,low_stock_threshold,is_reusable,barcode,active,sell_base_item" }
    );
    expect(itemRows).toEqual([{
      id: itemId,
      name: itemName,
      category: "Food",
      price: 0,
      stock_qty: 20,
      low_stock_threshold: 0,
      is_reusable: false,
      barcode: `QA-${runId}`,
      active: true,
      sell_base_item: true
    }]);
    evidence.item = itemRows[0];

    await page.getByRole("tablist", { name: "Inventory section", exact: true })
      .getByRole("button", { name: "Combos", exact: true }).click();
    const comboForm = page.getByRole("button", { name: "Create Combo", exact: true }).locator("xpath=ancestor::form");
    await comboForm.getByLabel("Combo Name", { exact: true }).fill(comboName);
    await comboForm.getByLabel("Combo Price", { exact: true }).fill("199");
    await comboForm.locator("select").first().selectOption("game");
    await comboForm.getByLabel("Included Game Minutes", { exact: true }).fill("60");
    await expect(comboForm.getByLabel("Active combo", { exact: true })).toBeChecked();
    const stationCheckbox = comboForm.getByLabel(stationName, { exact: true });
    await expect(stationCheckbox).not.toBeChecked();
    await stationCheckbox.check();
    await comboForm.getByRole("button", { name: "Add Fixed Item", exact: true }).click();
    const fixedRows = comboForm.locator(".combo-config-row");
    await expect(fixedRows).toHaveCount(1);
    const fixedRow = fixedRows.first();
    await fixedRow.locator("select").first().selectOption({ label: itemName });
    await fixedRow.getByLabel("Qty", { exact: true }).fill("1");
    const comboResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
    );
    await comboForm.getByRole("button", { name: "Create Combo", exact: true }).click();
    const comboResponse = await comboResponsePromise;
    expect(comboResponse.status()).toBe(200);
    const comboResult = await responseJson(comboResponse);
    evidence.comboResult = comboResult;
    evidence.phase = "combo-response-acknowledged";
    const comboId = exactIds(comboResult, "combos")[0] ?? null;
    (evidence.checkpoints as Record<string, string>)["combo-created"] = await checkpoint("combo-created", {
      actorId: identity.actorId,
      itemName,
      itemId,
      comboName,
      comboId,
      result: comboResult
    });
    expect(comboResult.app_state_version).toBe(preflightVersion + 2);
    expect(exactIds(comboResult, "combos")).toHaveLength(1);
    expect(exactIds(comboResult, "audit_logs")).toHaveLength(1);
    expect(exactIds(comboResult, "inventory_items")).toEqual([]);
    expect(exactIds(comboResult, "stock_movements")).toEqual([]);
    expect(Object.keys(comboResult.changed_rows).sort()).toEqual(["audit_logs", "combos"]);
    evidence.phase = "combo-created";
    await waitForSynced(page);

    const [combos, itemIdentityRows, itemBarcodeRows, comboIdentityRows, stationTargets, fixedItems, audits, events, movements, openSessions, openTabs, finalState] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "combos", { organization_id: `eq.${organizationId}`, id: `eq.${comboId}`, select: "id,name,type,active,price,included_minutes" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, name: `eq.${itemName}`, select: "id,name,barcode" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, barcode: `eq.QA-${runId}`, select: "id,name,barcode" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "combos", { organization_id: `eq.${organizationId}`, name: `eq.${comboName}`, select: "id,name" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "combo_station_targets", { organization_id: `eq.${organizationId}`, combo_id: `eq.${comboId}`, select: "combo_id,station_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "combo_fixed_items", { organization_id: `eq.${organizationId}`, combo_id: `eq.${comboId}`, select: "combo_id,id,sellable_option_id,quantity" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", { organization_id: `eq.${organizationId}`, id: `in.(${[...exactIds(itemResult, "audit_logs"), ...exactIds(comboResult, "audit_logs")].join(",")})`, select: "id,action,entity_type,entity_id,user_id,message" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", { organization_id: `eq.${organizationId}`, id: `in.(${itemResult.event_id},${comboResult.event_id})`, select: "id,event_type,entity_type,entity_id,created_by,metadata" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, item_id: `eq.${itemId}`, select: "id,item_id,type,quantity" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,status,customer_name" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,status,customer_name" }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" })
    ]);

    expect(combos).toEqual([{ id: comboId, name: comboName, type: "game", active: true, price: 199, included_minutes: 60 }]);
    expect(itemIdentityRows).toEqual([{ id: itemId, name: itemName, barcode: `QA-${runId}` }]);
    expect(itemBarcodeRows).toEqual(itemIdentityRows);
    expect(comboIdentityRows).toEqual([{ id: comboId, name: comboName }]);
    expect(stationTargets).toEqual([{ combo_id: comboId, station_id: stationId }]);
    expect(fixedItems).toHaveLength(1);
    expect(fixedItems[0]).toMatchObject({ combo_id: comboId, sellable_option_id: itemId, quantity: 1 });
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "inventory_created", entity_type: "inventory_item", entity_id: itemId, user_id: identity.actorId }),
      expect.objectContaining({ action: "combo_created", entity_type: "combo", entity_id: comboId, user_id: identity.actorId })
    ]));
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: itemResult.event_id, event_type: "admin_data_committed", entity_type: "admin_data", created_by: identity.actorId }),
      expect.objectContaining({ id: comboResult.event_id, event_type: "admin_data_committed", entity_type: "admin_data", created_by: identity.actorId })
    ]));
    expect(events.map((event) => (event.metadata as Record<string, unknown>).mutation_id).sort()).toEqual([itemResult.mutation_id, comboResult.mutation_id].sort());
    expect(movements).toEqual([]);
    expect(openSessions).toEqual([]);
    expect(openTabs).toEqual([]);
    expect(finalState).toHaveLength(1);
    expect(finalState[0].version).toBe(preflightVersion + 2);
    const compatibility = finalState[0].data as { inventoryItems?: Array<Record<string, unknown>>; combos?: Array<Record<string, unknown>> };
    const compatibilityItems = compatibility.inventoryItems?.filter((item) => item.name === itemName || item.barcode === `QA-${runId}`) ?? [];
    const compatibilityCombos = compatibility.combos?.filter((combo) => combo.name === comboName) ?? [];
    expect(compatibilityItems).toHaveLength(1);
    expect(compatibilityItems[0]).toMatchObject({ id: itemId, name: itemName, category: "Food", price: 0, stockQty: 20, lowStockThreshold: 0, isReusable: false, barcode: `QA-${runId}`, active: true, sellBaseItem: true });
    expect(compatibilityCombos).toHaveLength(1);
    expect(compatibilityCombos[0]).toMatchObject({ id: comboId, name: comboName, type: "game", active: true, price: 199, includedMinutes: 60, stationIds: [stationId] });
    expect(compatibilityCombos[0].fixedItems).toEqual([expect.objectContaining({ sellableOptionId: itemId, quantity: 1 })]);
    await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_admin_data_change").length).toBe(2);
    const adminRpcs = rpcEvidence.filter((entry) => entry.rpc === "commit_admin_data_change");
    expect(adminRpcs).toHaveLength(2);
    expect(adminRpcs.map((entry) => entry.status)).toEqual([200, 200]);
    expect(new Set(adminRpcs.map((entry) => entry.mutationId)).size).toBe(2);
    expect(adminRpcs.map((entry) => entry.mutationId)).toEqual([itemResult.mutation_id, comboResult.mutation_id]);
    expect(adminRpcs.map((entry) => entry.eventId)).toEqual([itemResult.event_id, comboResult.event_id]);
    expect(adminRpcs.map((entry) => entry.entityId)).toEqual([itemResult.entity_id, comboResult.entity_id]);
    expect(adminRpcs.map((entry) => entry.changedRows)).toEqual([itemResult.changed_rows, comboResult.changed_rows]);
    assertNoPageErrors(pageErrors);

    Object.assign(evidence, {
      phase: "final",
      combo: combos[0],
      stationTarget: stationTargets[0],
      fixedItem: fixedItems[0],
      audits,
      events,
      stockMovements: movements,
      openSessions,
      openTabs,
      compatibility: { item: compatibilityItems[0], combo: compatibilityCombos[0] },
      appState: { version: finalState[0].version, hash: hash(finalState[0].data) },
      rpcEvidence,
      pageErrors
    });
    (evidence.checkpoints as Record<string, string>).final = await checkpoint("final", evidence);
  } finally {
    await attachJson(testInfo, "checkout-repeat-combo-fixture-setup-evidence", evidence);
    await attachFailureScreenshot(testInfo, page, "checkout-repeat-combo-fixture-setup-failure");
  }
});
