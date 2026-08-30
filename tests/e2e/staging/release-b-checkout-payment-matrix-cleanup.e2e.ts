import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  captureAuthenticatedRestRequests,
  credentials,
  interceptSingleRpcCommand,
  readApiResponseBody,
  readRestRows,
  rejectSessionIfOpen,
  signIn,
  stationCard,
  type CapturedRpcRequest
} from "./support/app";

const root = process.cwd();
const cleanupRunId = process.env.E2E_RUN_ID ?? "missing-cleanup-run";
const sourceRunId = process.env.E2E_PAYMENT_MATRIX_SOURCE_RUN_ID ?? "missing-source-run";
const selectedCase = process.env.E2E_PAYMENT_MATRIX_CASE ?? "missing-case";
const recoveryPathValue = process.env.E2E_PAYMENT_MATRIX_RECOVERY_ARTIFACT;
const expectedRecoverySha256 = process.env.E2E_PAYMENT_MATRIX_RECOVERY_SHA256;
const recoveryPath = recoveryPathValue ? path.resolve(recoveryPathValue) : null;
const recoveryRaw = recoveryPath ? fs.readFileSync(recoveryPath) : null;
const recovery = recoveryRaw ? JSON.parse(recoveryRaw.toString("utf8")) : { customerName: "discovery-only", snapshot: { cleanupCandidates: [] } };

function hash(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
  }
  return value;
}

function sortedRows(rows: Array<Record<string, unknown>>) {
  return [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id))).map(stable);
}

function assertNoSecrets(value: unknown) {
  const forbidden: string[] = [];
  const scan = (entry: unknown, currentPath: string) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) return entry.forEach((item, index) => scan(item, `${currentPath}[${index}]`));
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      const childPath = `${currentPath}.${key}`;
      if (/^(authorization|apikey|password|access_token|refresh_token)$/i.test(key)) forbidden.push(childPath);
      scan(child, childPath);
    }
  };
  scan(value, "evidence");
  if (forbidden.length) throw new Error(`Refusing to persist sensitive payment cleanup evidence: ${forbidden.join(", ")}`);
}

function checkpoint(stage: string, value: Record<string, unknown>) {
  const evidence = {
    cleanupRunId,
    sourceRunId,
    selectedCase,
    stage,
    recordedAt: new Date().toISOString(),
    productionAllowed: false,
    safeForAutomaticRetry: false,
    ...value
  };
  assertNoSecrets(evidence);
  const directory = path.join(root, "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-payment-matrix-cleanup-${selectedCase}-${stage}-${cleanupRunId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
  return path.relative(root, target);
}

function appStateSessionProjection(data: unknown, sessionIds: string[]) {
  const value = data as { sessions?: Array<Record<string, unknown>> };
  return (value?.sessions ?? []).filter((entry) => sessionIds.includes(String(entry.id))).map(stable);
}

test("rejects only exact identity-bound open payment-matrix sessions", async ({ page }, testInfo) => {
  const actions: Array<Record<string, unknown>> = [];
  const authenticatedRequests: CapturedRpcRequest[] = [];
  captureAuthenticatedRestRequests(page, authenticatedRequests);
  let primaryError: unknown;
  let activeCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
  let activeRejectionUi: Promise<boolean> | undefined;
  try {
    expect(recoveryPath).toBeTruthy();
    expect(recoveryRaw).toBeTruthy();
    expect(hash(recoveryRaw!)).toBe(expectedRecoverySha256);
    expect(recovery).toEqual(expect.objectContaining({
      runId: sourceRunId,
      selectedCase,
      projectRef: "tkbdyzxwwbhkpztgjjxh",
      productionAllowed: false,
      safeForAutomaticRetry: false,
      safeForIdentityBoundCleanup: true,
      status: "partial",
      integrityFailures: [],
      snapshot: expect.objectContaining({ cleanupCandidates: expect.any(Array) })
    }));
    expect(recovery.outcomeClassification.some((entry: { outcome: string }) => entry.outcome === "ambiguous")).toBe(false);
    expect(recovery.snapshot.cleanupCandidates.length).toBeGreaterThan(0);

    await signIn(page, credentials("A"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, authenticatedRequests, "admin", "org-primary");
    expect(identity.actorId).toBe(recovery.actorId);
    const snapshot = recovery.snapshot as Record<string, unknown>;
    const candidateIds = (snapshot.cleanupCandidates as Array<{ id: string }>).map((entry) => entry.id);
    const billIds = (snapshot.bills as Array<{ id: string }>).map((entry) => entry.id);

    const selectExact = async (table: string, select: string, expected: Array<Record<string, unknown>>, query: Record<string, string>) => {
      const actual = await readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, table, query);
      expect(sortedRows(actual), `${table} drifted from the SHA-bound recovery snapshot.`).toEqual(sortedRows(expected));
      return actual;
    };
    const missingUuid = "00000000-0000-0000-0000-000000000000";
    const [sessions, bills, lines, payments, lineDiscounts, billDiscounts, movements, events, audits, openSessions, openTabs, appState] = await Promise.all([
      selectExact("sessions", "id,status,station_name_snapshot,customer_name,started_at,ended_at,closed_bill_id,close_disposition,close_reason,raw_data",
        snapshot.sessions as Array<Record<string, unknown>>, { organization_id: "eq.org-primary", customer_name: `eq.${recovery.customerName}`, select: "id,status,station_name_snapshot,customer_name,started_at,ended_at,closed_bill_id,close_disposition,close_reason,raw_data" }),
      selectExact("bills", "id,bill_number,customer_name,status,payment_mode,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,issued_by_user_id,session_id,settled_at,settled_by_user_id,raw_data",
        snapshot.bills as Array<Record<string, unknown>>, { organization_id: "eq.org-primary", customer_name: `eq.${recovery.customerName}`, select: "id,bill_number,customer_name,status,payment_mode,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,issued_by_user_id,session_id,settled_at,settled_by_user_id,raw_data" }),
      selectExact("bill_lines", "id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id,inventory_item_id",
        snapshot.lines as Array<Record<string, unknown>>, { organization_id: "eq.org-primary", bill_id: `in.(${billIds.length ? billIds.join(",") : missingUuid})`, select: "id,bill_id,type,description,quantity,unit_price,subtotal,discount_amount,total,linked_session_id,inventory_item_id" }),
      selectExact("payments", "id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id",
        snapshot.payments as Array<Record<string, unknown>>, { organization_id: "eq.org-primary", bill_id: `in.(${billIds.length ? billIds.join(",") : missingUuid})`, select: "id,bill_id,mode,amount,received_by_user_id,settlement_group_id,related_checkout_bill_id" }),
      selectExact("bill_line_discounts", "id,bill_id", snapshot.lineDiscounts as Array<Record<string, unknown>>,
        { organization_id: "eq.org-primary", bill_id: `in.(${billIds.length ? billIds.join(",") : missingUuid})`, select: "id,bill_id" }),
      selectExact("bill_discounts", "id,bill_id", snapshot.billDiscounts as Array<Record<string, unknown>>,
        { organization_id: "eq.org-primary", bill_id: `in.(${billIds.length ? billIds.join(",") : missingUuid})`, select: "id,bill_id" }),
      selectExact("stock_movements", "id,item_id,related_bill_id,type,quantity,user_id", snapshot.movements as Array<Record<string, unknown>>,
        { organization_id: "eq.org-primary", related_bill_id: `in.(${billIds.length ? billIds.join(",") : missingUuid})`, select: "id,item_id,related_bill_id,type,quantity,user_id" }),
      selectExact("operational_events", "id,event_type,entity_type,entity_id,created_by,metadata", snapshot.events as Array<Record<string, unknown>>,
        { organization_id: "eq.org-primary", id: `in.(${(snapshot.events as Array<{ id: string }>).length ? (snapshot.events as Array<{ id: string }>).map((entry) => entry.id).join(",") : missingUuid})`, select: "id,event_type,entity_type,entity_id,created_by,metadata" }),
      selectExact("audit_logs", "id,action,entity_type,entity_id,message,user_id", snapshot.audits as Array<Record<string, unknown>>,
        { organization_id: "eq.org-primary", id: `in.(${(snapshot.audits as Array<{ id: string }>).length ? (snapshot.audits as Array<{ id: string }>).map((entry) => entry.id).join(",") : missingUuid})`, select: "id,action,entity_type,entity_id,message,user_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "sessions", { organization_id: "eq.org-primary", status: "neq.closed", select: "id,customer_name,station_name_snapshot,status,close_disposition,closed_bill_id" }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "customer_tabs", { organization_id: "eq.org-primary", status: "eq.open", select: "id,customer_name,status" }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" })
    ]);
    expect(openSessions).toEqual(snapshot.openSessions);
    expect(openTabs).toEqual(snapshot.openTabs);
    expect(openSessions.map((entry) => entry.id).sort()).toEqual([...candidateIds].sort());
    expect(appState).toHaveLength(1);
    expect(appState[0].version).toBe((snapshot.appState as { version: number }).version);
    expect(hash(JSON.stringify(appState[0].data))).toBe((snapshot.appState as { hash: string }).hash);
    expect(appStateSessionProjection(appState[0].data, sessions.map((entry) => String(entry.id))))
      .toEqual((snapshot.appState as { sessionProjection: unknown }).sessionProjection);
    const runEntityIds = [...sessions.map((entry) => String(entry.id)), ...bills.map((entry) => String(entry.id))];
    const [runFinancialEvents, runFinancialAudits] = await Promise.all([
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "operational_events", {
        organization_id: "eq.org-primary",
        event_type: "eq.financial_checkout_committed_v2",
        entity_id: `in.(${runEntityIds.length ? runEntityIds.join(",") : missingUuid})`,
        select: "id,event_type,entity_type,entity_id,created_by,metadata"
      }),
      readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "audit_logs", {
        organization_id: "eq.org-primary",
        action: "in.(bill_issued,bill_pending,bill_settled,session_checkout_details_updated)",
        entity_id: `in.(${runEntityIds.length ? runEntityIds.join(",") : missingUuid})`,
        select: "id,action,entity_type,entity_id,message,user_id"
      })
    ]);
    expect(sortedRows(runFinancialEvents)).toEqual(sortedRows(snapshot.events as Array<Record<string, unknown>>));
    expect(sortedRows(runFinancialAudits)).toEqual(sortedRows(snapshot.audits as Array<Record<string, unknown>>));
    const currentCanonical = await Promise.all((snapshot.mutationStatuses as Array<Record<string, unknown>>).map(async (expected) => {
      const response = await page.request.post(`${identity.restBase}/rpc/get_financial_mutation_result`, {
        headers: identity.headers,
        data: { payload: { organization_id: "org-primary", mutation_id: expected.mutation_id, mutation_kind: "commitCheckoutBill" } }
      });
      expect(response.status()).toBe(200);
      return await response.json();
    }));
    expect(currentCanonical.map(stable)).toEqual((snapshot.mutationStatuses as Array<unknown>).map(stable));
    const verifiedSnapshot = { sessions, bills, lines, payments, lineDiscounts, billDiscounts, movements, events, audits,
      runFinancialEvents, runFinancialAudits, openSessions, openTabs,
      mutationStatuses: currentCanonical, appState: { version: appState[0].version, hash: hash(JSON.stringify(appState[0].data)), sessionProjection: appStateSessionProjection(appState[0].data, candidateIds) } };

    const financialMutationIds = new Set((snapshot.mutationStatuses as Array<{ mutation_id?: string }>).map((entry) => entry.mutation_id).filter(Boolean));
    for (const candidate of snapshot.cleanupCandidates as Array<{ id: string; customerName: string; stationName: string }>) {
      expect(candidate.customerName).toBe(recovery.customerName);
      expect(candidate.stationName).toBe("8 Ball Pool");
      await expect(stationCard(page, candidate.stationName)).toContainText(candidate.customerName);
      const reason = `Payment matrix identity-bound cleanup ${selectedCase} ${sourceRunId} via ${cleanupRunId}`;
      activeCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/reject_session");
      activeRejectionUi = rejectSessionIfOpen(page, candidate.stationName, candidate.customerName, reason);
      const captured = await activeCommand.captured;
      const envelope = structuredClone(captured.body) as {
        payload: { organization_id: string; mutation_id: string; mutation_kind: string; entity_id: string; payload: { session: { id: string }; auditLog: { id: string } } };
      };
      expect(activeCommand.captureCount()).toBe(1);
      expect(activeCommand.wasSubmitted()).toBe(false);
      expect(envelope.payload.organization_id).toBe("org-primary");
      expect(envelope.payload.mutation_kind).toBe("rejectSession");
      expect(envelope.payload.entity_id).toBe(candidate.id);
      expect(envelope.payload.payload.session.id).toBe(candidate.id);
      expect(envelope.payload.mutation_id).toBeTruthy();
      expect(financialMutationIds.has(envelope.payload.mutation_id)).toBe(false);
      expect(actions.some((entry) => entry.mutationId === envelope.payload.mutation_id)).toBe(false);
      const preparedPath = checkpoint(`${candidate.id}-prepared`, {
        status: "captured-not-submitted",
        recoveryArtifact: path.relative(root, recoveryPath!),
        recoverySha256: expectedRecoverySha256,
        candidate,
        reason,
        command: envelope,
        captureCount: activeCommand.captureCount(),
        submissionCount: 0,
        verifiedSnapshot
      });
      const response = await activeCommand.submit(envelope);
      const body = await readApiResponseBody(response);
      const acknowledgedPath = checkpoint(`${candidate.id}-acknowledged`, {
        status: "response-received",
        recoveryArtifact: path.relative(root, recoveryPath!),
        recoverySha256: expectedRecoverySha256,
        candidate,
        reason,
        preparedPath,
        commandSummary: { mutationId: envelope.payload.mutation_id, entityId: candidate.id, auditId: envelope.payload.payload.auditLog.id },
        captureCount: activeCommand.captureCount(),
        submissionCount: 1,
        response: { status: response.status(), body }
      });
      expect(response.status()).toBe(200);
      expect(body.mutation_id).toBe(envelope.payload.mutation_id);
      expect(body.entity_id).toBe(candidate.id);
      expect(body.changed_rows).toEqual(expect.objectContaining({ sessions: [candidate.id], audit_logs: [envelope.payload.payload.auditLog.id] }));
      expect(await activeRejectionUi).toBe(true);
      expect(activeCommand.wasSubmitted()).toBe(true);
      expect(activeCommand.captureCount()).toBe(1);
      await activeCommand.dispose();
      activeCommand = undefined;
      activeRejectionUi = undefined;
      actions.push({ action: "reject_session", ...candidate, reason, mutationId: envelope.payload.mutation_id, auditId: envelope.payload.payload.auditLog.id,
        eventId: body.event_id, preparedPath, acknowledgedPath, response: body });
    }

    const afterAppState = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", { id: "eq.primary", select: "version,data" });
    expect(afterAppState).toHaveLength(1);
    const finalPath = checkpoint("final", {
      status: "cleanup-confirmed",
      recoveryArtifact: path.relative(root, recoveryPath!),
      recoverySha256: expectedRecoverySha256,
      actorId: identity.actorId,
      verifiedSnapshot,
      actions,
      appStateAfter: {
        version: afterAppState[0].version,
        hash: hash(JSON.stringify(afterAppState[0].data)),
        sessionProjection: appStateSessionProjection(afterAppState[0].data, candidateIds)
      }
    });
    expect(actions).toHaveLength(recovery.snapshot.cleanupCandidates.length);
    expect(finalPath).toBeTruthy();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (activeCommand) {
      if (!activeCommand.wasSubmitted()) activeCommand.cancel();
      await activeCommand.dispose().catch(() => undefined);
      await activeRejectionUi?.catch(() => undefined);
    }
    await attachFailureScreenshot(testInfo, page, `payment-matrix-cleanup-${selectedCase}-failure`);
    if (!primaryError) expect(actions).toHaveLength(recovery.snapshot.cleanupCandidates.length);
  }
});
