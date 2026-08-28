import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import type { FinancialCheckoutV2RpcPayloadEnvelope } from "../../../src/dataGateway/financialRpcClient";
import {
  CUSTOMER_TAB_MUTATION_CONTRACTS,
  classifyCustomerTabRaceResponses,
  expectedCustomerTabRaceLoserCode,
  expectedCustomerTabRaceWinner,
  parseCustomerTabMutationRacePhase,
  parseExactCustomerTabMutationModes,
  parseExactCustomerTabMutationScenarios,
  selectedCustomerTabMutationRaceCases,
  type CustomerTabMutationMode,
  type CustomerTabMutationScenario
} from "../../../src/qa/customerTabMutationRace";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  captureRpcEvidence,
  createObserver,
  credentials,
  interceptSingleRpcCommand,
  readApiResponseBody,
  readPendingOperationalMutations,
  readRestRows,
  rpcRejectionCode,
  signIn,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const modes = parseExactCustomerTabMutationModes(process.env.E2E_TAB_MUTATION_RACE_MODES);
const scenarios = parseExactCustomerTabMutationScenarios(process.env.E2E_TAB_MUTATION_RACE_SCENARIOS);
const phase = parseCustomerTabMutationRacePhase(process.env.E2E_TAB_MUTATION_RACE_PHASE);
const selectedCases = selectedCustomerTabMutationRaceCases(phase);
const itemName = `QA Tab Mutation Race Item ${runId}`;
const comboName = `QA Tab Mutation Race Combo ${runId}`;
const organizationId = "org-primary";
const preflightVersion = Number(process.env.E2E_TAB_MUTATION_RACE_PREFLIGHT_VERSION);
const preflightHash = process.env.E2E_TAB_MUTATION_RACE_PREFLIGHT_HASH ?? "missing-preflight-hash";
const openingStock = 64;

type CheckoutEnvelope = { payload: FinancialCheckoutV2RpcPayloadEnvelope };
type OperationalEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    user_id: string;
    payload: Record<string, unknown>;
  };
};

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function changedIds(result: Record<string, unknown> | RpcEvidence | null, collection: string) {
  const snake = result && "changed_rows" in result && result.changed_rows && typeof result.changed_rows === "object"
    ? result.changed_rows as Record<string, unknown>
    : undefined;
  const camel = result && "changedRows" in result && result.changedRows && typeof result.changedRows === "object"
    ? result.changedRows as Record<string, unknown>
    : undefined;
  const values = (camel ?? snake)?.[collection];
  return Array.isArray(values) ? values.filter((entry): entry is string => typeof entry === "string") : [];
}

function rpcHeaders(captured: CapturedRpcRequest) {
  return {
    apikey: captured.headers.apikey,
    authorization: captured.headers.authorization,
    "content-type": "application/json",
    prefer: captured.headers.prefer || "return=representation"
  };
}

function acknowledgedCommand(requests: CapturedRpcRequest[], rpc: string, mutationId: unknown) {
  const captured = requests.findLast((entry) => {
    const body = entry.body as { payload?: { mutation_id?: string } } | null;
    return entry.url.includes(`/rest/v1/rpc/${rpc}`) && body?.payload?.mutation_id === mutationId;
  });
  expect(captured, `${rpc} acknowledgement must retain its exact request envelope.`).toBeTruthy();
  return captured!.body;
}

function persistCheckpoint(phase: string, evidence: unknown) {
  const directory = path.join(process.cwd(), "test-artifacts", "evidence");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `checkout-tab-mutation-race-${phase}-${runId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
  return path.relative(process.cwd(), target);
}

function billNumber(mode: CustomerTabMutationMode, scenario: CustomerTabMutationScenario) {
  return `BILL-QA-TAB-MUT-${runId}-${mode}-${scenario}`;
}

function customerName(mode: CustomerTabMutationMode, scenario: CustomerTabMutationScenario) {
  return `QA Tab Mutation Race ${runId} ${mode} ${scenario}`;
}

function withUniqueBillNumber(captured: CapturedRpcRequest, mode: CustomerTabMutationMode, scenario: CustomerTabMutationScenario) {
  const envelope = structuredClone(captured.body) as CheckoutEnvelope;
  const nextBillNumber = billNumber(mode, scenario);
  const primaryBill = envelope.payload.payload.primary_bill as { id?: string; billNumber?: string };
  primaryBill.billNumber = nextBillNumber;
  const update = envelope.payload.payload.bill_updates.find((entry) => entry.id === primaryBill.id);
  if (!update) throw new Error("Captured checkout omitted its primary bill update.");
  update.billNumber = nextBillNumber;
  return envelope;
}

async function mutationStatus(page: Page, captured: CapturedRpcRequest, envelope: CheckoutEnvelope["payload"]) {
  const response = await page.request.post(captured.url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"), {
    headers: rpcHeaders(captured),
    data: { payload: {
      organization_id: envelope.organization_id,
      mutation_id: envelope.mutation_id,
      mutation_kind: envelope.mutation_kind
    } }
  });
  expect(response.status()).toBe(200);
  return await response.json() as Record<string, unknown> | null;
}

async function openInventory(page: Page, section: "Catalog" | "Combos") {
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("tablist", { name: "Inventory section", exact: true })
    .getByRole("button", { name: section, exact: true }).click();
}

async function openCustomerTab(page: Page, name: string, onAcknowledged?: (result: Record<string, unknown>) => void) {
  await page.getByRole("button", { name: "Consumables Tab", exact: true }).click();
  const chip = page.locator("button.tab-chip").filter({ hasText: name });
  if (await chip.isVisible().catch(() => false)) {
    await chip.evaluate((button: HTMLButtonElement) => button.click());
    await expect(chip).toHaveClass(/is-active/);
    return;
  }
  await page.getByLabel("Customer Name", { exact: true }).fill(name);
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/rest/v1/rpc/open_customer_tab") && response.request().method() === "POST"
  );
  const form = page.getByRole("button", { name: "Open / Find Tab", exact: true }).locator("xpath=ancestor::form");
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  const response = await responsePromise;
  const result = await readApiResponseBody(response) as Record<string, unknown>;
  expect(response.status()).toBe(200);
  onAcknowledged?.(result);
  await waitForSynced(page);
  await expect.poll(() => readPendingOperationalMutations(page)).toEqual([]);
  await expect(chip).toHaveClass(/is-active/);
}

async function addBaselineItem(page: Page, name: string, onAcknowledged?: (result: Record<string, unknown>) => void) {
  await openCustomerTab(page, name);
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/rest/v1/rpc/add_customer_tab_item") && response.request().method() === "POST"
  );
  const card = page.locator("button.catalog-card").filter({ hasText: itemName }).first();
  await expect(card).toBeEnabled();
  await card.evaluate((button: HTMLButtonElement) => button.click());
  const response = await responsePromise;
  const result = await readApiResponseBody(response) as Record<string, unknown>;
  expect(response.status()).toBe(200);
  onAcknowledged?.(result);
  await waitForSynced(page);
  await expect(page.locator(".sale-current-tab-section").locator(".line-item-row").filter({ hasText: itemName })).toHaveCount(1);
}

async function prepareCheckout(page: Page, name: string) {
  await openCustomerTab(page, name);
  await page.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Finalize Customer Tab Bill", exact: true });
  await expect(dialog.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
  return dialog;
}

async function captureOperationalMutation(page: Page, mode: CustomerTabMutationMode) {
  const contract = CUSTOMER_TAB_MUTATION_CONTRACTS[mode];
  const command = await interceptSingleRpcCommand(page, `**/rest/v1/rpc/${contract.rpc}`);
  const current = page.locator(".sale-current-tab-section");
  if (mode === "add_item") {
    await page.locator("button.catalog-card").filter({ hasText: itemName }).first()
      .evaluate((button: HTMLButtonElement) => button.click());
  } else if (mode === "update_item") {
    const row = current.locator(".line-item-row").filter({ hasText: itemName }).first();
    await row.getByLabel("Qty", { exact: true }).fill("2");
  } else if (mode === "remove_item") {
    const row = current.locator(".line-item-row").filter({ hasText: itemName }).first();
    await row.getByRole("button", { name: "Remove", exact: true }).click();
  } else {
    const combo = page.locator(".combo-sale-card").filter({ hasText: comboName });
    await combo.getByRole("button", { name: "Apply", exact: true }).click();
  }
  return { command, captured: await command.captured };
}

async function rejectTab(page: Page, name: string, reason: string) {
  await openCustomerTab(page, name);
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes("/rest/v1/rpc/reject_customer_tab") && response.request().method() === "POST"
  );
  page.once("dialog", (dialog) => dialog.accept(reason));
  await page.getByRole("button", { name: "Reject Tab", exact: true }).click();
  const response = await responsePromise;
  const result = await readApiResponseBody(response) as Record<string, unknown>;
  expect(response.status()).toBe(200);
  await waitForSynced(page);
  return result;
}

async function readItemMovements(page: Page, restBase: string, headers: Record<string, string>, itemId: string) {
  return await readRestRows<Record<string, unknown>>(page, restBase, headers, "stock_movements", {
    organization_id: `eq.${organizationId}`,
    item_id: `eq.${itemId}`,
    select: "id,item_id,type,quantity,user_id,related_bill_id"
  });
}

test.describe.serial("Release B checkout versus customer-tab source mutations", () => {
  test(phase === "remaining-eleven"
    ? "remaining eleven zero-retry orderings preserve one canonical winner"
    : "all four RPC modes and all three zero-retry orderings preserve one canonical winner", async ({ browser, page }, testInfo) => {
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
    const evidence: Record<string, unknown> = {
      runId,
      itemName,
      comboName,
      modes,
      scenarios,
      phase,
      selectedCases,
      productionAllowed: false,
      safeForAutomaticRetry: false,
      cases: []
    };
    let itemId: string | undefined;
    let comboId: string | undefined;
    let fixtureCreated = false;
    let fixtureArchived = false;
    let activeCase: string | undefined;
    let activeTabId: string | undefined;
    let raceDispatched = false;
    let raceReconciled = false;
    let checkoutCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let operationalCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
    let primaryError: unknown;
    let cleanupError: string | undefined;
    const dismissDialog = (dialog: { dismiss(): Promise<void> }) => void dialog.dismiss();

    try {
      await signIn(page, credentials("A"));
      await signIn(observer.page, credentials("B"));
      const [origin, mutationActor] = await Promise.all([
        assertAuthoritativeOrganizationIdentity(page, originRequests, "admin", organizationId),
        assertAuthoritativeOrganizationIdentity(observer.page, observerRequests, "admin", organizationId)
      ]);
      expect(origin.actorId).not.toBe(mutationActor.actorId);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      const baseline = await readRestRows<{ version: number; data: unknown }>(page, origin.restBase, origin.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      });
      expect(baseline).toHaveLength(1);
      expect({ version: baseline[0].version, hash: hash(baseline[0].data) }).toEqual({ version: preflightVersion, hash: preflightHash });
      evidence.actors = { checkout: origin.actorId, mutation: mutationActor.actorId };
      evidence.preflightAppState = { version: preflightVersion, hash: preflightHash };
      evidence.setupPreparedPath = persistCheckpoint("setup-prepared", evidence);

      await openInventory(page, "Catalog");
      const itemForm = page.getByRole("button", { name: "Create Item", exact: true }).locator("xpath=ancestor::form");
      await itemForm.getByLabel("Item Name", { exact: true }).fill(itemName);
      await itemForm.locator("select").first().selectOption({ label: "Beverages" });
      await itemForm.getByLabel("Price", { exact: true }).fill("50");
      await itemForm.getByLabel("Opening Stock", { exact: true }).fill(String(openingStock));
      await itemForm.getByLabel("Low Stock Threshold", { exact: true }).fill("0");
      const itemResponsePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/commit_admin_data_change"));
      await itemForm.getByRole("button", { name: "Create Item", exact: true }).click();
      const itemResponse = await itemResponsePromise;
      const itemResult = await readApiResponseBody(itemResponse) as Record<string, unknown>;
      expect(itemResponse.status()).toBe(200);
      evidence.itemAcknowledgedPath = persistCheckpoint("item-acknowledged", { ...evidence, itemResult });
      itemId = changedIds(itemResult, "inventory_items")[0];
      expect(itemId).toBeTruthy();

      await openInventory(page, "Combos");
      const comboForm = page.getByRole("button", { name: "Create Combo", exact: true }).locator("xpath=ancestor::form");
      await comboForm.getByLabel("Combo Name", { exact: true }).fill(comboName);
      await comboForm.getByLabel("Combo Price", { exact: true }).fill("25");
      await comboForm.locator("select").first().selectOption("consumables");
      await comboForm.getByRole("button", { name: "Add Fixed Item", exact: true }).click();
      const fixed = comboForm.locator(".combo-config-row").first();
      await fixed.locator("select").first().selectOption({ label: itemName });
      await fixed.getByLabel("Qty", { exact: true }).fill("1");
      const comboResponsePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/commit_admin_data_change"));
      await comboForm.getByRole("button", { name: "Create Combo", exact: true }).click();
      const comboResponse = await comboResponsePromise;
      const comboResult = await readApiResponseBody(comboResponse) as Record<string, unknown>;
      expect(comboResponse.status()).toBe(200);
      evidence.comboAcknowledgedPath = persistCheckpoint("combo-acknowledged", { ...evidence, itemId, itemResult, comboResult });
      comboId = changedIds(comboResult, "combos")[0];
      expect(comboId).toBeTruthy();
      fixtureCreated = true;
      evidence.fixture = { itemId, comboId, itemResult, comboResult };
      evidence.fixtureCreatedPath = persistCheckpoint("fixture-created", evidence);
      await waitForSynced(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(page);
      const fixtureState = await readRestRows<{ version: number; data: unknown }>(page, origin.restBase, origin.headers, "app_state", {
        id: "eq.primary", select: "version,data"
      });
      expect(fixtureState[0].version).toBe(preflightVersion + 2);
      let expectedCompatibility = { version: fixtureState[0].version, hash: hash(fixtureState[0].data) };
      evidence.fixture = { ...(evidence.fixture as object), appState: expectedCompatibility };
      evidence.latestCompatibility = expectedCompatibility;
      evidence.fixtureVerifiedPath = persistCheckpoint("fixture-verified", evidence);

      for (const { mode, scenario } of selectedCases) {
        const contract = CUSTOMER_TAB_MUTATION_CONTRACTS[mode];
          activeCase = `${mode}-${scenario}`;
          activeTabId = undefined;
          raceDispatched = false;
          raceReconciled = false;
          const name = customerName(mode, scenario);
          const caseEvidence: Record<string, unknown> = { mode, scenario, customerName: name, contract };
          (evidence.cases as Array<Record<string, unknown>>).push(caseEvidence);

          await page.reload({ waitUntil: "domcontentloaded" });
          await waitForSynced(page);
          await openCustomerTab(page, name, (result) => {
            activeTabId = String(result.entity_id);
            caseEvidence.tabId = activeTabId;
            caseEvidence.openResult = result;
            caseEvidence.openCommand = acknowledgedCommand(originRequests, "open_customer_tab", result.mutation_id);
            caseEvidence.openPath = persistCheckpoint(`${activeCase}-tab-opened`, evidence);
          });
          await addBaselineItem(page, name, (result) => {
            caseEvidence.baselineAddResult = result;
            caseEvidence.baselineAddCommand = acknowledgedCommand(originRequests, "add_customer_tab_item", result.mutation_id);
            caseEvidence.baselinePath = persistCheckpoint(`${activeCase}-baseline-added`, evidence);
          });
          expect(activeTabId).toBeTruthy();
          const baselineItems = await readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "customer_tab_items", {
            organization_id: `eq.${organizationId}`, customer_tab_id: `eq.${activeTabId}`,
            select: "id,customer_tab_id,inventory_item_id,name,quantity,unit_price,combo_application_id"
          });
          expect(baselineItems).toEqual([expect.objectContaining({ inventory_item_id: itemId, quantity: 1, unit_price: 50, combo_application_id: null })]);
          const baselineLineId = String(baselineItems[0].id);
          await observer.page.reload({ waitUntil: "domcontentloaded" });
          await waitForSynced(observer.page);
          await openCustomerTab(observer.page, name);

          const [stockBeforeRows, movementsBefore, stateBefore] = await Promise.all([
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "inventory_items", {
              organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,stock_qty,active"
            }),
            readItemMovements(page, origin.restBase, origin.headers, itemId!),
            readRestRows<{ version: number; data: unknown }>(page, origin.restBase, origin.headers, "app_state", {
              id: "eq.primary", select: "version,data"
            })
          ]);
          expect({ version: stateBefore[0].version, hash: hash(stateBefore[0].data) }).toEqual(expectedCompatibility);
          const physicalStockBefore = Number(stockBeforeRows[0].stock_qty);

          const checkoutDialog = await prepareCheckout(page, name);
          checkoutCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
          page.on("dialog", dismissDialog);
          await checkoutDialog.getByRole("button", { name: "Issue Bill", exact: true }).click();
          const capturedCheckout = await checkoutCommand.captured;
          observer.page.on("dialog", dismissDialog);
          const operationalCapture = await captureOperationalMutation(observer.page, mode);
          operationalCommand = operationalCapture.command;
          const capturedOperational = operationalCapture.captured;
          expect(checkoutCommand.captureCount()).toBe(1);
          expect(operationalCommand.captureCount()).toBe(1);

          const checkoutEnvelope = withUniqueBillNumber(capturedCheckout, mode, scenario);
          const operationalEnvelope = structuredClone(capturedOperational.body) as OperationalEnvelope;
          const primaryBill = checkoutEnvelope.payload.payload.primary_bill as {
            id: string; billNumber: string; total: number; amountPaid: number; amountDue: number;
            lines?: Array<Record<string, unknown>>;
          };
          const operationalPayload = operationalEnvelope.payload.payload;
          expect(checkoutEnvelope.payload.entity_id).toBe(activeTabId);
          expect(checkoutEnvelope.payload.payload.source_customer_tab_ids).toEqual([activeTabId]);
          expect(primaryBill.billNumber).toBe(billNumber(mode, scenario));
          expect(Number(primaryBill.total)).toBe(50);
          expect(operationalEnvelope.payload).toEqual(expect.objectContaining({
            organization_id: organizationId,
            mutation_kind: contract.mutationKind,
            entity_id: activeTabId,
            user_id: mutationActor.actorId
          }));
          expect(operationalPayload.customerTabId).toBe(activeTabId);
          const candidateAudit = operationalPayload.auditLog as Record<string, unknown> | undefined;
          expect(candidateAudit ? 1 : 0).toBe(contract.expectedAuditCount);
          if (candidateAudit) {
            expect(candidateAudit).toEqual(expect.objectContaining({
              action: contract.auditAction,
              entityId: activeTabId,
              userId: mutationActor.actorId
            }));
          }
          expect(authenticatedJwtSubject(capturedCheckout.headers)).toBe(origin.actorId);
          expect(authenticatedJwtSubject(capturedOperational.headers)).toBe(mutationActor.actorId);
          const candidateComboApplication = operationalPayload.comboApplication as Record<string, unknown> | undefined;
          const candidateLine = operationalPayload.line as Record<string, unknown> | undefined;
          Object.assign(caseEvidence, {
            baselineLineId,
            checkoutMutationId: checkoutEnvelope.payload.mutation_id,
            operationalMutationId: operationalEnvelope.payload.mutation_id,
            candidateBillId: primaryBill.id,
            candidateBillNumber: primaryBill.billNumber,
            candidateAuditId: candidateAudit?.id ?? null,
            candidateLineId: candidateLine?.id ?? baselineLineId,
            candidateComboApplicationId: candidateComboApplication?.id ?? null,
            checkoutEnvelope,
            operationalEnvelope,
            appStateBefore: expectedCompatibility,
            physicalStockBefore,
            movementIdsBefore: movementsBefore.map((entry) => entry.id),
            captureCounts: { checkout: checkoutCommand.captureCount(), mutation: operationalCommand.captureCount() }
          });
          caseEvidence.preparedPath = persistCheckpoint(`${activeCase}-prepared`, evidence);

          raceDispatched = true;
          const submitAndCheckpoint = async (
            side: "checkout" | "mutation",
            command: NonNullable<typeof checkoutCommand>,
            envelope: CheckoutEnvelope | OperationalEnvelope
          ) => {
            const response = await command.submit(envelope);
            const body = await readApiResponseBody(response) as Record<string, unknown>;
            const raw = { status: response.status(), body };
            const recorded = (caseEvidence.responses ?? {}) as Record<string, unknown>;
            recorded[side] = raw;
            caseEvidence.responses = recorded;
            caseEvidence[`${side}ResponsePath`] = persistCheckpoint(`${activeCase}-${side}-response`, {
              ...evidence,
              latestRaceResponse: { side, ...raw }
            });
            return { response, body };
          };
          let checkoutResult: { response: APIResponse; body: Record<string, unknown> };
          let operationalResult: { response: APIResponse; body: Record<string, unknown> };
          if (scenario === "checkout_first") {
            checkoutResult = await submitAndCheckpoint("checkout", checkoutCommand, checkoutEnvelope);
            operationalResult = await submitAndCheckpoint("mutation", operationalCommand, operationalEnvelope);
          } else if (scenario === "mutation_first") {
            operationalResult = await submitAndCheckpoint("mutation", operationalCommand, operationalEnvelope);
            checkoutResult = await submitAndCheckpoint("checkout", checkoutCommand, checkoutEnvelope);
          } else {
            [checkoutResult, operationalResult] = await Promise.all([
              submitAndCheckpoint("checkout", checkoutCommand, checkoutEnvelope),
              submitAndCheckpoint("mutation", operationalCommand, operationalEnvelope)
            ]);
          }
          const { response: checkoutResponse, body: checkoutBody } = checkoutResult;
          const { response: operationalResponse, body: operationalBody } = operationalResult;
          Object.assign(caseEvidence, {
            responses: {
              checkout: { status: checkoutResponse.status(), body: checkoutBody },
              mutation: { status: operationalResponse.status(), body: operationalBody }
            }
          });
          caseEvidence.responsesPath = persistCheckpoint(`${activeCase}-responses`, evidence);
          const winner = classifyCustomerTabRaceResponses(checkoutResponse.status(), operationalResponse.status());
          const deterministicWinner = expectedCustomerTabRaceWinner(scenario);
          if (deterministicWinner) expect(winner).toBe(deterministicWinner);
          expect(rpcRejectionCode(winner === "checkout" ? operationalBody : checkoutBody))
            .toBe(expectedCustomerTabRaceLoserCode(winner));
          caseEvidence.winner = winner;

          const checkoutStatus = await mutationStatus(page, capturedCheckout, checkoutEnvelope.payload);
          const expectedCheckoutAudits = checkoutEnvelope.payload.payload.audit_logs;
          const expectedPayments = checkoutEnvelope.payload.payload.payments;
          const expectedMovements = checkoutEnvelope.payload.payload.stock_movements;
          const expectedLines = primaryBill.lines ?? [];
          const expectedAuditIds = expectedCheckoutAudits.map((entry) => String(entry.id));
          const candidateAuditId = candidateAudit?.id ? String(candidateAudit.id) : null;
          const [tabs, tabItems, comboApplications, billRows, lineRows, paymentRows, checkoutEvents, operationalEvents,
            checkoutAudits, operationalAudits, movementsAfter, stockAfterRows, stateAfter] = await Promise.all([
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "customer_tabs", {
              organization_id: `eq.${organizationId}`, id: `eq.${activeTabId}`,
              select: "id,status,close_disposition,closed_bill_id,customer_name"
            }),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "customer_tab_items", {
              organization_id: `eq.${organizationId}`, customer_tab_id: `eq.${activeTabId}`,
              select: "id,customer_tab_id,inventory_item_id,name,quantity,unit_price,combo_application_id,combo_id"
            }),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "customer_tab_combo_applications", {
              organization_id: `eq.${organizationId}`, customer_tab_id: `eq.${activeTabId}`,
              select: "id,customer_tab_id,combo_id,combo_name,price"
            }),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "bills", {
              organization_id: `eq.${organizationId}`, id: `eq.${primaryBill.id}`,
              select: "id,bill_number,status,total,amount_paid,amount_due,issued_by_user_id"
            }),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "bill_lines", {
              organization_id: `eq.${organizationId}`, bill_id: `eq.${primaryBill.id}`,
              select: "id,bill_id,type,inventory_item_id,quantity,unit_price,total"
            }),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "payments", {
              organization_id: `eq.${organizationId}`, bill_id: `eq.${primaryBill.id}`,
              select: "id,bill_id,amount,mode,received_by_user_id"
            }),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "operational_events", {
              organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${checkoutEnvelope.payload.mutation_id}`,
              select: "id,event_type,entity_type,entity_id,created_by,metadata"
            }),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "operational_events", {
              organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `eq.${operationalEnvelope.payload.mutation_id}`,
              select: "id,event_type,entity_type,entity_id,created_by,metadata"
            }),
            expectedAuditIds.length ? readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "audit_logs", {
              organization_id: `eq.${organizationId}`, id: `in.(${expectedAuditIds.join(",")})`,
              select: "id,action,entity_type,entity_id,user_id"
            }) : Promise.resolve([]),
            candidateAuditId ? readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "audit_logs", {
              organization_id: `eq.${organizationId}`, id: `eq.${candidateAuditId}`,
              select: "id,action,entity_type,entity_id,user_id"
            }) : Promise.resolve([]),
            readItemMovements(page, origin.restBase, origin.headers, itemId!),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "inventory_items", {
              organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,stock_qty,active"
            }),
            readRestRows<{ version: number; data: unknown }>(page, origin.restBase, origin.headers, "app_state", {
              id: "eq.primary", select: "version,data"
            })
          ]);
          expect(tabs).toHaveLength(1);
          expect({ version: stateAfter[0].version, hash: hash(stateAfter[0].data) }).toEqual(expectedCompatibility);
          const movementDelta = movementsAfter.filter((entry) => !movementsBefore.some((before) => before.id === entry.id));
          const physicalStockAfter = Number(stockAfterRows[0].stock_qty);
          const logicalReservation = tabs[0].status === "open"
            ? tabItems.filter((entry) => entry.inventory_item_id === itemId)
              .reduce((sum, entry) => sum + Number(entry.quantity), 0)
            : 0;

          if (winner === "checkout") {
            expect(tabs[0]).toEqual(expect.objectContaining({ status: "closed", close_disposition: "billed", closed_bill_id: primaryBill.id }));
            expect(billRows).toEqual([expect.objectContaining({
              id: primaryBill.id, bill_number: primaryBill.billNumber, status: "issued", total: 50,
              amount_paid: 50, amount_due: 0, issued_by_user_id: origin.actorId
            })]);
            expect(new Set(lineRows.map((entry) => entry.id))).toEqual(new Set(expectedLines.map((entry) => String(entry.id))));
            expect(new Set(paymentRows.map((entry) => entry.id))).toEqual(new Set(expectedPayments.map((entry) => String(entry.id))));
            expect(checkoutEvents).toEqual([expect.objectContaining({
              id: checkoutStatus?.event_id, event_type: "financial_checkout_committed_v2",
              entity_id: activeTabId, created_by: origin.actorId
            })]);
            expect(checkoutStatus?.bill_id).toBe(primaryBill.id);
            expect(checkoutAudits).toHaveLength(expectedCheckoutAudits.length);
            expect(checkoutAudits.every((entry) => entry.user_id === origin.actorId)).toBe(true);
            expect(operationalEvents).toEqual([]);
            expect(operationalAudits).toEqual([]);
            expect(comboApplications).toEqual([]);
            expect(tabItems).toEqual([expect.objectContaining({ id: baselineLineId, quantity: 1, combo_application_id: null })]);
            expect(logicalReservation).toBe(0);
            expect(movementDelta.map((entry) => entry.id).sort()).toEqual(expectedMovements.map((entry) => String(entry.id)).sort());
            expect(movementDelta).toEqual([expect.objectContaining({ item_id: itemId, type: "sale", quantity: -1, user_id: origin.actorId, related_bill_id: primaryBill.id })]);
            expect(physicalStockAfter).toBe(physicalStockBefore - 1);
          } else {
            expect(tabs[0]).toEqual(expect.objectContaining({ status: "open", close_disposition: null, closed_bill_id: null }));
            expect(billRows).toEqual([]);
            expect(lineRows).toEqual([]);
            expect(paymentRows).toEqual([]);
            expect(checkoutEvents).toEqual([]);
            expect(checkoutAudits).toEqual([]);
            expect(checkoutStatus).toBeNull();
            expect(operationalEvents).toEqual([expect.objectContaining({
              event_type: contract.eventType, entity_type: "customer_tab", entity_id: activeTabId,
              created_by: mutationActor.actorId
            })]);
            expect(operationalEvents[0].id).toBe(operationalBody.event_id);
            expect(operationalAudits).toHaveLength(contract.expectedAuditCount);
            if (candidateAuditId) expect(operationalAudits[0]).toEqual(expect.objectContaining({
              id: candidateAuditId, action: contract.auditAction, entity_id: activeTabId, user_id: mutationActor.actorId
            }));
            expect(movementDelta).toEqual([]);
            expect(physicalStockAfter).toBe(physicalStockBefore);
            expect(logicalReservation).toBe(1 + contract.expectedReservationDelta);
            if (mode === "add_item" || mode === "update_item") {
              expect(tabItems).toEqual([expect.objectContaining({ id: baselineLineId, quantity: 2, combo_application_id: null })]);
              expect(comboApplications).toEqual([]);
            } else if (mode === "remove_item") {
              expect(tabItems).toEqual([]);
              expect(comboApplications).toEqual([]);
            } else {
              expect(tabItems).toHaveLength(2);
              expect(tabItems).toContainEqual(expect.objectContaining({ id: baselineLineId, quantity: 1, combo_application_id: null }));
              expect(comboApplications).toEqual([expect.objectContaining({
                id: candidateComboApplication?.id, customer_tab_id: activeTabId, combo_id: comboId, combo_name: comboName, price: 25
              })]);
              expect(tabItems.filter((entry) => entry.combo_application_id === candidateComboApplication?.id))
                .toEqual([expect.objectContaining({ inventory_item_id: itemId, quantity: 1 })]);
            }
            expect(changedIds(operationalBody, "operational_events")).toEqual([String(operationalEvents[0].id)]);
            expect(changedIds(operationalBody, "audit_logs")).toHaveLength(contract.expectedAuditCount);
            expect(changedIds(operationalBody, "stock_movements")).toEqual([]);
          }

          Object.assign(caseEvidence, {
            checkoutMutationStatus: checkoutStatus,
            database: { tabs, tabItems, comboApplications, bills: billRows, lines: lineRows, payments: paymentRows,
              checkoutEvents, operationalEvents, checkoutAudits, operationalAudits, movementDelta,
              physicalStockBefore, physicalStockAfter, logicalReservation,
              appState: { version: stateAfter[0].version, hash: hash(stateAfter[0].data) } }
          });
          raceReconciled = true;
          caseEvidence.reconciledPath = persistCheckpoint(`${activeCase}-reconciled`, evidence);

          await Promise.all([checkoutCommand.dispose(), operationalCommand.dispose()]);
          checkoutCommand = undefined;
          operationalCommand = undefined;
          page.off("dialog", dismissDialog);
          observer.page.off("dialog", dismissDialog);

          if (winner === "mutation") {
            await observer.page.reload({ waitUntil: "domcontentloaded" });
            await waitForSynced(observer.page);
            const reason = `Playwright tab mutation race cleanup ${runId} ${mode} ${scenario}`;
            const rejected = await rejectTab(observer.page, name, reason);
            caseEvidence.cleanupAcknowledgedPath = persistCheckpoint(`${activeCase}-cleanup-acknowledged`, {
              ...evidence,
              pendingCleanupAcknowledgement: { tabId: activeTabId, reason, result: rejected }
            });
            caseEvidence.cleanup = {
              reason,
              result: rejected,
              command: acknowledgedCommand(observerRequests, "reject_customer_tab", rejected.mutation_id)
            };
            const [cleanedTab, cleanupState] = await Promise.all([
              readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "customer_tabs", {
                organization_id: `eq.${organizationId}`, id: `eq.${activeTabId}`,
                select: "id,status,close_disposition,closed_bill_id"
              }),
              readRestRows<{ version: number; data: unknown }>(page, origin.restBase, origin.headers, "app_state", {
                id: "eq.primary", select: "version,data"
              })
            ]);
            expect(cleanedTab).toEqual([{ id: activeTabId, status: "closed", close_disposition: "rejected", closed_bill_id: null }]);
            expect(cleanupState[0].version).toBe(expectedCompatibility.version + 1);
            expectedCompatibility = { version: cleanupState[0].version, hash: hash(cleanupState[0].data) };
            evidence.latestCompatibility = expectedCompatibility;
            caseEvidence.cleanup = { ...(caseEvidence.cleanup as object), tab: cleanedTab[0], appState: expectedCompatibility };
            caseEvidence.cleanupPath = persistCheckpoint(`${activeCase}-cleanup`, evidence);
          }

          await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), observer.page.reload({ waitUntil: "domcontentloaded" })]);
          if (winner === "checkout") {
            await waitForSynced(page);
            await expect(observer.page.getByText("1 conflict", { exact: true })).toBeVisible();
            await expect(observer.page.getByText("Pending sync.", { exact: false })).toHaveCount(0);
            caseEvidence.loserConflictVisible = true;
            await observer.page.getByRole("button", { name: "Clear", exact: true }).click();
            await waitForSynced(observer.page);
          } else {
            await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);
          }
          const [openTabs, reservations] = await Promise.all([
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "customer_tabs", {
              organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,customer_name,status"
            }),
            readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "customer_tab_items", {
              organization_id: `eq.${organizationId}`, customer_tab_id: `eq.${activeTabId}`, select: "id,quantity,inventory_item_id"
            })
          ]);
          expect(openTabs).toEqual([]);
          caseEvidence.postCase = { openTabs, retainedRows: reservations, logicalReservation: 0 };
          caseEvidence.postCasePath = persistCheckpoint(`${activeCase}-postcase`, evidence);
      }

      await openInventory(page, "Combos");
      const comboRow = page.locator(".combo-list-row").filter({ has: page.getByText(comboName, { exact: true }) });
      await expect(comboRow).toHaveCount(1);
      const comboArchivePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/commit_admin_data_change"));
      await comboRow.getByRole("button", { name: "Archive", exact: true }).click();
      const comboArchiveResponse = await comboArchivePromise;
      const comboArchive = await readApiResponseBody(comboArchiveResponse) as Record<string, unknown>;
      expect(comboArchiveResponse.status()).toBe(200);
      evidence.comboArchiveAcknowledgedPath = persistCheckpoint("combo-archive-acknowledged", { ...evidence, comboArchive });
      await waitForSynced(page);
      const stateAfterComboArchive = await readRestRows<{ version: number; data: unknown }>(
        page, origin.restBase, origin.headers, "app_state", { id: "eq.primary", select: "version,data" }
      );
      expect(stateAfterComboArchive[0].version).toBe(expectedCompatibility.version + 1);
      expectedCompatibility = { version: stateAfterComboArchive[0].version, hash: hash(stateAfterComboArchive[0].data) };
      evidence.latestCompatibility = expectedCompatibility;
      evidence.comboArchiveVerifiedPath = persistCheckpoint("combo-archive-verified", {
        ...evidence, comboArchive, appState: expectedCompatibility
      });

      await openInventory(page, "Catalog");
      const itemRow = page.locator(".inventory-table-wrap tbody tr").filter({ has: page.getByText(itemName, { exact: true }) });
      await expect(itemRow).toHaveCount(1);
      await itemRow.getByRole("button", { name: "Archive", exact: true }).click();
      const archiveDialog = page.getByRole("dialog", { name: `Archive Inventory Item - ${itemName}`, exact: true });
      const archiveReason = `Release B tab mutation race fixture cleanup ${runId}`;
      await archiveDialog.getByPlaceholder("Not restocking, duplicate item, incorrect setup...").fill(archiveReason);
      const itemArchivePromise = page.waitForResponse((response) => response.url().includes("/rest/v1/rpc/commit_admin_data_change"));
      await archiveDialog.getByRole("button", { name: "Archive Item", exact: true }).click();
      const itemArchiveResponse = await itemArchivePromise;
      const itemArchive = await readApiResponseBody(itemArchiveResponse) as Record<string, unknown>;
      expect(itemArchiveResponse.status()).toBe(200);
      evidence.itemArchiveAcknowledgedPath = persistCheckpoint("item-archive-acknowledged", {
        ...evidence, comboArchive, itemArchive, archiveReason
      });
      fixtureArchived = true;
      await waitForSynced(page);
      const stateAfterItemArchive = await readRestRows<{ version: number; data: unknown }>(
        page, origin.restBase, origin.headers, "app_state", { id: "eq.primary", select: "version,data" }
      );
      expect(stateAfterItemArchive[0].version).toBe(expectedCompatibility.version + 1);
      expectedCompatibility = { version: stateAfterItemArchive[0].version, hash: hash(stateAfterItemArchive[0].data) };
      evidence.latestCompatibility = expectedCompatibility;
      evidence.itemArchiveVerifiedPath = persistCheckpoint("item-archive-verified", {
        ...evidence, comboArchive, itemArchive, archiveReason, appState: expectedCompatibility
      });

      const [finalItem, finalCombo, openSessions, openTabs, finalMovements, finalState] = await Promise.all([
        readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "inventory_items", {
          organization_id: `eq.${organizationId}`, id: `eq.${itemId}`, select: "id,name,stock_qty,active"
        }),
        readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "combos", {
          organization_id: `eq.${organizationId}`, id: `eq.${comboId}`, select: "id,name,active,type"
        }),
        readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "sessions", {
          organization_id: `eq.${organizationId}`, status: "neq.closed", select: "id,status"
        }),
        readRestRows<Record<string, unknown>>(page, origin.restBase, origin.headers, "customer_tabs", {
          organization_id: `eq.${organizationId}`, status: "eq.open", select: "id,status"
        }),
        readItemMovements(page, origin.restBase, origin.headers, itemId!),
        readRestRows<{ version: number; data: unknown }>(page, origin.restBase, origin.headers, "app_state", {
          id: "eq.primary", select: "version,data"
        })
      ]);
      expect(finalItem).toEqual([expect.objectContaining({ id: itemId, name: itemName, active: false })]);
      expect(finalCombo).toEqual([{ id: comboId, name: comboName, active: false, type: "consumables" }]);
      expect(openSessions).toEqual([]);
      expect(openTabs).toEqual([]);
      expect(finalMovements.every((entry) => entry.type === "sale" && Number(entry.quantity) === -1)).toBe(true);
      expect({ version: finalState[0].version, hash: hash(finalState[0].data) }).toEqual(expectedCompatibility);
      evidence.cleanup = { comboArchive, itemArchive, archiveReason };
      evidence.final = {
        item: finalItem[0], combo: finalCombo[0], openSessions, openTabs, stockMovements: finalMovements,
        appState: { version: finalState[0].version, hash: hash(finalState[0].data) }
      };
      evidence.finalPath = persistCheckpoint("final", evidence);
      expect(originErrors.consoleErrors).toEqual([]);
      expect(observerErrors.consoleErrors).toEqual([]);
      [...originErrors.pageErrors, ...observerErrors.pageErrors].forEach((message) => expect(message).toMatch(
        /customer tab is no longer open|Bill inventory rows do not match the locked session or tab items/i
      ));
      await attachJson(testInfo, "checkout-tab-mutation-race-evidence", evidence);
    } catch (error) {
      primaryError = error;
      evidence.failure = {
        activeCase, activeTabId, raceDispatched, raceReconciled,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      };
      persistCheckpoint(`failure-${activeCase ?? "setup"}`, evidence);
      throw error;
    } finally {
      checkoutCommand?.cancel();
      operationalCommand?.cancel();
      await Promise.all([
        checkoutCommand?.dispose().catch(() => undefined),
        operationalCommand?.dispose().catch(() => undefined)
      ]);
      page.off("dialog", dismissDialog);
      observer.page.off("dialog", dismissDialog);
      if (raceDispatched && !raceReconciled) {
        cleanupError = "Race commands were dispatched; run the exact read-only reconciler before cleanup or retry.";
      } else if (fixtureCreated && !fixtureArchived && !primaryError) {
        cleanupError = "The QA item/combo fixture was created but not archived.";
      }
      await attachJson(testInfo, "checkout-tab-mutation-race-lifecycle", {
        runId, itemId, comboId, fixtureCreated, fixtureArchived, activeCase, activeTabId,
        raceDispatched, raceReconciled, cleanupError, rpcEvidence, originErrors, observerErrors, evidence
      });
      await attachFailureScreenshot(testInfo, page, "checkout-tab-mutation-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "checkout-tab-mutation-observer-failure");
      await observer.context.close();
      // eslint-disable-next-line no-unsafe-finally
      if (!primaryError && cleanupError) throw new Error(cleanupError);
    }
  });
});
