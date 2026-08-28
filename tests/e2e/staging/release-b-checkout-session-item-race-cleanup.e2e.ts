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
  openManagedSession,
  readApiResponseBody,
  readRestRows,
  signIn,
  stationCard,
  type CapturedRpcRequest,
  waitForSynced
} from "./support/app";

const cleanupRunId = process.env.E2E_RUN_ID ?? "missing-cleanup-run-id";
const fixtureRunId = process.env.E2E_SESSION_ITEM_RACE_FIXTURE_RUN_ID ?? "missing-fixture-run-id";
const recoveryArtifact = process.env.E2E_SESSION_ITEM_RACE_RECOVERY_ARTIFACT ?? "missing-recovery-artifact";
const organizationId = "org-primary";

function hash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(stable(entry))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if (value && typeof value === "object") {
    return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, JSON.parse(stable(entry))])));
  }
  return JSON.stringify(value);
}

function checkpoint(phase: string, evidence: unknown) {
  const directory = path.join(process.cwd(), "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-session-item-race-cleanup-${phase}-${cleanupRunId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
  return path.relative(process.cwd(), target);
}

async function mutationResults(
  page: Page,
  restBase: string,
  headers: Record<string, string>,
  classifications: Array<Record<string, unknown>>
) {
  return Promise.all(classifications.filter((entry) => entry.checkoutMutationId).map(async (entry) => {
    const response = await page.request.post(`${restBase}/rpc/get_financial_mutation_result`, {
      headers,
      data: { payload: {
        organization_id: organizationId,
        mutation_id: entry.checkoutMutationId,
        mutation_kind: "commitCheckoutBill"
      } }
    });
    expect(response.status()).toBe(200);
    return { mutationId: entry.checkoutMutationId, result: await response.json() };
  }));
}

async function rejectExact(
  page: Page,
  station: string,
  customerName: string,
  reason: string,
  onAcknowledged: (result: Record<string, unknown>) => void
) {
  await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
  const card = stationCard(page, station);
  await expect(card).toContainText(customerName);
  const modal = await openManagedSession(page, station);
  await modal.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
  await expect(modal.getByLabel("Customer Name", { exact: true })).toHaveValue(customerName);
  await modal.getByLabel("Customer Name", { exact: true }).locator("xpath=ancestor::form")
    .getByRole("button", { name: "Cancel", exact: true }).click();
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/rest/v1/rpc/reject_session") && response.request().method() === "POST"
  );
  page.once("dialog", (dialog) => dialog.accept(reason));
  await modal.getByRole("button", { name: "Reject Session", exact: true }).click();
  const response = await responsePromise;
  const result = await readApiResponseBody(response) as Record<string, unknown>;
  expect(response.status()).toBe(200);
  onAcknowledged(result);
  await expect(modal).toBeHidden();
  await waitForSynced(page);
  await expect(card).toContainText("Available");
  return result;
}

test("identity-bound session-item race cleanup changes only exact authorized lifecycle rows", async ({ browser, page }, testInfo) => {
  const recoveryPath = path.resolve(process.cwd(), recoveryArtifact);
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  const observer = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    locale: "en-IN",
    timezoneId: "Asia/Calcutta"
  });
  const observerPage = await observer.newPage();
  const originRequests: CapturedRpcRequest[] = [];
  const observerRequests: CapturedRpcRequest[] = [];
  captureAuthenticatedRestRequests(page, originRequests);
  captureAuthenticatedRestRequests(observerPage, observerRequests);
  const originErrors = capturePageErrors(page);
  const observerErrors = capturePageErrors(observerPage);
  const ledger: Record<string, unknown> = {
    cleanupRunId,
    fixtureRunId,
    recoveryArtifact,
    acknowledgements: []
  };
  let mutationStarted = false;
  let mutationCompleted = false;
  let primaryError: unknown;

  try {
    expect(recovery.runId).toBe(fixtureRunId);
    expect(recovery.safeForIdentityBoundCleanup).toBe(true);
    expect(recovery.safeForAutomaticRetry).toBe(false);
    expect(recovery.productionAllowed).toBe(false);
    expect(recovery.fixture?.stationName).toBeTruthy();
    await signIn(page, credentials("A"));
    await signIn(observerPage, credentials("B"));
    const [originIdentity, observerIdentity] = await Promise.all([
      assertAuthoritativeOrganizationIdentity(page, originRequests, "admin", organizationId),
      assertAuthoritativeOrganizationIdentity(observerPage, observerRequests, "admin", organizationId)
    ]);
    expect({ checkout: originIdentity.actorId, item: observerIdentity.actorId }).toEqual(recovery.actors);
    expect(originIdentity.actorId).not.toBe(observerIdentity.actorId);

    const sessionIds = recovery.acknowledgedSessionIds as string[];
    const billIds = (recovery.snapshot.bills as Array<Record<string, unknown>>).map((row) => String(row.id));
    const priorEventIdsForQuery = (recovery.snapshot.events as Array<Record<string, unknown>>).map((row) => String(row.id));
    const priorAuditIdsForQuery = (recovery.snapshot.audits as Array<Record<string, unknown>>).map((row) => String(row.id));
    const [items, sessions, bills, openSessions, openTabs, lines, payments, sessionItems, movements, events, audits, state, beforeMutations] = await Promise.all([
      recovery.fixture.itemId ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "inventory_items", {
        organization_id: `eq.${organizationId}`, id: `eq.${recovery.fixture.itemId}`, select: "id,name,stock_qty,active"
      }) : Promise.resolve([]),
      sessionIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "sessions", {
        organization_id: `eq.${organizationId}`, id: `in.(${sessionIds.join(",")})`,
        select: "id,customer_name,status,close_disposition,closed_bill_id"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "bills", {
        organization_id: `eq.${organizationId}`, id: `in.(${billIds.join(",")})`,
        select: "id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id"
      }) : Promise.resolve([]),
      readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "sessions", {
        organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,customer_name,status"
      }),
      readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "customer_tabs", {
        organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,customer_name,status"
      }),
      billIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "bill_lines", {
        organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.join(",")})`,
        select: "id,bill_id,type,inventory_item_id,quantity,unit_price,total,linked_session_id,raw_data"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "payments", {
        organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.join(",")})`,
        select: "id,bill_id,amount,mode,received_by_user_id"
      }) : Promise.resolve([]),
      sessionIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "session_items", {
        organization_id: `eq.${organizationId}`, session_id: `in.(${sessionIds.join(",")})`,
        select: "id,session_id,inventory_item_id,name,quantity,unit_price,raw_data"
      }) : Promise.resolve([]),
      recovery.fixture.itemId ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "stock_movements", {
        organization_id: `eq.${organizationId}`, item_id: `eq.${recovery.fixture.itemId}`,
        select: "id,item_id,type,quantity,user_id,related_bill_id"
      }) : Promise.resolve([]),
      priorEventIdsForQuery.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "operational_events", {
        organization_id: `eq.${organizationId}`, id: `in.(${priorEventIdsForQuery.join(",")})`,
        select: "id,event_type,entity_type,entity_id,created_by,metadata"
      }) : Promise.resolve([]),
      priorAuditIdsForQuery.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "audit_logs", {
        organization_id: `eq.${organizationId}`, id: `in.(${priorAuditIdsForQuery.join(",")})`,
        select: "id,action,entity_type,entity_id,user_id,message"
      }) : Promise.resolve([]),
      readRestRows<{ version: number; data: unknown }>(page, originIdentity.restBase, originIdentity.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      }),
      mutationResults(page, originIdentity.restBase, originIdentity.headers, recovery.scenarioClassifications)
    ]);
    expect(stable(items)).toBe(stable(recovery.snapshot.item));
    expect(stable(sessions)).toBe(stable(recovery.snapshot.sessions));
    expect(stable(bills)).toBe(stable(recovery.snapshot.bills));
    expect(stable(openSessions)).toBe(stable(recovery.snapshot.openSessions));
    expect(stable(openTabs)).toBe(stable(recovery.snapshot.openTabs));
    expect(stable(lines)).toBe(stable(recovery.snapshot.lines));
    expect(stable(payments)).toBe(stable(recovery.snapshot.payments));
    expect(stable(sessionItems)).toBe(stable(recovery.snapshot.sessionItems));
    expect(stable(movements)).toBe(stable(recovery.snapshot.movements));
    expect(stable(events)).toBe(stable(recovery.snapshot.events));
    expect(stable(audits)).toBe(stable(recovery.snapshot.audits));
    expect(stable(beforeMutations)).toBe(stable(recovery.scenarioClassifications
      .filter((entry: Record<string, unknown>) => entry.checkoutMutationId)
      .map((entry: Record<string, unknown>) => ({ mutationId: entry.checkoutMutationId, result: entry.mutationStatus }))));
    expect({ version: state[0].version, hash: hash(state[0].data) }).toEqual(recovery.snapshot.appState);
    ledger.preparedPath = checkpoint("prepared", { ...ledger, recovery, verifiedSnapshot: recovery.snapshot });

    const station = recovery.fixture.stationName as string;
    for (const action of recovery.actions.rejectSessions as Array<{ id: string; customerName: string }>) {
      mutationStarted = true;
      const reason = `Identity-bound session-item cleanup ${fixtureRunId} via ${cleanupRunId}`;
      const result = await rejectExact(page, station, action.customerName, reason, (acknowledged) => {
        expect(acknowledged.entity_id).toBe(action.id);
        (ledger.acknowledgements as Array<unknown>).push({ type: "reject_session", action, reason, result: acknowledged });
        ledger[`rejectAcknowledged_${action.id}`] = checkpoint(`reject-${action.id}-acknowledged`, ledger);
      });
      expect(result.entity_id).toBe(action.id);
    }

    if (recovery.actions.archiveItem) {
      mutationStarted = true;
      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await page.getByRole("tablist", { name: "Inventory section", exact: true })
        .getByRole("button", { name: "Catalog", exact: true }).click();
      const row = page.locator(".inventory-table-wrap tbody tr").filter({ hasText: recovery.fixture.itemName }).first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const reason = `Identity-bound session-item fixture cleanup ${fixtureRunId} via ${cleanupRunId}`;
      const dialog = page.getByRole("dialog", { name: `Archive Inventory Item - ${recovery.fixture.itemName}`, exact: true });
      await dialog.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(reason);
      const responsePromise = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await dialog.getByRole("button", { name: "Archive Item", exact: true }).click();
      const response = await responsePromise;
      const result = await readApiResponseBody(response);
      expect(response.status()).toBe(200);
      (ledger.acknowledgements as Array<unknown>).push({ type: "archive_item", action: recovery.actions.archiveItem, reason, result });
      ledger.archiveAcknowledgedPath = checkpoint("archive-acknowledged", ledger);
      await waitForSynced(page);
    }

    const acknowledgedEventIdsForQuery = (ledger.acknowledgements as Array<Record<string, unknown>>).flatMap((entry) => {
      const result = entry.result as Record<string, unknown>;
      const changed = result.changed_rows as Record<string, string[]> | undefined;
      return [...(typeof result.event_id === "string" ? [result.event_id] : []), ...(changed?.operational_events ?? [])];
    });
    const acknowledgedAuditIdsForQuery = (ledger.acknowledgements as Array<Record<string, unknown>>).flatMap((entry) => {
      const result = entry.result as Record<string, unknown>;
      const changed = result.changed_rows as Record<string, string[]> | undefined;
      return changed?.audit_logs ?? [];
    });
    const allEventIdsForQuery = [...new Set([...priorEventIdsForQuery, ...acknowledgedEventIdsForQuery])];
    const allAuditIdsForQuery = [...new Set([...priorAuditIdsForQuery, ...acknowledgedAuditIdsForQuery])];
    const [finalItems, finalSessions, finalBills, finalOpenSessions, finalOpenTabs, finalLines, finalPayments, finalSessionItems, finalMovements, finalEvents, finalAudits, finalState, afterMutations] = await Promise.all([
      recovery.fixture.itemId ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "inventory_items", {
        organization_id: `eq.${organizationId}`, id: `eq.${recovery.fixture.itemId}`,
        select: "id,name,stock_qty,active,archived_by_user_id,archive_reason"
      }) : Promise.resolve([]),
      sessionIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "sessions", {
        organization_id: `eq.${organizationId}`, id: `in.(${sessionIds.join(",")})`,
        select: "id,customer_name,status,close_disposition,closed_bill_id"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "bills", {
        organization_id: `eq.${organizationId}`, id: `in.(${billIds.join(",")})`,
        select: "id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id"
      }) : Promise.resolve([]),
      readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "sessions", {
        organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,customer_name,status"
      }),
      readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "customer_tabs", {
        organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,customer_name,status"
      }),
      billIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "bill_lines", {
        organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.join(",")})`,
        select: "id,bill_id,type,inventory_item_id,quantity,unit_price,total,linked_session_id,raw_data"
      }) : Promise.resolve([]),
      billIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "payments", {
        organization_id: `eq.${organizationId}`, bill_id: `in.(${billIds.join(",")})`,
        select: "id,bill_id,amount,mode,received_by_user_id"
      }) : Promise.resolve([]),
      sessionIds.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "session_items", {
        organization_id: `eq.${organizationId}`, session_id: `in.(${sessionIds.join(",")})`,
        select: "id,session_id,inventory_item_id,name,quantity,unit_price,raw_data"
      }) : Promise.resolve([]),
      recovery.fixture.itemId ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "stock_movements", {
        organization_id: `eq.${organizationId}`, item_id: `eq.${recovery.fixture.itemId}`,
        select: "id,item_id,type,quantity,user_id,related_bill_id"
      }) : Promise.resolve([]),
      allEventIdsForQuery.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "operational_events", {
        organization_id: `eq.${organizationId}`, id: `in.(${allEventIdsForQuery.join(",")})`,
        select: "id,event_type,entity_type,entity_id,created_by,metadata"
      }) : Promise.resolve([]),
      allAuditIdsForQuery.length ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "audit_logs", {
        organization_id: `eq.${organizationId}`, id: `in.(${allAuditIdsForQuery.join(",")})`,
        select: "id,action,entity_type,entity_id,user_id,message"
      }) : Promise.resolve([]),
      readRestRows<{ version: number; data: unknown }>(page, originIdentity.restBase, originIdentity.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      }),
      mutationResults(page, originIdentity.restBase, originIdentity.headers, recovery.scenarioClassifications)
    ]);
    if (recovery.snapshot.item.length) {
      expect(finalItems).toEqual([expect.objectContaining({
        id: recovery.fixture.itemId,
        name: recovery.fixture.itemName,
        stock_qty: recovery.snapshot.item[0].stock_qty,
        active: false,
        archived_by_user_id: originIdentity.actorId,
        archive_reason: expect.any(String)
      })]);
    } else {
      expect(finalItems).toEqual([]);
    }
    expect(finalOpenSessions).toEqual([]);
    expect(finalOpenTabs).toEqual([]);
    const rejectedSessionIds = new Set((recovery.actions.rejectSessions as Array<{ id: string }>).map((entry) => entry.id));
    expect(finalSessions).toHaveLength(recovery.snapshot.sessions.length);
    for (const beforeSession of recovery.snapshot.sessions as Array<Record<string, unknown>>) {
      const afterSession = finalSessions.find((entry) => entry.id === beforeSession.id);
      if (rejectedSessionIds.has(String(beforeSession.id))) {
        expect(afterSession).toEqual({
          id: beforeSession.id,
          customer_name: beforeSession.customer_name,
          status: "closed",
          close_disposition: "rejected",
          closed_bill_id: null
        });
      } else {
        expect(stable(afterSession)).toBe(stable(beforeSession));
      }
    }
    expect(stable(finalBills)).toBe(stable(recovery.snapshot.bills));
    expect(stable(finalLines)).toBe(stable(recovery.snapshot.lines));
    expect(stable(finalPayments)).toBe(stable(recovery.snapshot.payments));
    expect(stable(finalSessionItems)).toBe(stable(recovery.snapshot.sessionItems));
    expect(stable(finalMovements)).toBe(stable(recovery.snapshot.movements));
    expect(stable(afterMutations)).toBe(stable(beforeMutations));
    const priorEventIds = new Set((recovery.snapshot.events as Array<Record<string, unknown>>).map((row) => row.id));
    const priorAuditIds = new Set((recovery.snapshot.audits as Array<Record<string, unknown>>).map((row) => row.id));
    expect(stable(finalEvents.filter((row) => priorEventIds.has(row.id)))).toBe(stable(recovery.snapshot.events));
    expect(stable(finalAudits.filter((row) => priorAuditIds.has(row.id)))).toBe(stable(recovery.snapshot.audits));
    expect(new Set(finalEvents.filter((row) => !priorEventIds.has(row.id)).map((row) => row.id)))
      .toEqual(new Set(acknowledgedEventIdsForQuery));
    expect(new Set(finalAudits.filter((row) => !priorAuditIds.has(row.id)).map((row) => row.id)))
      .toEqual(new Set(acknowledgedAuditIdsForQuery));
    for (const acknowledgement of (ledger.acknowledgements as Array<Record<string, unknown>>)
      .filter((entry) => entry.type === "reject_session")) {
      const result = acknowledgement.result as Record<string, unknown>;
      const changed = result.changed_rows as Record<string, string[]>;
      const rejectEvent = finalEvents.find((row) => row.id === result.event_id);
      const rejectAudits = finalAudits.filter((row) => (changed.audit_logs ?? []).includes(String(row.id)));
      const action = acknowledgement.action as { id: string };
      expect(rejectEvent).toEqual(expect.objectContaining({
        event_type: "reject_session",
        entity_type: "session",
        entity_id: action.id,
        created_by: originIdentity.actorId,
        metadata: expect.objectContaining({ mutation_id: result.mutation_id })
      }));
      expect(rejectAudits).toEqual([expect.objectContaining({
        action: "session_rejected",
        entity_type: "session",
        entity_id: action.id,
        user_id: originIdentity.actorId,
        message: `Rejected ${recovery.fixture.stationName}. Reason: ${acknowledgement.reason}`
      })]);
    }
    const archiveAcknowledgement = (ledger.acknowledgements as Array<Record<string, unknown>>)
      .find((entry) => entry.type === "archive_item");
    if (archiveAcknowledgement) {
      const result = archiveAcknowledgement.result as Record<string, unknown>;
      const archiveEvent = finalEvents.find((row) => row.id === result.event_id);
      const archiveAuditIds = ((result.changed_rows as Record<string, string[]>)?.audit_logs ?? []);
      const archiveAudits = finalAudits.filter((row) => archiveAuditIds.includes(String(row.id)));
      expect(finalItems[0].archive_reason).toBe(archiveAcknowledgement.reason);
      expect(archiveEvent).toEqual(expect.objectContaining({
        event_type: "admin_data_committed",
        entity_type: result.entity_type,
        entity_id: result.entity_id,
        created_by: originIdentity.actorId,
        metadata: expect.objectContaining({ changed_rows: result.changed_rows })
      }));
      expect(archiveAudits).toEqual([expect.objectContaining({
        action: "inventory_archived",
        entity_type: "inventory_item",
        entity_id: recovery.fixture.itemId,
        user_id: originIdentity.actorId,
        message: `Archived ${recovery.fixture.itemName}. Reason: ${archiveAcknowledgement.reason}.`
      })]);
    }
    const expectedCompatibilityWrites = (recovery.actions.rejectSessions as unknown[]).length + (recovery.actions.archiveItem ? 1 : 0);
    expect(finalState[0].version).toBe(recovery.snapshot.appState.version + expectedCompatibilityWrites);
    ledger.final = {
      items: finalItems,
      sessions: finalSessions,
      bills: finalBills,
      openSessions: finalOpenSessions,
      openTabs: finalOpenTabs,
      lines: finalLines,
      payments: finalPayments,
      sessionItems: finalSessionItems,
      movements: finalMovements,
      events: finalEvents,
      audits: finalAudits,
      mutationResults: afterMutations,
      appState: { version: finalState[0].version, hash: hash(finalState[0].data) }
    };
    ledger.finalPath = checkpoint("final", ledger);
    mutationCompleted = true;
    expect(originErrors.consoleErrors).toEqual([]);
    expect(observerErrors.consoleErrors).toEqual([]);
    expect(originErrors.pageErrors).toEqual([]);
    expect(observerErrors.pageErrors).toEqual([]);
    await attachJson(testInfo, "checkout-session-item-race-cleanup-evidence", ledger);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await attachJson(testInfo, "checkout-session-item-race-cleanup-lifecycle", {
      ...ledger,
      mutationStarted,
      mutationCompleted,
      requiresReconciliation: mutationStarted && !mutationCompleted
    });
    await attachFailureScreenshot(testInfo, page, "checkout-session-item-cleanup-origin-failure");
    await attachFailureScreenshot(testInfo, observerPage, "checkout-session-item-cleanup-observer-failure");
    await observer.close();
    void primaryError;
  }
});
