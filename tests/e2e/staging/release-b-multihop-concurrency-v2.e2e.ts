import { createHash } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  browserDateTimeLocal,
  capturePageErrors,
  captureRpcEvidence,
  changedRowIds,
  createObserver,
  credentials,
  interceptSingleRpcCommand,
  openManagedSession,
  readApiResponseBody,
  readRestRows,
  rejectSessionIfOpen,
  rpcRejectionCode,
  signIn,
  startSession,
  stationCard,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_V2_MULTIHOP_STATION?.trim() || "Playstation";

type CheckoutEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    payload: {
      source_session_ids: string[];
      primary_bill: { id: string; billNumber: string };
      bill_updates: Array<{ id: string; billNumber: string }>;
      session_updates: Array<{ id: string }>;
      audit_logs: Array<{ id: string }>;
    };
  };
};

function appStateDataHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function prepareCheckoutCommand(captured: CapturedRpcRequest, suffix: "A" | "B") {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const billNumber = `BILL-QA-MULTIHOP-${runId}-${suffix}`;
  envelope.payload.mutation_id = `financial-multihop-${runId}-${suffix.toLowerCase()}`;
  envelope.payload.payload.primary_bill.billNumber = billNumber;
  const primaryUpdate = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primaryUpdate) throw new Error("Captured multi-hop checkout omitted its primary bill update.");
  primaryUpdate.billNumber = billNumber;
  return envelope;
}

test.describe.serial("Release B admin multi-hop checkout concurrency", () => {
  test("one three-session hop chain can enter only one bill", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA Multi Hop Race ${runId}`;
    const dialogMessages: string[] = [];
    const dismissDialog = (dialog: { message(): string; dismiss(): Promise<void> }) => {
      dialogMessages.push(dialog.message());
      void dialog.dismiss();
    };
    const chainSessionIds: string[] = [];
    let sessionStarted = false;
    let raceStarted = false;
    let raceResolved = false;
    let primaryError: unknown;
    let cleanupError: string | undefined;
    let raceEvidence: Record<string, unknown> | undefined;
    let originCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let observerCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;

    async function successfulRpcEntities(rpc: string) {
      return rpcEvidence.filter((entry) => entry.rpc === rpc && entry.status < 300 && entry.entityId);
    }

    async function waitForRpcEntity(rpc: string, expectedCount: number) {
      await expect.poll(async () => (await successfulRpcEntities(rpc)).length).toBe(expectedCount);
      return (await successfulRpcEntities(rpc))[expectedCount - 1].entityId!;
    }

    async function editAndHop(startOffsetMinutes: number, endOffsetMinutes: number, hopCount: number) {
      const managed = await openManagedSession(page, station);
      await managed.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await managed.getByLabel("Session Start Time", { exact: true })
        .fill(await browserDateTimeLocal(page, startOffsetMinutes));
      await managed.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const close = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await close.getByLabel("Session End Time", { exact: true })
        .fill(await browserDateTimeLocal(page, endOffsetMinutes));
      await close.getByLabel(/Game hop - close station without billing/).check();
      await close.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();
      const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
      await expect(continuation).toContainText(customerName);
      await waitForRpcEntity("hop_session", hopCount);
      await expect(stationCard(observer.page, station)).toContainText("Available");
      return continuation;
    }

    async function continueOnReleasedStation(continuationCount: number) {
      const continuation = page.getByRole("dialog", { name: "Continue Customer", exact: true });
      await continuation.getByLabel("Station", { exact: true }).selectOption({ label: station });
      await continuation.getByRole("button", { name: "Start Session", exact: true }).click();
      await expect(continuation).toBeHidden();
      await waitForSynced(page);
      const sessionId = await waitForRpcEntity("start_session", continuationCount + 1);
      await expect(stationCard(page, station)).toContainText(customerName);
      return sessionId;
    }

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      expect(await stationCard(page, station).innerText(), "The multi-hop station is occupied.").toContain("Available");

      await startSession(page, station, customerName);
      sessionStarted = true;
      chainSessionIds.push(await waitForRpcEntity("start_session", 1));

      await editAndHop(-12, -9, 1);
      chainSessionIds.push(await continueOnReleasedStation(1));
      await editAndHop(-8, -5, 2);
      chainSessionIds.push(await continueOnReleasedStation(2));
      expect(new Set(chainSessionIds).size).toBe(3);

      const finalManaged = await openManagedSession(page, station);
      await finalManaged.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await finalManaged.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -4));
      await finalManaged.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(observer.page);
      await expect(stationCard(observer.page, station)).toContainText(customerName);

      await finalManaged.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const originCheckout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      const checkoutEndAt = await browserDateTimeLocal(page, -1);
      await originCheckout.getByLabel("Session End Time", { exact: true }).fill(checkoutEndAt);
      await expect(originCheckout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();

      const observerManaged = await openManagedSession(observer.page, station);
      await observerManaged.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const observerCheckout = observer.page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await observerCheckout.getByLabel("Session End Time", { exact: true }).fill(checkoutEndAt);
      await expect(observerCheckout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();

      originCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
      observerCommand = await interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/commit_checkout_bill_v2");
      page.on("dialog", dismissDialog);
      observer.page.on("dialog", dismissDialog);
      await Promise.all([
        originCheckout.getByRole("button", { name: "Issue Bill", exact: true }).click(),
        observerCheckout.getByRole("button", { name: "Issue Bill", exact: true }).click()
      ]);
      const [capturedOrigin, capturedObserver] = await Promise.all([
        originCommand.captured,
        observerCommand.captured
      ]);
      expect(originCommand.captureCount()).toBe(1);
      expect(observerCommand.captureCount()).toBe(1);

      const envelopes = [
        prepareCheckoutCommand(capturedOrigin, "A"),
        prepareCheckoutCommand(capturedObserver, "B")
      ];
      for (const envelope of envelopes) {
        expect(new Set(envelope.payload.payload.source_session_ids)).toEqual(new Set(chainSessionIds));
        expect(new Set(envelope.payload.payload.session_updates.map((session) => session.id)))
          .toEqual(new Set(chainSessionIds));
      }
      expect(envelopes[0].payload.mutation_id).not.toBe(envelopes[1].payload.mutation_id);
      expect(envelopes[0].payload.payload.primary_bill.id).not.toBe(envelopes[1].payload.payload.primary_bill.id);
      expect(envelopes[0].payload.payload.primary_bill.billNumber)
        .not.toBe(envelopes[1].payload.payload.primary_bill.billNumber);

      const capturedRequests = [capturedOrigin, capturedObserver];
      const requestHeaders = capturedRequests.map((captured) => ({
        apikey: captured.headers.apikey,
        authorization: captured.headers.authorization,
        "content-type": "application/json",
        prefer: captured.headers.prefer || "return=representation"
      }));
      const actorIds = capturedRequests.map((captured) => authenticatedJwtSubject(captured.headers));
      const restBase = capturedOrigin.url.replace(/\/rpc\/[^/]+$/, "");
      const restHeaders = { apikey: requestHeaders[0].apikey, authorization: requestHeaders[0].authorization };
      const authoritativeRoles = await Promise.all(envelopes.map((envelope, index) =>
        (index === 0 ? page : observer.page).request.post(`${restBase}/rpc/current_user_org_role`, {
          headers: requestHeaders[index],
          data: { target_organization_id: envelope.payload.organization_id }
        })
      ));
      authoritativeRoles.forEach((response) => expect(response.status()).toBe(200));
      const roleValues = await Promise.all(authoritativeRoles.map((response) => response.json() as Promise<string | null>));
      expect(roleValues).toEqual(["admin", "admin"]);

      const beforeAppState = await readRestRows<{ version: number; data: unknown }>(
        page,
        restBase,
        restHeaders,
        "app_state",
        { id: "eq.primary", select: "version,data" }
      );
      expect(beforeAppState).toHaveLength(1);
      const appStateHashBefore = appStateDataHash(beforeAppState[0].data);
      raceEvidence = {
        customerName,
        station,
        chainSessionIds,
        checkoutEndAt,
        mutationIds: envelopes.map((envelope) => envelope.payload.mutation_id),
        billIds: envelopes.map((envelope) => envelope.payload.payload.primary_bill.id),
        billNumbers: envelopes.map((envelope) => envelope.payload.payload.primary_bill.billNumber),
        actorIds,
        authoritativeRoles: roleValues,
        appStateVersionBefore: beforeAppState[0].version,
        appStateHashBefore,
        captureCountsBeforeSend: [originCommand.captureCount(), observerCommand.captureCount()]
      };

      raceStarted = true;
      const responses: APIResponse[] = await Promise.all([
        originCommand.submit(envelopes[0]),
        observerCommand.submit(envelopes[1])
      ]);
      const bodies = await Promise.all(responses.map(readApiResponseBody));
      const winnerIndexes = responses.flatMap((response, index) => response.status() === 200 ? [index] : []);
      const loserIndexes = responses.flatMap((response, index) => response.status() >= 400 ? [index] : []);
      expect(winnerIndexes).toHaveLength(1);
      expect(loserIndexes).toHaveLength(1);
      const winnerIndex = winnerIndexes[0];
      const loserIndex = loserIndexes[0];
      expect(rpcRejectionCode(bodies[loserIndex])).toBe("session_not_billable");
      const winnerEnvelope = envelopes[winnerIndex];
      const loserEnvelope = envelopes[loserIndex];
      const winnerBillId = winnerEnvelope.payload.payload.primary_bill.id;
      const winnerActorId = actorIds[winnerIndex];
      expect(new Set(changedRowIds({ changedRows: bodies[winnerIndex].changed_rows } as RpcEvidence, "sessions")))
        .toEqual(new Set(chainSessionIds));

      const mutationStatuses = await Promise.all(envelopes.map((envelope, index) =>
        (index === 0 ? page : observer.page).request.post(
          capturedRequests[index].url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
          {
            headers: requestHeaders[index],
            data: {
              payload: {
                organization_id: envelope.payload.organization_id,
                mutation_id: envelope.payload.mutation_id,
                mutation_kind: envelope.payload.mutation_kind
              }
            }
          }
        )
      ));
      mutationStatuses.forEach((response) => expect(response.status()).toBe(200));
      const mutationStatusBodies = await Promise.all(
        mutationStatuses.map((response) => response.json() as Promise<Record<string, unknown> | null>)
      );
      expect(mutationStatusBodies[winnerIndex]?.bill_id).toBe(winnerBillId);
      expect(mutationStatusBodies[loserIndex]).toBeNull();

      const winnerAuditIds = winnerEnvelope.payload.payload.audit_logs.map((audit) => audit.id);
      const loserAuditIds = loserEnvelope.payload.payload.audit_logs.map((audit) => audit.id);
      expect(winnerAuditIds.length).toBeGreaterThan(0);
      expect(loserAuditIds.length).toBeGreaterThan(0);
      const [
        sessionRows,
        billRows,
        paymentRows,
        sessionChargeRows,
        winnerEventRows,
        loserEventRows,
        winnerAuditRows,
        loserAuditRows,
        afterAppState
      ] = await Promise.all([
        readRestRows<{
          id: string;
          status: string;
          close_disposition: string;
          closed_bill_id: string | null;
          continued_from_session_ids: string[] | null;
          started_at: string | null;
          ended_at: string | null;
        }>(page, restBase, restHeaders, "sessions", {
          organization_id: "eq.org-primary",
          id: `in.(${chainSessionIds.join(",")})`,
          select: "id,status,close_disposition,closed_bill_id,continued_from_session_ids,started_at,ended_at"
        }),
        readRestRows<{
          id: string;
          status: string;
          total: number;
          amount_paid: number;
          amount_due: number;
          issued_by_user_id: string;
        }>(page, restBase, restHeaders, "bills", {
          organization_id: "eq.org-primary",
          id: `in.(${envelopes.map((envelope) => envelope.payload.payload.primary_bill.id).join(",")})`,
          select: "id,status,total,amount_paid,amount_due,issued_by_user_id"
        }),
        readRestRows<{ id: string; amount: number; received_by_user_id: string }>(
          page,
          restBase,
          restHeaders,
          "payments",
          { organization_id: "eq.org-primary", bill_id: `eq.${winnerBillId}`, select: "id,amount,received_by_user_id" }
        ),
        readRestRows<{ id: string; type: string; linked_session_id: string | null; total: number }>(
          page,
          restBase,
          restHeaders,
          "bill_lines",
          {
            organization_id: "eq.org-primary",
            bill_id: `eq.${winnerBillId}`,
            type: "eq.session_charge",
            select: "id,type,linked_session_id,total"
          }
        ),
        readRestRows<{ id: string; created_by: string }>(page, restBase, restHeaders, "operational_events", {
          organization_id: "eq.org-primary",
          "metadata->>mutation_id": `eq.${winnerEnvelope.payload.mutation_id}`,
          select: "id,created_by"
        }),
        readRestRows<{ id: string; created_by: string }>(page, restBase, restHeaders, "operational_events", {
          organization_id: "eq.org-primary",
          "metadata->>mutation_id": `eq.${loserEnvelope.payload.mutation_id}`,
          select: "id,created_by"
        }),
        readRestRows<{ id: string; user_id: string }>(page, restBase, restHeaders, "audit_logs", {
          organization_id: "eq.org-primary",
          id: `in.(${winnerAuditIds.join(",")})`,
          select: "id,user_id"
        }),
        readRestRows<{ id: string; user_id: string }>(page, restBase, restHeaders, "audit_logs", {
          organization_id: "eq.org-primary",
          id: `in.(${loserAuditIds.join(",")})`,
          select: "id,user_id"
        }),
        readRestRows<{ version: number; data: unknown }>(page, restBase, restHeaders, "app_state", {
          id: "eq.primary",
          select: "version,data"
        })
      ]);

      expect(sessionRows).toHaveLength(3);
      const sessionsById = new Map(sessionRows.map((session) => [session.id, session]));
      chainSessionIds.forEach((sessionId) => {
        expect(sessionsById.get(sessionId)).toMatchObject({
          id: sessionId,
          status: "closed",
          close_disposition: "billed",
          closed_bill_id: winnerBillId
        });
        expect(sessionsById.get(sessionId)?.started_at).toBeTruthy();
        expect(sessionsById.get(sessionId)?.ended_at).toBeTruthy();
      });
      expect(sessionsById.get(chainSessionIds[0])?.continued_from_session_ids ?? []).toEqual([]);
      expect(sessionsById.get(chainSessionIds[1])?.continued_from_session_ids).toEqual([chainSessionIds[0]]);
      expect(sessionsById.get(chainSessionIds[2])?.continued_from_session_ids)
        .toEqual([chainSessionIds[0], chainSessionIds[1]]);
      expect(billRows).toHaveLength(1);
      expect(billRows[0].id).toBe(winnerBillId);
      expect(billRows[0].status).toBe("issued");
      expect(Number(billRows[0].total)).toBeGreaterThan(0);
      expect(Number(billRows[0].amount_due)).toBe(0);
      expect(Number(billRows[0].amount_paid)).toBe(Number(billRows[0].total));
      expect(paymentRows).toHaveLength(1);
      expect(paymentRows.reduce((sum, payment) => sum + Number(payment.amount), 0))
        .toBe(Number(billRows[0].amount_paid));
      expect(new Set(sessionChargeRows.map((line) => line.linked_session_id))).toEqual(new Set(chainSessionIds));
      expect(sessionChargeRows).toHaveLength(3);
      sessionChargeRows.forEach((line) => expect(Number(line.total)).toBeGreaterThan(0));
      expect(winnerEventRows).toHaveLength(1);
      expect(loserEventRows).toHaveLength(0);
      expect(winnerAuditRows).toHaveLength(winnerAuditIds.length);
      expect(loserAuditRows).toHaveLength(0);
      const persistedActorIds = new Set([
        billRows[0].issued_by_user_id,
        paymentRows[0].received_by_user_id,
        winnerEventRows[0].created_by,
        ...winnerAuditRows.map((audit) => audit.user_id)
      ]);
      expect([...persistedActorIds]).toEqual([winnerActorId]);
      expect(afterAppState).toHaveLength(1);
      const appStateHashAfter = appStateDataHash(afterAppState[0].data);
      expect(afterAppState[0].version).toBe(beforeAppState[0].version);
      expect(appStateHashAfter).toBe(appStateHashBefore);
      expect(originCommand.wasSubmitted()).toBe(true);
      expect(observerCommand.wasSubmitted()).toBe(true);
      expect(originCommand.captureCount()).toBe(1);
      expect(observerCommand.captureCount()).toBe(1);
      raceResolved = true;
      raceEvidence = {
        ...raceEvidence,
        statuses: responses.map((response) => response.status()),
        bodies,
        winnerIndex,
        loserIndex,
        winnerMutationId: winnerEnvelope.payload.mutation_id,
        loserMutationId: loserEnvelope.payload.mutation_id,
        winnerBillId,
        mutationStatusBodies,
        databaseEvidence: {
          sessions: sessionRows,
          bill: billRows[0],
          paymentCount: paymentRows.length,
          sessionCharges: sessionChargeRows,
          winnerEventCount: winnerEventRows.length,
          loserEventCount: loserEventRows.length,
          winnerAuditCount: winnerAuditRows.length,
          loserAuditCount: loserAuditRows.length,
          persistedActorIds: [...persistedActorIds],
          appStateVersionAfter: afterAppState[0].version,
          appStateHashAfter
        },
        finalCaptureCounts: [originCommand.captureCount(), observerCommand.captureCount()]
      };

      await Promise.all([page.waitForTimeout(750), observer.page.waitForTimeout(750)]);
      page.off("dialog", dismissDialog);
      observer.page.off("dialog", dismissDialog);
      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
      await observer.page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
      await Promise.all([
        page.reload({ waitUntil: "domcontentloaded" }),
        observer.page.reload({ waitUntil: "domcontentloaded" })
      ]);
      await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
      await expect(stationCard(page, station)).toContainText("Available");
      await expect(stationCard(observer.page, station)).toContainText("Available");
      expect(originErrors.consoleErrors).toEqual([]);
      expect(observerErrors.consoleErrors).toEqual([]);
      const errorCaptures = [originErrors, observerErrors];
      expect(errorCaptures[winnerIndex].pageErrors).toEqual([]);
      expect(errorCaptures[loserIndex].pageErrors).toHaveLength(1);
      expect(errorCaptures[loserIndex].pageErrors[0]).toMatch(/The primary session is no longer billable\.?/i);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      page.off("dialog", dismissDialog);
      observer.page.off("dialog", dismissDialog);
      originCommand?.cancel();
      observerCommand?.cancel();
      await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
      await observer.page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
      sessionStarted = sessionStarted || rpcEvidence.some(
        (entry) => entry.rpc === "start_session" && entry.status < 300
      );
      for (const entry of rpcEvidence.filter(
        (candidate) => candidate.rpc === "start_session" && candidate.status < 300 && candidate.entityId
      )) {
        if (!chainSessionIds.includes(entry.entityId!)) chainSessionIds.push(entry.entityId!);
      }
      const hasCommittedHop = rpcEvidence.some(
        (entry) => entry.rpc === "hop_session" && entry.status < 300
      );
      if (sessionStarted && !raceStarted) {
        try {
          for (const target of [page, observer.page]) {
            for (let index = 0; index < 3 && await target.getByRole("dialog").count(); index += 1) {
              const dialog = target.getByRole("dialog").last();
              const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
              const close = dialog.getByRole("button", { name: "Close", exact: true });
              if (await cancel.isVisible()) await cancel.click();
              else if (await close.isVisible()) await close.click();
              else break;
            }
          }
          const rejected = await rejectSessionIfOpen(
            page,
            station,
            customerName,
            `Playwright pre-race multi-hop cleanup ${runId}`
          );
          if (hasCommittedHop || !rejected) {
            cleanupError = "The multi-hop chain stopped before checkout; its exact session IDs require guarded reconciliation.";
          }
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown multi-hop pre-race cleanup failure";
        }
      } else if (raceStarted && !raceResolved) {
        cleanupError = "Multi-hop checkout commands were sent; reconcile both mutation IDs before any cleanup or retry.";
      }
      await attachJson(testInfo, "release-b-multihop-concurrency-v2-evidence", {
        runId,
        station,
        customerName,
        chainSessionIds,
        sessionStarted,
        raceStarted,
        raceResolved,
        cleanupError,
        dialogMessages,
        originErrors,
        observerErrors,
        raceEvidence,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "multihop-race-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "multihop-race-observer-failure");
      await observer.context.close();
      if (!primaryError && cleanupError) throw new Error(cleanupError);
    }
  });
});
