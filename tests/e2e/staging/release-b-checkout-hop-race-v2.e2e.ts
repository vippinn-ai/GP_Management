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
const station = process.env.E2E_V2_HOP_RACE_STATION?.trim() || "Playstation";

type Ordering = "checkout-first" | "hop-first" | "concurrent";
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

function makeUniqueBillNumber(captured: CapturedRpcRequest, ordering: Ordering) {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const suffix = ordering === "checkout-first" ? "A" : ordering === "hop-first" ? "B" : "C";
  const number = `BILL-QA-HOP-${runId}-${suffix}`;
  envelope.payload.payload.primary_bill.billNumber = number;
  const primaryUpdate = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primaryUpdate) throw new Error("Captured hop-race checkout omitted its primary bill update.");
  primaryUpdate.billNumber = number;
  return envelope;
}

test.describe.serial("Release B admin checkout versus game-hop concurrency", () => {
  for (const ordering of ["checkout-first", "hop-first", "concurrent"] as const) {
    const title = ordering === "checkout-first"
      ? "checkout commits before hop and stale hop is rejected"
      : ordering === "hop-first"
        ? "hop commits before checkout and the unbilled hop is consumed once"
        : "simultaneous checkout and hop resolve to one bill without an orphan";

    test(title, async ({ browser, page }, testInfo) => {
      const observer = await createObserver(browser);
      const rpcEvidence: RpcEvidence[] = [];
      const originErrors = capturePageErrors(page);
      const observerErrors = capturePageErrors(observer.page);
      captureRpcEvidence(page, "origin", rpcEvidence);
      captureRpcEvidence(observer.page, "observer", rpcEvidence);
      const orderingLabel = ordering === "checkout-first"
        ? "Checkout First"
        : ordering === "hop-first" ? "Hop First" : "Concurrent";
      const customerName = `QA Checkout Hop ${orderingLabel} ${runId}`;
      const observerDialogs: string[] = [];
      const dismissObserverDialog = (dialog: { message(): string; dismiss(): Promise<void> }) => {
        observerDialogs.push(dialog.message());
        void dialog.dismiss();
      };
      let sessionStarted = false;
      let raceStarted = false;
      let raceResolved = false;
      let sessionId: string | undefined;
      let primaryError: unknown;
      let cleanupError: string | undefined;
      let raceEvidence: Record<string, unknown> | undefined;
      let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      let hopCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;

      try {
        await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
        await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
        expect(await stationCard(page, station).innerText(), "The checkout/hop race station is occupied.").toContain("Available");
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
        const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
        const checkoutEndAt = await browserDateTimeLocal(page, -1);
        const hopEndAt = await browserDateTimeLocal(page, -2);
        await checkout.getByLabel("Session End Time", { exact: true }).fill(checkoutEndAt);
        await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();

        const observerSession = await openManagedSession(observer.page, station);
        await observerSession.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
        const hopCheckout = observer.page.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await hopCheckout.getByLabel("Session End Time", { exact: true }).fill(hopEndAt);
        await hopCheckout.getByLabel(/Game hop - close station without billing/).check();
        await expect(hopCheckout.getByRole("button", { name: "Confirm Game Hop", exact: true })).toBeEnabled();

        checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
        hopCommand = await interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/hop_session");
        observer.page.on("dialog", dismissObserverDialog);
        await Promise.all([
          checkout.getByRole("button", { name: "Issue Bill", exact: true }).click(),
          hopCheckout.getByRole("button", { name: "Confirm Game Hop", exact: true }).click()
        ]);
        const [capturedCheckout, capturedHop] = await Promise.all([
          checkoutCommand.captured,
          hopCommand.captured
        ]);
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(hopCommand.captureCount()).toBe(1);

        const checkoutEnvelope = makeUniqueBillNumber(capturedCheckout, ordering);
        const checkoutIdentity = checkoutEnvelope;
        const hopIdentity = capturedHop.body as {
          payload: {
            organization_id: string;
            mutation_id: string;
            payload: { session: { id: string }; auditLog: { id: string } };
          };
        };
        sessionId = checkoutIdentity.payload.payload.source_session_ids[0];
        expect(sessionId).toBeTruthy();
        expect(hopIdentity.payload.payload.session.id).toBe(sessionId);
        const billId = checkoutIdentity.payload.payload.primary_bill.id;
        const checkoutMutationId = checkoutIdentity.payload.mutation_id;
        const hopMutationId = hopIdentity.payload.mutation_id;
        const checkoutAuditIds = checkoutIdentity.payload.payload.audit_logs.map((audit) => audit.id);
        const hopAuditId = hopIdentity.payload.payload.auditLog.id;
        expect(checkoutAuditIds.length).toBeGreaterThan(0);
        const checkoutActorId = authenticatedJwtSubject(capturedCheckout.headers);
        const hopActorId = authenticatedJwtSubject(capturedHop.headers);
        const checkoutHeaders = {
          apikey: capturedCheckout.headers.apikey,
          authorization: capturedCheckout.headers.authorization,
          "content-type": "application/json",
          prefer: capturedCheckout.headers.prefer || "return=representation"
        };
        const hopHeaders = {
          apikey: capturedHop.headers.apikey,
          authorization: capturedHop.headers.authorization,
          "content-type": "application/json",
          prefer: capturedHop.headers.prefer || "return=representation"
        };
        const restBase = capturedCheckout.url.replace(/\/rpc\/[^/]+$/, "");
        const restHeaders = { apikey: checkoutHeaders.apikey, authorization: checkoutHeaders.authorization };
        const checkoutActorProfiles = await readRestRows<{ id: string; role: string; active: boolean }>(
          page,
          restBase,
          restHeaders,
          "profiles",
          { id: `eq.${checkoutActorId}`, select: "id,role,active" }
        );
        expect(checkoutActorProfiles).toHaveLength(1);
        expect(checkoutActorProfiles[0]).toMatchObject({ id: checkoutActorId, role: "admin", active: true });
        const [checkoutOrgRoleResponse, hopOrgRoleResponse] = await Promise.all([
          page.request.post(`${restBase}/rpc/current_user_org_role`, {
            headers: checkoutHeaders,
            data: { target_organization_id: checkoutIdentity.payload.organization_id }
          }),
          observer.page.request.post(`${restBase}/rpc/current_user_org_role`, {
            headers: hopHeaders,
            data: { target_organization_id: hopIdentity.payload.organization_id }
          })
        ]);
        expect(checkoutOrgRoleResponse.status()).toBe(200);
        expect(hopOrgRoleResponse.status()).toBe(200);
        const [checkoutOrgRole, hopOrgRole] = await Promise.all([
          checkoutOrgRoleResponse.json() as Promise<string | null>,
          hopOrgRoleResponse.json() as Promise<string | null>
        ]);
        expect(checkoutOrgRole).toBe("admin");
        expect(hopOrgRole).toBe("admin");
        raceEvidence = {
          ordering,
          customerName,
          sessionId,
          billId,
          checkoutMutationId,
          hopMutationId,
          checkoutAuditIds,
          hopAuditId,
          expectedCheckoutActorId: checkoutActorId,
          expectedHopActorId: hopActorId,
          checkoutActorRole: checkoutActorProfiles[0].role,
          authoritativeCheckoutOrgRole: checkoutOrgRole,
          authoritativeHopOrgRole: hopOrgRole,
          checkoutEndAt,
          hopEndAt,
          captureCountsBeforeSend: {
            checkout: checkoutCommand.captureCount(),
            hop: hopCommand.captureCount()
          }
        };
        const beforeAppState = await readRestRows<{ version: number }>(
          page,
          restBase,
          restHeaders,
          "app_state",
          { id: "eq.primary", select: "version" }
        );
        expect(beforeAppState).toHaveLength(1);
        raceEvidence.appStateVersionBefore = beforeAppState[0].version;

        raceStarted = true;
        let checkoutResponse: APIResponse;
        let hopResponse: APIResponse;
        if (ordering === "checkout-first") {
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
          hopResponse = await hopCommand.submit(capturedHop.body);
        } else if (ordering === "hop-first") {
          hopResponse = await hopCommand.submit(capturedHop.body);
          await expect(observer.page.getByRole("dialog", { name: "Continue Customer", exact: true })).toBeVisible();
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
        } else {
          [checkoutResponse, hopResponse] = await Promise.all([
            checkoutCommand.submit(checkoutEnvelope),
            hopCommand.submit(capturedHop.body)
          ]);
        }
        const [checkoutBody, hopBody] = await Promise.all([
          readApiResponseBody(checkoutResponse),
          readApiResponseBody(hopResponse)
        ]);
        expect(checkoutResponse.status()).toBe(200);
        if (ordering === "checkout-first") {
          expect(hopResponse.status()).toBe(400);
          expect(rpcRejectionCode(hopBody)).toBe("session_not_open");
        } else if (ordering === "hop-first") {
          expect(hopResponse.status()).toBe(200);
        } else {
          expect([200, 400]).toContain(hopResponse.status());
          if (hopResponse.status() === 400) expect(rpcRejectionCode(hopBody)).toBe("session_not_open");
        }
        const hopCommitted = hopResponse.status() === 200;
        raceEvidence.checkoutStatus = checkoutResponse.status();
        raceEvidence.hopStatus = hopResponse.status();
        raceEvidence.hopCommitted = hopCommitted;
        raceEvidence.checkoutBody = checkoutBody;
        raceEvidence.hopBody = hopBody;

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
          hopEventRows,
          checkoutAuditRows,
          hopAuditRows,
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
            "metadata->>mutation_id": `eq.${hopMutationId}`,
            select: "id,created_by"
          }),
          readRestRows<{ id: string; action: string; user_id: string }>(page, restBase, restHeaders, "audit_logs", {
            organization_id: "eq.org-primary",
            id: `in.(${checkoutAuditIds.join(",")})`,
            select: "id,action,user_id"
          }),
          readRestRows<{ id: string; action: string; user_id: string }>(page, restBase, restHeaders, "audit_logs", {
            organization_id: "eq.org-primary",
            id: `eq.${hopAuditId}`,
            select: "id,action,user_id"
          }),
          readRestRows<{ version: number }>(page, restBase, restHeaders, "app_state", {
            id: "eq.primary",
            select: "version"
          })
        ]);

        expect(sessionRows).toHaveLength(1);
        expect(sessionRows[0]).toMatchObject({
          status: "closed",
          close_disposition: "billed",
          close_reason: null,
          closed_bill_id: billId
        });
        expect(billRows).toHaveLength(1);
        expect(paymentRows).toHaveLength(1);
        expect(checkoutEventRows).toHaveLength(1);
        expect(checkoutAuditRows).toHaveLength(checkoutAuditIds.length);
        expect(mutationStatus?.bill_id).toBe(billId);
        expect(billRows[0].status).toBe("issued");
        expect(Number(billRows[0].total)).toBeGreaterThan(0);
        expect(Number(billRows[0].amount_due)).toBe(0);
        expect(Number(billRows[0].amount_paid)).toBe(Number(billRows[0].total));
        expect(paymentRows.reduce((sum, payment) => sum + Number(payment.amount), 0))
          .toBe(Number(billRows[0].amount_paid));
        const checkoutActorIds = new Set([
          billRows[0].issued_by_user_id,
          paymentRows[0].received_by_user_id,
          checkoutEventRows[0].created_by,
          ...checkoutAuditRows.map((audit) => audit.user_id)
        ]);
        expect([...checkoutActorIds]).toEqual([checkoutActorId]);
        expect(afterAppState).toHaveLength(1);
        if (hopCommitted) {
          expect(hopEventRows).toHaveLength(1);
          expect(hopAuditRows).toHaveLength(1);
          expect(hopAuditRows[0].action).toBe("session_hopped");
          expect(new Set([hopEventRows[0].created_by, hopAuditRows[0].user_id]))
            .toEqual(new Set([hopActorId]));
          expect(afterAppState[0].version).toBe(beforeAppState[0].version + 1);
        } else {
          expect(hopEventRows).toHaveLength(0);
          expect(hopAuditRows).toHaveLength(0);
          expect(afterAppState[0].version).toBe(beforeAppState[0].version);
        }
        raceEvidence.databaseEvidence = {
          session: sessionRows[0],
          bill: billRows[0],
          paymentCount: paymentRows.length,
          checkoutEventCount: checkoutEventRows.length,
          hopEventCount: hopEventRows.length,
          checkoutAuditCount: checkoutAuditRows.length,
          hopAuditCount: hopAuditRows.length,
          mutationStatus,
          appStateVersionBefore: beforeAppState[0].version,
          appStateVersionAfter: afterAppState[0].version,
          checkoutActorIds: [...checkoutActorIds],
          expectedCheckoutActorId: checkoutActorId,
          expectedHopActorId: hopActorId
        };
        raceResolved = true;

        if (hopCommitted) {
          await expect(observer.page.getByRole("dialog", { name: "Continue Customer", exact: true }))
            .toHaveCount(0, { timeout: 10_000 });
          raceEvidence.staleContinuationClosedBeforeReload = true;
        }

        await Promise.all([page.waitForTimeout(750), observer.page.waitForTimeout(750)]);
        expect(checkoutCommand.wasSubmitted()).toBe(true);
        expect(hopCommand.wasSubmitted()).toBe(true);
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(hopCommand.captureCount()).toBe(1);
        raceEvidence.finalCaptureCounts = {
          checkout: checkoutCommand.captureCount(),
          hop: hopCommand.captureCount()
        };
        const losingHopAlert = "The game hop was not completed. Latest data has been refreshed; review the session and try again.";
        if (hopCommitted) {
          expect(observerDialogs).not.toContain(losingHopAlert);
        } else {
          await expect.poll(() => observerDialogs.join("\n"), { timeout: 5_000 })
            .toContain(losingHopAlert);
          raceEvidence.losingHopAlert = observerDialogs;
        }
        observer.page.off("dialog", dismissObserverDialog);
        await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2");
        await observer.page.unroute("**/rest/v1/rpc/hop_session");
        await Promise.all([
          page.reload({ waitUntil: "domcontentloaded" }),
          observer.page.reload({ waitUntil: "domcontentloaded" })
        ]);
        if (hopCommitted) {
          await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
        } else {
          await waitForSynced(page);
          await expect(observer.page.getByText("1 conflict", { exact: true })).toBeVisible();
          await expect(observer.page.getByText("Pending sync.", { exact: false })).toHaveCount(0);
          raceEvidence.loserConflictVisible = true;
          await observer.page.getByRole("button", { name: "Clear", exact: true }).click();
          await waitForSynced(observer.page);
        }
        await expect(stationCard(page, station)).toContainText("Available");
        await expect(stationCard(observer.page, station)).toContainText("Available");
        expect(originErrors).toEqual({ consoleErrors: [], pageErrors: [] });
        expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        observer.page.off("dialog", dismissObserverDialog);
        checkoutCommand?.cancel();
        hopCommand?.cancel();
        await page.unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
        await observer.page.unroute("**/rest/v1/rpc/hop_session").catch(() => undefined);
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
            await rejectSessionIfOpen(page, station, customerName, `Playwright pre-race hop cleanup ${runId}`);
          } catch (error) {
            cleanupError = error instanceof Error ? error.message : "Unknown checkout/hop pre-race cleanup failure";
          }
        } else if (raceStarted && !raceResolved) {
          cleanupError = "Checkout/hop commands were sent; reconcile their mutation IDs before any cleanup or retry.";
        }
        await attachJson(testInfo, `release-b-checkout-hop-${ordering}-evidence`, {
          runId,
          ordering,
          station,
          customerName,
          sessionStarted,
          raceStarted,
          raceResolved,
          sessionId,
          cleanupError,
          observerDialogs,
          originErrors,
          observerErrors,
          raceEvidence,
          rpcEvidence
        });
        await attachFailureScreenshot(testInfo, page, `checkout-hop-${ordering}-origin-failure`);
        await attachFailureScreenshot(testInfo, observer.page, `checkout-hop-${ordering}-observer-failure`);
        await observer.context.close();
        if (!primaryError && cleanupError) throw new Error(cleanupError);
      }
    });
  }
});
