import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  captureAuthenticatedRestRequests,
  createObserver,
  credentials,
  interceptSingleRpcCommand,
  readApiResponseBody,
  readRestRows,
  signIn,
  type CapturedRpcRequest,
  waitForSynced
} from "./support/app";

const root = process.cwd();
const cleanupRunId = process.env.E2E_RUN_ID ?? "missing-cleanup-run";
const sourceRunId = process.env.E2E_REPLACEMENT_PARITY_SOURCE_RUN_ID ?? "missing-source-run";
const recoveryPathValue = process.env.E2E_REPLACEMENT_PARITY_RECOVERY_ARTIFACT;
const expectedRecoverySha256 = process.env.E2E_REPLACEMENT_PARITY_RECOVERY_SHA256;
const recoveryPath = recoveryPathValue ? path.resolve(recoveryPathValue) : null;
const recoveryRaw = recoveryPath ? fs.readFileSync(recoveryPath) : null;
const recovery = recoveryRaw ? JSON.parse(recoveryRaw.toString("utf8")) : { recovery: {}, snapshot: {}, actors: {} };

function sha(value: Buffer | string) { return createHash("sha256").update(value).digest("hex"); }
function dataHash(value: unknown) { return sha(JSON.stringify(value)); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
function sorted(rows: Array<Record<string, unknown>>) { return [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id))).map(stable); }
function assertNoSecrets(value: unknown) {
  const raw = JSON.stringify(value);
  expect(raw).not.toMatch(/"(?:authorization|apikey|password|access_token|refresh_token)"\s*:/i);
  expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
}
function checkpoint(stage: string, value: Record<string, unknown>) {
  const evidence = { cleanupRunId, sourceRunId, stage, recordedAt: new Date().toISOString(), productionAllowed: false, safeForAutomaticRetry: false, ...value };
  assertNoSecrets(evidence);
  const directory = path.join(root, "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-replacement-parity-cleanup-${stage}-${cleanupRunId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { fs.linkSync(temporary, target); } finally { fs.unlinkSync(temporary); }
  return path.relative(root, target);
}

test("applies only SHA-bound replacement-parity recovery actions", async ({ browser, page }, testInfo) => {
  const requests: CapturedRpcRequest[] = [];
  const observerRequests: CapturedRpcRequest[] = [];
  captureAuthenticatedRestRequests(page, requests);
  const observer = await createObserver(browser);
  captureAuthenticatedRestRequests(observer.page, observerRequests);
  const actions: Array<Record<string, unknown>> = [];
  let activeCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
  let primaryError: unknown;
  try {
    expect(recoveryPath).toBeTruthy();
    expect(recoveryRaw).toBeTruthy();
    expect(sha(recoveryRaw!)).toBe(expectedRecoverySha256);
    expect(recovery).toMatchObject({ runId: sourceRunId, projectRef: "tkbdyzxwwbhkpztgjjxh", productionAllowed: false, safeForAutomaticRetry: false, status: "partial", integrityFailures: [], ambiguities: [], safeForIdentityBoundCleanup: true });
    expect(recovery.recovery.rejectTab || recovery.recovery.archiveItem).toBeTruthy();

    await signIn(page, credentials("A"));
    await signIn(observer.page, credentials("B"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, requests, "admin", "org-primary");
    const observerIdentity = await assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", "org-primary");
    expect(identity.actorId).toBe(recovery.actors.origin);
    expect(observerIdentity.actorId).toBe(recovery.actors.observer);
    const snapshot = recovery.snapshot as Record<string, any>;
    const itemId = recovery.identities.itemId as string | null;
    const tabId = recovery.identities.tabId as string | null;
    const billIds = (snapshot.bills ?? []).map((row: Record<string, unknown>) => String(row.id));
    const eventIds = (snapshot.events ?? []).map((row: Record<string, unknown>) => String(row.id));
    const auditIds = (snapshot.audits ?? []).map((row: Record<string, unknown>) => String(row.id));
    const missing = "00000000-0000-0000-0000-000000000000";
    const exact = async (table: string, expected: Array<Record<string, unknown>>, query: Record<string, string>) => {
      const actual = await readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, table, query);
      expect(sorted(actual), `${table} drifted from SHA-bound recovery.`).toEqual(sorted(expected));
      return actual;
    };
    const [items, tabs, bills, lines, payments, movements, events, audits, openSessions, openTabs, appState, mutationStatuses] = await Promise.all([
      itemId ? exact("inventory_items", snapshot.items ?? [], { organization_id: "eq.org-primary", id: `eq.${itemId}`, select: "id,name,barcode,category,price,stock_qty,active,archived_by_user_id,archive_reason" }) : [],
      tabId ? exact("customer_tabs", snapshot.tabs ?? [], { organization_id: "eq.org-primary", id: `eq.${tabId}`, select: "id,status,close_disposition,closed_bill_id,customer_id,customer_name,close_reason" }) : [],
      exact("bills", snapshot.bills ?? [], { organization_id: "eq.org-primary", bill_number: `in.(${recovery.identities.originalBillNumber},${recovery.identities.replacementBillNumber})`, select: "id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,issued_by_user_id,customer_id,customer_name" }),
      exact("bill_lines", snapshot.lines ?? [], { organization_id: "eq.org-primary", bill_id: `in.(${billIds.length ? billIds.join(",") : missing})`, select: "id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,linked_session_id" }),
      exact("payments", snapshot.payments ?? [], { organization_id: "eq.org-primary", bill_id: `in.(${billIds.length ? billIds.join(",") : missing})`, select: "id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id" }),
      exact("stock_movements", snapshot.movements ?? [], { organization_id: "eq.org-primary", related_bill_id: `in.(${billIds.length ? billIds.join(",") : missing})`, select: "id,item_id,type,quantity,reason,related_bill_id,user_id" }),
      exact("operational_events", snapshot.events ?? [], { organization_id: "eq.org-primary", id: `in.(${eventIds.length ? eventIds.join(",") : missing})`, select: "id,event_type,entity_type,entity_id,created_by,metadata,created_at" }),
      exact("audit_logs", snapshot.audits ?? [], { organization_id: "eq.org-primary", id: `in.(${auditIds.length ? auditIds.join(",") : missing})`, select: "id,action,entity_type,entity_id,message,user_id,created_at" }),
      exact("sessions", snapshot.openSessions ?? [], { organization_id: "eq.org-primary", status: "neq.closed", select: "id,status,customer_name" }),
      exact("customer_tabs", snapshot.openTabs ?? [], { organization_id: "eq.org-primary", status: "eq.open", select: "id,status,customer_name" }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" }),
      Promise.all((snapshot.mutationStatuses ?? []).map(async (expected: Record<string, any>, index: number) => {
        const actorPage = index === 0 ? page : observer.page;
        const actorIdentity = index === 0 ? identity : observerIdentity;
        const response = await actorPage.request.post(`${actorIdentity.restBase}/rpc/get_financial_mutation_result`, {
          headers: actorIdentity.headers,
          data: { payload: { organization_id: "org-primary", mutation_id: expected.mutation_id, mutation_kind: "commitCheckoutBill" } }
        });
        expect(response.status()).toBe(200);
        return readApiResponseBody(response);
      }))
    ]);
    expect(appState).toHaveLength(1);
    expect({ version: appState[0].version, hash: dataHash(appState[0].data) }).toEqual(snapshot.appState);
    expect(mutationStatuses.map(stable)).toEqual((snapshot.mutationStatuses ?? []).map(stable));
    const baseline = { items, tabs, bills, lines, payments, movements, events, audits, mutationStatuses, openSessions, openTabs, appState: snapshot.appState };
    const preparedPath = checkpoint("prepared", { status: "recovery-revalidated", recoveryArtifact: path.relative(root, recoveryPath!), recoverySha256: expectedRecoverySha256, actorId: identity.actorId, baseline, authorizedActions: recovery.recovery });

    if (recovery.recovery.rejectTab) {
      const candidate = recovery.recovery.rejectTab;
      expect(openTabs).toEqual([expect.objectContaining({ id: candidate.id, customer_name: candidate.customerName, status: "open" })]);
      await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
      const chip = page.locator("button.tab-chip").filter({ hasText: candidate.customerName });
      await chip.evaluate((button: HTMLButtonElement) => button.click());
      const reason = `Replacement parity identity-bound cleanup ${sourceRunId} via ${cleanupRunId}`;
      page.once("dialog", (dialog) => dialog.accept(reason));
      activeCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/reject_customer_tab");
      const ui = page.getByRole("button", { name: "Reject Tab", exact: true }).click();
      const captured = await activeCommand.captured;
      const envelope = structuredClone(captured.body) as { payload: { organization_id: string; mutation_id: string; mutation_kind: string; entity_id: string } };
      expect(envelope.payload).toMatchObject({ organization_id: "org-primary", mutation_kind: "rejectCustomerTab", entity_id: candidate.id });
      const actionPrepared = checkpoint("tab-reject-prepared", { status: "captured-not-submitted", preparedPath, candidate, reason, request: envelope, captureCount: 1, submissionCount: 0 });
      const responsePromise = activeCommand.submit(envelope);
      const actionSubmitted = checkpoint("tab-reject-submitted", { status: "submitted-once-response-pending", actionPrepared, candidate, reason, request: envelope, captureCount: 1, submissionCount: 1 });
      const response = await responsePromise;
      const body = await readApiResponseBody(response);
      const actionResponse = checkpoint("tab-reject-response", { status: "response-received", actionPrepared, actionSubmitted, candidate, reason, request: envelope, response: { status: response.status(), body }, captureCount: 1, submissionCount: 1 });
      expect(response.status()).toBe(200);
      expect(body).toMatchObject({ mutation_id: envelope.payload.mutation_id, entity_type: "customer_tab", entity_id: candidate.id });
      expect(body.changed_rows?.customer_tabs).toEqual([candidate.id]);
      expect(body.changed_rows?.audit_logs).toHaveLength(1);
      expect(body.changed_rows?.operational_events).toEqual([body.event_id]);
      await ui;
      await activeCommand.dispose();
      activeCommand = undefined;
      await waitForSynced(page);
      actions.push({ type: "reject_customer_tab", candidate, reason, mutationId: envelope.payload.mutation_id, eventId: body.event_id, auditId: body.changed_rows.audit_logs[0], response: body, evidence: [actionPrepared, actionSubmitted, actionResponse] });
    }

    if (recovery.recovery.archiveItem) {
      const candidate = recovery.recovery.archiveItem;
      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await page.getByRole("tablist", { name: "Inventory section", exact: true }).getByRole("button", { name: "Catalog", exact: true }).click();
      await page.getByPlaceholder("Search active items by name or category").fill(candidate.name);
      const row = page.locator(".inventory-table-wrap tbody tr").filter({ hasText: candidate.name }).first();
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${candidate.name}`, exact: true });
      const reason = `Replacement parity identity-bound cleanup ${sourceRunId} via ${cleanupRunId}`;
      await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(reason);
      activeCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_admin_data_change");
      const ui = archive.getByRole("button", { name: "Archive Item", exact: true }).click();
      const captured = await activeCommand.captured;
      const envelope = structuredClone(captured.body) as { payload: { organization_id: string; mutation_id: string; mutation_kind: string; payload: { inventoryItems: Array<{ id: string; active: boolean }> } } };
      expect(envelope.payload.organization_id).toBe("org-primary");
      expect(envelope.payload.mutation_kind).toBe("commitAdminDataChange");
      expect(envelope.payload.payload.inventoryItems.find((item) => item.id === candidate.id)?.active).toBe(false);
      const actionPrepared = checkpoint("item-archive-prepared", { status: "captured-not-submitted", preparedPath, candidate, reason, request: envelope, captureCount: 1, submissionCount: 0 });
      const responsePromise = activeCommand.submit(envelope);
      const actionSubmitted = checkpoint("item-archive-submitted", { status: "submitted-once-response-pending", actionPrepared, candidate, reason, request: envelope, captureCount: 1, submissionCount: 1 });
      const response = await responsePromise;
      const body = await readApiResponseBody(response);
      const actionResponse = checkpoint("item-archive-response", { status: "response-received", actionPrepared, actionSubmitted, candidate, reason, request: envelope, response: { status: response.status(), body }, captureCount: 1, submissionCount: 1 });
      expect(response.status()).toBe(200);
      expect(body).toMatchObject({ mutation_id: envelope.payload.mutation_id, entity_type: "admin_data" });
      expect(body.changed_rows?.inventory_items).toEqual([candidate.id]);
      expect(body.changed_rows?.audit_logs).toHaveLength(1);
      await ui;
      await activeCommand.dispose();
      activeCommand = undefined;
      await waitForSynced(page);
      actions.push({ type: "archive_inventory_item", candidate, reason, mutationId: envelope.payload.mutation_id, eventId: body.event_id, auditId: body.changed_rows.audit_logs[0], response: body, evidence: [actionPrepared, actionSubmitted, actionResponse] });
    }

    expect(actions).toHaveLength(Number(Boolean(recovery.recovery.rejectTab)) + Number(Boolean(recovery.recovery.archiveItem)));
    const [finalItems, finalTabs, finalBills, finalLines, finalPayments, finalMovements, finalEvents, finalAudits, finalMutationStatuses, finalOpenSessions, finalOpenTabs, finalState] = await Promise.all([
      itemId ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "inventory_items", { organization_id: "eq.org-primary", id: `eq.${itemId}`, select: "id,name,barcode,category,price,stock_qty,active,archived_by_user_id,archive_reason" }) : [],
      tabId ? readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: "eq.org-primary", id: `eq.${tabId}`, select: "id,status,close_disposition,closed_bill_id,customer_id,customer_name,close_reason" }) : [],
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", { organization_id: "eq.org-primary", bill_number: `in.(${recovery.identities.originalBillNumber},${recovery.identities.replacementBillNumber})`, select: "id,bill_number,status,total,amount_paid,amount_due,replacement_of_bill_id,replaced_by_bill_id,replace_reason,replaced_by_user_id,issued_by_user_id,customer_id,customer_name" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bill_lines", { organization_id: "eq.org-primary", bill_id: `in.(${billIds.length ? billIds.join(",") : missing})`, select: "id,bill_id,type,description,inventory_item_id,quantity,unit_price,subtotal,discount_amount,total,linked_session_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "payments", { organization_id: "eq.org-primary", bill_id: `in.(${billIds.length ? billIds.join(",") : missing})`, select: "id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "stock_movements", { organization_id: "eq.org-primary", related_bill_id: `in.(${billIds.length ? billIds.join(",") : missing})`, select: "id,item_id,type,quantity,reason,related_bill_id,user_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", { organization_id: "eq.org-primary", id: `in.(${eventIds.length ? eventIds.join(",") : missing})`, select: "id,event_type,entity_type,entity_id,created_by,metadata,created_at" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", { organization_id: "eq.org-primary", id: `in.(${auditIds.length ? auditIds.join(",") : missing})`, select: "id,action,entity_type,entity_id,message,user_id,created_at" }),
      Promise.all((snapshot.mutationStatuses ?? []).map(async (expected: Record<string, any>, index: number) => {
        const actorPage = index === 0 ? page : observer.page;
        const actorIdentity = index === 0 ? identity : observerIdentity;
        const response = await actorPage.request.post(`${actorIdentity.restBase}/rpc/get_financial_mutation_result`, { headers: actorIdentity.headers, data: { payload: { organization_id: "org-primary", mutation_id: expected.mutation_id, mutation_kind: "commitCheckoutBill" } } });
        expect(response.status()).toBe(200);
        return readApiResponseBody(response);
      })),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: "eq.org-primary", status: "neq.closed", select: "id,status,customer_name" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: "eq.org-primary", status: "eq.open", select: "id,status,customer_name" }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" })
    ]);
    expect(sorted(finalBills)).toEqual(sorted(bills));
    expect(sorted(finalLines)).toEqual(sorted(lines));
    expect(sorted(finalPayments)).toEqual(sorted(payments));
    expect(sorted(finalMovements)).toEqual(sorted(movements));
    expect(sorted(finalEvents)).toEqual(sorted(events));
    expect(sorted(finalAudits)).toEqual(sorted(audits));
    expect(finalMutationStatuses.map(stable)).toEqual(mutationStatuses.map(stable));
    expect(finalOpenSessions).toEqual([]);
    expect(finalOpenTabs).toEqual([]);
    if (recovery.recovery.rejectTab) expect(finalTabs).toEqual([expect.objectContaining({ id: tabId, status: "closed", close_disposition: "rejected", closed_bill_id: null })]);
    if (recovery.recovery.archiveItem) expect(finalItems).toEqual([expect.objectContaining({ id: itemId, active: false, stock_qty: items[0].stock_qty, archived_by_user_id: identity.actorId })]);
    expect(finalState).toHaveLength(1);
    expect(finalState[0].version).toBe(snapshot.appState.version + actions.length);
    checkpoint("terminal", { status: "cleanup-confirmed", preparedPath, recoveryArtifact: path.relative(root, recoveryPath!), recoverySha256: expectedRecoverySha256, actorId: identity.actorId, observerActorId: observerIdentity.actorId, baseline, actions, final: { items: finalItems, tabs: finalTabs, bills: finalBills, lines: finalLines, payments: finalPayments, movements: finalMovements, events: finalEvents, audits: finalAudits, mutationStatuses: finalMutationStatuses, openSessions: finalOpenSessions, openTabs: finalOpenTabs, appState: { version: finalState[0].version, hash: dataHash(finalState[0].data) } } });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (activeCommand) {
      if (!activeCommand.wasSubmitted()) activeCommand.cancel();
      await activeCommand.dispose().catch(() => undefined);
    }
    await attachFailureScreenshot(testInfo, page, "replacement-parity-cleanup-failure");
    await observer.context.close();
    if (!primaryError) expect(actions.length).toBeGreaterThan(0);
  }
});
