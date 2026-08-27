import { createHash } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  browserDateTimeLocal,
  capturePageErrors,
  captureAuthenticatedRestRequests,
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
const station = process.env.E2E_V2_CHECKOUT_SETTLEMENT_RACE_STATION?.trim() || "8 Ball Pool";
const organizationId = "org-primary";

type BillSnapshot = {
  id: string;
  bill_number: string;
  status: string;
  total: number;
  amount_paid: number;
  amount_due: number;
  settled_at: string | null;
  issued_by_user_id: string;
};

type CheckoutEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    payload: {
      primary_bill: { id: string; billNumber: string };
      bill_updates: Array<{
        id: string;
        billNumber: string;
        status: string;
        amountPaid: number;
        amountDue: number;
      }>;
      payments: Array<{
        id: string;
        billId: string;
        amount: number;
        relatedCheckoutBillId?: string;
      }>;
      settlement_expectations: Array<{
        billId: string;
        expectedStatus: string;
        expectedAmountDue: number;
        settlementAmount: number;
        intendedAmountDue: number;
      }>;
      source_session_ids: string[];
      audit_logs: Array<{ id: string; action: string; entityId: string }>;
    };
  };
};

type AdjustmentEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    payload: {
      bill_updates: Array<{
        id: string;
        status: string;
        amountPaid: number;
        amountDue: number;
      }>;
      payments: Array<{
        id: string;
        billId: string;
        amount: number;
        relatedCheckoutBillId?: string;
      }>;
      bill_expectations: Array<{
        billId: string;
        expectedStatus: string;
        expectedAmountPaid: number;
        expectedAmountDue: number;
      }>;
      audit_logs: Array<{ id: string; action: string; entityId: string }>;
    };
  };
};

function appStateHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function sanitizedErrorMessage(error: unknown) {
  if (error === undefined) return undefined;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/((?:api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .slice(0, 2_000);
}

function rpcHeaders(captured: CapturedRpcRequest) {
  return {
    apikey: captured.headers.apikey,
    authorization: captured.headers.authorization,
    "content-type": "application/json",
    prefer: captured.headers.prefer || "return=representation"
  };
}

function makeUniqueCheckoutBillNumber(captured: CapturedRpcRequest) {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const billNumber = `BILL-QA-SETTLE-RACE-${runId}`;
  envelope.payload.payload.primary_bill.billNumber = billNumber;
  const primaryUpdate = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primaryUpdate) throw new Error("Captured checkout omitted its primary bill update.");
  primaryUpdate.billNumber = billNumber;
  return envelope;
}

async function openBillRegisterRow(page: Page, billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  return row;
}

async function startSessionDespitePendingBill(page: Page, customerName: string) {
  const card = stationCard(page, station);
  await expect(card).toContainText("Available");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  const start = page.getByRole("dialog", { name: "Start New Session", exact: true });
  await start.getByLabel("Customer Name", { exact: true }).fill(customerName);
  await start.getByRole("button", { name: "Start Session", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Outstanding Pending Bills", exact: true });
  await expect(warning).toContainText(customerName);
  await warning.getByRole("button", { name: "Continue Anyway", exact: true }).click();
  await expect(warning).toBeHidden();
  await expect(start).toBeHidden();
  await waitForSynced(page);
  await expect(card).toContainText(customerName);
}

async function mutationStatus(
  page: Page,
  captured: CapturedRpcRequest,
  envelope: CheckoutEnvelope["payload"] | AdjustmentEnvelope["payload"]
) {
  const response = await page.request.post(
    captured.url.replace(/commit_(?:checkout_bill|financial_adjustment)_v2$/, "get_financial_mutation_result"),
    {
      headers: rpcHeaders(captured),
      data: {
        payload: {
          organization_id: envelope.organization_id,
          mutation_id: envelope.mutation_id,
          mutation_kind: envelope.mutation_kind
        }
      }
    }
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown> | null;
}

test.describe.serial("Release B checkout versus standalone settlement concurrency", () => {
  test("one pending bill is settled exactly once when both v2 UI commands race", async ({
    browser,
    page
  }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const authenticatedRequests: CapturedRpcRequest[] = [];
    captureAuthenticatedRestRequests(page, authenticatedRequests);
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA Checkout Settlement Race ${runId}`;
    let firstSessionStarted = false;
    let pendingBillCommitted = false;
    let secondSessionStarted = false;
    let raceStarted = false;
    let raceResolved = false;
    let financialOutcomeResolved = false;
    let raceWinner: "checkout" | "adjustment" | undefined;
    let pendingBillNumber: string | undefined;
    let firstSessionId: string | undefined;
    let secondSessionId: string | undefined;
    let originRest: { restBase: string; headers: Record<string, string> } | undefined;
    let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let settlementCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let cleanupError: string | undefined;
    let quiescenceError: string | undefined;
    let primaryError: unknown;
    let evidence: Record<string, unknown> = {};
    const dismissDialog = (dialog: { dismiss(): Promise<void> }) => void dialog.dismiss();

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      const originIdentity = await assertAuthoritativeOrganizationIdentity(
        page,
        authenticatedRequests,
        "admin",
        organizationId
      );
      originRest = { restBase: originIdentity.restBase, headers: originIdentity.headers };
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      expect(
        await stationCard(page, station).innerText(),
        "The checkout/settlement race station is occupied."
      ).toContain("Available");

      await startSession(page, station, customerName);
      await expect
        .poll(
          () =>
            rpcEvidence.find((entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300)
              ?.entityId
        )
        .toBeTruthy();
      firstSessionId = rpcEvidence.find(
        (entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300
      )!.entityId;
      firstSessionStarted = Boolean(firstSessionId);
      const firstSession = await openManagedSession(page, station);
      await firstSession.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await firstSession.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await firstSession.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await firstSession.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const firstCheckout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await firstCheckout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await firstCheckout
        .locator("label")
        .filter({ hasText: "Payment Mode" })
        .locator("select")
        .selectOption("deferred");
      await firstCheckout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(firstCheckout).toBeHidden();
      await waitForSynced(page);
      await expect
        .poll(
          () =>
            rpcEvidence.filter(
              (entry) => entry.page === "origin" && entry.rpc === "commit_checkout_bill_v2" && entry.status < 300
            ).length
        )
        .toBe(1);
      const deferredResult = rpcEvidence.findLast(
        (entry) => entry.page === "origin" && entry.rpc === "commit_checkout_bill_v2" && entry.status < 300
      )!;
      pendingBillNumber = deferredResult.billNumber;
      expect(pendingBillNumber).toBeTruthy();
      expect(deferredResult.changedRows?.payments).toEqual([]);
      pendingBillCommitted = true;

      await startSessionDespitePendingBill(page, customerName);
      await expect
        .poll(
          () =>
            rpcEvidence.filter(
              (entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300
            )[1]?.entityId
        )
        .toBeTruthy();
      secondSessionId = rpcEvidence.filter(
        (entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300
      )[1].entityId;
      secondSessionStarted = Boolean(secondSessionId);
      const secondSession = await openManagedSession(page, station);
      await secondSession.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await secondSession.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await secondSession.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);

      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(observer.page);
      const pendingRow = await openBillRegisterRow(observer.page, pendingBillNumber!);
      await expect(pendingRow).toContainText("Pending");
      await pendingRow.getByRole("button", { name: "Settle", exact: true }).click();
      const settlement = observer.page.getByRole("dialog", { name: `Settle Bill - ${pendingBillNumber}`, exact: true });
      await settlement.getByRole("button", { name: /^Pay Full Amount/ }).click();

      await secondSession.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const currentCheckout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await currentCheckout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await expect(currentCheckout.getByText("Previous Dues", { exact: true })).toBeVisible();
      await expect(currentCheckout).toContainText(pendingBillNumber!);
      await expect(currentCheckout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();

      checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
      settlementCommand = await interceptSingleRpcCommand(
        observer.page,
        "**/rest/v1/rpc/commit_financial_adjustment_v2"
      );
      page.on("dialog", dismissDialog);
      observer.page.on("dialog", dismissDialog);
      await currentCheckout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await settlement.getByRole("button", { name: "Confirm Settlement", exact: true }).click();
      const [capturedCheckout, capturedSettlement] = await Promise.all([
        checkoutCommand.captured,
        settlementCommand.captured
      ]);
      expect(checkoutCommand.captureCount()).toBe(1);
      expect(settlementCommand.captureCount()).toBe(1);

      const checkoutEnvelope = makeUniqueCheckoutBillNumber(capturedCheckout);
      const adjustmentEnvelope = structuredClone(capturedSettlement.body) as AdjustmentEnvelope;
      const checkoutPatch = checkoutEnvelope.payload.payload;
      const adjustmentPatch = adjustmentEnvelope.payload.payload;
      expect(checkoutEnvelope.payload.organization_id).toBe(organizationId);
      expect(adjustmentEnvelope.payload.organization_id).toBe(organizationId);
      expect(checkoutEnvelope.payload.mutation_id).not.toBe(adjustmentEnvelope.payload.mutation_id);
      expect(adjustmentEnvelope.payload.mutation_kind).toBe("settlePendingBills");
      expect(checkoutPatch.source_session_ids).toHaveLength(1);
      expect(checkoutPatch.source_session_ids[0]).toBe(secondSessionId);
      expect(secondSessionId).toBe(checkoutEnvelope.payload.entity_id);
      const checkoutExpectation = checkoutPatch.settlement_expectations.find((expectation) =>
        checkoutPatch.bill_updates.some(
          (bill) => bill.id === expectation.billId && bill.billNumber === pendingBillNumber
        )
      );
      expect(checkoutExpectation, "Checkout omitted the selected pending bill expectation.").toBeTruthy();
      const pendingBillId = checkoutExpectation!.billId;
      expect(adjustmentEnvelope.payload.entity_id).toBe(pendingBillId);
      expect(adjustmentPatch.bill_expectations).toHaveLength(1);
      const adjustmentExpectation = adjustmentPatch.bill_expectations[0];
      expect(adjustmentExpectation).toEqual(
        expect.objectContaining({ billId: pendingBillId, expectedStatus: "pending" })
      );
      expect(checkoutExpectation!.expectedStatus).toBe("pending");
      expect(Number(checkoutExpectation!.expectedAmountDue)).toBeGreaterThan(0);
      expect(Number(checkoutExpectation!.settlementAmount)).toBe(Number(checkoutExpectation!.expectedAmountDue));
      expect(Number(checkoutExpectation!.intendedAmountDue)).toBe(0);
      const checkoutSettlementPayments = checkoutPatch.payments.filter((payment) => payment.billId === pendingBillId);
      const adjustmentPayments = adjustmentPatch.payments.filter((payment) => payment.billId === pendingBillId);
      expect(checkoutSettlementPayments).toHaveLength(1);
      expect(adjustmentPayments).toHaveLength(1);
      expect(Number(checkoutSettlementPayments[0].amount)).toBe(Number(checkoutExpectation!.expectedAmountDue));
      expect(Number(adjustmentPayments[0].amount)).toBe(Number(checkoutExpectation!.expectedAmountDue));
      expect(checkoutSettlementPayments[0].relatedCheckoutBillId).toBe(checkoutPatch.primary_bill.id);
      expect(adjustmentPayments[0].relatedCheckoutBillId).toBeUndefined();

      const checkoutHeaders = rpcHeaders(capturedCheckout);
      const restBase = capturedCheckout.url.replace(/\/rpc\/[^/]+$/, "");
      const restHeaders = { apikey: checkoutHeaders.apikey, authorization: checkoutHeaders.authorization };
      const checkoutActorId = authenticatedJwtSubject(capturedCheckout.headers);
      const adjustmentActorId = authenticatedJwtSubject(capturedSettlement.headers);
      evidence = {
        runId,
        customerName,
        station,
        pendingBillId,
        pendingBillNumber,
        secondSessionId,
        currentBillId: checkoutPatch.primary_bill.id,
        currentBillNumber: checkoutPatch.primary_bill.billNumber,
        checkoutMutationId: checkoutEnvelope.payload.mutation_id,
        adjustmentMutationId: adjustmentEnvelope.payload.mutation_id,
        checkoutActorId,
        adjustmentActorId,
        captureCountsBeforeSend: {
          checkout: checkoutCommand.captureCount(),
          settlement: settlementCommand.captureCount()
        }
      };
      expect(originRest?.restBase).toBe(restBase);
      expect(authenticatedJwtSubject(originRest?.headers ?? {})).toBe(checkoutActorId);
      const [livePendingBills, pendingPaymentsBefore, beforeAppState] = await Promise.all([
        readRestRows<BillSnapshot>(page, restBase, restHeaders, "bills", {
          organization_id: `eq.${organizationId}`,
          id: `eq.${pendingBillId}`,
          select: "id,bill_number,status,total,amount_paid,amount_due,settled_at,issued_by_user_id"
        }),
        readRestRows<{ id: string }>(page, restBase, restHeaders, "payments", {
          organization_id: `eq.${organizationId}`,
          bill_id: `eq.${pendingBillId}`,
          select: "id"
        }),
        readRestRows<{ version: number; data: unknown }>(page, restBase, restHeaders, "app_state", {
          id: "eq.primary",
          select: "version,data"
        })
      ]);
      expect(livePendingBills).toHaveLength(1);
      const livePendingBill = livePendingBills[0];
      expect(livePendingBill.bill_number).toBe(pendingBillNumber);
      expect(livePendingBill.status).toBe("pending");
      expect(Number(livePendingBill.amount_due)).toBeGreaterThan(0);
      expect(Number(livePendingBill.amount_paid)).toBe(0);
      expect(pendingPaymentsBefore).toEqual([]);
      expect(checkoutExpectation).toEqual(
        expect.objectContaining({
          expectedStatus: livePendingBill.status,
          expectedAmountDue: Number(livePendingBill.amount_due),
          settlementAmount: Number(livePendingBill.amount_due),
          intendedAmountDue: 0
        })
      );
      expect(adjustmentExpectation).toEqual(
        expect.objectContaining({
          expectedStatus: livePendingBill.status,
          expectedAmountPaid: Number(livePendingBill.amount_paid),
          expectedAmountDue: Number(livePendingBill.amount_due)
        })
      );
      expect(beforeAppState).toHaveLength(1);
      const appStateVersionBefore = beforeAppState[0].version;
      const appStateHashBefore = appStateHash(beforeAppState[0].data);
      evidence = {
        ...evidence,
        pendingDue: checkoutExpectation!.expectedAmountDue,
        authoritativePendingBillBefore: livePendingBill,
        appStateVersionBefore,
        appStateHashBefore,
      };

      raceStarted = true;
      const [checkoutResponse, adjustmentResponse] = await Promise.all([
        checkoutCommand.submit(checkoutEnvelope),
        settlementCommand.submit(adjustmentEnvelope)
      ]);
      const [checkoutBody, adjustmentBody] = await Promise.all([
        readApiResponseBody(checkoutResponse),
        readApiResponseBody(adjustmentResponse)
      ]);
      const responses: Array<{
        kind: "checkout" | "adjustment";
        response: APIResponse;
        body: Record<string, unknown>;
      }> = [
        { kind: "checkout", response: checkoutResponse, body: checkoutBody },
        { kind: "adjustment", response: adjustmentResponse, body: adjustmentBody }
      ];
      const winners = responses.filter(({ response }) => response.status() === 200);
      const losers = responses.filter(({ response }) => response.status() >= 400);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const winner = winners[0];
      const loser = losers[0];
      expect(loser.response.status()).toBe(400);
      expect(rpcRejectionCode(loser.body)).toBe(
        winner.kind === "checkout" ? "financial_adjustment_conflict" : "settlement_conflict"
      );

      const [checkoutMutationStatus, adjustmentMutationStatus] = await Promise.all([
        mutationStatus(page, capturedCheckout, checkoutEnvelope.payload),
        mutationStatus(observer.page, capturedSettlement, adjustmentEnvelope.payload)
      ]);
      expect(winner.kind === "checkout" ? checkoutMutationStatus : adjustmentMutationStatus).not.toBeNull();
      expect(winner.kind === "checkout" ? adjustmentMutationStatus : checkoutMutationStatus).toBeNull();
      const winnerMutationStatus = winner.kind === "checkout" ? checkoutMutationStatus! : adjustmentMutationStatus!;
      expect(winnerMutationStatus).toEqual(winner.body);
      const winnerPatch = winner.kind === "checkout" ? checkoutPatch : adjustmentPatch;
      const winnerChangedRows = winnerMutationStatus.changed_rows as Record<string, unknown>;
      const winnerPaymentIds = winnerPatch.payments.map((payment) => payment.id);
      const winnerAuditIds = winnerPatch.audit_logs.map((audit) => audit.id);
      expect(new Set(winnerChangedRows.payments as string[])).toEqual(new Set(winnerPaymentIds));
      expect(new Set(winnerChangedRows.audit_logs as string[])).toEqual(new Set(winnerAuditIds));
      const expectedSettlementAudit = winnerPatch.audit_logs.find(
        (audit) => audit.entityId === pendingBillId && audit.action === "bill_settled"
      );
      expect(expectedSettlementAudit).toBeTruthy();

      const [
        pendingBills,
        currentBills,
        pendingPayments,
        sessions,
        settlementAudits,
        checkoutEvents,
        adjustmentEvents,
        afterAppState
      ] = await Promise.all([
        readRestRows<BillSnapshot>(page, restBase, restHeaders, "bills", {
          organization_id: `eq.${organizationId}`,
          id: `eq.${pendingBillId}`,
          select: "id,bill_number,status,total,amount_paid,amount_due,settled_at,issued_by_user_id"
        }),
        readRestRows<BillSnapshot>(page, restBase, restHeaders, "bills", {
          organization_id: `eq.${organizationId}`,
          id: `eq.${checkoutPatch.primary_bill.id}`,
          select: "id,bill_number,status,total,amount_paid,amount_due,settled_at,issued_by_user_id"
        }),
        readRestRows<{
          id: string;
          amount: number;
          received_by_user_id: string;
          related_checkout_bill_id: string | null;
        }>(page, restBase, restHeaders, "payments", {
          organization_id: `eq.${organizationId}`,
          bill_id: `eq.${pendingBillId}`,
          select: "id,amount,received_by_user_id,related_checkout_bill_id"
        }),
        readRestRows<{ id: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(
          page,
          restBase,
          restHeaders,
          "sessions",
          {
            organization_id: `eq.${organizationId}`,
            id: `eq.${secondSessionId}`,
            select: "id,status,close_disposition,closed_bill_id"
          }
        ),
        readRestRows<{ id: string; action: string; user_id: string }>(page, restBase, restHeaders, "audit_logs", {
          organization_id: `eq.${organizationId}`,
          entity_type: "eq.bill",
          entity_id: `eq.${pendingBillId}`,
          action: "eq.bill_settled",
          select: "id,action,user_id"
        }),
        readRestRows<{ id: string; created_by: string }>(page, restBase, restHeaders, "operational_events", {
          organization_id: `eq.${organizationId}`,
          "metadata->>mutation_id": `eq.${checkoutEnvelope.payload.mutation_id}`,
          select: "id,created_by"
        }),
        readRestRows<{ id: string; created_by: string }>(page, restBase, restHeaders, "operational_events", {
          organization_id: `eq.${organizationId}`,
          "metadata->>mutation_id": `eq.${adjustmentEnvelope.payload.mutation_id}`,
          select: "id,created_by"
        }),
        readRestRows<{ version: number; data: unknown }>(page, restBase, restHeaders, "app_state", {
          id: "eq.primary",
          select: "version,data"
        })
      ]);
      expect(pendingBills).toHaveLength(1);
      expect(pendingBills[0].status).toBe("issued");
      expect(Number(pendingBills[0].amount_due)).toBe(0);
      expect(Number(pendingBills[0].amount_paid)).toBe(Number(pendingBills[0].total));
      expect(pendingBills[0].settled_at).toBeTruthy();
      expect(pendingPayments).toHaveLength(1);
      expect(Number(pendingPayments[0].amount)).toBe(Number(checkoutExpectation!.expectedAmountDue));
      expect(winnerPaymentIds).toContain(pendingPayments[0].id);
      expect(settlementAudits).toHaveLength(1);
      expect(settlementAudits[0].id).toBe(expectedSettlementAudit!.id);
      expect(sessions).toHaveLength(1);
      expect(afterAppState).toHaveLength(1);
      expect(afterAppState[0].version).toBe(appStateVersionBefore);
      expect(appStateHash(afterAppState[0].data)).toBe(appStateHashBefore);

      const expectedWinnerActorId = winner.kind === "checkout" ? checkoutActorId : adjustmentActorId;
      expect(pendingPayments[0].received_by_user_id).toBe(expectedWinnerActorId);
      expect(settlementAudits[0].user_id).toBe(expectedWinnerActorId);
      if (winner.kind === "checkout") {
        expect(currentBills).toHaveLength(1);
        expect(sessions[0]).toEqual(
          expect.objectContaining({
            status: "closed",
            close_disposition: "billed",
            closed_bill_id: checkoutPatch.primary_bill.id
          })
        );
        expect(pendingPayments[0].related_checkout_bill_id).toBe(checkoutPatch.primary_bill.id);
        expect(checkoutEvents).toHaveLength(1);
        expect(adjustmentEvents).toHaveLength(0);
        expect(checkoutEvents[0].id).toBe(winnerMutationStatus.event_id);
        expect(checkoutEvents[0].created_by).toBe(checkoutActorId);
      } else {
        expect(currentBills).toHaveLength(0);
        expect(sessions[0]).toEqual(
          expect.objectContaining({
            status: "active",
            close_disposition: null,
            closed_bill_id: null
          })
        );
        expect(pendingPayments[0].related_checkout_bill_id).toBeNull();
        expect(checkoutEvents).toHaveLength(0);
        expect(adjustmentEvents).toHaveLength(1);
        expect(adjustmentEvents[0].id).toBe(winnerMutationStatus.event_id);
        expect(adjustmentEvents[0].created_by).toBe(adjustmentActorId);
      }
      raceWinner = winner.kind;
      financialOutcomeResolved = true;
      raceResolved = true;
      evidence = {
        ...evidence,
        winner: winner.kind,
        checkoutStatus: checkoutResponse.status(),
        checkoutBody,
        adjustmentStatus: adjustmentResponse.status(),
        adjustmentBody,
        loserCode: rpcRejectionCode(loser.body),
        checkoutMutationStatus,
        adjustmentMutationStatus,
        databaseEvidence: {
          pendingBill: pendingBills[0],
          currentBillCount: currentBills.length,
          pendingPayments,
          session: sessions[0],
          settlementAudits,
          checkoutEvents,
          adjustmentEvents,
          appStateVersionAfter: afterAppState[0].version,
          appStateHashAfter: appStateHash(afterAppState[0].data),
          expectedWinnerActorId
        }
      };

      expect(checkoutCommand.wasSubmitted()).toBe(true);
      expect(settlementCommand.wasSubmitted()).toBe(true);
      expect(checkoutCommand.captureCount()).toBe(1);
      expect(settlementCommand.captureCount()).toBe(1);
      expect(originErrors.consoleErrors).toEqual([]);
      expect(observerErrors.consoleErrors).toEqual([]);
      expect(originErrors.pageErrors.length + observerErrors.pageErrors.length).toBeLessThanOrEqual(1);
      const expectedLoserMessage =
        winner.kind === "checkout"
          ? /A bill changed before the financial adjustment was committed/i
          : /A pending bill changed before checkout/i;
      [...originErrors.pageErrors, ...observerErrors.pageErrors].forEach((message) =>
        expect(message).toMatch(expectedLoserMessage)
      );
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      checkoutCommand?.cancel();
      settlementCommand?.cancel();
      const capturedCommands = [checkoutCommand, settlementCommand].filter(
        (command): command is NonNullable<typeof command> => Boolean(command && command.captureCount() > 0)
      );
      await Promise.all(capturedCommands.map((command) => command.settled.catch(() => undefined)));
      if (!raceStarted && capturedCommands.length > 0) {
        // Keep both RPC routes installed while the canceled UI commands and
        // bounded status lookups are terminated by navigation. This prevents
        // an ambiguous-response recovery from escaping failure cleanup.
        const quiescenceTargets = [page, observer.page];
        const quiescenceResults = await Promise.allSettled(
          quiescenceTargets.map((target) => target.reload({ waitUntil: "domcontentloaded" }))
        );
        const failedQuiescence = quiescenceResults
          .map((result, index) => ({ result, index }))
          .filter(
            (entry): entry is { result: PromiseRejectedResult; index: number } => entry.result.status === "rejected"
          );
        if (failedQuiescence.length > 0) {
          quiescenceError = failedQuiescence
            .map(({ result, index }) =>
              `browser ${index === 0 ? "origin" : "observer"}: ${sanitizedErrorMessage(result.reason)}`
            )
            .join("; ");
          cleanupError = `Pre-race browser quiescence failed; external reconciliation is required. ${quiescenceError}`;
          await Promise.all(
            failedQuiescence.map(async ({ index }) => {
              const target = quiescenceTargets[index];
              if (!target.isClosed()) await target.close({ runBeforeUnload: false });
            })
          );
        }
      }
      await checkoutCommand?.dispose().catch(() => undefined);
      await settlementCommand?.dispose().catch(() => undefined);
      page.off("dialog", dismissDialog);
      observer.page.off("dialog", dismissDialog);
      const acknowledgedStarts = rpcEvidence.filter(
        (entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300
      );
      firstSessionId = firstSessionId ?? acknowledgedStarts[0]?.entityId;
      secondSessionId = secondSessionId ?? acknowledgedStarts[1]?.entityId;
      firstSessionStarted = firstSessionStarted || Boolean(firstSessionId);
      secondSessionStarted = secondSessionStarted || Boolean(secondSessionId);
      if (
        !page.isClosed() &&
        secondSessionStarted &&
        (!raceStarted || (financialOutcomeResolved && raceWinner === "adjustment"))
      ) {
        try {
          for (const target of [page, observer.page]) {
            await target.reload({ waitUntil: "domcontentloaded" });
            const conflict = target.getByText(/\d+ conflict/, { exact: false });
            if (await conflict.count()) {
              const clear = target.getByRole("button", { name: "Clear", exact: true });
              if (await clear.isVisible()) await clear.click();
            }
            await waitForSynced(target);
          }
          const rejected = await rejectSessionIfOpen(
            page,
            station,
            customerName,
            `Playwright checkout-settlement race cleanup ${runId}`
          );
          expect(rejected, "Cleanup did not reject the exact open second session.").toBe(true);
          if (!originRest || !secondSessionId)
            throw new Error("Cleanup lacks the authoritative second-session identity.");
          const cleaned = await readRestRows<{
            id: string;
            status: string;
            close_disposition: string | null;
            closed_bill_id: string | null;
          }>(page, originRest.restBase, originRest.headers, "sessions", {
            organization_id: `eq.${organizationId}`,
            id: `eq.${secondSessionId}`,
            select: "id,status,close_disposition,closed_bill_id"
          });
          expect(cleaned).toEqual([
            { id: secondSessionId, status: "closed", close_disposition: "rejected", closed_bill_id: null }
          ]);
        } catch (error) {
          cleanupError = sanitizedErrorMessage(error) ?? "Unknown checkout-settlement cleanup failure";
        }
      } else if (!page.isClosed() && firstSessionStarted && !pendingBillCommitted) {
        try {
          await page.reload({ waitUntil: "domcontentloaded" });
          const conflict = page.getByText(/\d+ conflict/, { exact: false });
          if (await conflict.count()) {
            const clear = page.getByRole("button", { name: "Clear", exact: true });
            if (await clear.isVisible()) await clear.click();
          }
          await waitForSynced(page);
          const rejected = await rejectSessionIfOpen(
            page,
            station,
            customerName,
            `Playwright deferred setup cleanup ${runId}`
          );
          expect(rejected, "Cleanup did not reject the exact open first session.").toBe(true);
          if (!originRest || !firstSessionId)
            throw new Error("Cleanup lacks the authoritative first-session identity.");
          const cleaned = await readRestRows<{
            id: string;
            status: string;
            close_disposition: string | null;
            closed_bill_id: string | null;
          }>(page, originRest.restBase, originRest.headers, "sessions", {
            organization_id: `eq.${organizationId}`,
            id: `eq.${firstSessionId}`,
            select: "id,status,close_disposition,closed_bill_id"
          });
          expect(cleaned).toEqual([
            { id: firstSessionId, status: "closed", close_disposition: "rejected", closed_bill_id: null }
          ]);
        } catch (error) {
          cleanupError = sanitizedErrorMessage(error) ?? "Unknown deferred setup cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-checkout-settlement-race-v2-evidence", {
        ...evidence,
        firstSessionStarted,
        firstSessionId,
        pendingBillCommitted,
        secondSessionStarted,
        raceStarted,
        raceResolved,
        financialOutcomeResolved,
        raceWinner,
        cleanupError,
        quiescenceError,
        primaryError: sanitizedErrorMessage(primaryError),
        rpcEvidence,
        finalCaptureCounts: {
          checkout: checkoutCommand?.captureCount() ?? 0,
          settlement: settlementCommand?.captureCount() ?? 0
        }
      });
      await attachFailureScreenshot(testInfo, page, "checkout-settlement-race-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "checkout-settlement-race-observer-failure");
      await observer.context.close();
    }

    expect(cleanupError).toBeUndefined();
  });
});
