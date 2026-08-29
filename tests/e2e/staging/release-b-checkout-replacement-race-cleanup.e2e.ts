import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  attachJson,
  captureAuthenticatedRestRequests,
  createObserver,
  credentials,
  readApiResponseBody,
  readRestRows,
  signIn,
  waitForSynced
} from "./support/app";

const cleanupRunId = process.env.E2E_RUN_ID ?? "missing-cleanup-run-id";
const cleanupKind = process.env.E2E_CLEANUP_RACE_KIND ?? "replacement";
if (cleanupKind !== "replacement" && cleanupKind !== "refund" && cleanupKind !== "void") {
  throw new Error("E2E_CLEANUP_RACE_KIND must be exactly replacement, refund, or void.");
}
const isRefundCleanup = cleanupKind === "refund";
const isVoidCleanup = cleanupKind === "void";
const isDispositionCleanup = isRefundCleanup || isVoidCleanup;
const fixtureRunId = isDispositionCleanup
  ? process.env.E2E_DISPOSITION_RACE_FIXTURE_RUN_ID ?? process.env.E2E_REFUND_RACE_FIXTURE_RUN_ID ?? "missing-fixture-run-id"
  : process.env.E2E_REPLACEMENT_RACE_FIXTURE_RUN_ID ?? "missing-fixture-run-id";
const recoveryRelative = isDispositionCleanup
  ? process.env.E2E_CHECKOUT_DISPOSITION_RACE_RECOVERY_ARTIFACT ?? process.env.E2E_REFUND_RACE_RECOVERY_ARTIFACT ?? ""
  : process.env.E2E_REPLACEMENT_RACE_RECOVERY_ARTIFACT ?? "";
const organizationId = "org-primary";
const dispositionLabel = isVoidCleanup ? "Void" : "Refund";
const itemName = isDispositionCleanup ? `QA ${dispositionLabel} Race ${fixtureRunId}` : `QA Replacement Race ${fixtureRunId}`;
const customerNames = isDispositionCleanup
  ? [`QA ${dispositionLabel} Source ${fixtureRunId}`, `QA ${dispositionLabel} Checkout ${fixtureRunId}`]
  : [`QA Replacement Source ${fixtureRunId}`, `QA Replacement Checkout ${fixtureRunId}`];
const billNumbers = isDispositionCleanup
  ? ["ORIGINAL", "CHECKOUT"].map((suffix) => `BILL-QA-${dispositionLabel.toUpperCase()}-RACE-${fixtureRunId}-${suffix}`)
  : ["ORIGINAL", "CHECKOUT", "REPLACEMENT"].map((suffix) => `BILL-QA-REPLACE-RACE-${fixtureRunId}-${suffix}`);
const openingStock = isDispositionCleanup ? 2 : 3;
const cleanupLabel = isDispositionCleanup ? `${cleanupKind}-race` : "replacement-race";
const artifactPrefix = isDispositionCleanup ? `checkout-${cleanupKind}-race-cleanup` : "checkout-replacement-race-cleanup";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function expectExactAuthorizedRows(
  actualRows: Array<Record<string, unknown>>,
  expectedRows: Array<Record<string, unknown>>,
  identity: "id" | "bill_number"
) {
  expect(actualRows).toHaveLength(expectedRows.length);
  const sortByIdentity = (rows: Array<Record<string, unknown>>) =>
    [...rows].sort((left, right) => String(left[identity] ?? "").localeCompare(String(right[identity] ?? "")));
  const sortedActual = sortByIdentity(actualRows);
  const sortedExpected = sortByIdentity(expectedRows);
  expect(sortedActual.map((row) => row[identity])).toEqual(sortedExpected.map((row) => row[identity]));
  const projectedActual = sortedActual.map((actual, index) =>
    Object.fromEntries(Object.keys(sortedExpected[index]).map((key) => [key, actual[key]]))
  );
  expect(stable(projectedActual)).toEqual(stable(sortedExpected));
}
function checkpoint(phase: string, value: unknown) {
  const directory = path.join(process.cwd(), "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${artifactPrefix}-${phase}-${cleanupRunId}.json`);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path.relative(process.cwd(), target);
}
function compatibilityTabs(data: unknown, authorizedTabIds: string[]) {
  const state = data as { customerTabs?: Array<Record<string, unknown>> };
  return (state.customerTabs ?? [])
    .filter((tab) => authorizedTabIds.includes(String(tab.id)))
    .map((tab) => ({
      id: tab.id,
      customer_name: tab.customerName,
      status: tab.status,
      close_disposition: tab.closeDisposition ?? null,
      closed_bill_id: tab.closedBillId ?? null,
      close_reason: tab.closeReason ?? null
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}
async function openInventory(page: Page) {
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Catalog", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Active Items", exact: true })).toBeVisible();
}

test("identity-bound cleanup closes only exact QA tabs and archives only the exact fixture", async ({ browser, page }, testInfo) => {
  const observer = await createObserver(browser);
  const requests: Parameters<typeof captureAuthenticatedRestRequests>[1] = [];
  const observerRequests: Parameters<typeof captureAuthenticatedRestRequests>[1] = [];
  captureAuthenticatedRestRequests(page, requests);
  captureAuthenticatedRestRequests(observer.page, observerRequests);
  const recoveryPath = path.resolve(process.cwd(), recoveryRelative);
  const recoveryBytes = fs.readFileSync(recoveryPath);
  const recoverySha256 = createHash("sha256").update(recoveryBytes).digest("hex");
  const recovery = JSON.parse(recoveryBytes.toString("utf8"));
  const cleanupResults: Array<Record<string, unknown>> = [];
  let finalEvidence: Record<string, unknown> = {};
  try {
    expect(recovery.runId).toBe(fixtureRunId);
    if (isDispositionCleanup) {
      if (isVoidCleanup || recovery.disposition !== undefined) expect(recovery.disposition).toBe(cleanupKind);
      expect(recoverySha256).toBe(process.env.E2E_CHECKOUT_DISPOSITION_RACE_RECOVERY_SHA256);
    }
    expect(recovery.safeForIdentityBoundCleanup).toBe(true);
    expect(recovery.safeForAutomaticRetry).toBe(false);
    expect(recovery.productionAllowed).toBe(false);
    await signIn(page, credentials("A"));
    await signIn(observer.page, credentials("B"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, requests, "admin", organizationId);
    const observerIdentity = await assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", organizationId);
    expect(identity.actorId).toBe(recovery.actors.origin);
    expect(observerIdentity.actorId).toBe(recovery.actors.observer);

    const [items, bills, tabs, openSessions, openTabs, appState] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, name: `eq.${itemName}`, select: "id,name,stock_qty,active,archived_by_user_id,archive_reason" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", { organization_id: `eq.${organizationId}`, bill_number: `in.(${billNumbers.join(",")})`, select: "id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,void_reason,voided_at,voided_by_user_id,issued_by_user_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, customer_name: `in.(\"${customerNames[0]}\",\"${customerNames[1]}\")`, select: "id,customer_name,status,close_disposition,closed_bill_id,close_reason" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,status,customer_name" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,status,customer_name" }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" })
    ]);
    const recoveryItems = recovery.items ?? recovery.inventory ?? [];
    expectExactAuthorizedRows(items, recoveryItems, "id");
    expectExactAuthorizedRows(bills, recovery.bills ?? [], "bill_number");
    expectExactAuthorizedRows(tabs, recovery.tabs ?? [], "id");
    expect(openSessions).toEqual([]);
    expectExactAuthorizedRows(openTabs, recovery.openTabs ?? [], "id");
    expect(appState).toHaveLength(1);
    expect({ version: appState[0].version, hash: hash(appState[0].data) }).toEqual(recovery.appState);
    const itemId = String(items[0]?.id ?? "");
    expect(itemId).toBeTruthy();
    const billIds = bills.map((row) => String(row.id));
    const [tabItems, movements, lines, payments] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tab_items", { organization_id: `eq.${organizationId}`, inventory_item_id: `eq.${itemId}`, select: "id,customer_tab_id,inventory_item_id,quantity,unit_price" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, item_id: `eq.${itemId}`, select: "id,item_id,type,quantity,related_bill_id,user_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_lines", { organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.length ? billIds.join(",") : "missing-bill"})`, select: "id,bill_id,type,inventory_item_id,quantity,unit_price,total" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "payments", { organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.length ? billIds.join(",") : "missing-bill"})`, select: "id,bill_id,mode,amount,received_by_user_id" })
    ]);
    expectExactAuthorizedRows(tabItems, recovery.tabItems ?? [], "id");
    const recoveryMovements = recovery.allItemMovements ?? recovery.movements ?? [];
    expectExactAuthorizedRows(movements, recoveryMovements, "id");
    expectExactAuthorizedRows(lines, recovery.lines ?? [], "id");
    expectExactAuthorizedRows(payments, recovery.payments ?? [], "id");
    expect(openingStock + movements.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(Number(items[0].stock_qty));
    const recoveryEvents = recovery.events ?? [];
    const recoveryAudits = recovery.audits ?? [];
    const [events, audits, mutationStatuses] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", {
        organization_id: `eq.${organizationId}`,
        id: `in.(${recoveryEvents.length ? recoveryEvents.map((row: Record<string, unknown>) => row.id).join(",") : "missing-recovery-event"})`,
        select: "id,event_type,entity_type,entity_id,created_by,metadata"
      }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", {
        organization_id: `eq.${organizationId}`,
        id: `in.(${recoveryAudits.length ? recoveryAudits.map((row: Record<string, unknown>) => row.id).join(",") : "missing-recovery-audit"})`,
        select: "id,action,entity_type,entity_id,message,user_id"
      }),
      Promise.all((recovery.mutationIds ?? []).map(async (mutationId: string, index: number) => {
        const mutationActor = recovery.mutationActors?.[index] ?? recovery.actors.origin;
        const actorContext = mutationActor === recovery.actors.observer
          ? { request: observer.page.request, headers: observerIdentity.headers }
          : { request: page.request, headers: identity.headers };
        const response = await actorContext.request.post(`${identity.restBase}/rpc/get_financial_mutation_result`, {
          headers: actorContext.headers,
          data: {
            payload: {
              organization_id: organizationId,
              mutation_id: mutationId,
              mutation_kind: recovery.mutationKinds?.[index] ?? "commitCheckoutBill"
            }
          }
        });
        expect(response.status()).toBe(200);
        return await readApiResponseBody(response);
      }))
    ]);
    expectExactAuthorizedRows(events, recoveryEvents, "id");
    expectExactAuthorizedRows(audits, recoveryAudits, "id");
    expect(stable(mutationStatuses)).toEqual(stable(recovery.mutationStatuses ?? []));
    expect(events.every((row) => [recovery.actors.origin, recovery.actors.observer].includes(row.created_by))).toBe(true);
    expect(audits.every((row) => [recovery.actors.origin, recovery.actors.observer].includes(row.user_id))).toBe(true);
    for (const status of mutationStatuses.filter(Boolean)) {
      expect(billIds).toContain(String(status.bill_id));
      expect(events.map((row) => row.id)).toContain(status.event_id);
      expect((status.changed_rows?.bills ?? []).every((id: string) => billIds.includes(id))).toBe(true);
      expect((status.changed_rows?.payments ?? []).every((id: string) => payments.some((row) => row.id === id))).toBe(true);
      expect((status.changed_rows?.stock_movements ?? []).every((id: string) => movements.some((row) => row.id === id))).toBe(true);
      expect((status.changed_rows?.audit_logs ?? []).every((id: string) => audits.some((row) => row.id === id))).toBe(true);
      const event = events.find((row) => row.id === status.event_id);
      expect((event?.metadata as Record<string, unknown>)?.mutation_id).toBe(status.mutation_id);
      const mutationIndex = (recovery.mutationIds as string[]).indexOf(String(status.mutation_id));
      expect(event?.created_by).toBe(
        recovery.mutationActors?.[mutationIndex] ?? (mutationIndex === 2 ? recovery.actors.observer : recovery.actors.origin)
      );
      if (status.entity_type === "customer_tab") {
        expect(tabs.find((row) => row.id === status.entity_id)).toMatchObject({
          status: "closed",
          close_disposition: "billed",
          closed_bill_id: status.bill_id
        });
      }
    }

    const authorizedTabIds = tabs.map((row) => String(row.id));
    const beforeCompatibilityTabs = compatibilityTabs(appState[0].data, authorizedTabIds);
    expect(new Set(beforeCompatibilityTabs.map((tab) => tab.id)).size).toBe(beforeCompatibilityTabs.length);
    for (const compatibilityTab of beforeCompatibilityTabs) {
      const normalizedTab = tabs.find((tab) => tab.id === compatibilityTab.id);
      expect(normalizedTab).toBeTruthy();
      expect(stable(compatibilityTab)).toEqual(stable(normalizedTab));
    }
    const beforeState = appState[0].data as { inventoryItems?: Array<Record<string, unknown>> };
    const beforeCompatibilityItem = (beforeState.inventoryItems ?? []).find((item) => item.id === itemId);
    expect(beforeCompatibilityItem).toMatchObject({ id: itemId, active: items[0].active });
    expect(Number(beforeCompatibilityItem?.stockQty)).toBe(Number(items[0].stock_qty));
    const beforeEvidence = {
      items,
      bills,
      tabs,
      tabItems,
      movements,
      lines,
      payments,
      events,
      audits,
      mutationStatuses,
      openSessions,
      openTabs,
      appState: {
        version: appState[0].version,
        hash: hash(appState[0].data),
        compatibilityItem: beforeCompatibilityItem,
        compatibilityTabs: beforeCompatibilityTabs
      }
    };
    const checkpointEvidence = (phase: string) => checkpoint(phase, {
      phase,
      cleanupKind,
      cleanupRunId,
      fixtureRunId,
      recoveryArtifact: recoveryRelative,
      recoverySha256,
      actors: recovery.actors,
      itemId,
      cleanupResults: [...cleanupResults],
      before: beforeEvidence
    });
    checkpointEvidence("prepared");

    const authorizedOpenTabs = (recovery.openTabs ?? []) as Array<Record<string, unknown>>;
    for (const [index, authorizedOpenTab] of authorizedOpenTabs.entries()) {
      const openTab = tabs.find((row) => row.id === authorizedOpenTab.id);
      expect(openTab).toBeTruthy();
      expect(openTab?.status).toBe("open");
      if (!openTab) throw new Error(`Authorized recovery tab ${authorizedOpenTab.id} is missing.`);
      const customerName = String(openTab.customer_name);
      expect(customerNames).toContain(customerName);
      await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
      const chip = page.locator("button.tab-chip").filter({ hasText: customerName });
      await chip.evaluate((button: HTMLButtonElement) => button.click());
      page.once("dialog", (dialog) => dialog.accept(`Identity-bound ${cleanupLabel} cleanup ${cleanupRunId}`));
      const responsePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/reject_customer_tab") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Reject Tab", exact: true }).click();
      const response = await responsePromise;
      const result = await readApiResponseBody(response);
      expect(response.status()).toBe(200);
      cleanupResults.push({ operation: "reject_customer_tab", entityId: openTab.id, result });
      checkpointEvidence(`reject-${index + 1}-acknowledged`);
      await waitForSynced(page);
    }

    if (items[0].active) {
      await openInventory(page);
      const row = page.locator(".inventory-table-wrap tbody tr").filter({ hasText: itemName }).first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
      await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(`Identity-bound ${cleanupLabel} cleanup ${cleanupRunId}`);
      const responsePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST");
      await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
      const response = await responsePromise;
      const result = await readApiResponseBody(response);
      expect(response.status()).toBe(200);
      cleanupResults.push({ operation: "archive_inventory_item", entityId: itemId, result });
      checkpointEvidence("archive-acknowledged");
      await waitForSynced(page);
    }

    const [finalItems, finalBills, finalTabs, finalOpenSessions, finalOpenTabs, finalMovements, finalState] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,stock_qty,active,archived_by_user_id,archive_reason" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", { organization_id: `eq.${organizationId}`, bill_number: `in.(${billNumbers.join(",")})`, select: "id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,void_reason,voided_at,voided_by_user_id,issued_by_user_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, customer_name: `in.(\"${customerNames[0]}\",\"${customerNames[1]}\")`, select: "id,customer_name,status,close_disposition,closed_bill_id,close_reason" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,status,customer_name" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,status,customer_name" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: `eq.${organizationId}`, item_id: `eq.${itemId}`, select: "id,item_id,type,quantity,related_bill_id,user_id" }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" })
    ]);
    expect(finalItems[0]).toMatchObject({ id: itemId, active: false, archived_by_user_id: identity.actorId });
    expectExactAuthorizedRows(finalBills, bills, "bill_number");
    expect(finalTabs).toHaveLength(tabs.length);
    expect([...finalTabs].map((row) => row.id).sort()).toEqual([...tabs].map((row) => row.id).sort());
    expect(finalTabs.every((row) => row.status === "closed")).toBe(true);
    expect(finalOpenSessions).toEqual([]);
    expect(finalOpenTabs).toEqual([]);
    expectExactAuthorizedRows(finalMovements, movements, "id");
    expect(finalState).toHaveLength(1);
    const afterCompatibilityTabs = compatibilityTabs(finalState[0].data, authorizedTabIds);
    expect(stable(afterCompatibilityTabs)).toEqual(stable([...finalTabs].sort((left, right) => String(left.id).localeCompare(String(right.id)))));
    const afterState = finalState[0].data as { inventoryItems?: Array<Record<string, unknown>> };
    const afterCompatibilityItem = (afterState.inventoryItems ?? []).find((item) => item.id === itemId);
    expect(afterCompatibilityItem).toMatchObject({ id: itemId, active: false });
    expect(Number(afterCompatibilityItem?.stockQty)).toBe(Number(finalItems[0].stock_qty));
    finalEvidence = {
      cleanupKind,
      cleanupRunId,
      fixtureRunId,
      recoveryArtifact: recoveryRelative,
      recoverySha256,
      actors: recovery.actors,
      itemId,
      cleanupResults,
      before: beforeEvidence,
      after: {
        items: finalItems,
        bills: finalBills,
        tabs: finalTabs,
        movements: finalMovements,
        appState: {
          version: finalState[0].version,
          hash: hash(finalState[0].data),
          compatibilityItem: afterCompatibilityItem,
          compatibilityTabs: afterCompatibilityTabs
        }
      }
    };
    const artifact = checkpoint("final", finalEvidence);
    await attachJson(testInfo, `${artifactPrefix}-evidence`, { ...finalEvidence, artifact });
  } finally {
    await attachFailureScreenshot(testInfo, page, `${artifactPrefix}-failure`);
    await attachFailureScreenshot(testInfo, observer.page, `${artifactPrefix}-observer-failure`);
    await observer.context.close();
  }
});
