import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
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
  readPendingOperationalMutations,
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
const station = process.env.E2E_SESSION_ITEM_RACE_STATION?.trim() || "8 Ball Pool";
const itemName = `QA Session Item Race ${runId}`;
const organizationId = "org-primary";
const preflightVersion = Number(process.env.E2E_SESSION_ITEM_RACE_PREFLIGHT_VERSION);
const preflightHash = process.env.E2E_SESSION_ITEM_RACE_PREFLIGHT_HASH ?? "missing-preflight-hash";

type Scenario = "checkout_first" | "item_first" | "simultaneous";
type CheckoutEnvelope = { payload: FinancialCheckoutV2RpcPayloadEnvelope };
type ItemEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: "addSessionItem";
    entity_id: string;
    user_id: string;
    payload: {
      sessionId: string;
      item: {
        id: string;
        inventoryItemId: string;
        name: string;
        quantity: number;
        unitPrice: number;
        addedAt: string;
      };
      stockMovement: {
        id: string;
        itemId: string;
        type: string;
        quantity: number;
        userId: string;
      };
      auditLog: {
        id: string;
        action: string;
        entityType: string;
        entityId: string;
        userId: string;
      };
    };
  };
};

const allScenarios: Array<{ scenario: Scenario; expectedWinner?: "checkout" | "item" }> = [
  { scenario: "checkout_first", expectedWinner: "checkout" },
  { scenario: "item_first", expectedWinner: "item" },
  { scenario: "simultaneous" }
];
const selectedScenarioNames = (process.env.E2E_SESSION_ITEM_RACE_SCENARIOS ?? allScenarios.map(({ scenario }) => scenario).join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedScenarioSelections = [
  ["checkout_first", "item_first", "simultaneous"],
  ["item_first", "simultaneous"]
];
if (!allowedScenarioSelections.some((selection) => selection.join(",") === selectedScenarioNames.join(","))) {
  throw new Error("E2E_SESSION_ITEM_RACE_SCENARIOS is not an approved exact scenario selection.");
}
const scenarios = allScenarios.filter(({ scenario }) => selectedScenarioNames.includes(scenario));

function appStateHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function changedIds(result: Record<string, unknown> | RpcEvidence | null, collection: string) {
  const snakeRows = result && "changed_rows" in result && result.changed_rows && typeof result.changed_rows === "object"
    ? result.changed_rows as Record<string, unknown>
    : undefined;
  const camelRows = result && "changedRows" in result && result.changedRows && typeof result.changedRows === "object"
    ? result.changedRows as Record<string, unknown>
    : undefined;
  const rows = camelRows ?? snakeRows;
  const values = rows?.[collection];
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

function acknowledgedCommand(
  requests: CapturedRpcRequest[],
  rpc: string,
  mutationId: unknown
) {
  const captured = requests.findLast((entry) => {
    const body = entry.body as { payload?: { mutation_id?: string } } | null;
    return entry.url.includes(`/rest/v1/rpc/${rpc}`) && body?.payload?.mutation_id === mutationId;
  });
  expect(captured, `${rpc} acknowledged response must retain its exact request envelope.`).toBeTruthy();
  return captured!.body;
}

function withUniqueBillNumber(captured: CapturedRpcRequest, scenario: Scenario) {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const billNumber = `BILL-QA-ITEM-RACE-${runId}-${scenario}`;
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

function persistCheckpoint(phase: string, evidence: unknown) {
  const directory = path.join(process.cwd(), "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-session-item-race-${phase}-${runId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
  return path.relative(process.cwd(), target);
}

async function openInventory(page: Page) {
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("tablist", { name: "Inventory section", exact: true })
    .getByRole("button", { name: "Catalog", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Active Items", exact: true })).toBeVisible();
}

async function clearConflict(page: Page) {
  const clear = page.getByRole("button", { name: "Clear", exact: true });
  const synced = page.getByText(/^Synced(?:\s|$)/).first();
  let syncedSince = 0;
  await expect.poll(async () => {
    if (await clear.isVisible().catch(() => false)) return "clear";
    if (await synced.isVisible().catch(() => false)) {
      if (!syncedSince) syncedSince = Date.now();
      return Date.now() - syncedSince >= 1_500 ? "stable-synced" : "settling-synced";
    }
    syncedSince = 0;
    return "loading";
  }, { timeout: 10_000, intervals: [100] }).toMatch(/^(clear|stable-synced)$/);
  if (await clear.isVisible().catch(() => false)) await clear.click();
  await waitForSynced(page);
}

async function startSessionAcknowledged(
  page: Page,
  customerName: string,
  onAcknowledged: (result: Record<string, unknown>) => void
) {
  const card = stationCard(page, station);
  await expect(card).toContainText("Available");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Start New Session", exact: true });
  await modal.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const playMode = modal.getByLabel("Play Mode", { exact: true });
  if (await playMode.count()) await playMode.selectOption("group");
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/rest/v1/rpc/start_session") && response.request().method() === "POST"
  );
  await modal.getByRole("button", { name: "Start Session", exact: true }).click();
  const response = await responsePromise;
  const result = await readApiResponseBody(response) as Record<string, unknown>;
  expect(response.status()).toBe(200);
  expect(typeof result.entity_id).toBe("string");
  onAcknowledged(result);
  await expect(modal).toBeHidden();
  await waitForSynced(page);
  await expect(card).toContainText(customerName);
}

async function rejectSessionAcknowledged(
  page: Page,
  customerName: string,
  reason: string,
  onAcknowledged: (result: Record<string, unknown>) => void
) {
  await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
  const card = stationCard(page, station);
  await expect(card).toContainText(customerName);
  const modal = await openManagedSession(page, station);
  await modal.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
  await expect(modal.getByLabel("Customer Name", { exact: true })).toHaveValue(customerName);
  await modal.getByLabel("Customer Name", { exact: true }).locator("xpath=ancestor::form")
    .getByRole("button", { name: "Cancel", exact: true }).click();
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/rest/v1/rpc/reject_session") && response.request().method() === "POST"
  );
  page.once("dialog", (dialog) => dialog.accept(reason));
  await modal.getByRole("button", { name: "Reject Session", exact: true }).click();
  const response = await responsePromise;
  const result = await readApiResponseBody(response) as Record<string, unknown>;
  expect(response.status()).toBe(200);
  onAcknowledged(result);
  await expect(modal).toBeHidden();
  await waitForSynced(page);
  await expect(card).toContainText("Available");
  return result;
}

test.describe.serial("Release B checkout versus direct session-item concurrency", () => {
  test(`${selectedScenarioNames.join(" + ")} zero-retry orderings preserve one canonical winner`, async ({ browser, page }, testInfo) => {
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
    const evidence: Record<string, unknown> = {
      runId,
      station,
      itemName,
      selectedScenarios: selectedScenarioNames,
      scenarios: []
    };
    let itemId: string | undefined;
    let itemCreated = false;
    let itemArchived = false;
    let activeScenario: Scenario | undefined;
    let activeCustomer: string | undefined;
    let activeSessionId: string | undefined;
    let raceDispatched = false;
    let raceReconciled = false;
    let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let itemCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let primaryError: unknown;
    let cleanupError: string | undefined;
    const dismissDialog = (dialog: { dismiss(): Promise<void> }) => void dialog.dismiss();

    try {
      // Resolve username-backed logins sequentially; the staging resolver is not a race target.
      await signIn(page, credentials("A"));
      await signIn(observer.page, credentials("B"));
      const [originIdentity, observerIdentity] = await Promise.all([
        assertAuthoritativeOrganizationIdentity(page, originRequests, "admin", organizationId),
        assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", organizationId)
      ]);
      expect(originIdentity.actorId).not.toBe(observerIdentity.actorId);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);

      const preflightState = await readRestRows<{ version: number; data: unknown }>(
        page,
        originIdentity.restBase,
        originIdentity.headers,
        "app_state",
        { id: "eq.primary", select: "version,data" }
      );
      expect(preflightState).toHaveLength(1);
      expect(preflightState[0].version).toBe(preflightVersion);
      expect(appStateHash(preflightState[0].data)).toBe(preflightHash);
      evidence.actors = { checkout: originIdentity.actorId, item: observerIdentity.actorId };
      evidence.preflightAppState = { version: preflightVersion, hash: preflightHash };
      evidence.setupPreparedPath = persistCheckpoint("setup-prepared", evidence);

      await openInventory(page);
      const createForm = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
      await createForm.getByLabel("Item Name", { exact: true }).fill(itemName);
      await createForm.locator("select").first().selectOption({ label: "Beverages" });
      await createForm.getByLabel("Price", { exact: true }).fill("50");
      await createForm.getByLabel("Opening Stock", { exact: true }).fill("3");
      await createForm.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
      const created = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await createForm.getByRole("button", { name: "Create Item", exact: true }).click();
      const createdResponse = await created;
      const createdBody = await readApiResponseBody(createdResponse);
      expect(createdResponse.status()).toBe(200);
      itemId = changedIds(createdBody as Record<string, unknown>, "inventory_items")[0];
      expect(itemId).toBeTruthy();
      itemCreated = true;
      evidence.fixture = {
        itemId,
        createdBody,
        createdCommand: acknowledgedCommand(originRequests, "commit_admin_data_change", createdBody.mutation_id)
      };
      evidence.fixtureCreatedPath = persistCheckpoint("fixture-created", evidence);
      await waitForSynced(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(page);
      await expect.poll(() => readPendingOperationalMutations(page)).toEqual([]);

      const fixtureState = await readRestRows<{ version: number; data: unknown }>(
        page,
        originIdentity.restBase,
        originIdentity.headers,
        "app_state",
        { id: "eq.primary", select: "version,data" }
      );
      expect(fixtureState).toHaveLength(1);
      expect(fixtureState[0].version).toBe(preflightVersion + 1);
      let expectedCompatibility = {
        version: fixtureState[0].version,
        hash: appStateHash(fixtureState[0].data)
      };
      evidence.fixture = { itemId, createdBody, appState: expectedCompatibility };
      evidence.fixtureVerifiedPath = persistCheckpoint("fixture-verified", evidence);

      for (const { scenario, expectedWinner } of scenarios) {
        activeScenario = scenario;
        activeCustomer = `QA Session Item Race ${runId} ${scenario}`;
        activeSessionId = undefined;
        raceDispatched = false;
        raceReconciled = false;
        const scenarioEvidence: Record<string, unknown> = { scenario, customerName: activeCustomer };
        (evidence.scenarios as Array<Record<string, unknown>>).push(scenarioEvidence);

        await page.getByRole("button", { name: "Live Dashboard", exact: true }).click();
        await expect(stationCard(page, station)).toContainText("Available");
        await startSessionAcknowledged(page, activeCustomer, (result) => {
          activeSessionId = String(result.entity_id);
          scenarioEvidence.sessionId = activeSessionId;
          scenarioEvidence.startMutationId = result.mutation_id;
          scenarioEvidence.startResult = result;
          scenarioEvidence.startCommand = acknowledgedCommand(originRequests, "start_session", result.mutation_id);
          scenarioEvidence.startAcknowledgedPath = persistCheckpoint(`${scenario}-start-acknowledged`, evidence);
        });

        const managed = await openManagedSession(page, station);
        await managed.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        await managed.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
        const saved = page.waitForResponse((response) =>
          response.url().includes("/rest/v1/rpc/save_live_session_details") && response.request().method() === "POST"
        );
        await managed.getByRole("button", { name: "Save Session Details", exact: true }).click();
        const savedResponse = await saved;
        const savedBody = await readApiResponseBody(savedResponse) as Record<string, unknown>;
        expect(savedResponse.status()).toBe(200);
        scenarioEvidence.saveResult = savedBody;
        scenarioEvidence.saveCommand = acknowledgedCommand(originRequests, "save_live_session_details", savedBody.mutation_id);
        scenarioEvidence.saveAcknowledgedPath = persistCheckpoint(`${scenario}-save-acknowledged`, evidence);
        await waitForSynced(page);
        await observer.page.reload({ waitUntil: "domcontentloaded" });
        await waitForSynced(observer.page);
        await expect(stationCard(observer.page, station)).toContainText(activeCustomer);

        const [stateBefore, sessionItemsBefore, itemBefore] = await Promise.all([
          readRestRows<{ version: number; data: unknown }>(page, originIdentity.restBase, originIdentity.headers, "app_state", {
            id: "eq.primary", select: "version,data"
          }),
          readRestRows<{ id: string }>(page, originIdentity.restBase, originIdentity.headers, "session_items", {
            organization_id: `eq.${organizationId}`, session_id: `eq.${activeSessionId}`, select: "id"
          }),
          readRestRows<{ id: string; stock_qty: number; active: boolean }>(page, originIdentity.restBase, originIdentity.headers, "inventory_items", {
            organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,stock_qty,active"
          })
        ]);
        expect(stateBefore).toHaveLength(1);
        expect({ version: stateBefore[0].version, hash: appStateHash(stateBefore[0].data) }).toEqual(expectedCompatibility);
        expect(sessionItemsBefore).toEqual([]);
        expect(itemBefore).toEqual([{ id: itemId, stock_qty: 3, active: true }]);

        await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
        const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
        checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
        page.on("dialog", dismissDialog);
        await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
        const capturedCheckout = await checkoutCommand.captured;

        const observerManaged = await openManagedSession(observer.page, station);
        const itemAdder = observerManaged.locator(".session-item-adder");
        await itemAdder.getByLabel("Search inventory item", { exact: true }).fill(itemName);
        const option = itemAdder.locator("button.sellable-picker-option").filter({ hasText: itemName });
        await expect(option).toHaveCount(1);
        await option.click();
        itemCommand = await interceptSingleRpcCommand(observer.page, "**/rest/v1/rpc/add_session_item");
        observer.page.on("dialog", dismissDialog);
        await itemAdder.getByRole("button", { name: "Add Item", exact: true }).click();
        const capturedItem = await itemCommand.captured;
        expect(checkoutCommand.captureCount()).toBe(1);
        expect(itemCommand.captureCount()).toBe(1);

        const checkoutEnvelope = withUniqueBillNumber(capturedCheckout, scenario);
        const itemEnvelope = structuredClone(capturedItem.body) as ItemEnvelope;
        const primaryBill = checkoutEnvelope.payload.payload.primary_bill as {
          id: string;
          billNumber: string;
          total: number;
          amountPaid: number;
          amountDue: number;
          lines?: Array<Record<string, unknown>>;
        };
        const expectedLines = primaryBill.lines ?? [];
        const expectedPayments = checkoutEnvelope.payload.payload.payments;
        const expectedCheckoutAudits = checkoutEnvelope.payload.payload.audit_logs;
        const expectedCheckoutMovements = checkoutEnvelope.payload.payload.stock_movements;
        expect(checkoutEnvelope.payload.organization_id).toBe(organizationId);
        expect(checkoutEnvelope.payload.entity_id).toBe(activeSessionId);
        expect(checkoutEnvelope.payload.payload.source_session_ids).toEqual([activeSessionId]);
        expect(Number(primaryBill.total)).toBeGreaterThan(0);
        expect(Number(primaryBill.amountPaid)).toBe(Number(primaryBill.total));
        expect(Number(primaryBill.amountDue)).toBe(0);
        expect(expectedLines.length).toBeGreaterThan(0);
        expect(expectedPayments).toHaveLength(1);
        expect(expectedCheckoutMovements).toEqual([]);
        expect(itemEnvelope.payload).toEqual(expect.objectContaining({
          organization_id: organizationId,
          mutation_kind: "addSessionItem",
          entity_id: activeSessionId,
          user_id: observerIdentity.actorId
        }));
        expect(itemEnvelope.payload.payload.sessionId).toBe(activeSessionId);
        expect(itemEnvelope.payload.payload.item).toEqual(expect.objectContaining({
          inventoryItemId: itemId,
          name: itemName,
          quantity: 1,
          unitPrice: 50
        }));
        expect(itemEnvelope.payload.payload.stockMovement).toEqual(expect.objectContaining({
          itemId,
          type: "session_reservation",
          quantity: -1,
          userId: observerIdentity.actorId
        }));
        expect(itemEnvelope.payload.payload.auditLog).toEqual(expect.objectContaining({
          action: "session_item_added",
          entityId: activeSessionId,
          userId: observerIdentity.actorId
        }));
        expect(authenticatedJwtSubject(capturedCheckout.headers)).toBe(originIdentity.actorId);
        expect(authenticatedJwtSubject(capturedItem.headers)).toBe(observerIdentity.actorId);

        Object.assign(scenarioEvidence, {
          checkoutMutationId: checkoutEnvelope.payload.mutation_id,
          itemMutationId: itemEnvelope.payload.mutation_id,
          candidateBillId: primaryBill.id,
          candidateBillNumber: primaryBill.billNumber,
          candidateSessionItemId: itemEnvelope.payload.payload.item.id,
          candidateReservationId: itemEnvelope.payload.payload.stockMovement.id,
          candidateItemAuditId: itemEnvelope.payload.payload.auditLog.id,
          appStateBefore: expectedCompatibility,
          expectedFinancial: {
            bill: primaryBill,
            lines: expectedLines,
            payments: expectedPayments,
            audits: expectedCheckoutAudits,
            movements: expectedCheckoutMovements
          },
          expectedOperational: itemEnvelope.payload.payload,
          captureCounts: { checkout: checkoutCommand.captureCount(), item: itemCommand.captureCount() }
        });
        scenarioEvidence.preparedPath = persistCheckpoint(`${scenario}-prepared`, {
          ...evidence,
          submissionPlan: { scenario, checkoutEnvelope, itemEnvelope }
        });

        raceDispatched = true;
        let checkoutResponse: APIResponse;
        let itemResponse: APIResponse;
        if (scenario === "checkout_first") {
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
          itemResponse = await itemCommand.submit(itemEnvelope);
        } else if (scenario === "item_first") {
          itemResponse = await itemCommand.submit(itemEnvelope);
          checkoutResponse = await checkoutCommand.submit(checkoutEnvelope);
        } else {
          [checkoutResponse, itemResponse] = await Promise.all([
            checkoutCommand.submit(checkoutEnvelope),
            itemCommand.submit(itemEnvelope)
          ]);
        }
        const [checkoutBody, itemBody] = await Promise.all([
          readApiResponseBody(checkoutResponse),
          readApiResponseBody(itemResponse)
        ]);
        Object.assign(scenarioEvidence, {
          responses: {
            checkout: { status: checkoutResponse.status(), body: checkoutBody },
            item: { status: itemResponse.status(), body: itemBody }
          }
        });
        scenarioEvidence.responsesPath = persistCheckpoint(`${scenario}-responses`, evidence);

        const checkoutWon = checkoutResponse.status() === 200;
        const itemWon = itemResponse.status() === 200;
        expect(Number(checkoutWon) + Number(itemWon)).toBe(1);
        const winner = checkoutWon ? "checkout" : "item";
        if (expectedWinner) expect(winner).toBe(expectedWinner);
        expect(checkoutWon ? itemResponse.status() : checkoutResponse.status()).toBe(400);
        expect(checkoutWon ? rpcRejectionCode(itemBody) : rpcRejectionCode(checkoutBody)).toBe(
          checkoutWon ? "session_not_open" : "source_item_mismatch"
        );

        const checkoutStatus = await mutationStatus(page, capturedCheckout, checkoutEnvelope.payload);
        const checkoutAuditIds = expectedCheckoutAudits.map((audit) => String(audit.id));
        const expectedPaymentIds = expectedPayments.map((payment) => String(payment.id));
        const expectedLineIds = expectedLines.map((line) => String(line.id));
        const [
          sessionRows,
          billRows,
          lineRows,
          paymentRows,
          checkoutEvents,
          itemEvents,
          checkoutAudits,
          itemAudits,
          addedItems,
          reservationMovements,
          inventoryAfter,
          stateAfter
        ] = await Promise.all([
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "sessions", {
            organization_id: `eq.${organizationId}`, id: `eq.${activeSessionId}`,
            select: "id,status,close_disposition,closed_bill_id,raw_data"
          }),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "bills", {
            organization_id: `eq.${organizationId}`, id: `eq.${primaryBill.id}`,
            select: "id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id"
          }),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "bill_lines", {
            organization_id: `eq.${organizationId}`, bill_id: `eq.${primaryBill.id}`,
            select: "id,bill_id,type,inventory_item_id,quantity,unit_price,total,linked_session_id,raw_data"
          }),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "payments", {
            organization_id: `eq.${organizationId}`, bill_id: `eq.${primaryBill.id}`,
            select: "id,bill_id,amount,mode,received_by_user_id"
          }),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "operational_events", {
            organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${checkoutEnvelope.payload.mutation_id}`,
            select: "id,event_type,entity_type,entity_id,created_by,metadata"
          }),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "operational_events", {
            organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${itemEnvelope.payload.mutation_id}`,
            select: "id,event_type,entity_type,entity_id,created_by,metadata"
          }),
          checkoutAuditIds.length
            ? readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "audit_logs", {
                organization_id: `eq.${organizationId}`, id: `in.(${checkoutAuditIds.join(",")})`,
                select: "id,action,entity_type,entity_id,user_id"
              })
            : Promise.resolve([]),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "audit_logs", {
            organization_id: `eq.${organizationId}`, id: `eq.${itemEnvelope.payload.payload.auditLog.id}`,
            select: "id,action,entity_type,entity_id,user_id"
          }),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "session_items", {
            organization_id: `eq.${organizationId}`, id: `eq.${itemEnvelope.payload.payload.item.id}`,
            select: "id,session_id,inventory_item_id,name,quantity,unit_price,raw_data"
          }),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "stock_movements", {
            organization_id: `eq.${organizationId}`, id: `eq.${itemEnvelope.payload.payload.stockMovement.id}`,
            select: "id,item_id,type,quantity,user_id,related_bill_id"
          }),
          readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "inventory_items", {
            organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,stock_qty,active"
          }),
          readRestRows<{ version: number; data: unknown }>(page, originIdentity.restBase, originIdentity.headers, "app_state", {
            id: "eq.primary", select: "version,data"
          })
        ]);

        expect(sessionRows).toHaveLength(1);
        expect(stateAfter).toHaveLength(1);
        expect({ version: stateAfter[0].version, hash: appStateHash(stateAfter[0].data) }).toEqual(expectedCompatibility);
        expect(inventoryAfter).toEqual([{ id: itemId, stock_qty: 3, active: true }]);
        if (checkoutWon) {
          expect(sessionRows[0]).toEqual(expect.objectContaining({
            status: "closed", close_disposition: "billed", closed_bill_id: primaryBill.id
          }));
          expect(billRows).toEqual([expect.objectContaining({
            id: primaryBill.id,
            bill_number: primaryBill.billNumber,
            status: "issued",
            total: Number(primaryBill.total),
            amount_paid: Number(primaryBill.amountPaid),
            amount_due: 0,
            issued_by_user_id: originIdentity.actorId
          })]);
          expect(new Set(lineRows.map((row) => row.id))).toEqual(new Set(expectedLineIds));
          for (const expected of expectedLines) {
            expect(lineRows).toContainEqual(expect.objectContaining({
              id: expected.id,
              bill_id: primaryBill.id,
              type: expected.type,
              quantity: Number(expected.quantity),
              unit_price: Number(expected.unitPrice),
              total: Number(expected.total),
              linked_session_id: activeSessionId
            }));
          }
          expect(new Set(paymentRows.map((row) => row.id))).toEqual(new Set(expectedPaymentIds));
          expect(paymentRows.every((row) => row.bill_id === primaryBill.id && row.received_by_user_id === originIdentity.actorId)).toBe(true);
          expect(new Set(checkoutAudits.map((row) => row.id))).toEqual(new Set(checkoutAuditIds));
          expect(checkoutAudits.every((row) => row.user_id === originIdentity.actorId)).toBe(true);
          expect(checkoutEvents).toEqual([expect.objectContaining({
            id: checkoutStatus?.event_id,
            event_type: "financial_checkout_committed_v2",
            entity_id: activeSessionId,
            created_by: originIdentity.actorId,
            metadata: expect.objectContaining({ mutation_id: checkoutEnvelope.payload.mutation_id })
          })]);
          expect(checkoutStatus?.bill_id).toBe(primaryBill.id);
          expect(itemEvents).toEqual([]);
          expect(itemAudits).toEqual([]);
          expect(addedItems).toEqual([]);
          expect(reservationMovements).toEqual([]);
        } else {
          expect(sessionRows[0]).toEqual(expect.objectContaining({
            status: "active", close_disposition: null, closed_bill_id: null
          }));
          expect(billRows).toEqual([]);
          expect(lineRows).toEqual([]);
          expect(paymentRows).toEqual([]);
          expect(checkoutEvents).toEqual([]);
          expect(checkoutAudits).toEqual([]);
          expect(checkoutStatus).toBeNull();
          expect(addedItems).toEqual([expect.objectContaining({
            id: itemEnvelope.payload.payload.item.id,
            session_id: activeSessionId,
            inventory_item_id: itemId,
            name: itemName,
            quantity: 1,
            unit_price: 50
          })]);
          expect(reservationMovements).toEqual([expect.objectContaining({
            id: itemEnvelope.payload.payload.stockMovement.id,
            item_id: itemId,
            type: "session_reservation",
            quantity: -1,
            user_id: observerIdentity.actorId,
            related_bill_id: null
          })]);
          expect(itemAudits).toEqual([expect.objectContaining({
            id: itemEnvelope.payload.payload.auditLog.id,
            action: "session_item_added",
            entity_type: "session",
            entity_id: activeSessionId,
            user_id: observerIdentity.actorId
          })]);
          expect(itemEvents).toEqual([expect.objectContaining({
            event_type: "add_session_item",
            entity_type: "session",
            entity_id: activeSessionId,
            created_by: observerIdentity.actorId
          })]);
          expect(itemEvents[0].id).toBe((itemBody as Record<string, unknown>).event_id);
          expect(new Set(changedIds(itemBody as Record<string, unknown>, "sessions"))).toEqual(new Set([activeSessionId]));
          expect(new Set(changedIds(itemBody as Record<string, unknown>, "session_items"))).toEqual(new Set([itemEnvelope.payload.payload.item.id]));
          expect(new Set(changedIds(itemBody as Record<string, unknown>, "stock_movements"))).toEqual(new Set([itemEnvelope.payload.payload.stockMovement.id]));
          expect(new Set(changedIds(itemBody as Record<string, unknown>, "audit_logs"))).toEqual(new Set([itemEnvelope.payload.payload.auditLog.id]));
          expect(new Set(changedIds(itemBody as Record<string, unknown>, "operational_events"))).toEqual(new Set([String(itemEvents[0].id)]));
        }

        Object.assign(scenarioEvidence, {
          winner,
          checkoutMutationStatus: checkoutStatus,
          database: {
            session: sessionRows[0], bills: billRows, lines: lineRows, payments: paymentRows,
            checkoutEvents, checkoutAudits, itemEvents, itemAudits, addedItems,
            reservationMovements, inventory: inventoryAfter,
            appState: { version: stateAfter[0].version, hash: appStateHash(stateAfter[0].data) }
          }
        });
        raceReconciled = true;
        scenarioEvidence.reconciledPath = persistCheckpoint(`${scenario}-reconciled`, evidence);

        await Promise.all([checkoutCommand.dispose(), itemCommand.dispose()]);
        checkoutCommand = undefined;
        itemCommand = undefined;
        page.off("dialog", dismissDialog);
        observer.page.off("dialog", dismissDialog);

        if (itemWon) {
          await observer.page.reload({ waitUntil: "domcontentloaded" });
          await waitForSynced(observer.page);
          const cleanupReason = `Playwright session-item race cleanup ${runId} ${scenario}`;
          const rejectedBody = await rejectSessionAcknowledged(observer.page, activeCustomer, cleanupReason, (result) => {
            scenarioEvidence.cleanupAcknowledgement = result;
            scenarioEvidence.cleanupCommand = acknowledgedCommand(observerRequests, "reject_session", result.mutation_id);
            scenarioEvidence.cleanupAcknowledgedPath = persistCheckpoint(`${scenario}-cleanup-acknowledged`, evidence);
          });
          const cleanup = rpcEvidence.findLast(
            (entry) => entry.rpc === "reject_session" && entry.status < 300 && entry.entityId === activeSessionId
          );
          expect(cleanup?.mutationId).toBeTruthy();
          expect(cleanup?.eventId).toBeTruthy();
          const cleanupAudits = changedIds(cleanup!, "audit_logs");
          const [cleanedSession, cleanupEvents, cleanupAuditRows, cleanupState] = await Promise.all([
            readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "sessions", {
              organization_id: `eq.${organizationId}`, id: `eq.${activeSessionId}`,
              select: "id,status,close_disposition,closed_bill_id"
            }),
            readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "operational_events", {
              organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${cleanup!.mutationId}`,
              select: "id,event_type,entity_id,created_by,metadata"
            }),
            readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "audit_logs", {
              organization_id: `eq.${organizationId}`, id: `in.(${cleanupAudits.join(",")})`,
              select: "id,action,entity_id,user_id"
            }),
            readRestRows<{ version: number; data: unknown }>(page, originIdentity.restBase, originIdentity.headers, "app_state", {
              id: "eq.primary", select: "version,data"
            })
          ]);
          expect(cleanedSession).toEqual([{ id: activeSessionId, status: "closed", close_disposition: "rejected", closed_bill_id: null }]);
          expect(cleanupEvents).toEqual([expect.objectContaining({
            id: cleanup!.eventId,
            event_type: "reject_session",
            entity_id: activeSessionId,
            created_by: observerIdentity.actorId
          })]);
          expect(cleanupAuditRows).toEqual([expect.objectContaining({
            action: "session_rejected", entity_id: activeSessionId, user_id: observerIdentity.actorId
          })]);
          expect(cleanupState[0].version).toBe(expectedCompatibility.version + 1);
          expectedCompatibility = {
            version: cleanupState[0].version,
            hash: appStateHash(cleanupState[0].data)
          };
          scenarioEvidence.cleanup = {
            reason: cleanupReason,
            acknowledgedResult: rejectedBody,
            result: cleanup,
            session: cleanedSession[0],
            event: cleanupEvents[0],
            audit: cleanupAuditRows[0],
            appState: expectedCompatibility
          };
          scenarioEvidence.cleanupPath = persistCheckpoint(`${scenario}-cleanup`, evidence);
        }

        await Promise.all([
          page.reload({ waitUntil: "domcontentloaded" }),
          observer.page.reload({ waitUntil: "domcontentloaded" })
        ]);
        await Promise.all([clearConflict(page), clearConflict(observer.page)]);
        await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
        await expect(stationCard(page, station)).toContainText("Available");
        await expect(stationCard(observer.page, station)).toContainText("Available");
      }

      await openInventory(page);
      const row = page.locator(".inventory-table-wrap tbody tr").filter({ hasText: itemName }).first();
      await expect(row).toBeVisible();
      await expect(row.locator("td").nth(4)).toContainText("3");
      await row.getByRole("button", { name: "Archive", exact: true }).click();
      const archiveReason = `Release B session-item race fixture cleanup ${runId}`;
      const archive = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
      await archive.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(archiveReason);
      const archived = page.waitForResponse((response) =>
        response.url().includes("/rest/v1/rpc/commit_admin_data_change") && response.request().method() === "POST"
      );
      await archive.getByRole("button", { name: "Archive Item", exact: true }).click();
      const archivedResponse = await archived;
      const archivedBody = await readApiResponseBody(archivedResponse);
      expect(archivedResponse.status()).toBe(200);
      itemArchived = true;
      evidence.cleanup = {
        archiveReason,
        archivedBody,
        archivedCommand: acknowledgedCommand(originRequests, "commit_admin_data_change", archivedBody.mutation_id)
      };
      evidence.archiveAcknowledgedPath = persistCheckpoint("archive-acknowledged", evidence);
      await waitForSynced(page);

      const [finalItem, openSessions, openTabs, finalState] = await Promise.all([
        readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "inventory_items", {
          organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,stock_qty,active"
        }),
        readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "sessions", {
          organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,status,customer_name"
        }),
        readRestRows<Record<string, unknown>>(page, originIdentity.restBase, originIdentity.headers, "customer_tabs", {
          organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,status,customer_name"
        }),
        readRestRows<{ version: number; data: unknown }>(page, originIdentity.restBase, originIdentity.headers, "app_state", {
          id: "eq.primary", select: "version,data"
        })
      ]);
      expect(finalItem).toEqual([{ id: itemId, name: itemName, stock_qty: 3, active: false }]);
      expect(openSessions).toEqual([]);
      expect(openTabs).toEqual([]);
      evidence.cleanup = {
        archiveReason,
        archivedBody,
        item: finalItem[0],
        appState: { version: finalState[0].version, hash: appStateHash(finalState[0].data) }
      };
      evidence.emptyFloor = { sessions: openSessions, tabs: openTabs };
      evidence.finalPath = persistCheckpoint("final", evidence);

      expect(checkoutCommand).toBeUndefined();
      expect(itemCommand).toBeUndefined();
      expect(originErrors.consoleErrors).toEqual([]);
      expect(observerErrors.consoleErrors).toEqual([]);
      const allowedPageErrors = [...originErrors.pageErrors, ...observerErrors.pageErrors];
      allowedPageErrors.forEach((message) => expect(message).toMatch(
        /The session is no longer open|Bill inventory rows do not match the locked session or tab items/i
      ));
      await attachJson(testInfo, "checkout-session-item-race-evidence", evidence);
    } catch (error) {
      primaryError = error;
      evidence.failure = {
        activeScenario,
        activeCustomer,
        activeSessionId,
        raceDispatched,
        raceReconciled,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      };
      persistCheckpoint(`failure-${activeScenario ?? "setup"}`, evidence);
      throw error;
    } finally {
      checkoutCommand?.cancel();
      itemCommand?.cancel();
      await Promise.all([
        checkoutCommand?.dispose().catch(() => undefined),
        itemCommand?.dispose().catch(() => undefined)
      ]);
      page.off("dialog", dismissDialog);
      observer.page.off("dialog", dismissDialog);
      if (activeSessionId && !raceDispatched) {
        try {
          await observer.page.reload({ waitUntil: "domcontentloaded" });
          await rejectSessionIfOpen(
            observer.page,
            station,
            activeCustomer!,
            `Playwright pre-race session-item cleanup ${runId} ${activeScenario}`
          );
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : String(error);
        }
      } else if (raceDispatched && !raceReconciled) {
        cleanupError = "Race commands were dispatched; reconcile exact mutation IDs before cleanup or retry.";
      }
      if (itemCreated && !itemArchived && !primaryError && !cleanupError) {
        cleanupError = "The QA inventory fixture was created but not archived.";
      }
      await attachJson(testInfo, "checkout-session-item-race-lifecycle", {
        runId,
        itemId,
        itemCreated,
        itemArchived,
        activeScenario,
        activeCustomer,
        activeSessionId,
        raceDispatched,
        raceReconciled,
        cleanupError,
        rpcEvidence,
        originErrors,
        observerErrors,
        evidence
      });
      await attachFailureScreenshot(testInfo, page, "checkout-session-item-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "checkout-session-item-observer-failure");
      await observer.context.close();
      // A cleanup-only failure must fail the test even when the primary assertions passed.
      // eslint-disable-next-line no-unsafe-finally
      if (!primaryError && cleanupError) throw new Error(cleanupError);
    }
  });
});
