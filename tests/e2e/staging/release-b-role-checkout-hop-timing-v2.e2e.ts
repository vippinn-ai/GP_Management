import { expect, test, type APIResponse, type Page } from "@playwright/test";
import type { FinancialCheckoutV2RpcPayloadEnvelope } from "../../../src/dataGateway/financialRpcClient";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  attachJson,
  captureAuthenticatedRestRequests,
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
  type OperationalRole,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const ROLE_MATRIX_CONFIRMATION = "release-b-receptionist-manager";
const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_V2_ROLE_HOP_STATION?.trim() || "Playstation";
const matrixPhase = process.env.E2E_ROLE_MATRIX_PHASE ?? "all";
if (!new Set(["all", "remaining", "remaining-three"]).has(matrixPhase)) {
  throw new Error("E2E_ROLE_MATRIX_PHASE must be all, remaining, or remaining-three.");
}

type Slot = "A" | "B";
type Ordering = "checkout-first" | "hop-first" | "concurrent";
type RoleScenario = {
  id: string;
  ordering: Ordering;
  checkoutSlot: Slot;
  checkoutRole: Exclude<OperationalRole, "admin">;
  hopSlot: Slot;
  hopRole: Exclude<OperationalRole, "admin">;
};

type CheckoutRpcEnvelope = FinancialCheckoutV2RpcPayloadEnvelope & {
  payload: FinancialCheckoutV2RpcPayloadEnvelope["payload"] & {
    primary_bill: { id: string; billNumber: string };
    bill_updates: Array<{ id: string; billNumber: string }>;
    session_updates: Array<{ id: string; startedAt: string; endedAt: string }>;
    audit_logs: Array<{ id: string }>;
  };
};

type CheckoutEnvelope = { payload: CheckoutRpcEnvelope };

type HopEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    payload: {
      session: { id: string; startedAt: string; endedAt: string };
      auditLog: { id: string };
    };
  };
};

const scenarios: RoleScenario[] = [
  { id: "rec-checkout-first", ordering: "checkout-first", checkoutSlot: "A", checkoutRole: "receptionist", hopSlot: "B", hopRole: "manager" },
  { id: "mgr-checkout-first", ordering: "checkout-first", checkoutSlot: "B", checkoutRole: "manager", hopSlot: "A", hopRole: "receptionist" },
  { id: "rec-checkout-hop-first", ordering: "hop-first", checkoutSlot: "A", checkoutRole: "receptionist", hopSlot: "B", hopRole: "manager" },
  { id: "mgr-checkout-hop-first", ordering: "hop-first", checkoutSlot: "B", checkoutRole: "manager", hopSlot: "A", hopRole: "receptionist" },
  { id: "rec-checkout-concurrent", ordering: "concurrent", checkoutSlot: "A", checkoutRole: "receptionist", hopSlot: "B", hopRole: "manager" },
  { id: "mgr-checkout-concurrent", ordering: "concurrent", checkoutSlot: "B", checkoutRole: "manager", hopSlot: "A", hopRole: "receptionist" }
];
const remainingThreeScenarioIds = new Set([
  "mgr-checkout-hop-first",
  "rec-checkout-concurrent",
  "mgr-checkout-concurrent"
]);
const selectedScenarios = matrixPhase === "remaining"
  ? scenarios.filter((scenario) => scenario.ordering !== "checkout-first")
  : matrixPhase === "remaining-three"
    ? scenarios.filter((scenario) => remainingThreeScenarioIds.has(scenario.id))
  : scenarios;

function makeUniqueBillNumber(captured: CapturedRpcRequest, scenarioId: string, suffix = "RACE") {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const number = `BILL-QA-ROLE-${runId}-${scenarioId}-${suffix}`.toUpperCase();
  envelope.payload.payload.primary_bill.billNumber = number;
  const primaryUpdate = envelope.payload.payload.bill_updates.find(
    (bill) => bill.id === envelope.payload.payload.primary_bill.id
  );
  if (!primaryUpdate) throw new Error("Captured role-matrix checkout omitted its primary bill update.");
  primaryUpdate.billNumber = number;
  return envelope;
}

function pageForSlot(slot: Slot, pageA: Page, pageB: Page) {
  return slot === "A" ? pageA : pageB;
}

test.describe.serial("Release B receptionist and manager checkout-hop timing", () => {
  test.skip(
    process.env.E2E_ROLE_MATRIX !== ROLE_MATRIX_CONFIRMATION,
    "Run through the dedicated role-matrix runner with distinct receptionist and manager credentials."
  );

  test("preflight proves distinct active authoritative role identities before any write", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const requestsA: CapturedRpcRequest[] = [];
    const requestsB: CapturedRpcRequest[] = [];
    captureAuthenticatedRestRequests(page, requestsA);
    captureAuthenticatedRestRequests(observer.page, requestsB);
    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      const [receptionist, manager] = await Promise.all([
        assertAuthoritativeOrganizationIdentity(page, requestsA, "receptionist"),
        assertAuthoritativeOrganizationIdentity(observer.page, requestsB, "manager")
      ]);
      expect(receptionist.actorId).not.toBe(manager.actorId);
      expect(receptionist.restBase).toBe(manager.restBase);
      await attachJson(testInfo, "release-b-role-matrix-preflight", {
        runId,
        organizationId: "org-primary",
        receptionist: { actorId: receptionist.actorId, role: receptionist.role },
        manager: { actorId: manager.actorId, role: manager.role },
        distinctActors: receptionist.actorId !== manager.actorId,
        writesAttempted: false
      });
    } finally {
      await observer.context.close();
    }
  });

  for (const scenario of selectedScenarios) {
    test(`${scenario.id} resolves with authorized timing and one terminal bill`, async ({ browser, page }, testInfo) => {
      const observer = await createObserver(browser);
      const pageA = page;
      const pageB = observer.page;
      const checkoutPage = pageForSlot(scenario.checkoutSlot, pageA, pageB);
      const hopPage = pageForSlot(scenario.hopSlot, pageA, pageB);
      const requestsA: CapturedRpcRequest[] = [];
      const requestsB: CapturedRpcRequest[] = [];
      const rpcEvidence: RpcEvidence[] = [];
      const errorsA = capturePageErrors(pageA);
      const errorsB = capturePageErrors(pageB);
      const hopDialogs: string[] = [];
      const dismissHopDialog = (dialog: { message(): string; dismiss(): Promise<void> }) => {
        hopDialogs.push(dialog.message());
        void dialog.dismiss();
      };
      captureAuthenticatedRestRequests(pageA, requestsA);
      captureAuthenticatedRestRequests(pageB, requestsB);
      captureRpcEvidence(pageA, "origin", rpcEvidence);
      captureRpcEvidence(pageB, "observer", rpcEvidence);

      const customerName = `QA Role Hop ${scenario.id} ${runId}`;
      let sessionStarted = false;
      let commandsSent = false;
      let raceReconciled = false;
      let terminalBillConfirmed = false;
      let sessionId: string | undefined;
      let primaryError: unknown;
      let cleanupError: string | undefined;
      let evidence: Record<string, unknown> = { scenario, customerName };
      let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      let hopCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      let cleanupCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;

      try {
        await Promise.all([signIn(pageA, credentials("A")), signIn(pageB, credentials("B"))]);
        const [receptionist, manager] = await Promise.all([
          assertAuthoritativeOrganizationIdentity(pageA, requestsA, "receptionist"),
          assertAuthoritativeOrganizationIdentity(pageB, requestsB, "manager")
        ]);
        expect(receptionist.actorId).not.toBe(manager.actorId);
        const identities = { A: receptionist, B: manager };
        const checkoutIdentity = identities[scenario.checkoutSlot];
        const hopIdentity = identities[scenario.hopSlot];
        expect(checkoutIdentity.role).toBe(scenario.checkoutRole);
        expect(hopIdentity.role).toBe(scenario.hopRole);
        expect(checkoutIdentity.restBase).toBe(hopIdentity.restBase);
        evidence.rolePreflight = {
          organizationId: "org-primary",
          checkout: { actorId: checkoutIdentity.actorId, role: checkoutIdentity.role },
          hop: { actorId: hopIdentity.actorId, role: hopIdentity.role },
          distinctActors: checkoutIdentity.actorId !== hopIdentity.actorId
        };

        expect(await stationCard(checkoutPage, station).innerText(), "The role-matrix station is occupied.").toContain("Available");
        await startSession(checkoutPage, station, customerName);
        sessionStarted = true;
        await hopPage.reload({ waitUntil: "domcontentloaded" });
        await waitForSynced(hopPage);
        await expect(stationCard(hopPage, station)).toContainText(customerName);
        await expect.poll(
          () => [...rpcEvidence].reverse().find((entry) => entry.rpc === "start_session" && entry.status < 300)?.entityId
        ).toBeTruthy();
        sessionId = [...rpcEvidence].reverse().find(
          (entry) => entry.rpc === "start_session" && entry.status < 300
        )?.entityId;
        expect(sessionId).toBeTruthy();
        const [beforeSession, beforeAppState] = await Promise.all([
          readRestRows<{ id: string; started_at: string; ended_at: string | null }>(
            checkoutPage,
            checkoutIdentity.restBase,
            checkoutIdentity.headers,
            "sessions",
            { organization_id: "eq.org-primary", id: `eq.${sessionId}`, select: "id,started_at,ended_at" }
          ),
          readRestRows<{ version: number }>(checkoutPage, checkoutIdentity.restBase, checkoutIdentity.headers, "app_state", {
            id: "eq.primary",
            select: "version"
          })
        ]);
        expect(beforeSession).toHaveLength(1);
        expect(beforeSession[0].ended_at).toBeNull();

        const checkoutSession = await openManagedSession(checkoutPage, station);
        await checkoutSession.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        await expect(
          checkoutSession.getByLabel("Session Start Time", { exact: true }),
          `${scenario.checkoutRole} must not receive the admin timing editor.`
        ).toHaveCount(0);
        await checkoutSession.getByRole("button", { name: "Cancel", exact: true }).click();
        await checkoutSession.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
        const checkoutDialog = checkoutPage.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await expect(checkoutDialog.getByLabel("Session Start Time", { exact: true })).toHaveCount(0);
        await expect(checkoutDialog.getByLabel("Session End Time", { exact: true })).toHaveCount(0);
        await checkoutPage.waitForTimeout(1_100);

        const hopSession = await openManagedSession(hopPage, station);
        await hopSession.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        await expect(
          hopSession.getByLabel("Session Start Time", { exact: true }),
          `${scenario.hopRole} must not receive the admin timing editor.`
        ).toHaveCount(0);
        await hopSession.getByRole("button", { name: "Cancel", exact: true }).click();
        await hopSession.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
        const hopDialog = hopPage.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await expect(hopDialog.getByLabel("Session Start Time", { exact: true })).toHaveCount(0);
        await expect(hopDialog.getByLabel("Session End Time", { exact: true })).toHaveCount(0);
        await hopDialog.getByLabel(/Game hop - close station without billing/).check();

        checkoutCommand = await interceptSingleRpcCommand(checkoutPage, "**/rest/v1/rpc/commit_checkout_bill_v2");
        hopCommand = await interceptSingleRpcCommand(hopPage, "**/rest/v1/rpc/hop_session");
        hopPage.on("dialog", dismissHopDialog);
        await Promise.all([
          checkoutDialog.getByRole("button", { name: "Issue Bill", exact: true }).click(),
          hopDialog.getByRole("button", { name: "Confirm Game Hop", exact: true }).click()
        ]);
        const [capturedCheckout, capturedHop] = await Promise.all([checkoutCommand.captured, hopCommand.captured]);
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(hopCommand.captureCount()).toBe(1);

        const checkoutEnvelope = makeUniqueBillNumber(capturedCheckout, scenario.id);
        const hopEnvelope = capturedHop.body as HopEnvelope;
        expect(checkoutEnvelope.payload.payload.source_session_ids[0]).toBe(sessionId);
        const billId = checkoutEnvelope.payload.payload.primary_bill.id;
        const checkoutMutationId = checkoutEnvelope.payload.mutation_id;
        const hopMutationId = hopEnvelope.payload.mutation_id;
        const checkoutAuditIds = checkoutEnvelope.payload.payload.audit_logs.map((audit) => audit.id);
        const hopAuditId = hopEnvelope.payload.payload.auditLog.id;
        expect(hopEnvelope.payload.payload.session.id).toBe(sessionId);
        expect(checkoutEnvelope.payload.organization_id).toBe("org-primary");
        expect(hopEnvelope.payload.organization_id).toBe("org-primary");
        const checkoutSessionUpdate = checkoutEnvelope.payload.payload.session_updates.find((entry) => entry.id === sessionId);
        expect(checkoutSessionUpdate).toBeTruthy();
        expect(new Date(checkoutSessionUpdate!.startedAt).getTime()).toBe(new Date(beforeSession[0].started_at).getTime());
        expect(new Date(hopEnvelope.payload.payload.session.startedAt).getTime()).toBe(new Date(beforeSession[0].started_at).getTime());
        expect(new Date(checkoutSessionUpdate!.endedAt).getTime()).not.toBe(
          new Date(hopEnvelope.payload.payload.session.endedAt).getTime()
        );
        expect(new Date(checkoutSessionUpdate!.endedAt).getTime()).toBeGreaterThan(
          new Date(checkoutSessionUpdate!.startedAt).getTime()
        );
        expect(new Date(hopEnvelope.payload.payload.session.endedAt).getTime()).toBeGreaterThan(
          new Date(hopEnvelope.payload.payload.session.startedAt).getTime()
        );
        evidence.commandPreflight = {
          sessionId,
          billId,
          checkoutMutationId,
          hopMutationId,
          checkoutAuditIds,
          hopAuditId,
          normalizedStartedAt: beforeSession[0].started_at,
          normalizedEndedAt: beforeSession[0].ended_at,
          submittedCheckoutStartedAt: checkoutSessionUpdate!.startedAt,
          submittedCheckoutEndedAt: checkoutSessionUpdate!.endedAt,
          submittedHopStartedAt: hopEnvelope.payload.payload.session.startedAt,
          submittedHopEndedAt: hopEnvelope.payload.payload.session.endedAt,
          appStateVersionBefore: beforeAppState[0].version,
          captureCounts: { checkout: checkoutCommand.captureCount(), hop: hopCommand.captureCount() }
        };

        commandsSent = true;
        let checkoutResponse: APIResponse;
        let hopResponse: APIResponse;
        if (scenario.ordering === "checkout-first") {
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
          hopResponse = await hopCommand.submit(capturedHop.body);
        } else if (scenario.ordering === "hop-first") {
          hopResponse = await hopCommand.submit(capturedHop.body);
          expect(hopResponse.status()).toBe(200);
          await expect(hopPage.getByRole("dialog", { name: "Continue Customer", exact: true })).toBeVisible();
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
        const checkoutCommitted = checkoutResponse.status() === 200;
        const hopCommitted = hopResponse.status() === 200;
        expect(Number(checkoutCommitted) + Number(hopCommitted)).toBe(1);
        if (checkoutCommitted) {
          expect(hopResponse.status()).toBe(400);
          expect(rpcRejectionCode(hopBody)).toBe("session_not_open");
        } else {
          expect(checkoutResponse.status()).toBe(400);
          expect(rpcRejectionCode(checkoutBody)).toBe("invalid_session_timing");
        }

        const mutationStatusResponse = await checkoutPage.request.post(
          `${checkoutIdentity.restBase}/rpc/get_financial_mutation_result`,
          {
            headers: checkoutIdentity.headers,
            data: {
              payload: {
                organization_id: "org-primary",
                mutation_id: checkoutMutationId,
                mutation_kind: checkoutEnvelope.payload.mutation_kind
              }
            }
          }
        );
        expect(mutationStatusResponse.status()).toBe(200);
        const mutationStatus = await mutationStatusResponse.json() as Record<string, unknown> | null;
        const [sessionRows, billRows, paymentRows, checkoutEventRows, hopEventRows, checkoutAuditRows, hopAuditRows, afterRaceAppState] = await Promise.all([
          readRestRows<{ id: string; status: string; close_disposition: string; closed_bill_id: string | null; started_at: string; ended_at: string }>(
            checkoutPage,
            checkoutIdentity.restBase,
            checkoutIdentity.headers,
            "sessions",
            { organization_id: "eq.org-primary", id: `eq.${sessionId}`, select: "id,status,close_disposition,closed_bill_id,started_at,ended_at" }
          ),
          readRestRows<{ id: string; total: number; amount_paid: number; amount_due: number; issued_by_user_id: string }>(
            checkoutPage,
            checkoutIdentity.restBase,
            checkoutIdentity.headers,
            "bills",
            { organization_id: "eq.org-primary", id: `eq.${billId}`, select: "id,total,amount_paid,amount_due,issued_by_user_id" }
          ),
          readRestRows<{ id: string; amount: number; received_by_user_id: string }>(checkoutPage, checkoutIdentity.restBase, checkoutIdentity.headers, "payments", {
            organization_id: "eq.org-primary", bill_id: `eq.${billId}`, select: "id,amount,received_by_user_id"
          }),
          readRestRows<{ id: string; created_by: string }>(checkoutPage, checkoutIdentity.restBase, checkoutIdentity.headers, "operational_events", {
            organization_id: "eq.org-primary", "metadata->>mutation_id": `eq.${checkoutMutationId}`, select: "id,created_by"
          }),
          readRestRows<{ id: string; created_by: string }>(checkoutPage, checkoutIdentity.restBase, checkoutIdentity.headers, "operational_events", {
            organization_id: "eq.org-primary", "metadata->>mutation_id": `eq.${hopMutationId}`, select: "id,created_by"
          }),
          readRestRows<{ id: string; user_id: string }>(checkoutPage, checkoutIdentity.restBase, checkoutIdentity.headers, "audit_logs", {
            organization_id: "eq.org-primary", id: `in.(${checkoutAuditIds.join(",")})`, select: "id,user_id"
          }),
          readRestRows<{ id: string; user_id: string }>(checkoutPage, checkoutIdentity.restBase, checkoutIdentity.headers, "audit_logs", {
            organization_id: "eq.org-primary", id: `eq.${hopAuditId}`, select: "id,user_id"
          }),
          readRestRows<{ version: number }>(checkoutPage, checkoutIdentity.restBase, checkoutIdentity.headers, "app_state", {
            id: "eq.primary", select: "version"
          })
        ]);
        expect(sessionRows).toHaveLength(1);
        expect(afterRaceAppState).toHaveLength(1);
        if (checkoutCommitted) {
          expect(sessionRows[0]).toMatchObject({ status: "closed", close_disposition: "billed", closed_bill_id: billId });
          expect(billRows).toHaveLength(1);
          const billTotal = Number(billRows[0].total);
          const billAmountPaid = Number(billRows[0].amount_paid);
          expect(paymentRows).toHaveLength(billTotal === 0 ? 0 : 1);
          expect(checkoutEventRows).toHaveLength(1);
          expect(checkoutAuditRows).toHaveLength(checkoutAuditIds.length);
          expect(hopEventRows).toHaveLength(0);
          expect(hopAuditRows).toHaveLength(0);
          expect(mutationStatus?.bill_id).toBe(billId);
          expect(afterRaceAppState[0].version).toBe(beforeAppState[0].version);
          expect(billAmountPaid).toBe(billTotal);
          expect(Number(billRows[0].amount_due)).toBe(0);
          expect(paymentRows.reduce((sum, payment) => sum + Number(payment.amount), 0))
            .toBe(billAmountPaid);
          expect(new Set([
            billRows[0].issued_by_user_id,
            ...paymentRows.map((payment) => payment.received_by_user_id),
            checkoutEventRows[0].created_by,
            ...checkoutAuditRows.map((audit) => audit.user_id)
          ])).toEqual(new Set([checkoutIdentity.actorId]));
          terminalBillConfirmed = true;
        } else {
          expect(sessionRows[0]).toMatchObject({ status: "closed", close_disposition: "hopped", closed_bill_id: null });
          expect(billRows).toHaveLength(0);
          expect(paymentRows).toHaveLength(0);
          expect(checkoutEventRows).toHaveLength(0);
          expect(checkoutAuditRows).toHaveLength(0);
          expect(hopEventRows).toHaveLength(1);
          expect(hopAuditRows).toHaveLength(1);
          expect(mutationStatus).toBeNull();
          expect(afterRaceAppState[0].version).toBe(beforeAppState[0].version + 1);
          expect(new Set([hopEventRows[0].created_by, hopAuditRows[0].user_id]))
            .toEqual(new Set([hopIdentity.actorId]));
        }
        raceReconciled = true;
        evidence.raceResult = {
          checkoutStatus: checkoutResponse.status(),
          hopStatus: hopResponse.status(),
          checkoutRejectionCode: rpcRejectionCode(checkoutBody),
          hopRejectionCode: rpcRejectionCode(hopBody),
          checkoutCommitted,
          hopCommitted,
          session: sessionRows[0],
          billCount: billRows.length,
          paymentCount: paymentRows.length,
          checkoutEventCount: checkoutEventRows.length,
          hopEventCount: hopEventRows.length,
          checkoutAuditCount: checkoutAuditRows.length,
          hopAuditCount: hopAuditRows.length,
          mutationStatus,
          appStateVersionAfterRace: afterRaceAppState[0].version
        };

        await Promise.all([pageA.waitForTimeout(750), pageB.waitForTimeout(750)]);
        expect(checkoutCommand.wasSubmitted()).toBe(true);
        expect(hopCommand.wasSubmitted()).toBe(true);
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(hopCommand.captureCount()).toBe(1);
        evidence.raceResult = {
          ...(evidence.raceResult as Record<string, unknown>),
          finalCaptureCounts: { checkout: checkoutCommand.captureCount(), hop: hopCommand.captureCount() }
        };

        await checkoutCommand.dispose();
        await hopCommand.dispose();
        checkoutCommand = undefined;
        hopCommand = undefined;

        if (hopCommitted) {
          await expect(hopPage.getByRole("dialog", { name: "Continue Customer", exact: true })).toBeVisible();
          await hopPage.getByRole("dialog", { name: "Continue Customer", exact: true })
            .getByRole("button", { name: "Bill & Done", exact: true }).click();
          const cleanupDialog = hopPage.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
          await expect(cleanupDialog).toBeVisible();
          await expect(cleanupDialog.getByLabel("Session Start Time", { exact: true })).toHaveCount(0);
          await expect(cleanupDialog.getByLabel("Session End Time", { exact: true })).toHaveCount(0);
          cleanupCommand = await interceptSingleRpcCommand(hopPage, "**/rest/v1/rpc/commit_checkout_bill_v2");
          await cleanupDialog.getByRole("button", { name: "Issue Bill", exact: true }).click();
          const capturedCleanup = await cleanupCommand.captured;
          expect(cleanupCommand.captureCount()).toBe(1);
          const cleanupEnvelope = makeUniqueBillNumber(capturedCleanup, scenario.id, "CLEAN");
          const cleanupSessionUpdate = cleanupEnvelope.payload.payload.session_updates.find((entry) => entry.id === sessionId);
          expect(cleanupSessionUpdate).toBeTruthy();
          expect(new Date(cleanupSessionUpdate!.startedAt).getTime()).toBe(new Date(sessionRows[0].started_at).getTime());
          expect(new Date(cleanupSessionUpdate!.endedAt).getTime()).toBe(new Date(sessionRows[0].ended_at).getTime());
          const cleanupResponse = await cleanupCommand.submit(cleanupEnvelope);
          const cleanupBody = await readApiResponseBody(cleanupResponse);
          expect(cleanupResponse.status()).toBe(200);
          const cleanupBillId = cleanupEnvelope.payload.payload.primary_bill.id;
          const cleanupMutationId = cleanupEnvelope.payload.mutation_id;
          const cleanupAuditIds = cleanupEnvelope.payload.payload.audit_logs.map((audit) => audit.id);
          const cleanupMutationStatusResponse = await hopPage.request.post(
            `${hopIdentity.restBase}/rpc/get_financial_mutation_result`,
            {
              headers: hopIdentity.headers,
              data: {
                payload: {
                  organization_id: "org-primary",
                  mutation_id: cleanupMutationId,
                  mutation_kind: cleanupEnvelope.payload.mutation_kind
                }
              }
            }
          );
          expect(cleanupMutationStatusResponse.status()).toBe(200);
          const cleanupMutationStatus = await cleanupMutationStatusResponse.json() as Record<string, unknown> | null;
          const [cleanedSession, cleanupBills, cleanupLines, cleanupPayments, cleanupEvents, cleanupAudits, cleanupAppState] = await Promise.all([
            readRestRows<{ status: string; close_disposition: string; closed_bill_id: string | null }>(hopPage, hopIdentity.restBase, hopIdentity.headers, "sessions", {
              organization_id: "eq.org-primary", id: `eq.${sessionId}`, select: "status,close_disposition,closed_bill_id"
            }),
            readRestRows<{ id: string; total: number; amount_paid: number; amount_due: number; issued_by_user_id: string }>(hopPage, hopIdentity.restBase, hopIdentity.headers, "bills", {
              organization_id: "eq.org-primary", id: `eq.${cleanupBillId}`, select: "id,total,amount_paid,amount_due,issued_by_user_id"
            }),
            readRestRows<{ id: string; type: string; linked_session_id: string | null }>(hopPage, hopIdentity.restBase, hopIdentity.headers, "bill_lines", {
              organization_id: "eq.org-primary", bill_id: `eq.${cleanupBillId}`, select: "id,type,linked_session_id"
            }),
            readRestRows<{ id: string; amount: number; received_by_user_id: string }>(hopPage, hopIdentity.restBase, hopIdentity.headers, "payments", {
              organization_id: "eq.org-primary", bill_id: `eq.${cleanupBillId}`, select: "id,amount,received_by_user_id"
            }),
            readRestRows<{ id: string; created_by: string }>(hopPage, hopIdentity.restBase, hopIdentity.headers, "operational_events", {
              organization_id: "eq.org-primary", "metadata->>mutation_id": `eq.${cleanupMutationId}`, select: "id,created_by"
            }),
            readRestRows<{ id: string; user_id: string }>(hopPage, hopIdentity.restBase, hopIdentity.headers, "audit_logs", {
              organization_id: "eq.org-primary", id: `in.(${cleanupAuditIds.join(",")})`, select: "id,user_id"
            }),
            readRestRows<{ version: number }>(hopPage, hopIdentity.restBase, hopIdentity.headers, "app_state", {
              id: "eq.primary", select: "version"
            })
          ]);
          expect(cleanedSession).toEqual([{ status: "closed", close_disposition: "billed", closed_bill_id: cleanupBillId }]);
          expect(cleanupBills).toHaveLength(1);
          expect(cleanupLines).toHaveLength(1);
          expect(cleanupLines[0]).toMatchObject({ type: "session_charge", linked_session_id: sessionId });
          const cleanupAmountPaid = Number(cleanupBills[0].amount_paid);
          expect(cleanupPayments).toHaveLength(cleanupAmountPaid > 0 ? 1 : 0);
          expect(cleanupEvents).toHaveLength(1);
          expect(cleanupAudits).toHaveLength(cleanupAuditIds.length);
          expect(cleanupMutationStatus?.bill_id).toBe(cleanupBillId);
          expect(cleanupAmountPaid).toBe(Number(cleanupBills[0].total));
          expect(Number(cleanupBills[0].amount_due)).toBe(0);
          expect(cleanupPayments.reduce((sum, payment) => sum + Number(payment.amount), 0))
            .toBe(cleanupAmountPaid);
          expect(new Set([
            cleanupBills[0].issued_by_user_id,
            ...cleanupPayments.map((payment) => payment.received_by_user_id),
            cleanupEvents[0].created_by,
            ...cleanupAudits.map((audit) => audit.user_id)
          ])).toEqual(new Set([hopIdentity.actorId]));
          expect(cleanupAppState).toEqual(afterRaceAppState);
          await hopPage.waitForTimeout(750);
          expect(cleanupCommand.wasSubmitted()).toBe(true);
          expect(cleanupCommand.captureCount()).toBe(1);
          terminalBillConfirmed = true;
          evidence.hoppedSessionCleanup = {
            status: cleanupResponse.status(),
            body: cleanupBody,
            billId: cleanupBillId,
            mutationId: cleanupMutationId,
            auditIds: cleanupAuditIds,
            actorId: hopIdentity.actorId,
            submittedStartedAt: cleanupSessionUpdate!.startedAt,
            submittedEndedAt: cleanupSessionUpdate!.endedAt,
            mutationStatus: cleanupMutationStatus,
            billLines: cleanupLines,
            auditCount: cleanupAudits.length,
            finalCaptureCount: cleanupCommand.captureCount(),
            appStateVersionAfterCleanup: cleanupAppState[0].version
          };
          await cleanupCommand.dispose();
          cleanupCommand = undefined;
        }

        await Promise.all([pageA.reload({ waitUntil: "domcontentloaded" }), pageB.reload({ waitUntil: "domcontentloaded" })]);
        if (checkoutCommitted) {
          const losingHopPage = hopPage;
          await expect(losingHopPage.getByText("1 conflict", { exact: true })).toBeVisible();
          await losingHopPage.getByRole("button", { name: "Clear", exact: true }).click();
        }
        await Promise.all([waitForSynced(pageA), waitForSynced(pageB)]);
        await expect(stationCard(pageA, station)).toContainText("Available");
        await expect(stationCard(pageB, station)).toContainText("Available");
        expect(terminalBillConfirmed).toBe(true);
        expect(errorsA.consoleErrors).toEqual([]);
        expect(errorsB.consoleErrors).toEqual([]);
        if (checkoutCommitted) {
          expect(errorsA.pageErrors).toEqual([]);
          expect(errorsB.pageErrors).toEqual([]);
        } else {
          const checkoutErrors = scenario.checkoutSlot === "A" ? errorsA.pageErrors : errorsB.pageErrors;
          const nonCheckoutErrors = scenario.checkoutSlot === "A" ? errorsB.pageErrors : errorsA.pageErrors;
          expect(checkoutErrors).toHaveLength(1);
          expect(checkoutErrors[0]).toMatch(/Session timing changes are invalid or not authorized\.?/i);
          expect(nonCheckoutErrors).toEqual([]);
        }
        const syncGuardDialog = "Live changes for this session are still syncing with the server. Please wait until Live actions shows Synced before issuing the bill, hopping, rejecting, or closing it.";
        const refreshedConflictDialog = "The game hop was not completed. Latest data has been refreshed; review the session and try again.";
        expect(hopDialogs.every((message) => [syncGuardDialog, refreshedConflictDialog].includes(message))).toBe(true);
        if (!checkoutCommitted) expect(hopDialogs).not.toContain(refreshedConflictDialog);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        hopPage.off("dialog", dismissHopDialog);
        checkoutCommand?.cancel();
        hopCommand?.cancel();
        cleanupCommand?.cancel();
        if (checkoutCommand) await checkoutCommand.dispose().catch(() => undefined);
        if (hopCommand) await hopCommand.dispose().catch(() => undefined);
        if (cleanupCommand) await cleanupCommand.dispose().catch(() => undefined);
        sessionStarted = sessionStarted || rpcEvidence.some((entry) => entry.rpc === "start_session" && entry.status < 300);
        if (sessionStarted && !commandsSent) {
          try {
            const cleanupConfirmed = await rejectSessionIfOpen(
              checkoutPage,
              station,
              customerName,
              `Playwright role-matrix pre-race cleanup ${runId}`
            );
            if (!cleanupConfirmed) {
              throw new Error("Pre-race cleanup did not positively confirm rejection of the exact QA session.");
            }
          } catch (error) {
            cleanupError = error instanceof Error ? error.message : "Unknown role-matrix pre-race cleanup failure";
          }
        } else if (commandsSent && (!raceReconciled || !terminalBillConfirmed)) {
          cleanupError = "Role checkout-hop commands were sent; reconcile their mutation IDs and any hopped session before cleanup or retry.";
        }
        evidence = {
          ...evidence,
          runId,
          station,
          sessionId,
          sessionStarted,
          commandsSent,
          raceReconciled,
          terminalBillConfirmed,
          cleanupError,
          hopDialogs,
          errorsA,
          errorsB,
          rpcEvidence
        };
        await attachJson(testInfo, `release-b-role-checkout-hop-${scenario.id}-evidence`, evidence);
        await attachFailureScreenshot(testInfo, pageA, `${scenario.id}-a-failure`);
        await attachFailureScreenshot(testInfo, pageB, `${scenario.id}-b-failure`);
        await observer.context.close();
        if (!primaryError && cleanupError) throw new Error(cleanupError);
      }
    });
  }
});
