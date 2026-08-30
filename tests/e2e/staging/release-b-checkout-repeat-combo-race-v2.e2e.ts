import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import type { FinancialCheckoutV2RpcPayloadEnvelope } from "../../../src/dataGateway/financialRpcClient";
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
  stationCard,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_REPEAT_COMBO_STATION?.trim() || "missing-station";
const comboId = process.env.E2E_REPEAT_COMBO_ID?.trim() || "missing-combo";
const comboName = process.env.E2E_REPEAT_COMBO_NAME?.trim() || "missing-combo-name";
const choiceSelections = JSON.parse(process.env.E2E_REPEAT_COMBO_CHOICE_SELECTIONS || "[]") as Array<{
  groupId: string;
  label: string;
  optionId: string;
  optionName: string;
}>;
const preflightAppStateVersion = Number(process.env.E2E_REPEAT_COMBO_PREFLIGHT_VERSION);
const preflightAppStateHash = process.env.E2E_REPEAT_COMBO_PREFLIGHT_HASH ?? "missing-preflight-hash";
const organizationId = "org-primary";
const projectRef = "tkbdyzxwwbhkpztgjjxh";
let expectedCompatibility = { version: preflightAppStateVersion, hash: preflightAppStateHash };

type Scenario = "checkout_first" | "combo_first" | "simultaneous";
type TimingPoint = { iso: string; monotonicMs: number };

function timingPoint(): TimingPoint {
  return { iso: new Date().toISOString(), monotonicMs: performance.now() };
}

function elapsed(start: TimingPoint, end: TimingPoint) {
  return Number((end.monotonicMs - start.monotonicMs).toFixed(3));
}
type OperationalEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: "repeatSessionCombo";
    entity_id: string;
    user_id: string;
    payload: {
      sessionId: string;
      comboApplication: { id: string; comboId: string; comboName: string };
      items: Array<{ id: string; inventoryItemId?: string; comboApplicationId?: string }>;
      stockMovements: Array<{ id: string; itemId: string; quantity: number; userId: string }>;
      auditLog: { id: string; action: string; entityId: string; userId: string };
    };
  };
};
type CheckoutEnvelope = { payload: FinancialCheckoutV2RpcPayloadEnvelope };

function appStateHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function changedIds(result: RpcEvidence | Record<string, unknown> | undefined, collection: string) {
  const snakeRows = result && "changed_rows" in result && result.changed_rows && typeof result.changed_rows === "object"
    ? result.changed_rows as Record<string, unknown>
    : undefined;
  const camelRows = result && "changedRows" in result && result.changedRows && typeof result.changedRows === "object"
    ? result.changedRows as Record<string, unknown>
    : undefined;
  const values = camelRows?.[collection] ?? snakeRows?.[collection];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

function rpcHeaders(captured: CapturedRpcRequest) {
  return {
    apikey: captured.headers.apikey,
    authorization: captured.headers.authorization,
    "content-type": "application/json",
    prefer: captured.headers.prefer || "return=representation"
  };
}

function withUniqueBillNumber(captured: CapturedRpcRequest, scenario: Scenario) {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const billNumber = `BILL-QA-COMBO-RACE-${runId}-${scenario}`;
  const primaryBill = envelope.payload.payload.primary_bill as { id?: string; billNumber?: string };
  primaryBill.billNumber = billNumber;
  const primaryUpdate = envelope.payload.payload.bill_updates.find((bill) => bill.id === primaryBill.id);
  if (!primaryUpdate) throw new Error("Captured checkout omitted its primary bill update.");
  primaryUpdate.billNumber = billNumber;
  return envelope;
}

async function mutationStatus(page: Page, captured: CapturedRpcRequest, envelope: CheckoutEnvelope["payload"]) {
  const response = await page.request.post(
    captured.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
    {
      headers: rpcHeaders(captured),
      data: { payload: {
        organization_id: envelope.organization_id,
        mutation_id: envelope.mutation_id,
        mutation_kind: envelope.mutation_kind
      } }
    }
  );
  expect(response.status()).toBe(200);
  return await response.json() as Record<string, unknown> | null;
}

async function startSessionWithCombo(page: Page, customerName: string, onAcknowledged: (sessionId: string) => void) {
  const card = stationCard(page, station);
  await expect(card).toContainText("Available");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Start New Session", exact: true });
  await modal.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const comboSelect = modal.getByRole("combobox", { name: "Combo", exact: true });
  await expect(comboSelect).toBeVisible();
  const comboOption = comboSelect.locator("option").filter({ hasText: comboName });
  await expect(comboOption, "The rendered modal must contain exactly the reviewed combo option.").toHaveCount(1);
  expect(await comboOption.getAttribute("value")).toBe(comboId);
  const comboOptionLabel = (await comboOption.textContent())?.trim();
  expect(comboOptionLabel).toBeTruthy();
  await comboSelect.selectOption({ label: comboOptionLabel! });
  await expect(comboSelect).toHaveValue(comboId);
  const requiredChoices = modal.locator("select[required]");
  expect(await requiredChoices.count()).toBe(choiceSelections.length);
  for (const selection of choiceSelections) {
    const choiceSelect = modal.getByRole("combobox", { name: selection.label, exact: true });
    await expect(choiceSelect).toBeVisible();
    const choiceOption = choiceSelect.locator("option").filter({ hasText: selection.optionName });
    await expect(choiceOption, `The rendered ${selection.label} options must contain exactly the reviewed choice.`).toHaveCount(1);
    expect(await choiceOption.getAttribute("value")).toBe(selection.optionId);
    const choiceOptionLabel = (await choiceOption.textContent())?.trim();
    expect(choiceOptionLabel).toBeTruthy();
    await choiceSelect.selectOption({ label: choiceOptionLabel! });
    await expect(choiceSelect).toHaveValue(selection.optionId);
  }
  const playMode = modal.getByLabel("Play Mode", { exact: true });
  if (await playMode.count()) await playMode.selectOption("group");
  const acknowledged = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/rest/v1/rpc/start_session")
  );
  await modal.getByRole("button", { name: "Start Session", exact: true }).click();
  const response = await acknowledged;
  const body = await response.json() as Record<string, unknown>;
  expect(response.status()).toBe(200);
  expect(typeof body.entity_id).toBe("string");
  onAcknowledged(String(body.entity_id));
  await expect(modal).toBeHidden();
  await waitForSynced(page);
  await expect(card).toContainText(customerName);
}

async function persistEvidence(scenario: Scenario, evidence: Record<string, unknown>) {
  const directory = path.join(process.cwd(), "test-artifacts", "reconciliation");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `checkout-repeat-combo-race-${runId}-${scenario}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  );
}

async function persistEvidenceCheckpoint(
  scenario: Scenario,
  phase: "prepared" | "responses",
  evidence: Record<string, unknown>
) {
  const directory = path.join(process.cwd(), "test-artifacts", "reconciliation");
  await mkdir(directory, { recursive: true });
  const artifactPath = path.join(directory, `checkout-repeat-combo-race-${runId}-${scenario}-${phase}.json`);
  const temporaryPath = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ ...evidence, checkpoint: phase }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporaryPath, artifactPath);
}

async function captureWithin<T>(captured: Promise<T>, label: string, timeoutMs = 10_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      captured,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} was not captured within ${timeoutMs} ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const scenarios: Array<{ scenario: Scenario; expectedWinner?: "checkout" | "combo" }> = [
  { scenario: "checkout_first", expectedWinner: "checkout" },
  { scenario: "combo_first", expectedWinner: "combo" },
  { scenario: "simultaneous" }
];

test.describe.serial("Release B checkout versus repeat-session-combo concurrency", () => {
  for (const { scenario, expectedWinner } of scenarios) {
    test(`${scenario} commits exactly one compatible session transition`, async ({ browser, page }, testInfo) => {
      const observer = await createObserver(browser);
      const rpcEvidence: RpcEvidence[] = [];
      const originRequests: CapturedRpcRequest[] = [];
      const observerRequests: CapturedRpcRequest[] = [];
      captureAuthenticatedRestRequests(page, originRequests);
      captureAuthenticatedRestRequests(observer.page, observerRequests);
      captureRpcEvidence(page, "origin", rpcEvidence);
      captureRpcEvidence(observer.page, "observer", rpcEvidence);
      const originErrors = capturePageErrors(page);
      const observerErrors = capturePageErrors(observer.page);
      const customerName = `QA Combo Race ${runId} ${scenario}`;
      let sessionId: string | undefined;
      let sessionStarted = false;
      let raceStarted = false;
      let outcomeResolved = false;
      let checkoutSubmitted = false;
      let comboSubmitted = false;
      let checkoutSubmissionCount = 0;
      let comboSubmissionCount = 0;
      let checkoutCaptureCount = 0;
      let comboCaptureCount = 0;
      let raceWinner: "checkout" | "combo" | undefined;
      let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      let comboCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
      let cleanupRest: { restBase: string; headers: Record<string, string> } | undefined;
      let cleanupActorId: string | undefined;
      let evidence: Record<string, unknown> = {
        runId,
        scenario,
        projectRef,
        productionAllowed: false,
        safeForAutomaticRetry: false,
        customerName,
        station,
        comboId
      };
      let cleanupError: string | undefined;
      const dismissDialog = (dialog: { dismiss(): Promise<void> }) => void dialog.dismiss();

      try {
        await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
        const [originIdentity, observerIdentity] = await Promise.all([
          assertAuthoritativeOrganizationIdentity(page, originRequests, "admin", organizationId),
          assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", organizationId)
        ]);
        cleanupRest = { restBase: originIdentity.restBase, headers: originIdentity.headers };
        cleanupActorId = originIdentity.actorId;
        await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
        await startSessionWithCombo(page, customerName, (acknowledgedSessionId) => {
          sessionId = acknowledgedSessionId;
          sessionStarted = true;
          evidence = { ...evidence, sessionId, setupAcknowledged: true };
        });
        await expect.poll(() => rpcEvidence.find((entry) => entry.rpc === "start_session" && entry.status < 300)?.entityId).toBeTruthy();
        const setupResult = rpcEvidence.find((entry) => entry.rpc === "start_session" && entry.status < 300)!;
        expect(setupResult.entityId).toBe(sessionId);
        const setupStockMovementIds = changedIds(setupResult, "stock_movements");
        expect(setupStockMovementIds.length).toBeGreaterThan(0);

        const managed = await openManagedSession(page, station);
        await managed.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        await managed.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
        await managed.getByRole("button", { name: "Save Session Details", exact: true }).click();
        await waitForSynced(page);
        await observer.page.reload({ waitUntil: "domcontentloaded" });
        await waitForSynced(observer.page);

        const originRest = originIdentity.restBase;
        const restHeaders = originIdentity.headers;
        const [beforeSessions, initialCombos, initialItems, initialReservationMovements] = await Promise.all([
          readRestRows<{ id: string; status: string; started_at: string; raw_data: Record<string, unknown> }>(page, originRest, restHeaders, "sessions", {
            organization_id: `eq.${organizationId}`, id: `eq.${sessionId}`, select: "id,status,started_at,raw_data"
          }),
          readRestRows<{ id: string; combo_id: string; raw_data: Record<string, unknown> }>(page, originRest, restHeaders, "session_combo_applications", {
            organization_id: `eq.${organizationId}`, session_id: `eq.${sessionId}`, select: "id,combo_id,raw_data"
          }),
          readRestRows<{ id: string; inventory_item_id: string | null; combo_application_id: string | null; quantity: number; stock_units_per_sale: number | null }>(page, originRest, restHeaders, "session_items", {
            organization_id: `eq.${organizationId}`, session_id: `eq.${sessionId}`, select: "id,inventory_item_id,combo_application_id,quantity,stock_units_per_sale"
          }),
          readRestRows<{ id: string; item_id: string; type: string; quantity: number; user_id: string }>(page, originRest, restHeaders, "stock_movements", {
            organization_id: `eq.${organizationId}`, id: `in.(${setupStockMovementIds.join(",")})`, select: "id,item_id,type,quantity,user_id"
          })
        ]);
        expect(beforeSessions).toHaveLength(1);
        expect(beforeSessions[0].status).toBe("active");
        expect(initialCombos).toHaveLength(1);
        expect(initialCombos[0].combo_id).toBe(comboId);
        expect(initialItems.length).toBeGreaterThan(0);
        expect(initialItems.every((item) => item.combo_application_id === initialCombos[0].id)).toBe(true);
        expect(new Set(initialReservationMovements.map((movement) => movement.id))).toEqual(new Set(setupStockMovementIds));
        expect(initialReservationMovements.every((movement) => movement.type === "session_reservation" && Number(movement.quantity) < 0 && movement.user_id === originIdentity.actorId)).toBe(true);

        const inventoryIds = [...new Set(initialItems.map((item) => item.inventory_item_id).filter((value): value is string => Boolean(value)))].sort();
        const [inventoryBefore, appStateBefore] = await Promise.all([
          readRestRows<{ id: string; stock_qty: number }>(page, originRest, restHeaders, "inventory_items", {
            organization_id: `eq.${organizationId}`, id: `in.(${inventoryIds.join(",")})`, select: "id,stock_qty"
          }),
          readRestRows<{ version: number; data: unknown }>(page, originRest, restHeaders, "app_state", { id: "eq.primary", select: "version,data" })
        ]);
        expect(appStateBefore).toHaveLength(1);
        const versionBefore = appStateBefore[0].version;
        const hashBefore = appStateHash(appStateBefore[0].data);
        expect({ version: versionBefore, hash: hashBefore }).toEqual(expectedCompatibility);

        const observerManaged = await openManagedSession(observer.page, station);
        comboCommand = await interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/repeat_session_combo");
        let resolveRepeatDialog!: (message: string) => void;
        const repeatDialog = new Promise<string>((resolve) => { resolveRepeatDialog = resolve; });
        const captureRepeatDialog = (dialog: { message(): string; dismiss(): Promise<void> }) => {
          resolveRepeatDialog(dialog.message());
          void dialog.dismiss();
        };
        observer.page.once("dialog", captureRepeatDialog);
        await observerManaged.getByRole("button", { name: "Repeat Combo", exact: true }).click();
        let capturedCombo: CapturedRpcRequest;
        try {
          capturedCombo = await Promise.race([
            captureWithin(comboCommand.captured, "repeat_session_combo"),
            repeatDialog.then((message) => {
              throw new Error(`Repeat Combo was rejected by the UI before RPC dispatch: ${message}`);
            })
          ]);
        } finally {
          observer.page.off("dialog", captureRepeatDialog);
        }
        comboCaptureCount = comboCommand.captureCount();
        expect(comboCaptureCount).toBe(1);

        await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
        const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
        checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
        page.on("dialog", dismissDialog);
        observer.page.on("dialog", dismissDialog);
        await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();

        const capturedCheckout = await captureWithin(checkoutCommand.captured, "commit_checkout_bill_v2");
        checkoutCaptureCount = checkoutCommand.captureCount();
        expect(checkoutCaptureCount).toBe(1);
        const checkoutEnvelope = withUniqueBillNumber(capturedCheckout, scenario);
        const comboEnvelope = structuredClone(capturedCombo.body) as OperationalEnvelope;
        const primaryBill = checkoutEnvelope.payload.payload.primary_bill as {
          id: string;
          billNumber: string;
          total: number;
          amountPaid: number;
          amountDue: number;
          lines?: Array<Record<string, unknown>>;
        };
        const expectedBillLines = primaryBill.lines ?? [];
        const expectedPayments = checkoutEnvelope.payload.payload.payments;
        const expectedCheckoutAudits = checkoutEnvelope.payload.payload.audit_logs;
        const expectedSaleMovements = checkoutEnvelope.payload.payload.stock_movements;
        expect(checkoutEnvelope.payload.organization_id).toBe(organizationId);
        expect(checkoutEnvelope.payload.entity_id).toBe(sessionId);
        expect(checkoutEnvelope.payload.payload.source_session_ids).toEqual([sessionId]);
        expect(Number(primaryBill.total)).toBeGreaterThan(0);
        expect(Number(primaryBill.amountPaid)).toBe(Number(primaryBill.total));
        expect(Number(primaryBill.amountDue)).toBe(0);
        expect(expectedBillLines.length).toBeGreaterThan(0);
        expect(expectedPayments).toHaveLength(1);
        expect(Number(expectedPayments[0].amount)).toBe(Number(primaryBill.total));
        expect(expectedCheckoutAudits.length).toBeGreaterThan(0);
        expect(expectedSaleMovements.length).toBeGreaterThan(0);
        expect(expectedSaleMovements.every((movement) => Number(movement.quantity) < 0)).toBe(true);
        expect(comboEnvelope.payload.organization_id).toBe(organizationId);
        expect(comboEnvelope.payload.mutation_kind).toBe("repeatSessionCombo");
        expect(comboEnvelope.payload.entity_id).toBe(sessionId);
        expect(comboEnvelope.payload.payload.sessionId).toBe(sessionId);
        expect(comboEnvelope.payload.payload.comboApplication.comboId).toBe(comboId);
        expect(comboEnvelope.payload.payload.items.length).toBe(initialItems.length);
        expect(comboEnvelope.payload.payload.items.every((item) => item.comboApplicationId === comboEnvelope.payload.payload.comboApplication.id)).toBe(true);
        expect(authenticatedJwtSubject(capturedCheckout.headers)).toBe(originIdentity.actorId);
        expect(authenticatedJwtSubject(capturedCombo.headers)).toBe(observerIdentity.actorId);
        expect(comboEnvelope.payload.user_id).toBe(observerIdentity.actorId);

        expect(new Set(comboEnvelope.payload.payload.items.map((item) => item.inventoryItemId).filter(Boolean))).toEqual(new Set(inventoryIds));
        evidence = {
          ...evidence,
          actors: { checkout: originIdentity.actorId, combo: observerIdentity.actorId },
          sessionId,
          initialComboApplicationIds: initialCombos.map((row) => row.id),
          initialItemIds: initialItems.map((row) => row.id).sort(),
          setupStockMovementIds,
          initialReservationMovements,
          checkoutMutationId: checkoutEnvelope.payload.mutation_id,
          comboMutationId: comboEnvelope.payload.mutation_id,
          candidateBillId: primaryBill.id,
          candidateBillNumber: primaryBill.billNumber,
          repeatedComboApplicationId: comboEnvelope.payload.payload.comboApplication.id,
          repeatedItemIds: comboEnvelope.payload.payload.items.map((item) => item.id).sort(),
          repeatedStockMovementIds: comboEnvelope.payload.payload.stockMovements.map((movement) => movement.id).sort(),
          repeatedAuditId: comboEnvelope.payload.payload.auditLog.id,
          expectedOperational: {
            comboApplication: comboEnvelope.payload.payload.comboApplication,
            items: comboEnvelope.payload.payload.items,
            stockMovements: comboEnvelope.payload.payload.stockMovements,
            auditLog: comboEnvelope.payload.payload.auditLog
          },
          expectedFinancial: {
            bill: primaryBill,
            payments: expectedPayments,
            audits: expectedCheckoutAudits,
            stockMovements: expectedSaleMovements,
            lineIds: expectedBillLines.map((line) => String(line.id)).sort(),
            paymentIds: expectedPayments.map((payment) => String(payment.id)).sort(),
            auditIds: expectedCheckoutAudits.map((audit) => String(audit.id)).sort(),
            stockMovementIds: expectedSaleMovements.map((movement) => String(movement.id)).sort()
          },
          inventoryBefore,
          appStateBefore: { version: versionBefore, hash: hashBefore },
          captureCounts: { checkout: checkoutCaptureCount, combo: comboCaptureCount }
        };

        const preparedEvidence = {
          ...evidence,
          lifecycle: {
            sessionStarted,
            raceStarted: true,
            outcomeResolved,
            checkoutSubmitted,
            comboSubmitted,
            checkoutSubmissionCount,
            comboSubmissionCount,
            checkoutCaptureCount,
            comboCaptureCount
          },
          submissionPlan: {
            order: scenario,
            checkoutEnvelope,
            comboEnvelope
          }
        };
        await persistEvidenceCheckpoint(scenario, "prepared", preparedEvidence);
        evidence = preparedEvidence;
        raceStarted = true;
        const submission = timingPoint();
        let checkoutResponse: APIResponse;
        let comboResponse: APIResponse;
        if (scenario === "checkout_first") {
          checkoutSubmitted = true;
          checkoutSubmissionCount += 1;
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
          comboSubmitted = true;
          comboSubmissionCount += 1;
          comboResponse = await comboCommand.submit(comboEnvelope);
        } else if (scenario === "combo_first") {
          comboSubmitted = true;
          comboSubmissionCount += 1;
          comboResponse = await comboCommand.submit(comboEnvelope);
          checkoutSubmitted = true;
          checkoutSubmissionCount += 1;
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
        } else {
          checkoutSubmitted = true;
          comboSubmitted = true;
          checkoutSubmissionCount += 1;
          comboSubmissionCount += 1;
          [checkoutResponse, comboResponse] = await Promise.all([
            checkoutCommand.submit(checkoutEnvelope),
            comboCommand.submit(comboEnvelope)
          ]);
        }
        const [checkoutBody, comboBody] = await Promise.all([
          readApiResponseBody(checkoutResponse),
          readApiResponseBody(comboResponse)
        ]);
        const responseReceived = timingPoint();
        const responseEvidence = {
          ...evidence,
          lifecycle: {
            sessionStarted,
            raceStarted,
            outcomeResolved,
            checkoutSubmitted,
            comboSubmitted,
            checkoutSubmissionCount,
            comboSubmissionCount,
            checkoutCaptureCount,
            comboCaptureCount
          },
          responses: {
            checkout: { status: checkoutResponse.status(), body: checkoutBody },
            combo: { status: comboResponse.status(), body: comboBody }
          },
          timings: {
            submission,
            response: responseReceived,
            responseMs: elapsed(submission, responseReceived)
          }
        };
        await persistEvidenceCheckpoint(scenario, "responses", responseEvidence);
        evidence = responseEvidence;
        const checkoutWon = checkoutResponse.status() === 200;
        const comboWon = comboResponse.status() === 200;
        expect(Number(checkoutWon) + Number(comboWon)).toBe(1);
        raceWinner = checkoutWon ? "checkout" : "combo";
        if (expectedWinner) expect(raceWinner).toBe(expectedWinner);
        expect(checkoutWon ? comboResponse.status() : checkoutResponse.status()).toBe(400);
        expect(checkoutWon ? rpcRejectionCode(comboBody) : rpcRejectionCode(checkoutBody)).toBe(
          checkoutWon ? "session_not_open" : "source_item_mismatch"
        );
        const expectedLoserUiMessage = checkoutWon
          ? "Repeating combo: The session is no longer open."
          : "Bill inventory rows do not match the locked session or tab items.";
        const loserPage = checkoutWon ? observer.page : page;
        const loserError = loserPage.locator(".remote-error-banner").filter({ hasText: expectedLoserUiMessage });
        await expect(loserError, "The losing command must surface its exact conflict message in the UI.")
          .toHaveCount(1);
        await expect(loserError).toContainText(expectedLoserUiMessage);
        const uiTerminal = timingPoint();
        const raceTimings = {
          submission,
          response: responseReceived,
          uiTerminal,
          responseMs: elapsed(submission, responseReceived),
          browserCompletionMs: elapsed(submission, uiTerminal)
        };
        expect(raceTimings.responseMs).toBeGreaterThanOrEqual(0);
        expect(raceTimings.browserCompletionMs).toBeGreaterThanOrEqual(raceTimings.responseMs);
        expect(raceTimings.browserCompletionMs).toBeLessThan(7_000);

        const checkoutStatus = await mutationStatus(page, capturedCheckout, checkoutEnvelope.payload);
        expect(checkoutWon ? checkoutStatus : null).toEqual(checkoutWon ? checkoutBody : null);
        if (!checkoutWon) expect(checkoutStatus).toBeNull();
        const [
          sessionAfterRace, combosAfterRace, itemsAfterRace, candidateBills, persistedBillLines,
          persistedPayments, checkoutAudits, checkoutMovements, checkoutEvents, comboEvents,
          repeatedAudits, repeatedMovements, inventoryAfterRace, appStateAfterRace
        ] = await Promise.all([
          readRestRows<{ id: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(page, originRest, restHeaders, "sessions", {
            organization_id: `eq.${organizationId}`, id: `eq.${sessionId}`, select: "id,status,close_disposition,closed_bill_id"
          }),
          readRestRows<{ id: string; combo_id: string }>(page, originRest, restHeaders, "session_combo_applications", {
            organization_id: `eq.${organizationId}`, session_id: `eq.${sessionId}`, select: "id,combo_id"
          }),
          readRestRows<{ id: string; combo_application_id: string | null; inventory_item_id: string | null }>(page, originRest, restHeaders, "session_items", {
            organization_id: `eq.${organizationId}`, session_id: `eq.${sessionId}`, select: "id,combo_application_id,inventory_item_id"
          }),
          readRestRows<{ id: string; bill_number: string; status: string; total: number; amount_paid: number; amount_due: number; issued_by_user_id: string }>(page, originRest, restHeaders, "bills", {
            organization_id: `eq.${organizationId}`, id: `eq.${primaryBill.id}`, select: "id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id"
          }),
          readRestRows<{ id: string; bill_id: string; type: string; linked_session_id: string | null; inventory_item_id: string | null; quantity: number; unit_price: number; total: number; raw_data: Record<string, unknown> }>(page, originRest, restHeaders, "bill_lines", {
            organization_id: `eq.${organizationId}`, bill_id: `eq.${primaryBill.id}`, select: "id,bill_id,type,linked_session_id,inventory_item_id,quantity,unit_price,total,raw_data"
          }),
          readRestRows<{ id: string; bill_id: string; amount: number; mode: string; received_by_user_id: string }>(page, originRest, restHeaders, "payments", {
            organization_id: `eq.${organizationId}`, bill_id: `eq.${primaryBill.id}`, select: "id,bill_id,amount,mode,received_by_user_id"
          }),
          readRestRows<{ id: string; action: string; entity_id: string; user_id: string }>(page, originRest, restHeaders, "audit_logs", {
            organization_id: `eq.${organizationId}`, id: `in.(${expectedCheckoutAudits.map((audit) => audit.id).join(",")})`, select: "id,action,entity_id,user_id"
          }),
          readRestRows<{ id: string; item_id: string; type: string; quantity: number; user_id: string; related_bill_id: string | null }>(page, originRest, restHeaders, "stock_movements", {
            organization_id: `eq.${organizationId}`, id: `in.(${expectedSaleMovements.map((movement) => movement.id).join(",")})`, select: "id,item_id,type,quantity,user_id,related_bill_id"
          }),
          readRestRows<{ id: string; event_type: string; entity_id: string; created_by: string; metadata: Record<string, unknown> }>(page, originRest, restHeaders, "operational_events", {
            organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${checkoutEnvelope.payload.mutation_id}`, select: "id,event_type,entity_id,created_by,metadata"
          }),
          readRestRows<{ id: string; event_type: string; entity_id: string; created_by: string; metadata: Record<string, unknown> }>(page, originRest, restHeaders, "operational_events", {
            organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${comboEnvelope.payload.mutation_id}`, select: "id,event_type,entity_id,created_by,metadata"
          }),
          readRestRows<{ id: string; action: string; user_id: string }>(page, originRest, restHeaders, "audit_logs", {
            organization_id: `eq.${organizationId}`, id: `eq.${comboEnvelope.payload.payload.auditLog.id}`, select: "id,action,user_id"
          }),
          readRestRows<{ id: string; item_id: string; type: string; quantity: number; user_id: string; related_bill_id: string | null }>(page, originRest, restHeaders, "stock_movements", {
            organization_id: `eq.${organizationId}`, id: `in.(${comboEnvelope.payload.payload.stockMovements.map((movement) => movement.id).join(",")})`, select: "id,item_id,type,quantity,user_id,related_bill_id"
          }),
          readRestRows<{ id: string; stock_qty: number }>(page, originRest, restHeaders, "inventory_items", {
            organization_id: `eq.${organizationId}`, id: `in.(${inventoryIds.join(",")})`, select: "id,stock_qty"
          }),
          readRestRows<{ version: number; data: unknown }>(page, originRest, restHeaders, "app_state", { id: "eq.primary", select: "version,data" })
        ]);
        expect(sessionAfterRace).toHaveLength(1);
        expect(appStateAfterRace[0].version).toBe(versionBefore);
        expect(appStateHash(appStateAfterRace[0].data)).toBe(hashBefore);
        if (checkoutWon) {
          expect(sessionAfterRace[0]).toEqual(expect.objectContaining({ status: "closed", close_disposition: "billed", closed_bill_id: primaryBill.id }));
          expect(candidateBills).toHaveLength(1);
          expect(candidateBills[0].bill_number).toBe(primaryBill.billNumber);
          expect(candidateBills[0].status).toBe("issued");
          expect(Number(candidateBills[0].total)).toBe(Number(primaryBill.total));
          expect(Number(candidateBills[0].amount_paid)).toBe(Number(primaryBill.total));
          expect(Number(candidateBills[0].amount_due)).toBe(0);
          expect(candidateBills[0].issued_by_user_id).toBe(originIdentity.actorId);
          const changedRows = checkoutStatus!.changed_rows as Record<string, string[]>;
          expect(new Set(changedRows.bills)).toEqual(new Set([primaryBill.id]));
          expect(new Set(changedRows.payments)).toEqual(new Set(expectedPayments.map((payment) => String(payment.id))));
          expect(new Set(changedRows.audit_logs)).toEqual(new Set(expectedCheckoutAudits.map((audit) => String(audit.id))));
          expect(new Set(changedRows.stock_movements)).toEqual(new Set(expectedSaleMovements.map((movement) => String(movement.id))));
          expect(new Set(persistedBillLines.map((line) => line.id))).toEqual(new Set(expectedBillLines.map((line) => String(line.id))));
          expect(persistedBillLines.every((line) => line.bill_id === primaryBill.id && line.linked_session_id === sessionId)).toBe(true);
          for (const expectedLine of expectedBillLines) {
            const actual = persistedBillLines.find((line) => line.id === expectedLine.id);
            expect(actual).toBeTruthy();
            expect(actual).toEqual(expect.objectContaining({
              type: expectedLine.type,
              inventory_item_id: expectedLine.inventoryItemId ?? null,
              quantity: Number(expectedLine.quantity),
              unit_price: Number(expectedLine.unitPrice),
              total: Number(expectedLine.total)
            }));
            expect(actual!.raw_data?.linkedSessionItemId ?? null).toBe(expectedLine.linkedSessionItemId ?? null);
          }
          expect(persistedPayments).toHaveLength(1);
          expect(persistedPayments[0]).toEqual(expect.objectContaining({
            id: String(expectedPayments[0].id),
            bill_id: primaryBill.id,
            amount: Number(expectedPayments[0].amount),
            mode: expectedPayments[0].mode,
            received_by_user_id: originIdentity.actorId
          }));
          expect(new Set(checkoutAudits.map((audit) => audit.id))).toEqual(new Set(expectedCheckoutAudits.map((audit) => String(audit.id))));
          expect(checkoutAudits.every((audit) => audit.user_id === originIdentity.actorId)).toBe(true);
          expectedCheckoutAudits.forEach((audit) => expect(checkoutAudits).toContainEqual(expect.objectContaining({ id: audit.id, action: audit.action, entity_id: audit.entityId })));
          expect(new Set(checkoutMovements.map((movement) => movement.id))).toEqual(new Set(expectedSaleMovements.map((movement) => String(movement.id))));
          expect(checkoutMovements.every((movement) => movement.type === "sale" && Number(movement.quantity) < 0 && movement.user_id === originIdentity.actorId && movement.related_bill_id === primaryBill.id)).toBe(true);
          expectedSaleMovements.forEach((movement) => expect(checkoutMovements).toContainEqual(expect.objectContaining({
            id: movement.id,
            item_id: movement.itemId,
            quantity: Number(movement.quantity)
          })));
          expect(checkoutEvents).toHaveLength(1);
          expect(checkoutEvents[0]).toEqual(expect.objectContaining({
            id: checkoutStatus!.event_id,
            event_type: "financial_checkout_committed_v2",
            entity_id: sessionId,
            created_by: originIdentity.actorId
          }));
          expect(changedIds(checkoutStatus!, "operational_events")).toEqual([]);
          expect(comboEvents).toEqual([]);
          expect(repeatedAudits).toEqual([]);
          expect(repeatedMovements).toEqual([]);
          expect(combosAfterRace.map((row) => row.id).sort()).toEqual(initialCombos.map((row) => row.id).sort());
          expect(itemsAfterRace.map((row) => row.id).sort()).toEqual(initialItems.map((row) => row.id).sort());
          const inventoryBeforeById = new Map(inventoryBefore.map((row) => [row.id, Number(row.stock_qty)]));
          const saleDeltaByItem = new Map<string, number>();
          checkoutMovements.forEach((movement) => saleDeltaByItem.set(movement.item_id, (saleDeltaByItem.get(movement.item_id) ?? 0) + Number(movement.quantity)));
          inventoryAfterRace.forEach((row) => expect(Number(row.stock_qty)).toBe(inventoryBeforeById.get(row.id)! + (saleDeltaByItem.get(row.id) ?? 0)));
          expect([...saleDeltaByItem.values()].some((quantity) => quantity < 0)).toBe(true);
        } else {
          expect(sessionAfterRace[0]).toEqual(expect.objectContaining({ status: "active", close_disposition: null, closed_bill_id: null }));
          expect(candidateBills).toEqual([]);
          expect(persistedBillLines).toEqual([]);
          expect(persistedPayments).toEqual([]);
          expect(checkoutAudits).toEqual([]);
          expect(checkoutMovements).toEqual([]);
          expect(checkoutEvents).toEqual([]);
          expect(comboEvents).toHaveLength(1);
          expect(comboEvents[0]).toEqual(expect.objectContaining({
            id: comboBody.event_id,
            event_type: "repeat_session_combo",
            entity_id: sessionId,
            created_by: observerIdentity.actorId
          }));
          expect(new Set(changedIds(comboBody, "sessions"))).toEqual(new Set([sessionId]));
          expect(new Set(changedIds(comboBody, "session_combo_applications"))).toEqual(new Set([comboEnvelope.payload.payload.comboApplication.id]));
          expect(new Set(changedIds(comboBody, "session_items"))).toEqual(new Set(comboEnvelope.payload.payload.items.map((item) => item.id)));
          expect(new Set(changedIds(comboBody, "stock_movements"))).toEqual(new Set(comboEnvelope.payload.payload.stockMovements.map((movement) => movement.id)));
          expect(new Set(changedIds(comboBody, "audit_logs"))).toEqual(new Set([comboEnvelope.payload.payload.auditLog.id]));
          expect(new Set(changedIds(comboBody, "operational_events"))).toEqual(new Set([String(comboBody.event_id)]));
          expect(repeatedAudits).toEqual([{ id: comboEnvelope.payload.payload.auditLog.id, action: "combo_repeated", user_id: observerIdentity.actorId }]);
          expect(new Set(repeatedMovements.map((movement) => movement.id))).toEqual(new Set(comboEnvelope.payload.payload.stockMovements.map((movement) => movement.id)));
          expect(repeatedMovements.every((movement) => movement.type === "session_reservation" && Number(movement.quantity) < 0 && movement.user_id === observerIdentity.actorId && movement.related_bill_id === null)).toBe(true);
          expect(combosAfterRace.map((row) => row.id)).toContain(comboEnvelope.payload.payload.comboApplication.id);
          expect(new Set(itemsAfterRace.map((row) => row.id))).toEqual(new Set([...initialItems.map((row) => row.id), ...comboEnvelope.payload.payload.items.map((item) => item.id)]));
          expect(
            [...inventoryAfterRace].sort((left, right) => left.id.localeCompare(right.id))
          ).toEqual([...inventoryBefore].sort((left, right) => left.id.localeCompare(right.id)));
        }
        outcomeResolved = true;
        evidence = {
          ...evidence,
          winner: raceWinner,
          loserUiMessage: expectedLoserUiMessage,
          responses: responseEvidence.responses,
          timings: raceTimings,
          checkoutMutationStatus: checkoutStatus,
          afterRace: {
            session: sessionAfterRace[0], combos: combosAfterRace, items: itemsAfterRace,
            candidateBills, persistedBillLines, persistedPayments, checkoutAudits, checkoutMovements,
            checkoutEvents, comboEvents, repeatedAudits, repeatedMovements, inventory: inventoryAfterRace,
            appState: { version: appStateAfterRace[0].version, hash: appStateHash(appStateAfterRace[0].data) }
          }
        };
        await persistEvidence(scenario, evidence);

        await Promise.all([checkoutCommand.dispose(), comboCommand.dispose()]);
        checkoutCommand = undefined;
        comboCommand = undefined;
        page.off("dialog", dismissDialog);
        observer.page.off("dialog", dismissDialog);

        if (comboWon) {
          await page.reload({ waitUntil: "domcontentloaded" });
          await waitForSynced(page);
          const cleanupReason = `Playwright combo-race cleanup ${runId} ${scenario}`;
          expect(await rejectSessionIfOpen(page, station, customerName, cleanupReason)).toBe(true);
          const cleanup = rpcEvidence.findLast((entry) => entry.rpc === "reject_session" && entry.status < 300);
          expect(cleanup?.entityId).toBe(sessionId);
          expect(cleanup?.mutationId).toBeTruthy();
          expect(cleanup?.eventId).toBeTruthy();
          const cleanupAuditIds = changedIds(cleanup, "audit_logs");
          const cleanupMovementIds = changedIds(cleanup, "stock_movements");
          expect(cleanupAuditIds).toHaveLength(1);
          expect(cleanupMovementIds).toEqual([]);
          const [cleanedSession, cleanupEvents, cleanupAudits, inventoryAfterCleanup, appStateAfterCleanup] = await Promise.all([
            readRestRows<{ id: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(page, originRest, restHeaders, "sessions", {
              organization_id: `eq.${organizationId}`, id: `eq.${sessionId}`, select: "id,status,close_disposition,closed_bill_id"
            }),
            readRestRows<{ id: string; event_type: string; created_by: string; metadata: Record<string, unknown> }>(page, originRest, restHeaders, "operational_events", {
              organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${cleanup?.mutationId}`, select: "id,event_type,created_by,metadata"
            }),
            readRestRows<{ id: string; action: string; entity_id: string; user_id: string; message: string }>(page, originRest, restHeaders, "audit_logs", {
              organization_id: `eq.${organizationId}`, id: `in.(${cleanupAuditIds.join(",")})`, select: "id,action,entity_id,user_id,message"
            }),
            readRestRows<{ id: string; stock_qty: number }>(page, originRest, restHeaders, "inventory_items", {
              organization_id: `eq.${organizationId}`, id: `in.(${inventoryIds.join(",")})`, select: "id,stock_qty"
            }),
            readRestRows<{ version: number; data: unknown }>(page, originRest, restHeaders, "app_state", { id: "eq.primary", select: "version,data" })
          ]);
          expect(cleanedSession).toEqual([{ id: sessionId, status: "closed", close_disposition: "rejected", closed_bill_id: null }]);
          expect(cleanupEvents).toHaveLength(1);
          expect(cleanupEvents[0].event_type).toBe("reject_session");
          expect(cleanupEvents[0].id).toBe(cleanup!.eventId);
          expect(cleanupEvents[0].created_by).toBe(originIdentity.actorId);
          expect(cleanupAudits).toEqual([expect.objectContaining({
            id: cleanupAuditIds[0], action: "session_rejected", entity_id: sessionId, user_id: originIdentity.actorId
          })]);
          expect([...inventoryAfterCleanup].sort((left, right) => left.id.localeCompare(right.id))).toEqual(
            [...inventoryBefore].sort((left, right) => left.id.localeCompare(right.id))
          );
          expect(appStateAfterCleanup[0].version).toBe(versionBefore + 1);
          evidence = {
            ...evidence,
            cleanup: {
              reason: cleanupReason,
              result: cleanup,
              event: cleanupEvents[0],
              audit: cleanupAudits[0],
              movements: [],
              availabilityReleasedByClosedSession: true,
              session: cleanedSession[0]
            },
            appStateAfterCleanup: {
              version: appStateAfterCleanup[0].version,
              hash: appStateHash(appStateAfterCleanup[0].data)
            }
          };
          await persistEvidence(scenario, evidence);
          expectedCompatibility = {
            version: appStateAfterCleanup[0].version,
            hash: appStateHash(appStateAfterCleanup[0].data)
          };
        } else {
          expectedCompatibility = { version: appStateAfterRace[0].version, hash: appStateHash(appStateAfterRace[0].data) };
        }

        const allowedErrors = [...originErrors.pageErrors, ...observerErrors.pageErrors];
        expect(originErrors.consoleErrors).toEqual([]);
        expect(observerErrors.consoleErrors).toEqual([]);
        expect(allowedErrors.length).toBeLessThanOrEqual(1);
        allowedErrors.forEach((message) => expect(message).toMatch(/The session is no longer open|Bill inventory rows do not match the locked session or tab items/i));
        await attachJson(testInfo, "checkout-repeat-combo-race-evidence", evidence);
      } catch (error) {
        evidence = {
          ...evidence,
          lifecycle: {
            sessionStarted,
            raceStarted,
            outcomeResolved,
            checkoutSubmitted,
            comboSubmitted,
            checkoutSubmissionCount,
            comboSubmissionCount,
            checkoutCaptureCount,
            comboCaptureCount
          },
          primaryError: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        };
        await persistEvidence(scenario, evidence);
        throw error;
      } finally {
        checkoutCommand?.cancel();
        comboCommand?.cancel();
        await Promise.all([
          checkoutCommand?.dispose().catch(() => undefined),
          comboCommand?.dispose().catch(() => undefined)
        ]);
        page.off("dialog", dismissDialog);
        observer.page.off("dialog", dismissDialog);
        const acknowledgedStart = rpcEvidence.findLast(
          (entry) => entry.rpc === "start_session" && entry.status < 300 && typeof entry.entityId === "string"
        );
        if (!sessionId && acknowledgedStart?.entityId) {
          sessionId = acknowledgedStart.entityId;
          sessionStarted = true;
          evidence = { ...evidence, sessionId, setupAcknowledged: true };
        }
        if (sessionStarted && !outcomeResolved && !raceStarted && sessionId) {
          try {
            if (!cleanupRest || !cleanupActorId) throw new Error("Authoritative cleanup context was not captured.");
            await page.reload({ waitUntil: "domcontentloaded" });
            const cleanupReason = `Playwright pre-race combo cleanup ${runId} ${scenario}`;
            expect(await rejectSessionIfOpen(page, station, customerName, cleanupReason)).toBe(true);
            await expect.poll(() => rpcEvidence.findLast(
              (entry) => entry.rpc === "reject_session" && entry.status < 300 && entry.entityId === sessionId
            )).toBeTruthy();
            const cleanup = rpcEvidence.findLast(
              (entry) => entry.rpc === "reject_session" && entry.status < 300 && entry.entityId === sessionId
            );
            expect(cleanup?.mutationId).toBeTruthy();
            expect(cleanup?.eventId).toBeTruthy();
            const cleanupAuditIds = changedIds(cleanup, "audit_logs");
            const cleanupMovementIds = changedIds(cleanup, "stock_movements");
            expect(cleanupAuditIds).toHaveLength(1);
            expect(cleanupMovementIds).toEqual([]);
            const [cleanedSession, cleanupEvents, cleanupAudits, cleanupMovements, cleanupAppState] = await Promise.all([
              readRestRows<{ id: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(page, cleanupRest.restBase, cleanupRest.headers, "sessions", {
                organization_id: `eq.${organizationId}`, id: `eq.${sessionId}`, select: "id,status,close_disposition,closed_bill_id"
              }),
              readRestRows<{ id: string; event_type: string; entity_id: string; created_by: string; metadata: Record<string, unknown> }>(page, cleanupRest.restBase, cleanupRest.headers, "operational_events", {
                organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${cleanup!.mutationId}`, select: "id,event_type,entity_id,created_by,metadata"
              }),
              readRestRows<{ id: string; action: string; entity_id: string; user_id: string }>(page, cleanupRest.restBase, cleanupRest.headers, "audit_logs", {
                organization_id: `eq.${organizationId}`, id: `in.(${cleanupAuditIds.join(",")})`, select: "id,action,entity_id,user_id"
              }),
              cleanupMovementIds.length > 0
                ? readRestRows<{ id: string; item_id: string; type: string; quantity: number; user_id: string; related_bill_id: string | null }>(page, cleanupRest.restBase, cleanupRest.headers, "stock_movements", {
                    organization_id: `eq.${organizationId}`, id: `in.(${cleanupMovementIds.join(",")})`, select: "id,item_id,type,quantity,user_id,related_bill_id"
                  })
                : Promise.resolve([]),
              readRestRows<{ version: number; data: unknown }>(page, cleanupRest.restBase, cleanupRest.headers, "app_state", {
                id: "eq.primary", select: "version,data"
              })
            ]);
            expect(cleanedSession).toEqual([{ id: sessionId, status: "closed", close_disposition: "rejected", closed_bill_id: null }]);
            expect(cleanupEvents).toEqual([expect.objectContaining({
              id: cleanup!.eventId,
              event_type: "reject_session",
              entity_id: sessionId,
              created_by: cleanupActorId
            })]);
            expect(cleanupAudits).toEqual([expect.objectContaining({
              id: cleanupAuditIds[0], action: "session_rejected", entity_id: sessionId, user_id: cleanupActorId
            })]);
            expect(cleanupMovements).toEqual([]);
            evidence = {
              ...evidence,
              emergencyCleanup: {
                reason: cleanupReason,
                result: cleanup,
                session: cleanedSession[0],
                event: cleanupEvents[0],
                audit: cleanupAudits[0],
                movements: cleanupMovements,
                availabilityReleasedByClosedSession: true,
                appState: { version: cleanupAppState[0].version, hash: appStateHash(cleanupAppState[0].data) }
              }
            };
          } catch (error) {
            cleanupError = error instanceof Error ? error.message : String(error);
          }
        }
        evidence = {
          ...evidence,
          lifecycle: {
            sessionStarted,
            raceStarted,
            outcomeResolved,
            checkoutSubmitted,
            comboSubmitted,
            checkoutSubmissionCount,
            comboSubmissionCount,
            checkoutCaptureCount,
            comboCaptureCount
          },
          cleanupDisposition: raceStarted && !outcomeResolved ? "skipped_ambiguous_race" : undefined,
          cleanupError
        };
        await persistEvidence(scenario, evidence);
        await attachJson(testInfo, "checkout-repeat-combo-race-final", evidence);
        await attachFailureScreenshot(testInfo, page, "checkout-repeat-combo-origin-failure");
        await attachFailureScreenshot(testInfo, observer.page, "checkout-repeat-combo-observer-failure");
        await observer.context.close();
      }
    });
  }
});
