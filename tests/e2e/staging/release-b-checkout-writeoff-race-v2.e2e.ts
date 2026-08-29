import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  browserDateTimeLocal,
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
  type RpcEvidence,
  waitForSynced
} from "./support/app";

type Scenario = "checkout_first" | "writeoff_first" | "simultaneous";
type Winner = "checkout" | "writeoff";
type CheckoutEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    payload: {
      primary_bill: Record<string, unknown> & { id: string; billNumber: string };
      bill_updates: Array<Record<string, unknown> & { id: string; billNumber: string }>;
      payments: Array<Record<string, unknown> & { id: string; billId: string; amount: number; relatedCheckoutBillId?: string }>;
      settlement_expectations: Array<{ billId: string; expectedStatus: string; expectedAmountDue: number; settlementAmount: number; intendedAmountDue: number }>;
      source_session_ids: string[];
      audit_logs: Array<{ id: string; action: string; entityId: string }>;
      stock_movements: Array<{ id: string }>;
    };
  };
};
type WriteoffEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    payload: {
      bill_updates: Array<Record<string, unknown> & {
        id: string; billNumber: string; status: string; amountPaid: number; amountDue: number;
        voidedAt?: string; voidReason?: string;
      }>;
      payments: unknown[];
      stock_movements: unknown[];
      inventory_updates: unknown[];
      bill_expectations: Array<{ billId: string; expectedStatus: string; expectedAmountPaid: number; expectedAmountDue: number }>;
      audit_logs: Array<{ id: string; action: string; entityId: string; message: string }>;
    };
  };
};

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const organizationId = "org-primary";
const station = process.env.E2E_V2_CHECKOUT_SETTLEMENT_RACE_STATION?.trim() || "8 Ball Pool";
const allScenarios: Array<{ scenario: Scenario; expectedWinner?: Winner }> = [
  { scenario: "checkout_first", expectedWinner: "checkout" },
  { scenario: "writeoff_first", expectedWinner: "writeoff" },
  { scenario: "simultaneous" }
];
const selectedScenarioNames = (process.env.E2E_CHECKOUT_WRITEOFF_SCENARIOS ?? allScenarios.map(({ scenario }) => scenario).join(","))
  .split(",").map((value) => value.trim()).filter(Boolean);
const allowedScenarioSelections = [
  ["checkout_first", "writeoff_first", "simultaneous"],
  ["writeoff_first", "simultaneous"],
  ["simultaneous"]
];
if (!allowedScenarioSelections.some((selection) => selection.join(",") === selectedScenarioNames.join(","))) {
  throw new Error("E2E_CHECKOUT_WRITEOFF_SCENARIOS is not an approved exact scenario selection.");
}
const scenarios = allScenarios.filter(({ scenario }) => selectedScenarioNames.includes(scenario));

function appStateHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function rpcHeaders(captured: CapturedRpcRequest) {
  return {
    apikey: captured.headers.apikey,
    authorization: captured.headers.authorization,
    "content-type": "application/json",
    prefer: captured.headers.prefer || "return=representation"
  };
}

function checkoutEnvelope(captured: CapturedRpcRequest, scenario: Scenario) {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const billNumber = `BILL-QA-WRITEOFF-RACE-${runId}-${scenario}`;
  envelope.payload.payload.primary_bill.billNumber = billNumber;
  const update = envelope.payload.payload.bill_updates.find((bill) => bill.id === envelope.payload.payload.primary_bill.id);
  if (!update) throw new Error("Captured checkout omitted its primary bill update.");
  update.billNumber = billNumber;
  return envelope;
}

async function mutationStatus(page: Page, captured: CapturedRpcRequest, envelope: CheckoutEnvelope["payload"] | WriteoffEnvelope["payload"]) {
  const response = await page.request.post(
    captured.url.replace(/commit_(?:checkout_bill|financial_adjustment)_v2$/, "get_financial_mutation_result"),
    {
      headers: rpcHeaders(captured),
      data: { payload: { organization_id: envelope.organization_id, mutation_id: envelope.mutation_id, mutation_kind: envelope.mutation_kind } }
    }
  );
  expect(response.status()).toBe(200);
  return await response.json() as Record<string, unknown> | null;
}

async function startDespitePending(page: Page, customerName: string) {
  const card = stationCard(page, station);
  await expect(card).toContainText("Available");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start New Session", exact: true });
  await dialog.getByLabel("Customer Name", { exact: true }).fill(customerName);
  await dialog.getByRole("button", { name: "Start Session", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Outstanding Pending Bills", exact: true });
  await expect(warning).toContainText(customerName);
  await warning.getByRole("button", { name: "Continue Anyway", exact: true }).click();
  await expect(warning).toBeHidden();
  await waitForSynced(page);
}

async function openBillRow(page: Page, billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  return row;
}

function persistCheckpoint(scenario: Scenario | "final", phase: string, evidence: unknown) {
  const forbiddenCredentialPaths: string[] = [];
  const scan = (value: unknown, currentPath: string) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => scan(entry, `${currentPath}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const entryPath = currentPath ? `${currentPath}.${key}` : key;
      if (/^(authorization|apikey|password)$/i.test(key)) forbiddenCredentialPaths.push(entryPath);
      scan(entry, entryPath);
    }
  };
  scan(evidence, "evidence");
  if (forbiddenCredentialPaths.length) {
    throw new Error(`Refusing to persist credential-bearing checkout-writeoff evidence: ${forbiddenCredentialPaths.join(", ")}`);
  }
  const directory = path.resolve(process.cwd(), "test-artifacts", "evidence");
  mkdirSync(directory, { recursive: true });
  const finalPath = path.join(directory, `checkout-writeoff-race-${scenario}-${phase}-${runId}.json`);
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, finalPath);
  return path.relative(process.cwd(), finalPath);
}

test.describe.serial("Release B checkout versus pending write-off concurrency", () => {
  const runEvidence: Array<Record<string, unknown>> = [];

  for (const { scenario, expectedWinner } of scenarios) {
    test(`${scenario} commits exactly one pending-bill transition`, async ({ browser, page }, testInfo) => {
      const observer = await createObserver(browser);
      const originRequests: CapturedRpcRequest[] = [];
      const observerRequests: CapturedRpcRequest[] = [];
      const rpcEvidence: RpcEvidence[] = [];
      captureAuthenticatedRestRequests(page, originRequests);
      captureAuthenticatedRestRequests(observer.page, observerRequests);
      captureRpcEvidence(page, "origin", rpcEvidence);
      captureRpcEvidence(observer.page, "observer", rpcEvidence);
      const originErrors = capturePageErrors(page);
      const observerErrors = capturePageErrors(observer.page);
      const customerName = `QA Checkout Writeoff Race ${runId} ${scenario}`;
      const reason = `Release B checkout write-off race ${runId} ${scenario}`;
      let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      let writeoffCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      let raceDispatched = false;
      let outcomeResolved = false;
      let winner: Winner | undefined;
      let firstSessionId: string | undefined;
      let secondSessionId: string | undefined;
      let pendingBillId: string | undefined;
      let pendingBillNumber: string | undefined;
      let cleanupError: string | undefined;
      let evidence: Record<string, unknown> = { runId, scenario, customerName, reason, station };
      const dismissDialog = (dialog: { dismiss(): Promise<void> }) => void dialog.dismiss();

      try {
        await signIn(page, credentials("A"));
        await signIn(observer.page, credentials("B"));
        const [origin, adjustment] = await Promise.all([
          assertAuthoritativeOrganizationIdentity(page, originRequests, "admin", organizationId),
          assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", organizationId)
        ]);
        expect(origin.actorId).not.toBe(adjustment.actorId);
        await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
        await expect(stationCard(page, station)).toContainText("Available");

        await startSession(page, station, customerName);
        await expect.poll(() => rpcEvidence.filter((entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300)[0]?.entityId).toBeTruthy();
        firstSessionId = rpcEvidence.filter((entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300)[0].entityId;
        const first = await openManagedSession(page, station);
        await first.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        await first.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
        await first.getByRole("button", { name: "Save Session Details", exact: true }).click();
        await waitForSynced(page);
        await first.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
        const setupCheckout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await setupCheckout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
        await setupCheckout.locator("label").filter({ hasText: "Payment Mode" }).locator("select").selectOption("deferred");
        await setupCheckout.getByRole("button", { name: "Issue Bill", exact: true }).click();
        await expect(setupCheckout).toBeHidden();
        await waitForSynced(page);
        await expect.poll(() => rpcEvidence.filter((entry) => entry.page === "origin" && entry.rpc === "commit_checkout_bill_v2" && entry.status < 300).length).toBe(1);
        const setupResult = rpcEvidence.find((entry) => entry.page === "origin" && entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)!;
        const setupRequest = originRequests.findLast((entry) =>
          entry.url.endsWith("/rest/v1/rpc/commit_checkout_bill_v2") &&
          (entry.body as CheckoutEnvelope | undefined)?.payload?.mutation_id === setupResult.mutationId
        );
        pendingBillId = setupResult.billId;
        pendingBillNumber = setupResult.billNumber;
        expect(pendingBillId).toBeTruthy();
        expect(pendingBillNumber).toBeTruthy();
        expect(setupResult.changedRows?.payments).toEqual([]);
        expect(setupRequest).toBeTruthy();

        await startDespitePending(page, customerName);
        await expect.poll(() => rpcEvidence.filter((entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300)[1]?.entityId).toBeTruthy();
        secondSessionId = rpcEvidence.filter((entry) => entry.page === "origin" && entry.rpc === "start_session" && entry.status < 300)[1].entityId;
        const second = await openManagedSession(page, station);
        await second.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        await second.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
        await second.getByRole("button", { name: "Save Session Details", exact: true }).click();
        await waitForSynced(page);

        await observer.page.reload({ waitUntil: "domcontentloaded" });
        await waitForSynced(observer.page);
        const pendingRow = await openBillRow(observer.page, pendingBillNumber!);
        await expect(pendingRow).toContainText("Pending");
        await pendingRow.getByRole("button", { name: "Write Off", exact: true }).click();
        const writeoffDialog = observer.page.getByRole("dialog", { name: `Write Off Bad Debt - ${pendingBillNumber}`, exact: true });
        await writeoffDialog.getByPlaceholder("Reason for writing off this debt").fill(reason);

        await second.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
        const checkoutDialog = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await checkoutDialog.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
        await expect(checkoutDialog.getByText("Previous Dues", { exact: true })).toBeVisible();
        await expect(checkoutDialog).toContainText(pendingBillNumber!);

        checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
        writeoffCommand = await interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/commit_financial_adjustment_v2");
        page.on("dialog", dismissDialog);
        observer.page.on("dialog", dismissDialog);
        await checkoutDialog.getByRole("button", { name: "Issue Bill", exact: true }).click();
        await writeoffDialog.getByRole("button", { name: "Write Off", exact: true }).click();
        const [capturedCheckout, capturedWriteoff] = await Promise.all([checkoutCommand.captured, writeoffCommand.captured]);
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(writeoffCommand.captureCount()).toBe(1);
        const checkout = checkoutEnvelope(capturedCheckout, scenario);
        const writeoff = structuredClone(capturedWriteoff.body) as WriteoffEnvelope;
        const checkoutPatch = checkout.payload.payload;
        const writeoffPatch = writeoff.payload.payload;
        expect(checkout.payload.organization_id).toBe(organizationId);
        expect(writeoff.payload.organization_id).toBe(organizationId);
        expect(checkout.payload.mutation_kind).toBe("commitCheckoutBill");
        expect(writeoff.payload.mutation_kind).toBe("writeOffPendingBills");
        expect(checkout.payload.entity_id).toBe(secondSessionId);
        expect(checkoutPatch.source_session_ids).toEqual([secondSessionId]);
        const settlementExpectation = checkoutPatch.settlement_expectations.find((entry) => entry.billId === pendingBillId);
        expect(settlementExpectation).toEqual(expect.objectContaining({ expectedStatus: "pending", intendedAmountDue: 0 }));
        expect(writeoff.payload.entity_id).toBe(pendingBillId);
        expect(writeoffPatch.bill_expectations).toEqual([expect.objectContaining({ billId: pendingBillId, expectedStatus: "pending", expectedAmountPaid: 0 })]);
        expect(writeoffPatch.bill_updates).toHaveLength(1);
        expect(writeoffPatch.bill_updates[0]).toEqual(expect.objectContaining({ id: pendingBillId, status: "voided", amountPaid: 0, voidReason: reason }));
        expect(writeoffPatch.payments).toEqual([]);
        expect(writeoffPatch.stock_movements).toEqual([]);
        expect(writeoffPatch.inventory_updates).toEqual([]);
        expect(writeoffPatch.audit_logs).toEqual([expect.objectContaining({ action: "bill_voided_bad_debt", entityId: pendingBillId })]);
        expect(authenticatedJwtSubject(capturedCheckout.headers)).toBe(origin.actorId);
        expect(authenticatedJwtSubject(capturedWriteoff.headers)).toBe(adjustment.actorId);

        const restBase = origin.restBase;
        const restHeaders = origin.headers;
        const [pendingBefore, paymentsBefore, stateBefore] = await Promise.all([
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "bills", {
            organization_id: `eq.${organizationId}`, id: `eq.${pendingBillId}`,
            select: "id,bill_number,status,total,amount_paid,amount_due,voided_at,voided_by_user_id,void_reason"
          }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "payments", {
            organization_id: `eq.${organizationId}`, bill_id: `eq.${pendingBillId}`, select: "id"
          }),
          readRestRows<{ version: number; data: unknown }>(page, restBase, restHeaders, "app_state", { id: "eq.primary", select: "version,data" })
        ]);
        expect(pendingBefore).toHaveLength(1);
        expect(pendingBefore[0]).toEqual(expect.objectContaining({ status: "pending", amount_paid: 0 }));
        expect(paymentsBefore).toEqual([]);
        const compatibilityBefore = { version: stateBefore[0].version, hash: appStateHash(stateBefore[0].data) };
        evidence = {
          ...evidence,
          actors: { checkout: origin.actorId, writeoff: adjustment.actorId },
          firstSessionId,
          secondSessionId,
          setupResult,
          setupCommand: structuredClone(setupRequest!.body),
          setupMutationId: setupResult.mutationId,
          pendingBillId,
          pendingBillNumber,
          checkoutMutationId: checkout.payload.mutation_id,
          writeoffMutationId: writeoff.payload.mutation_id,
          candidateBillId: checkoutPatch.primary_bill.id,
          candidateBillNumber: checkoutPatch.primary_bill.billNumber,
          expectedCheckout: {
            bill: checkoutPatch.primary_bill,
            payments: checkoutPatch.payments,
            audits: checkoutPatch.audit_logs,
            stockMovements: checkoutPatch.stock_movements
          },
          expectedWriteoff: { bills: writeoffPatch.bill_updates, audits: writeoffPatch.audit_logs },
          authoritativePendingBillBefore: pendingBefore[0],
          compatibilityBefore,
          setupOperationalEvidence: structuredClone(rpcEvidence),
          setupCommands: originRequests
            .filter((entry) => Boolean((entry.body as { payload?: { mutation_id?: string } } | null)?.payload?.mutation_id))
            .map((entry) => ({ rpc: new URL(entry.url).pathname.split("/").at(-1), body: structuredClone(entry.body) })),
          captureCounts: { checkout: 1, writeoff: 1 },
          submissionPlan: { scenario, checkout, writeoff }
        };
        evidence.preparedPath = persistCheckpoint(scenario, "prepared", evidence);

        raceDispatched = true;
        let checkoutResponse: APIResponse;
        let writeoffResponse: APIResponse;
        if (scenario === "checkout_first") {
          checkoutResponse = await checkoutCommand.submit(checkout);
          writeoffResponse = await writeoffCommand.submit(writeoff);
        } else if (scenario === "writeoff_first") {
          writeoffResponse = await writeoffCommand.submit(writeoff);
          checkoutResponse = await checkoutCommand.submit(checkout);
        } else {
          [checkoutResponse, writeoffResponse] = await Promise.all([
            checkoutCommand.submit(checkout), writeoffCommand.submit(writeoff)
          ]);
        }
        const [checkoutBody, writeoffBody] = await Promise.all([
          readApiResponseBody(checkoutResponse), readApiResponseBody(writeoffResponse)
        ]);
        const responses = {
          checkout: { status: checkoutResponse.status(), body: checkoutBody },
          writeoff: { status: writeoffResponse.status(), body: writeoffBody }
        };
        const responsesPath = persistCheckpoint(scenario, "responses", {
          ...evidence,
          raceDispatched: true,
          responses,
          captureCounts: {
            checkout: checkoutCommand.captureCount(),
            writeoff: writeoffCommand.captureCount()
          },
          submitted: {
            checkout: checkoutCommand.wasSubmitted(),
            writeoff: writeoffCommand.wasSubmitted()
          }
        });
        const checkoutWon = checkoutResponse.status() === 200;
        const writeoffWon = writeoffResponse.status() === 200;
        expect(Number(checkoutWon) + Number(writeoffWon)).toBe(1);
        winner = checkoutWon ? "checkout" : "writeoff";
        if (expectedWinner) expect(winner).toBe(expectedWinner);
        expect(checkoutWon ? writeoffResponse.status() : checkoutResponse.status()).toBe(400);
        expect(checkoutWon ? rpcRejectionCode(writeoffBody) : rpcRejectionCode(checkoutBody)).toBe(
          checkoutWon ? "financial_adjustment_conflict" : "settlement_conflict"
        );
        const [checkoutStatus, writeoffStatus] = await Promise.all([
          mutationStatus(page, capturedCheckout, checkout.payload),
          mutationStatus(observer.page, capturedWriteoff, writeoff.payload)
        ]);
        expect(checkoutWon ? checkoutStatus : writeoffStatus).not.toBeNull();
        expect(checkoutWon ? writeoffStatus : checkoutStatus).toBeNull();

        const expectedWriteoffAuditId = writeoffPatch.audit_logs[0].id;
        const [pendingAfter, currentBills, pendingPayments, sessions, writeoffAudits, checkoutEvents, writeoffEvents, movements, stateAfter] = await Promise.all([
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "bills", {
            organization_id: `eq.${organizationId}`, id: `eq.${pendingBillId}`,
            select: "id,bill_number,status,total,amount_paid,amount_due,settled_at,voided_at,voided_by_user_id,void_reason,issued_by_user_id"
          }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "bills", {
            organization_id: `eq.${organizationId}`, id: `eq.${checkoutPatch.primary_bill.id}`,
            select: "id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id"
          }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "payments", {
            organization_id: `eq.${organizationId}`, bill_id: `eq.${pendingBillId}`,
            select: "id,bill_id,amount,mode,received_by_user_id,related_checkout_bill_id"
          }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "sessions", {
            organization_id: `eq.${organizationId}`, id: `eq.${secondSessionId}`,
            select: "id,status,close_disposition,closed_bill_id,customer_name"
          }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "audit_logs", {
            organization_id: `eq.${organizationId}`, id: `eq.${expectedWriteoffAuditId}`,
            select: "id,action,entity_type,entity_id,user_id,message"
          }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "operational_events", {
            organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${checkout.payload.mutation_id}`,
            select: "id,event_type,entity_type,entity_id,created_by,metadata"
          }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "operational_events", {
            organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${writeoff.payload.mutation_id}`,
            select: "id,event_type,entity_type,entity_id,created_by,metadata"
          }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "stock_movements", {
            organization_id: `eq.${organizationId}`, related_bill_id: `in.(${pendingBillId},${checkoutPatch.primary_bill.id})`, select: "id"
          }),
          readRestRows<{ version: number; data: unknown }>(page, restBase, restHeaders, "app_state", { id: "eq.primary", select: "version,data" })
        ]);
        expect(pendingAfter).toHaveLength(1);
        expect(sessions).toHaveLength(1);
        expect(movements).toEqual([]);
        expect({ version: stateAfter[0].version, hash: appStateHash(stateAfter[0].data) }).toEqual(compatibilityBefore);
        if (checkoutWon) {
          expect(pendingAfter[0]).toEqual(expect.objectContaining({ status: "issued", amount_due: 0 }));
          expect(Number(pendingAfter[0].amount_paid)).toBe(Number(pendingAfter[0].total));
          expect(currentBills).toHaveLength(1);
          expect(pendingPayments).toHaveLength(1);
          expect(pendingPayments[0].received_by_user_id).toBe(origin.actorId);
          expect(pendingPayments[0].related_checkout_bill_id).toBe(checkoutPatch.primary_bill.id);
          expect(sessions[0]).toEqual(expect.objectContaining({ status: "closed", close_disposition: "billed", closed_bill_id: checkoutPatch.primary_bill.id }));
          expect(writeoffAudits).toEqual([]);
          expect(checkoutEvents).toHaveLength(1);
          expect(checkoutEvents[0].created_by).toBe(origin.actorId);
          expect(writeoffEvents).toEqual([]);
        } else {
          expect(pendingAfter[0]).toEqual(expect.objectContaining({ status: "voided", amount_paid: 0, voided_by_user_id: adjustment.actorId, void_reason: reason }));
          expect(Number(pendingAfter[0].amount_due)).toBe(Number(pendingBefore[0].amount_due));
          expect(currentBills).toEqual([]);
          expect(pendingPayments).toEqual([]);
          expect(sessions[0]).toEqual(expect.objectContaining({ status: "active", close_disposition: null, closed_bill_id: null }));
          expect(writeoffAudits).toEqual([expect.objectContaining({ id: expectedWriteoffAuditId, action: "bill_voided_bad_debt", entity_id: pendingBillId, user_id: adjustment.actorId })]);
          expect(checkoutEvents).toEqual([]);
          expect(writeoffEvents).toHaveLength(1);
          expect(writeoffEvents[0].created_by).toBe(adjustment.actorId);
        }
        outcomeResolved = true;

        await Promise.all([checkoutCommand.dispose(), writeoffCommand.dispose()]);
        page.off("dialog", dismissDialog);
        observer.page.off("dialog", dismissDialog);
        const losingPage = checkoutWon ? observer.page : page;
        const winningPage = checkoutWon ? page : observer.page;
        const losingBody = checkoutWon ? writeoffBody : checkoutBody;
        expect(losingBody).toEqual(expect.objectContaining({ message: expect.any(String) }));
        const expectedLoserUiMessage = (losingBody as { message: string }).message;
        const losingError = losingPage.locator(".remote-error-banner").filter({ hasText: expectedLoserUiMessage });
        await waitForSynced(winningPage);
        await expect(losingError, "The losing financial command must surface its exact rejection in the UI.")
          .toHaveCount(1);
        await expect(losingError).toContainText(expectedLoserUiMessage);
        await expect(losingPage.getByText("1 conflict", { exact: true })).toHaveCount(0);
        const losingModal = checkoutWon ? writeoffDialog : checkoutDialog;
        await expect(losingModal).toBeVisible();
        await losingModal.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(losingModal).toBeHidden();
        if (!checkoutWon) {
          const managedSessionDialog = losingPage.getByRole("dialog", { name: station, exact: true });
          await expect(managedSessionDialog).toBeVisible();
          await managedSessionDialog.getByRole("button", { name: "Close", exact: true }).click();
          await expect(managedSessionDialog).toBeHidden();
        }
        await losingError.getByRole("button", { name: "Dismiss", exact: true }).click();
        await expect(losingError).toHaveCount(0);
        await waitForSynced(losingPage);

        await Promise.all([
          page.reload({ waitUntil: "domcontentloaded" }),
          observer.page.reload({ waitUntil: "domcontentloaded" })
        ]);
        await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
        await Promise.all([
          expect(page.getByText("1 conflict", { exact: true })).toHaveCount(0),
          expect(observer.page.getByText("1 conflict", { exact: true })).toHaveCount(0),
          expect(page.locator(".remote-error-banner")).toHaveCount(0),
          expect(observer.page.locator(".remote-error-banner")).toHaveCount(0)
        ]);

        let cleanup: Record<string, unknown> | null = null;
        if (writeoffWon) {
          const cleanupReason = `Playwright checkout-writeoff winner cleanup ${runId} ${scenario}`;
          const rejected = await rejectSessionIfOpen(page, station, customerName, cleanupReason);
          expect(rejected).toBe(true);
          const rejection = rpcEvidence.findLast((entry) => entry.rpc === "reject_session" && entry.status < 300 && entry.entityId === secondSessionId);
          expect(rejection?.mutationId).toBeTruthy();
          expect(rejection?.eventId).toBeTruthy();
          cleanup = { reason: cleanupReason, rejection };
          const cleanupAcknowledgedPath = persistCheckpoint(scenario, "cleanup-acknowledged", {
            ...evidence,
            raceDispatched: true,
            winner,
            responsesPath,
            responses,
            mutationResults: { checkout: checkoutStatus, writeoff: writeoffStatus },
            cleanup
          });
          cleanup = { ...cleanup, cleanupAcknowledgedPath };
        }

        await Promise.all([
          page.reload({ waitUntil: "domcontentloaded" }),
          observer.page.reload({ waitUntil: "domcontentloaded" })
        ]);
        await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
        await expect(stationCard(page, station)).toContainText("Available");
        await expect(stationCard(observer.page, station)).toContainText("Available");

        const [finalSession, finalState, openSessions, openTabs] = await Promise.all([
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "sessions", {
            organization_id: `eq.${organizationId}`, id: `eq.${secondSessionId}`, select: "id,status,close_disposition,closed_bill_id"
          }),
          readRestRows<{ version: number; data: unknown }>(page, restBase, restHeaders, "app_state", { id: "eq.primary", select: "version,data" }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "sessions", { organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,status" }),
          readRestRows<Record<string, unknown>>(page, restBase, restHeaders, "customer_tabs", { organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,status" })
        ]);
        expect(openSessions).toEqual([]);
        expect(openTabs).toEqual([]);
        const reconciled = {
          ...evidence,
          winner,
          responsesPath,
          responses,
          mutationResults: { checkout: checkoutStatus, writeoff: writeoffStatus },
          database: { pendingBill: pendingAfter[0], currentBills, pendingPayments, sessionBeforeCleanup: sessions[0], writeoffAudits, checkoutEvents, writeoffEvents, movements },
          cleanup,
          finalSession: finalSession[0],
          compatibilityAfterFinancial: { version: stateAfter[0].version, hash: appStateHash(stateAfter[0].data) },
          compatibilityFinal: { version: finalState[0].version, hash: appStateHash(finalState[0].data) },
          openFloor: { sessions: openSessions, tabs: openTabs }
        };
        reconciled.reconciledPath = persistCheckpoint(scenario, "reconciled", reconciled);
        evidence = reconciled;
        runEvidence.push(reconciled);
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(writeoffCommand.captureCount()).toBe(1);
        expect(checkoutCommand.wasSubmitted()).toBe(true);
        expect(writeoffCommand.wasSubmitted()).toBe(true);
        expect(originErrors).toEqual({ consoleErrors: [], pageErrors: [] });
        expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
      } catch (error) {
        evidence = { ...evidence, failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
        throw error;
      } finally {
        checkoutCommand?.cancel();
        writeoffCommand?.cancel();
        await Promise.all([checkoutCommand?.settled.catch(() => undefined), writeoffCommand?.settled.catch(() => undefined)]);
        await checkoutCommand?.dispose().catch(() => undefined);
        await writeoffCommand?.dispose().catch(() => undefined);
        page.off("dialog", dismissDialog);
        observer.page.off("dialog", dismissDialog);
        if (!raceDispatched && secondSessionId && !page.isClosed()) {
          try {
            await page.reload({ waitUntil: "domcontentloaded" });
            const clear = page.getByRole("button", { name: "Clear", exact: true });
            if (await clear.isVisible()) await clear.click();
            await waitForSynced(page);
            await rejectSessionIfOpen(page, station, customerName, `Pre-race checkout-writeoff cleanup ${runId} ${scenario}`);
          } catch (error) {
            cleanupError = error instanceof Error ? error.message : String(error);
          }
        } else if (raceDispatched && !outcomeResolved) {
          cleanupError = "Race outcome is ambiguous; exact read-only reconciliation is required before cleanup.";
        }
        await attachJson(testInfo, "release-b-checkout-writeoff-race-evidence", { ...evidence, cleanupError, rpcEvidence });
        await attachFailureScreenshot(testInfo, page, "checkout-writeoff-race-origin-failure");
        await attachFailureScreenshot(testInfo, observer.page, "checkout-writeoff-race-observer-failure");
        await observer.context.close();
      }
      expect(cleanupError).toBeUndefined();
    });
  }

  test.afterAll(async () => {
    expect(runEvidence).toHaveLength(selectedScenarioNames.length);
    const finalEvidence = {
      status: "completed",
      mode: "writeoff",
      runId,
      productionAllowed: false,
      selectedScenarios: selectedScenarioNames,
      scenarios: runEvidence,
      winners: runEvidence.map((entry) => ({ scenario: entry.scenario, winner: entry.winner }))
    };
    persistCheckpoint("final", "checkpoint", finalEvidence);
  });
});
