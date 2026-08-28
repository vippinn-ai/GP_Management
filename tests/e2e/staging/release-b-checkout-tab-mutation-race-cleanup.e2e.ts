import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
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

const cleanupRunId = process.env.E2E_RUN_ID ?? "missing-cleanup-run-id";
const sourceRunId = process.env.E2E_TAB_MUTATION_SOURCE_RUN_ID ?? "missing-source-run-id";
const recoveryArtifact = process.env.E2E_TAB_MUTATION_RACE_RECOVERY_ARTIFACT ?? "missing-recovery-artifact";
const expectedRecoveryHash = process.env.E2E_TAB_MUTATION_RECOVERY_SHA256 ?? "missing-recovery-hash";
const organizationId = "org-primary";

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(stable(entry)))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, JSON.parse(stable(entry))])));
  return JSON.stringify(value);
}
function changedIds(result: Record<string, unknown>, collection: string) {
  const rows = result.changed_rows as Record<string, unknown> | undefined;
  const values = rows?.[collection];
  return Array.isArray(values) ? values.map(String) : [];
}
function checkpoint(phase: string, value: unknown) {
  const directory = path.join(process.cwd(), "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-tab-mutation-race-cleanup-${phase}-${cleanupRunId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
  return path.relative(process.cwd(), target);
}
async function openTab(page: Page, customerName: string) {
  await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
  const chip = page.locator("button.tab-chip").filter({ hasText: customerName });
  await expect(chip).toHaveCount(1);
  await chip.evaluate((button: HTMLButtonElement) => button.click());
  await expect(chip).toHaveClass(/is-active/);
}
async function mutationResults(page: Page, restBase: string, headers: Record<string, string>, snapshot: Array<Record<string, unknown>>) {
  return await Promise.all(snapshot.map(async (expected) => {
    const response = await page.request.post(`${restBase}/rpc/get_financial_mutation_result`, {
      headers,
      data: { payload: { organization_id: organizationId, mutation_id: expected.mutationId, mutation_kind: "commitCheckoutBill" } }
    });
    expect(response.status()).toBe(200);
    return { mutationId: expected.mutationId, result: await response.json() };
  }));
}

test("fresh identity-bound cleanup preserves every reconciled source effect", async ({ page }, testInfo) => {
  const recoveryPath = path.resolve(process.cwd(), recoveryArtifact);
  test.skip(!fs.existsSync(recoveryPath), "An exact recovery artifact is required.");
  const recoveryBytes = fs.readFileSync(recoveryPath);
  expect(createHash("sha256").update(recoveryBytes).digest("hex")).toBe(expectedRecoveryHash);
  const recovery = JSON.parse(recoveryBytes.toString("utf8"));
  expect(cleanupRunId).not.toBe(sourceRunId);
  expect(recovery).toMatchObject({
    runId: sourceRunId,
    projectRef: "tkbdyzxwwbhkpztgjjxh",
    productionAllowed: false,
    safeForAutomaticRetry: false,
    safeForIdentityBoundCleanup: true,
    failures: []
  });
  const errors = capturePageErrors(page);
  const requests: Parameters<typeof captureAuthenticatedRestRequests>[1] = [];
  captureAuthenticatedRestRequests(page, requests);
  const evidence: Record<string, unknown> = {
    cleanupRunId,
    sourceRunId,
    recoveryArtifact,
    recoverySha256: expectedRecoveryHash,
    productionAllowed: false,
    safeForAutomaticRetry: false,
    actions: []
  };
  let primaryError: unknown;
  try {
    await signIn(page, credentials("A"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, requests, "admin", organizationId);
    expect(identity.actorId).toBe(recovery.actors.checkout);
    const tabIds = recovery.snapshot.tabs.map((row: Record<string, unknown>) => String(row.id));
    const billIds = recovery.snapshot.bills.map((row: Record<string, unknown>) => String(row.id));
    const priorEventIds = recovery.snapshot.events.map((row: Record<string, unknown>) => String(row.id));
    const priorAuditIds = recovery.snapshot.audits.map((row: Record<string, unknown>) => String(row.id));
    const itemId = recovery.fixture.itemId as string | null;
    const comboId = recovery.fixture.comboId as string | null;

    const [itemsBefore, combosBefore, tabsBefore, tabItemsBefore, comboAppsBefore, billsBefore, linesBefore,
      paymentsBefore, movementsBefore, eventsBefore, auditsBefore, openSessionsBefore, openTabsBefore, stateBefore,
      mutationsBefore] = await Promise.all([
      itemId ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", {
        organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,stock_qty,active,archived_by_user_id,archive_reason"
      }) : Promise.resolve([]),
      comboId ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "combos", {
        organization_id: `eq.${organizationId}`, id: `eq.${comboId}`, select: "id,name,type,active"
      }) : Promise.resolve([]),
      tabIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", {
        organization_id: `eq.${organizationId}`, id: `in.(${tabIds.join(",")})`, select: "id,customer_name,status,close_disposition,closed_bill_id"
      }) : Promise.resolve([]),
      tabIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tab_items", {
        organization_id: `eq.${organizationId}`, customer_tab_id: `in.(${tabIds.join(",")})`,
        select: "id,customer_tab_id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id"
      }) : Promise.resolve([]),
      tabIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tab_combo_applications", {
        organization_id: `eq.${organizationId}`, customer_tab_id: `in.(${tabIds.join(",")})`, select: "id,customer_tab_id,combo_id,combo_name,price"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", {
        organization_id: `eq.${organizationId}`, id: `in.(${billIds.join(",")})`, select: "id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_lines", {
        organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.join(",")})`,
        select: "id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,combo_application_id,combo_id"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "payments", {
        organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.join(",")})`,
        select: "id,bill_id,amount,mode,received_by_user_id,settlement_group_id,related_checkout_bill_id"
      }) : Promise.resolve([]),
      itemId ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", {
        organization_id: `eq.${organizationId}`, item_id: `eq.${itemId}`, select: "id,item_id,type,quantity,reason,user_id,related_bill_id"
      }) : Promise.resolve([]),
      priorEventIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", {
        organization_id: `eq.${organizationId}`, id: `in.(${priorEventIds.join(",")})`, select: "id,event_type,entity_type,entity_id,created_by,metadata"
      }) : Promise.resolve([]),
      priorAuditIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", {
        organization_id: `eq.${organizationId}`, id: `in.(${priorAuditIds.join(",")})`, select: "id,action,entity_type,entity_id,user_id,message"
      }) : Promise.resolve([]),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", {
        organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,customer_name,status"
      }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", {
        organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,customer_name,status"
      }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      }),
      mutationResults(page, identity.restBase, identity.headers, recovery.snapshot.mutationResults)
    ]);
    const liveBefore = {
      item: itemsBefore, combo: combosBefore, tabs: tabsBefore, tabItems: tabItemsBefore,
      comboApplications: comboAppsBefore, bills: billsBefore, lines: linesBefore, payments: paymentsBefore,
      movements: movementsBefore, events: eventsBefore, audits: auditsBefore, mutations: mutationsBefore,
      appState: { version: stateBefore[0].version, hash: hash(stateBefore[0].data) }
    };
    expect(stable(liveBefore.item)).toBe(stable(recovery.snapshot.item));
    expect(stable(liveBefore.combo)).toBe(stable(recovery.snapshot.combo));
    expect(stable(liveBefore.tabs)).toBe(stable(recovery.snapshot.tabs));
    expect(stable(liveBefore.tabItems)).toBe(stable(recovery.snapshot.tabItems));
    expect(stable(liveBefore.comboApplications)).toBe(stable(recovery.snapshot.comboApplications));
    expect(stable(liveBefore.bills)).toBe(stable(recovery.snapshot.bills));
    expect(stable(liveBefore.lines)).toBe(stable(recovery.snapshot.lines));
    expect(stable(liveBefore.payments)).toBe(stable(recovery.snapshot.payments));
    expect(stable(liveBefore.movements)).toBe(stable(recovery.snapshot.movements));
    expect(stable(liveBefore.events)).toBe(stable(recovery.snapshot.events));
    expect(stable(liveBefore.audits)).toBe(stable(recovery.snapshot.audits));
    expect(stable(liveBefore.mutations)).toBe(stable(recovery.snapshot.mutationResults));
    expect(liveBefore.appState).toEqual(recovery.snapshot.appState);
    expect(openSessionsBefore).toEqual([]);
    expect(stable(openTabsBefore)).toBe(stable(recovery.openFloor.tabs));
    evidence.before = liveBefore;
    evidence.preparedPath = checkpoint("prepared", evidence);
    let expectedVersion = stateBefore[0].version;

    for (const tab of openTabsBefore) {
      await openTab(page, String(tab.customer_name));
      const reason = `Authorized tab-mutation recovery ${sourceRunId} ${cleanupRunId} ${tab.id}`;
      const responsePromise = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/reject_customer_tab") && response.request().method() === "POST"
      );
      page.once("dialog", (dialog) => dialog.accept(reason));
      await page.getByRole("button", { name: "Reject Tab", exact: true }).click();
      const response = await responsePromise;
      const result = await readApiResponseBody(response) as Record<string, unknown>;
      expect(response.status()).toBe(200);
      const acknowledgementPath = checkpoint(`reject-${tab.id}-acknowledged`, {
        cleanupRunId, sourceRunId, recoveryArtifact, recoverySha256: expectedRecoveryHash,
        productionAllowed: false, safeForAutomaticRetry: false, tab, reason, result
      });
      (evidence.actions as unknown[]).push({ type: "reject_customer_tab", tab, reason, result, acknowledgementPath });
      expectedVersion += 1;
      await waitForSynced(page);
      const state = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      });
      expect(state[0].version).toBe(expectedVersion);
      (evidence.actions as Array<Record<string, unknown>>).at(-1)!.compatibility = { version: state[0].version, hash: hash(state[0].data) };
      (evidence.actions as Array<Record<string, unknown>>).at(-1)!.verifiedPath = checkpoint(`reject-${tab.id}-verified`, evidence);
    }

    if (combosBefore[0]?.active) {
      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Combos", exact: true }).click();
      const row = page.locator(".combo-list-row").filter({ has: page.getByText(String(combosBefore[0].name), { exact: true }) });
      await expect(row).toHaveCount(1);
      const responsePromise = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST");
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const response = await responsePromise;
      const result = await readApiResponseBody(response) as Record<string, unknown>;
      expect(response.status()).toBe(200);
      const acknowledgementPath = checkpoint("combo-archive-acknowledged", {
        cleanupRunId, sourceRunId, recoveryArtifact, recoverySha256: expectedRecoveryHash,
        productionAllowed: false, safeForAutomaticRetry: false, comboId, result
      });
      (evidence.actions as unknown[]).push({ type: "archive_combo", comboId, result, acknowledgementPath });
      expectedVersion += 1;
      await waitForSynced(page);
      const state = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      });
      expect(state[0].version).toBe(expectedVersion);
      (evidence.actions as Array<Record<string, unknown>>).at(-1)!.compatibility = { version: state[0].version, hash: hash(state[0].data) };
      (evidence.actions as Array<Record<string, unknown>>).at(-1)!.verifiedPath = checkpoint("combo-archive-verified", evidence);
    }

    if (itemsBefore[0]?.active) {
      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Catalog", exact: true }).click();
      const row = page.locator(".inventory-table-wrap tbody tr").filter({ has: page.getByText(String(itemsBefore[0].name), { exact: true }) });
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemsBefore[0].name}`, exact: true });
      const reason = `Authorized tab-mutation recovery ${sourceRunId} ${cleanupRunId}`;
      await dialog.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(reason);
      const responsePromise = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST");
      await dialog.getByRole("button", { name: "Archive Item", exact: true }).click();
      const response = await responsePromise;
      const result = await readApiResponseBody(response) as Record<string, unknown>;
      expect(response.status()).toBe(200);
      const acknowledgementPath = checkpoint("item-archive-acknowledged", {
        cleanupRunId, sourceRunId, recoveryArtifact, recoverySha256: expectedRecoveryHash,
        productionAllowed: false, safeForAutomaticRetry: false, itemId, reason, result
      });
      (evidence.actions as unknown[]).push({ type: "archive_item", itemId, reason, result, acknowledgementPath });
      expectedVersion += 1;
      await waitForSynced(page);
      const state = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      });
      expect(state[0].version).toBe(expectedVersion);
      (evidence.actions as Array<Record<string, unknown>>).at(-1)!.compatibility = { version: state[0].version, hash: hash(state[0].data) };
      (evidence.actions as Array<Record<string, unknown>>).at(-1)!.verifiedPath = checkpoint("item-archive-verified", evidence);
    }

    const actionEventIds = (evidence.actions as Array<Record<string, unknown>>).flatMap((entry) => {
      const result = entry.result as Record<string, unknown>;
      return [...(typeof result.event_id === "string" ? [result.event_id] : []), ...changedIds(result, "operational_events")];
    });
    const actionAuditIds = (evidence.actions as Array<Record<string, unknown>>).flatMap((entry) =>
      changedIds(entry.result as Record<string, unknown>, "audit_logs"));
    const [itemsAfter, combosAfter, tabsAfter, tabItemsAfter, comboAppsAfter, billsAfter, linesAfter,
      paymentsAfter, movementsAfter, priorEventsAfter, priorAuditsAfter, actionEvents, actionAudits,
      openSessionsAfter, openTabsAfter, stateAfter, mutationsAfter] = await Promise.all([
      itemId ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", {
        organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,stock_qty,active,archived_by_user_id,archive_reason"
      }) : Promise.resolve([]),
      comboId ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "combos", {
        organization_id: `eq.${organizationId}`, id: `eq.${comboId}`, select: "id,name,type,active"
      }) : Promise.resolve([]),
      tabIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", {
        organization_id: `eq.${organizationId}`, id: `in.(${tabIds.join(",")})`, select: "id,customer_name,status,close_disposition,closed_bill_id"
      }) : Promise.resolve([]),
      tabIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tab_items", {
        organization_id: `eq.${organizationId}`, customer_tab_id: `in.(${tabIds.join(",")})`,
        select: "id,customer_tab_id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id"
      }) : Promise.resolve([]),
      tabIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tab_combo_applications", {
        organization_id: `eq.${organizationId}`, customer_tab_id: `in.(${tabIds.join(",")})`, select: "id,customer_tab_id,combo_id,combo_name,price"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", {
        organization_id: `eq.${organizationId}`, id: `in.(${billIds.join(",")})`, select: "id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_lines", {
        organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.join(",")})`,
        select: "id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,combo_application_id,combo_id"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "payments", {
        organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.join(",")})`,
        select: "id,bill_id,amount,mode,received_by_user_id,settlement_group_id,related_checkout_bill_id"
      }) : Promise.resolve([]),
      itemId ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", {
        organization_id: `eq.${organizationId}`, item_id: `eq.${itemId}`, select: "id,item_id,type,quantity,reason,user_id,related_bill_id"
      }) : Promise.resolve([]),
      priorEventIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", {
        organization_id: `eq.${organizationId}`, id: `in.(${priorEventIds.join(",")})`, select: "id,event_type,entity_type,entity_id,created_by,metadata"
      }) : Promise.resolve([]),
      priorAuditIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", {
        organization_id: `eq.${organizationId}`, id: `in.(${priorAuditIds.join(",")})`, select: "id,action,entity_type,entity_id,user_id,message"
      }) : Promise.resolve([]),
      actionEventIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", {
        organization_id: `eq.${organizationId}`, id: `in.(${actionEventIds.join(",")})`, select: "id,event_type,entity_type,entity_id,created_by,metadata"
      }) : Promise.resolve([]),
      actionAuditIds.length ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", {
        organization_id: `eq.${organizationId}`, id: `in.(${actionAuditIds.join(",")})`, select: "id,action,entity_type,entity_id,user_id,message"
      }) : Promise.resolve([]),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", {
        organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,status"
      }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", {
        organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,status"
      }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      }),
      mutationResults(page, identity.restBase, identity.headers, recovery.snapshot.mutationResults)
    ]);
    expect(stable(tabItemsAfter)).toBe(stable(tabItemsBefore));
    expect(stable(comboAppsAfter)).toBe(stable(comboAppsBefore));
    expect(stable(billsAfter)).toBe(stable(billsBefore));
    expect(stable(linesAfter)).toBe(stable(linesBefore));
    expect(stable(paymentsAfter)).toBe(stable(paymentsBefore));
    expect(stable(movementsAfter)).toBe(stable(movementsBefore));
    expect(stable(priorEventsAfter)).toBe(stable(eventsBefore));
    expect(stable(priorAuditsAfter)).toBe(stable(auditsBefore));
    expect(stable(mutationsAfter)).toBe(stable(mutationsBefore));
    expect(openSessionsAfter).toEqual([]);
    expect(openTabsAfter).toEqual([]);
    for (const before of tabsBefore) {
      const after = tabsAfter.find((row) => row.id === before.id);
      if (openTabsBefore.some((row) => row.id === before.id)) {
        expect(after).toEqual(expect.objectContaining({ id: before.id, customer_name: before.customer_name, status: "closed", close_disposition: "rejected", closed_bill_id: null }));
      } else {
        expect(stable(after)).toBe(stable(before));
      }
    }
    if (itemsBefore.length) expect(itemsAfter[0]).toEqual(expect.objectContaining({
      id: itemsBefore[0].id, name: itemsBefore[0].name, stock_qty: itemsBefore[0].stock_qty,
      active: false, archived_by_user_id: identity.actorId
    }));
    if (combosBefore.length) expect(combosAfter[0]).toEqual(expect.objectContaining({ id: combosBefore[0].id, name: combosBefore[0].name, type: combosBefore[0].type, active: false }));
    expect(actionEvents).toHaveLength(actionEventIds.length);
    expect(actionEvents.every((row) => row.created_by === identity.actorId)).toBe(true);
    expect(actionAudits).toHaveLength(actionAuditIds.length);
    expect(actionAudits.every((row) => row.user_id === identity.actorId)).toBe(true);
    expect(stateAfter[0].version).toBe(expectedVersion);
    const finalSnapshot = {
      item: itemsAfter, combo: combosAfter, tabs: tabsAfter, tabItems: tabItemsAfter,
      comboApplications: comboAppsAfter, bills: billsAfter, lines: linesAfter, payments: paymentsAfter,
      movements: movementsAfter, priorEvents: priorEventsAfter, priorAudits: priorAuditsAfter,
      actionEvents, actionAudits, mutationResults: mutationsAfter,
      openFloor: { sessions: openSessionsAfter, tabs: openTabsAfter },
      appState: { version: stateAfter[0].version, hash: hash(stateAfter[0].data) }
    };
    evidence.final = finalSnapshot;
    evidence.finalPath = checkpoint("final", evidence);
    expect(errors.consoleErrors).toEqual([]);
  } catch (error) {
    primaryError = error;
    evidence.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    await attachJson(testInfo, "checkout-tab-mutation-race-cleanup-evidence", evidence);
    await attachFailureScreenshot(testInfo, page, "checkout-tab-mutation-race-cleanup-failure");
    if (!primaryError && !(evidence.final as Record<string, unknown> | undefined)?.appState) {
      // eslint-disable-next-line no-unsafe-finally
      throw new Error("Cleanup completed without an immutable final checkpoint.");
    }
  }
});
