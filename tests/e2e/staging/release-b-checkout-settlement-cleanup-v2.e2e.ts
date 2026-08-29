import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  attachJson,
  captureAuthenticatedRestRequests,
  captureRpcEvidence,
  credentials,
  readRestRows,
  rejectSessionIfOpen,
  signIn,
  type CapturedRpcRequest,
  type RpcEvidence
} from "./support/app";

const cleanupRunId = process.env.E2E_RUN_ID?.trim();
const sourceRunId = process.env.E2E_RACE_SOURCE_RUN_ID?.trim();
const sessionId = process.env.E2E_RACE_CLEANUP_SESSION_ID?.trim();
const expectedVersion = Number(process.env.E2E_RACE_CLEANUP_APP_STATE_VERSION);
const expectedHash = process.env.E2E_RACE_CLEANUP_APP_STATE_HASH?.trim();
const customerName = process.env.E2E_RACE_CLEANUP_CUSTOMER_NAME?.trim() || `QA Checkout Settlement Race ${sourceRunId}`;
const station = process.env.E2E_RACE_CLEANUP_STATION?.trim() || "8 Ball Pool";
const reason = process.env.E2E_RACE_CLEANUP_REASON?.trim() || `Playwright checkout-settlement adjustment-winner cleanup source ${sourceRunId} execution ${cleanupRunId}`;
const comboRecoveryPath = process.env.E2E_REPEAT_COMBO_RECOVERY_ARTIFACT?.trim();
const comboRecovery = comboRecoveryPath ? JSON.parse(readFileSync(comboRecoveryPath, "utf8")) : null;
const writeoffRecoveryPath = process.env.E2E_CHECKOUT_WRITEOFF_RECOVERY_ARTIFACT?.trim();
const writeoffRecoverySha256 = process.env.E2E_CHECKOUT_WRITEOFF_RECOVERY_SHA256?.trim();
if (Boolean(writeoffRecoveryPath) !== Boolean(writeoffRecoverySha256)) {
  throw new Error("Checkout-writeoff cleanup requires both the recovery artifact path and SHA-256.");
}
const writeoffRecoveryBytes = writeoffRecoveryPath ? readFileSync(writeoffRecoveryPath) : null;
const writeoffRecovery = writeoffRecoveryBytes ? JSON.parse(writeoffRecoveryBytes.toString("utf8")) : null;

if (!cleanupRunId || !sourceRunId || cleanupRunId === sourceRunId || !sessionId || !Number.isInteger(expectedVersion) || !expectedHash) {
  throw new Error("Exact checkout-settlement cleanup identity and app_state baseline are required.");
}

function appStateHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
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

test("rejects only the exact unbilled adjustment-winner session", async ({ page }, testInfo) => {
  const requests: CapturedRpcRequest[] = [];
  const rpcEvidence: RpcEvidence[] = [];
  captureAuthenticatedRestRequests(page, requests);
  captureRpcEvidence(page, "origin", rpcEvidence);
  let cleanupEvidence: Record<string, unknown> = {};

  try {
    await signIn(page, credentials("A"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, requests, "admin", "org-primary");
    const [beforeSessions, beforeAppState] = await Promise.all([
      readRestRows<{
        id: string;
        status: string;
        close_disposition: string | null;
        closed_bill_id: string | null;
        customer_name: string;
        station_name_snapshot: string;
      }>(page, identity.restBase, identity.headers, "sessions", {
        organization_id: "eq.org-primary",
        id: `eq.${sessionId}`,
        select: "id,status,close_disposition,closed_bill_id,customer_name,station_name_snapshot"
      }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary",
        select: "version,data"
      })
    ]);
    expect(beforeSessions).toEqual([{
      id: sessionId,
      status: "active",
      close_disposition: null,
      closed_bill_id: null,
      customer_name: customerName,
      station_name_snapshot: station
    }]);
    expect(beforeAppState).toHaveLength(1);
    expect(beforeAppState[0].version).toBe(expectedVersion);
    expect(appStateHash(beforeAppState[0].data)).toBe(expectedHash);

    if (writeoffRecovery) {
      expect(path.resolve(writeoffRecoveryPath!)).toBe(writeoffRecoveryPath);
      expect(createHash("sha256").update(writeoffRecoveryBytes!).digest("hex")).toBe(writeoffRecoverySha256);
      expect(writeoffRecovery).toEqual(expect.objectContaining({
        runId: sourceRunId,
        projectRef: "tkbdyzxwwbhkpztgjjxh",
        productionAllowed: false,
        safeForAutomaticRetry: false,
        status: "partial",
        safeForIdentityBoundCleanup: true,
        failures: [],
        cleanupCandidates: [expect.objectContaining({ sessionId, customerName, station, reason })],
        openFloor: { sessions: [expect.objectContaining({ id: sessionId, status: "active", customer_name: customerName })], tabs: [] },
        appState: { version: expectedVersion, hash: expectedHash }
      }));
      const snapshot = writeoffRecovery.exactRunData as Record<string, Array<Record<string, unknown>>>;
      const selectByIds = async (table: string, select: string, expected: Array<Record<string, unknown>>) => {
        const actual = await readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, table, {
          organization_id: "eq.org-primary",
          id: `in.(${(expected.length ? expected.map((entry) => entry.id) : ["missing-writeoff-cleanup-row"]).join(",")})`,
          select
        });
        expect(sortedRows(actual), `${table} drifted from the authorized recovery snapshot.`).toEqual(sortedRows(expected));
      };
      await Promise.all([
        selectByIds("sessions", "id,status,close_disposition,closed_bill_id,customer_name,station_name_snapshot", snapshot.sessions),
        selectByIds("bills", "id,bill_number,customer_name,customer_phone,payment_mode,session_id,status,subtotal,total_discount_amount,bill_discount_amount,round_off_enabled,round_off_amount,total,amount_paid,amount_due,settled_at,voided_at,voided_by_user_id,void_reason,issued_by_user_id", snapshot.bills),
        selectByIds("bill_lines", "id,bill_id,type,description,quantity,unit_price,total,linked_session_id", snapshot.lines),
        selectByIds("payments", "id,bill_id,amount,mode,received_by_user_id,related_checkout_bill_id", snapshot.payments),
        selectByIds("stock_movements", "id,item_id,type,quantity,related_bill_id,user_id", snapshot.stockMovements),
        selectByIds("operational_events", "id,event_type,entity_type,entity_id,created_by,metadata", snapshot.entityEvents),
        selectByIds("audit_logs", "id,action,entity_type,entity_id,user_id,message", snapshot.entityAudits)
      ]);
    }

    if (comboRecovery) {
      expect(comboRecovery.safeForIdentityBoundCleanup).toBe(true);
      expect(comboRecovery.runId).toBe(sourceRunId);
      expect(comboRecovery.session.id).toBe(sessionId);
      expect(comboRecovery.checkoutMutationId).toBeTruthy();
      const [events, audits, combos, items, movements, checkoutMutationResponse] = await Promise.all([
        readRestRows<{ id: string; event_type: string; entity_id: string; created_by: string; metadata: unknown }>(page, identity.restBase, identity.headers, "operational_events", {
          organization_id: "eq.org-primary", entity_id: `eq.${sessionId}`, select: "id,event_type,entity_id,created_by,metadata", order: "created_at.asc"
        }),
        readRestRows<{ id: string; action: string; entity_id: string; user_id: string }>(page, identity.restBase, identity.headers, "audit_logs", {
          organization_id: "eq.org-primary", entity_id: `eq.${sessionId}`, select: "id,action,entity_id,user_id", order: "created_at.asc"
        }),
        readRestRows<{ id: string; combo_id: string; combo_name: string; price: number; included_minutes: number }>(page, identity.restBase, identity.headers, "session_combo_applications", {
          organization_id: "eq.org-primary", session_id: `eq.${sessionId}`, select: "id,combo_id,combo_name,price,included_minutes", order: "created_at.asc"
        }),
        readRestRows<{ id: string; inventory_item_id: string | null; name: string; quantity: number; unit_price: number; combo_application_id: string | null; combo_id: string | null }>(page, identity.restBase, identity.headers, "session_items", {
          organization_id: "eq.org-primary", session_id: `eq.${sessionId}`, select: "id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id", order: "created_at.asc"
        }),
        readRestRows<{ id: string; item_id: string; type: string; quantity: number; user_id: string; related_bill_id: string | null }>(page, identity.restBase, identity.headers, "stock_movements", {
          organization_id: "eq.org-primary", id: `in.(${comboRecovery.movements.map((entry: { id: string }) => entry.id).join(",")})`, select: "id,item_id,type,quantity,user_id,related_bill_id"
        }),
        page.request.post(`${identity.restBase}/rpc/get_financial_mutation_result`, {
          headers: identity.headers,
          data: {
            payload: {
              organization_id: "org-primary",
              mutation_id: comboRecovery.checkoutMutationId,
              mutation_kind: "commitCheckoutBill"
            }
          }
        })
      ]);
      expect(events).toEqual(comboRecovery.events.map(({ id, event_type, entity_id, created_by, metadata }: Record<string, unknown>) => ({ id, event_type, entity_id, created_by, metadata })));
      expect(audits).toEqual(comboRecovery.audits.map(({ id, action, entity_id, user_id }: Record<string, unknown>) => ({ id, action, entity_id, user_id })));
      expect(combos).toEqual(comboRecovery.combos.map(({ id, combo_id, combo_name, price, included_minutes }: Record<string, unknown>) => ({ id, combo_id, combo_name, price, included_minutes })));
      expect(items).toEqual(comboRecovery.items.map(({ id, inventory_item_id, name, quantity, unit_price, combo_application_id, combo_id }: Record<string, unknown>) => ({ id, inventory_item_id, name, quantity, unit_price, combo_application_id, combo_id })));
      const expectedMovements = comboRecovery.movements.map(({ id, item_id, type, quantity, user_id, related_bill_id }: Record<string, unknown>) => ({
        id, item_id, type, quantity, user_id, related_bill_id
      })).sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id));
      expect(movements.sort((left, right) => left.id.localeCompare(right.id))).toEqual(expectedMovements);
      expect(movements.every((entry) => entry.type === "session_reservation" && Number(entry.quantity) < 0 && entry.user_id === identity.actorId && entry.related_bill_id === null)).toBe(true);
      expect(checkoutMutationResponse.status()).toBe(200);
      expect(await checkoutMutationResponse.json()).toBeNull();
    }

    const rejected = await rejectSessionIfOpen(page, station, customerName, reason);
    expect(rejected, "Guarded cleanup did not reject the exact active session.").toBe(true);
    const rejection = rpcEvidence.filter((entry) => entry.rpc === "reject_session" && entry.status < 300);
    expect(rejection).toHaveLength(1);
    expect(rejection[0].entityId).toBe(sessionId);
    expect(rejection[0].mutationId).toBeTruthy();
    expect(rejection[0].eventId).toBeTruthy();
    expect(rejection[0].changedRows?.sessions).toEqual([sessionId]);
    expect(rejection[0].changedRows?.audit_logs).toHaveLength(1);
    expect(rpcEvidence.filter((entry) => entry.rpc.startsWith("commit_financial") || entry.rpc === "commit_checkout_bill_v2")).toEqual([]);

    const [afterSessions, afterAppState] = await Promise.all([
      readRestRows<{ id: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(
        page,
        identity.restBase,
        identity.headers,
        "sessions",
        {
          organization_id: "eq.org-primary",
          id: `eq.${sessionId}`,
          select: "id,status,close_disposition,closed_bill_id"
        }
      ),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary",
        select: "version,data"
      })
    ]);
    expect(afterSessions).toEqual([{
      id: sessionId,
      status: "closed",
      close_disposition: "rejected",
      closed_bill_id: null
    }]);
    expect(afterAppState).toHaveLength(1);
    expect(afterAppState[0].version).toBe(expectedVersion + 1);
    cleanupEvidence = {
      cleanupRunId,
      sourceRunId,
      sessionId,
      customerName,
      station,
      reason,
      actorId: identity.actorId,
      rejection: rejection[0],
      recoveryArtifact: writeoffRecoveryPath ? path.resolve(writeoffRecoveryPath) : undefined,
      recoverySha256: writeoffRecoverySha256,
      appStateBefore: { version: beforeAppState[0].version, hash: expectedHash },
      appStateAfter: {
        version: afterAppState[0].version,
        hash: appStateHash(afterAppState[0].data)
      }
    };
  } finally {
    await attachJson(testInfo, "checkout-settlement-adjustment-winner-cleanup", {
      ...cleanupEvidence,
      rpcEvidence
    });
    await attachFailureScreenshot(testInfo, page, "checkout-settlement-cleanup-failure");
  }
});
