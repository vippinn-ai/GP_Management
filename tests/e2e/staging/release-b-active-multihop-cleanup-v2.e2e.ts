import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  browserDateTimeLocal,
  capturePageErrors,
  changedRowIds,
  credentials,
  interceptSingleRpcCommand,
  openManagedSession,
  readApiResponseBody,
  readRestRows,
  signIn,
  stationCard,
  waitForSynced,
  type CapturedRpcRequest,
  type RpcEvidence
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const primarySessionId = process.env.E2E_GUARDED_ACTIVE_SESSION_ID?.trim();
const customerName = process.env.E2E_GUARDED_ACTIVE_CUSTOMER?.trim();
const station = process.env.E2E_GUARDED_ACTIVE_STATION?.trim();
const sourceSessionIds = (process.env.E2E_GUARDED_ACTIVE_SOURCE_IDS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const expectedAppStateVersion = Number(process.env.E2E_GUARDED_ACTIVE_APP_STATE_VERSION);
const expectedAppStateHash = process.env.E2E_GUARDED_ACTIVE_APP_STATE_HASH?.trim();
const captureOnly = process.env.E2E_GUARDED_ACTIVE_CAPTURE_ONLY === "true";

type CheckoutEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    payload: {
      source_session_ids: string[];
      primary_bill: { id: string; billNumber: string; lines: Array<{ linkedSessionId?: string }> };
      bill_updates: Array<{ id: string; billNumber: string }>;
      session_updates: Array<{ id: string; startedAt?: string; endedAt?: string }>;
      audit_logs: Array<{ id: string }>;
    };
  };
};

function appStateHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function prepareCommand(captured: CapturedRpcRequest) {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const billNumber = `BILL-QA-ACTIVE-MULTIHOP-${runId}`;
  envelope.payload.mutation_id = `financial-active-multihop-${runId}`;
  envelope.payload.payload.primary_bill.billNumber = billNumber;
  const primaryUpdate = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primaryUpdate) throw new Error("Captured checkout omitted its primary bill update.");
  primaryUpdate.billNumber = billNumber;
  return envelope;
}

test.describe.serial("Release B guarded active multi-hop cleanup", () => {
  test("bills one exact active three-session chain once", async ({ page }, testInfo) => {
    test.skip(
      !primarySessionId || !customerName || !station || !expectedAppStateHash,
      "Exact active multi-hop cleanup identity was not supplied."
    );
    test.skip(
      sourceSessionIds.length !== 3 || new Set(sourceSessionIds).size !== 3 ||
      !sourceSessionIds.includes(primarySessionId!) || !Number.isInteger(expectedAppStateVersion),
      "The active cleanup requires exactly three unique sources and an app_state checkpoint."
    );

    const pageErrors = capturePageErrors(page);
    let command: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let checkoutSent = false;
    let checkoutResolved = false;
    let primaryError: unknown;
    let cleanupError: string | undefined;
    let evidence: Record<string, unknown> = {};
    const dialogMessages: string[] = [];
    const dismissDialog = (dialog: { message(): string; dismiss(): Promise<void> }) => {
      dialogMessages.push(dialog.message());
      void dialog.dismiss();
    };

    try {
      await signIn(page, credentials("A"));
      const managed = await openManagedSession(page, station!);
      await managed.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await expect(managed.getByLabel("Customer Name", { exact: true })).toHaveValue(customerName!);
      await managed.getByRole("button", { name: "Cancel", exact: true }).click();
      await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();

      command = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
      page.on("dialog", dismissDialog);
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      const captured = await command.captured;
      expect(command.captureCount()).toBe(1);
      const envelope = prepareCommand(captured);
      const expectedSourceIds = [...sourceSessionIds].sort();
      expect(envelope.payload.entity_id).toBe(primarySessionId);
      expect(envelope.payload.payload.source_session_ids).toHaveLength(3);
      expect([...envelope.payload.payload.source_session_ids].sort()).toEqual(expectedSourceIds);
      const submittedSessionIds = envelope.payload.payload.session_updates.map((session) => session.id);
      expect(submittedSessionIds).toHaveLength(3);
      expect([...submittedSessionIds].sort()).toEqual(expectedSourceIds);
      expect(envelope.payload.payload.primary_bill.lines).toHaveLength(3);
      const linkedLineSessionIds = envelope.payload.payload.primary_bill.lines
        .flatMap((line) => line.linkedSessionId ? [line.linkedSessionId] : []);
      expect(linkedLineSessionIds).toHaveLength(3);
      expect([...linkedLineSessionIds].sort()).toEqual(expectedSourceIds);

      const actorId = authenticatedJwtSubject(captured.headers);
      const headers = {
        apikey: captured.headers.apikey,
        authorization: captured.headers.authorization,
        "content-type": "application/json",
        prefer: captured.headers.prefer || "return=representation"
      };
      const restHeaders = { apikey: headers.apikey, authorization: headers.authorization };
      const restBase = captured.url.replace(/\/rpc\/[^/]+$/, "");
      const [roleResponse, sessionsBefore, appStateBefore] = await Promise.all([
        page.request.post(`${restBase}/rpc/current_user_org_role`, {
          headers,
          data: { target_organization_id: envelope.payload.organization_id }
        }),
        readRestRows<{
          id: string; status: string; close_disposition: string | null; closed_bill_id: string | null;
          started_at: string; ended_at: string | null;
          continued_from_session_ids: string[] | null; customer_name: string | null; station_name_snapshot: string;
        }>(page, restBase, restHeaders, "sessions", {
          organization_id: "eq.org-primary",
          id: `in.(${sourceSessionIds.join(",")})`,
          select: "id,status,close_disposition,closed_bill_id,started_at,ended_at,continued_from_session_ids,customer_name,station_name_snapshot"
        }),
        readRestRows<{ version: number; data: unknown }>(page, restBase, restHeaders, "app_state", {
          id: "eq.primary", select: "version,data"
        })
      ]);
      expect(roleResponse.status()).toBe(200);
      expect(await roleResponse.json()).toBe("admin");
      expect(appStateBefore).toHaveLength(1);
      expect(appStateBefore[0].version).toBe(expectedAppStateVersion);
      expect(appStateHash(appStateBefore[0].data)).toBe(expectedAppStateHash);
      expect(sessionsBefore).toHaveLength(3);
      const beforeById = new Map(sessionsBefore.map((session) => [session.id, session]));
      const [firstId, secondId, thirdId] = sourceSessionIds;
      for (const session of sessionsBefore) {
        expect(session).toMatchObject({ customer_name: customerName, station_name_snapshot: station, closed_bill_id: null });
      }
      expect(beforeById.get(firstId)).toMatchObject({ status: "closed", close_disposition: "hopped" });
      expect(beforeById.get(secondId)).toMatchObject({ status: "closed", close_disposition: "hopped", continued_from_session_ids: [firstId] });
      expect(beforeById.get(thirdId)).toMatchObject({ status: "active", close_disposition: null, continued_from_session_ids: [firstId, secondId] });
      const timingComparisons = envelope.payload.payload.session_updates.map((session) => {
        const stored = beforeById.get(session.id);
        return {
          id: session.id,
          submittedStartedAt: session.startedAt ?? null,
          storedStartedAt: stored?.started_at ?? null,
          submittedEndedAt: session.endedAt ?? null,
          storedEndedAt: stored?.ended_at ?? null,
          startedAtMatches: Boolean(stored && session.startedAt && new Date(session.startedAt).getTime() === new Date(stored.started_at).getTime()),
          endedAtMatches: Boolean(stored && session.endedAt && stored.ended_at && new Date(session.endedAt).getTime() === new Date(stored.ended_at).getTime())
        };
      });

      evidence = {
        primarySessionId, sourceSessionIds, customerName, station, actorId,
        mutationId: envelope.payload.mutation_id,
        billId: envelope.payload.payload.primary_bill.id,
        billNumber: envelope.payload.payload.primary_bill.billNumber,
        sessionsBefore, submittedSessionUpdates: envelope.payload.payload.session_updates, timingComparisons,
        appStateVersionBefore: appStateBefore[0].version,
        appStateHashBefore: expectedAppStateHash
      };

      if (captureOnly) {
        command.cancel();
        await command.settled;
        return;
      }
      for (const comparison of timingComparisons.filter((entry) => entry.id !== primarySessionId)) {
        expect(comparison.startedAtMatches, `${comparison.id} carried start time`).toBe(true);
        expect(comparison.endedAtMatches, `${comparison.id} carried end time`).toBe(true);
      }

      checkoutSent = true;
      const response = await command.submit(envelope);
      const body = await readApiResponseBody(response);
      evidence = { ...evidence, responseStatus: response.status(), responseBody: body };
      expect(response.status()).toBe(200);
      expect(body.bill_id).toBe(envelope.payload.payload.primary_bill.id);
      const changedSessionIds = changedRowIds({ changedRows: body.changed_rows } as RpcEvidence, "sessions");
      expect(changedSessionIds).toHaveLength(3);
      expect([...changedSessionIds].sort()).toEqual(expectedSourceIds);

      const statusResponse = await page.request.post(
        captured.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
        {
          headers,
          data: { payload: {
            organization_id: envelope.payload.organization_id,
            mutation_id: envelope.payload.mutation_id,
            mutation_kind: envelope.payload.mutation_kind
          } }
        }
      );
      expect(statusResponse.status()).toBe(200);
      const mutationStatus = await statusResponse.json() as Record<string, unknown> | null;
      expect(mutationStatus?.bill_id).toBe(envelope.payload.payload.primary_bill.id);
      const billId = envelope.payload.payload.primary_bill.id;
      const auditIds = envelope.payload.payload.audit_logs.map((audit) => audit.id);
      const [sessionsAfter, bills, payments, lines, events, audits, appStateAfter] = await Promise.all([
        readRestRows<{ id: string; status: string; close_disposition: string; closed_bill_id: string }>(page, restBase, restHeaders, "sessions", {
          organization_id: "eq.org-primary", id: `in.(${sourceSessionIds.join(",")})`, select: "id,status,close_disposition,closed_bill_id"
        }),
        readRestRows<{ id: string; status: string; total: number; amount_paid: number; amount_due: number; issued_by_user_id: string }>(page, restBase, restHeaders, "bills", {
          organization_id: "eq.org-primary", id: `eq.${billId}`, select: "id,status,total,amount_paid,amount_due,issued_by_user_id"
        }),
        readRestRows<{ id: string; amount: number; received_by_user_id: string }>(page, restBase, restHeaders, "payments", {
          organization_id: "eq.org-primary", bill_id: `eq.${billId}`, select: "id,amount,received_by_user_id"
        }),
        readRestRows<{ id: string; linked_session_id: string | null }>(page, restBase, restHeaders, "bill_lines", {
          organization_id: "eq.org-primary", bill_id: `eq.${billId}`, select: "id,linked_session_id"
        }),
        readRestRows<{ id: string; created_by: string }>(page, restBase, restHeaders, "operational_events", {
          organization_id: "eq.org-primary", "metadata->>mutation_id": `eq.${envelope.payload.mutation_id}`, select: "id,created_by"
        }),
        readRestRows<{ id: string; user_id: string }>(page, restBase, restHeaders, "audit_logs", {
          organization_id: "eq.org-primary", id: `in.(${auditIds.join(",")})`, select: "id,user_id"
        }),
        readRestRows<{ version: number; data: unknown }>(page, restBase, restHeaders, "app_state", { id: "eq.primary", select: "version,data" })
      ]);
      expect(sessionsAfter).toHaveLength(3);
      sessionsAfter.forEach((session) => expect(session).toMatchObject({ status: "closed", close_disposition: "billed", closed_bill_id: billId }));
      expect(bills).toHaveLength(1);
      expect(bills[0].status).toBe("issued");
      expect(Number(bills[0].total)).toBeGreaterThan(0);
      expect(Number(bills[0].amount_paid)).toBe(Number(bills[0].total));
      expect(Number(bills[0].amount_due)).toBe(0);
      expect(payments).toHaveLength(1);
      expect(Number(payments[0].amount)).toBe(Number(bills[0].total));
      expect(lines).toHaveLength(3);
      const persistedLinkedIds = lines.flatMap((line) => line.linked_session_id ? [line.linked_session_id] : []);
      expect(persistedLinkedIds).toHaveLength(3);
      expect([...persistedLinkedIds].sort()).toEqual(expectedSourceIds);
      expect(events).toHaveLength(1);
      expect(audits).toHaveLength(auditIds.length);
      expect(new Set([
        bills[0].issued_by_user_id, payments[0].received_by_user_id, events[0].created_by,
        ...audits.map((audit) => audit.user_id)
      ])).toEqual(new Set([actorId]));
      expect(appStateAfter).toHaveLength(1);
      expect(appStateAfter[0].version).toBe(expectedAppStateVersion);
      expect(appStateHash(appStateAfter[0].data)).toBe(expectedAppStateHash);
      expect(command.captureCount()).toBe(1);
      checkoutResolved = true;
      evidence = { ...evidence, mutationStatus, sessionsAfter, bill: bills[0], payment: payments[0], lines, eventCount: events.length, auditCount: audits.length };

      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(page);
      await expect(stationCard(page, station!)).toContainText("Available");
      expect(pageErrors).toEqual({ consoleErrors: [], pageErrors: [] });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      page.off("dialog", dismissDialog);
      command?.cancel();
      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
      if (checkoutSent && !checkoutResolved) {
        cleanupError = "Active multi-hop checkout was sent; reconcile its exact mutation ID before any cleanup or retry.";
      }
      await attachJson(testInfo, "release-b-active-multihop-cleanup-evidence", {
        runId, primarySessionId, sourceSessionIds, captureOnly, checkoutSent, checkoutResolved, cleanupError,
        dialogMessages, pageErrors, evidence
      });
      await attachFailureScreenshot(testInfo, page, "active-multihop-cleanup-failure");
      if (!primaryError && cleanupError) throw new Error(cleanupError);
    }
  });
});
