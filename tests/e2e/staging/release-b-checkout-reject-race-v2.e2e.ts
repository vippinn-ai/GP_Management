import { expect, test, type APIResponse } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  browserDateTimeLocal,
  capturePageErrors,
  captureRpcEvidence,
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
const station = process.env.E2E_V2_REJECT_RACE_STATION?.trim() || "8 Ball Pool";

type CheckoutEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    payload: {
      source_session_ids: string[];
      primary_bill: { id: string; billNumber: string };
      bill_updates: Array<{ id: string; billNumber: string }>;
      audit_logs: Array<{ id: string }>;
    };
  };
};

function makeUniqueBillNumber(captured: CapturedRpcRequest, suffix: "C" | "D") {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const number = `BILL-QA-REJECT-${runId}-${suffix}`;
  envelope.payload.payload.primary_bill.billNumber = number;
  const primaryUpdate = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primaryUpdate) throw new Error("Captured reject-race checkout omitted its primary bill update.");
  primaryUpdate.billNumber = number;
  return envelope;
}

test.describe.serial("Release B checkout versus rejection concurrency", () => {
  for (const ordering of ["checkout-first", "reject-first"] as const) {
    const title = ordering === "checkout-first"
      ? "checkout commits before a stale rejection and remains the only financial result"
      : "rejection commits before checkout and prevents every financial result";

    test(title, async ({ browser, page }, testInfo) => {
      const observer = await createObserver(browser);
      const rpcEvidence: RpcEvidence[] = [];
      const originErrors = capturePageErrors(page);
      const observerErrors = capturePageErrors(observer.page);
      captureRpcEvidence(page, "origin", rpcEvidence);
      captureRpcEvidence(observer.page, "observer", rpcEvidence);
      const orderingLabel = ordering === "checkout-first" ? "Checkout First" : "Reject First";
      const customerName = `QA Checkout Reject ${orderingLabel} ${runId}`;
      const rejectReason = `Playwright ${orderingLabel} reject race ${runId}`;
      let sessionStarted = false;
      let raceStarted = false;
      let raceResolved = false;
      let sessionId: string | undefined;
      let primaryError: unknown;
      let cleanupError: string | undefined;
      let raceEvidence: Record<string, unknown> | undefined;
      let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      let rejectCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      const dismissOriginDialog = (dialog: { dismiss(): Promise<void> }) => void dialog.dismiss();

      try {
        await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
        await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
        expect(await stationCard(page, station).innerText(), "The checkout/reject race station is occupied.").toContain("Available");
        await startSession(page, station, customerName);
        sessionStarted = true;

        const originSession = await openManagedSession(page, station);
        await originSession.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        await originSession.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
        await originSession.getByRole("button", { name: "Save Session Details", exact: true }).click();
        await waitForSynced(page);
        await observer.page.reload({ waitUntil: "domcontentloaded" });
        await waitForSynced(observer.page);
        await expect(stationCard(observer.page, station)).toContainText(customerName);

        await originSession.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
        checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
        page.on("dialog", dismissOriginDialog);
        const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
        await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
        await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
        const capturedCheckout = await checkoutCommand.captured;
        const checkoutEnvelope = makeUniqueBillNumber(capturedCheckout, ordering === "checkout-first" ? "C" : "D");

        const observerSession = await openManagedSession(observer.page, station);
        await observerSession.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        const observerCustomer = observerSession.getByLabel("Customer Name", { exact: true });
        await expect(observerCustomer).toHaveValue(customerName);
        await observerCustomer.locator("xpath=ancestor::form")
          .getByRole("button", { name: "Cancel", exact: true }).click();
        rejectCommand = await interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/reject_session*");
        observer.page.once("dialog", (dialog) => dialog.accept(rejectReason));
        await observerSession.getByRole("button", { name: "Reject Session", exact: true }).click();
        const capturedReject = await rejectCommand.captured;
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(rejectCommand.captureCount()).toBe(1);

        const checkoutHeaders = {
          apikey: capturedCheckout.headers.apikey,
          authorization: capturedCheckout.headers.authorization,
          "content-type": "application/json",
          prefer: capturedCheckout.headers.prefer || "return=representation"
        };
        const rejectHeaders = {
          apikey: capturedReject.headers.apikey,
          authorization: capturedReject.headers.authorization,
          "content-type": "application/json",
          prefer: capturedReject.headers.prefer || "return=representation"
        };
        const checkoutIdentity = checkoutEnvelope;
        const rejectIdentity = capturedReject.body as {
          payload: {
            organization_id: string;
            mutation_id: string;
            entity_id: string;
            payload: {
              effective_ended_at: string;
              audit_log_id: string;
            };
          };
        };
        sessionId = checkoutIdentity.payload.payload.source_session_ids[0];
        expect(sessionId).toBeTruthy();
        expect(rejectIdentity.payload.entity_id).toBe(sessionId);
        const billId = checkoutIdentity.payload.payload.primary_bill.id;
        const checkoutMutationId = checkoutIdentity.payload.mutation_id;
        const rejectMutationId = rejectIdentity.payload.mutation_id;
        const rejectAuditId = rejectIdentity.payload.payload.audit_log_id;
        const checkoutAuditIds = checkoutIdentity.payload.payload.audit_logs.map((audit) => audit.id);
        expect(checkoutAuditIds.length).toBeGreaterThan(0);
        const checkoutActorId = authenticatedJwtSubject(capturedCheckout.headers);
        const rejectActorId = authenticatedJwtSubject(capturedReject.headers);
        const restBase = capturedCheckout.url.replace(/\/rpc\/[^/]+$/, "");
        const restHeaders = { apikey: checkoutHeaders.apikey, authorization: checkoutHeaders.authorization };
        raceEvidence = {
          ordering,
          customerName,
          sessionId,
          billId,
          checkoutMutationId,
          rejectMutationId,
          rejectAuditId,
          checkoutAuditIds,
          expectedWinnerActorId: ordering === "checkout-first" ? checkoutActorId : rejectActorId,
          captureCountsBeforeSend: {
            checkout: checkoutCommand.captureCount(),
            reject: rejectCommand.captureCount()
          }
        };
        const beforeAppState = await readRestRows<{ version: number; updated_at: string; updated_by: string }>(
          page,
          restBase,
          restHeaders,
          "app_state",
          { id: "eq.primary", select: "version,updated_at,updated_by" }
        );
        expect(beforeAppState).toHaveLength(1);
        raceEvidence.appStateVersionBefore = beforeAppState[0].version;
        raceStarted = true;
        let checkoutResponse: APIResponse;
        let rejectResponse: APIResponse;
        if (ordering === "checkout-first") {
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
          rejectResponse = await rejectCommand.submit(capturedReject.body);
        } else {
          rejectResponse = await rejectCommand.submit(capturedReject.body);
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
        }

        const [checkoutBody, rejectBody] = await Promise.all([
          readApiResponseBody(checkoutResponse),
          readApiResponseBody(rejectResponse)
        ]);
        if (ordering === "checkout-first") {
          expect(checkoutResponse.status()).toBe(200);
          expect(rejectResponse.status()).toBe(400);
          expect(rpcRejectionCode(rejectBody)).toBe("session_not_open");
        } else {
          expect(rejectResponse.status()).toBe(200);
          expect(checkoutResponse.status()).toBe(400);
          expect(rpcRejectionCode(checkoutBody)).toBe("session_not_billable");
        }

        raceEvidence.checkoutStatus = checkoutResponse.status();
        raceEvidence.rejectStatus = rejectResponse.status();
        raceEvidence.checkoutBody = checkoutBody;
        raceEvidence.rejectBody = rejectBody;

        const mutationStatusResponse = await page.request.post(
          capturedCheckout.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
          {
            headers: checkoutHeaders,
            data: {
              payload: {
                organization_id: checkoutIdentity.payload.organization_id,
                mutation_id: checkoutMutationId,
                mutation_kind: checkoutIdentity.payload.mutation_kind
              }
            }
          }
        );
        expect(mutationStatusResponse.status()).toBe(200);
        const mutationStatus = await mutationStatusResponse.json() as Record<string, unknown> | null;
        const [
          sessionRows,
          billRows,
          paymentRows,
          checkoutEventRows,
          rejectEventRows,
          checkoutAuditRows,
          rejectAuditRows,
          afterAppState
        ] = await Promise.all([
          readRestRows<{
            id: string;
            status: string;
            close_disposition: string;
            close_reason: string | null;
            closed_bill_id: string | null;
          }>(page, restBase, restHeaders, "sessions", {
            organization_id: "eq.org-primary",
            id: `eq.${sessionId}`,
            select: "id,status,close_disposition,close_reason,closed_bill_id"
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
            id: `eq.${billId}`,
            select: "id,status,total,amount_paid,amount_due,issued_by_user_id"
          }),
          readRestRows<{ id: string; amount: number; received_by_user_id: string }>(page, restBase, restHeaders, "payments", {
            organization_id: "eq.org-primary",
            bill_id: `eq.${billId}`,
            select: "id,amount,received_by_user_id"
          }),
          readRestRows<{ id: string; created_by: string }>(page, restBase, restHeaders, "operational_events", {
            organization_id: "eq.org-primary",
            "metadata->>mutation_id": `eq.${checkoutMutationId}`,
            select: "id,created_by"
          }),
          readRestRows<{ id: string; created_by: string }>(page, restBase, restHeaders, "operational_events", {
            organization_id: "eq.org-primary",
            "metadata->>mutation_id": `eq.${rejectMutationId}`,
            select: "id,created_by"
          }),
          readRestRows<{ id: string; action: string; user_id: string }>(page, restBase, restHeaders, "audit_logs", {
            organization_id: "eq.org-primary",
            id: `in.(${checkoutAuditIds.join(",")})`,
            select: "id,action,user_id"
          }),
          readRestRows<{ id: string; action: string; user_id: string }>(page, restBase, restHeaders, "audit_logs", {
            organization_id: "eq.org-primary",
            id: `eq.${rejectAuditId}`,
            select: "id,action,user_id"
          }),
          readRestRows<{ version: number; updated_at: string; updated_by: string }>(page, restBase, restHeaders, "app_state", {
            id: "eq.primary",
            select: "version,updated_at,updated_by"
          })
        ]);
        expect(sessionRows).toHaveLength(1);
        expect(afterAppState).toHaveLength(1);
        expect(sessionRows[0].status).toBe("closed");
        const actorIds = new Set<string>();
        if (ordering === "checkout-first") {
          expect(sessionRows[0].close_disposition).toBe("billed");
          expect(sessionRows[0].closed_bill_id).toBe(billId);
          expect(billRows).toHaveLength(1);
          expect(paymentRows).toHaveLength(1);
          expect(checkoutEventRows).toHaveLength(1);
          expect(rejectEventRows).toHaveLength(0);
          expect(checkoutAuditRows).toHaveLength(checkoutAuditIds.length);
          expect(rejectAuditRows).toHaveLength(0);
          expect(mutationStatus?.bill_id).toBe(billId);
          expect(afterAppState[0].version).toBe(beforeAppState[0].version);
          expect(billRows[0].status).toBe("issued");
          expect(Number(billRows[0].total)).toBeGreaterThan(0);
          expect(Number(billRows[0].amount_due)).toBe(0);
          expect(Number(billRows[0].amount_paid)).toBe(Number(billRows[0].total));
          expect(paymentRows.reduce((sum, payment) => sum + Number(payment.amount), 0))
            .toBe(Number(billRows[0].amount_paid));
          actorIds.add(billRows[0].issued_by_user_id);
          actorIds.add(paymentRows[0].received_by_user_id);
          actorIds.add(checkoutEventRows[0].created_by);
          checkoutAuditRows.forEach((audit) => actorIds.add(audit.user_id));
        } else {
          expect(sessionRows[0].close_disposition).toBe("rejected");
          expect(sessionRows[0].closed_bill_id).toBeNull();
          expect(sessionRows[0].close_reason).toBe(rejectReason);
          expect(billRows).toHaveLength(0);
          expect(paymentRows).toHaveLength(0);
          expect(checkoutEventRows).toHaveLength(0);
          expect(rejectEventRows).toHaveLength(1);
          expect(checkoutAuditRows).toHaveLength(0);
          expect(rejectAuditRows).toHaveLength(1);
          expect(rejectAuditRows[0].action).toBe("session_rejected");
          expect(mutationStatus).toBeNull();
          expect(afterAppState[0].version).toBe(beforeAppState[0].version + 1);
          actorIds.add(rejectEventRows[0].created_by);
          actorIds.add(rejectAuditRows[0].user_id);
        }
        const expectedWinnerActorId = ordering === "checkout-first" ? checkoutActorId : rejectActorId;
        expect([...actorIds]).toEqual([expectedWinnerActorId]);
        raceEvidence.databaseEvidence = {
          session: sessionRows[0],
          billCount: billRows.length,
          paymentCount: paymentRows.length,
          checkoutEventCount: checkoutEventRows.length,
          rejectEventCount: rejectEventRows.length,
          checkoutAuditCount: checkoutAuditRows.length,
          rejectAuditCount: rejectAuditRows.length,
          mutationStatus,
          appStateVersionBefore: beforeAppState[0].version,
          appStateVersionAfter: afterAppState[0].version,
          actorIds: [...actorIds],
          expectedWinnerActorId
        };
        raceResolved = true;

        await Promise.all([page.waitForTimeout(750), observer.page.waitForTimeout(750)]);
        expect(checkoutCommand.wasSubmitted()).toBe(true);
        expect(rejectCommand.wasSubmitted()).toBe(true);
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(rejectCommand.captureCount()).toBe(1);
        raceEvidence.finalCaptureCounts = {
          checkout: checkoutCommand.captureCount(),
          reject: rejectCommand.captureCount()
        };
        page.off("dialog", dismissOriginDialog);
        await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
        await observer.page.unroute("**/rest/v1/rpc/reject_session*");
        await Promise.all([
          page.reload({ waitUntil: "domcontentloaded" }),
          observer.page.reload({ waitUntil: "domcontentloaded" })
        ]);
        if (ordering === "checkout-first") {
          await waitForSynced(page);
          await expect(observer.page.getByText("1 conflict", { exact: true })).toBeVisible();
          await expect(observer.page.getByText("Pending sync.", { exact: false })).toHaveCount(0);
          raceEvidence.loserConflictVisible = true;
          await observer.page.getByRole("button", { name: "Clear", exact: true }).click();
          await waitForSynced(observer.page);
        } else {
          await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
        }
        await expect(stationCard(page, station)).toContainText("Available");
        await expect(stationCard(observer.page, station)).toContainText("Available");
        expect(originErrors.consoleErrors).toEqual([]);
        expect(observerErrors.consoleErrors).toEqual([]);
        expect(observerErrors.pageErrors).toEqual([]);
        if (ordering === "checkout-first") {
          expect(originErrors.pageErrors).toEqual([]);
        } else {
          expect(originErrors.pageErrors).toHaveLength(1);
          expect(originErrors.pageErrors[0]).toMatch(/The primary session is no longer billable\.?/i);
        }
      } catch (error) {
        primaryError = error;
      } finally {
        page.off("dialog", dismissOriginDialog);
        checkoutCommand?.cancel();
        rejectCommand?.cancel();
        await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
        await observer.page.unroute("**/rest/v1/rpc/reject_session*").catch(() => undefined);
        sessionStarted = sessionStarted || rpcEvidence.some(
          (entry) => entry.rpc === "start_session" && entry.status < 300
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
            await rejectSessionIfOpen(page, station, customerName, `Playwright pre-race cleanup ${runId}`);
          } catch (error) {
            cleanupError = error instanceof Error ? error.message : "Unknown checkout/reject pre-race cleanup failure";
          }
        } else if (raceStarted && !raceResolved) {
          cleanupError = "Checkout/reject commands were sent; reconcile their mutation IDs before any cleanup or retry.";
        }
        await attachJson(testInfo, `release-b-checkout-reject-${ordering}-evidence`, {
          runId,
          ordering,
          station,
          customerName,
          rejectReason,
          sessionStarted,
          raceStarted,
          raceResolved,
          sessionId,
          cleanupError,
          originErrors,
          observerErrors,
          raceEvidence,
          rpcEvidence
        });
        await attachFailureScreenshot(testInfo, page, `checkout-reject-${ordering}-origin-failure`);
        await attachFailureScreenshot(testInfo, observer.page, `checkout-reject-${ordering}-observer-failure`);
        await observer.context.close();
      }
      if (primaryError) throw primaryError;
      if (cleanupError) throw new Error(cleanupError);
    });
  }
});
