import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
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
  signIn,
  startSession,
  stationCard,
  type AuthoritativeOrganizationIdentity,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

type CheckoutEnvelope = {
  payload: {
    organization_id: string;
    mutation_id: string;
    mutation_kind: string;
    entity_id: string;
    payload: {
      primary_bill: { id: string; billNumber: string; lines: Array<{ id: string }> };
      bill_updates: Array<{ id: string; billNumber: string }>;
      payments: Array<{ id: string; billId: string; mode: string; amount: number; relatedCheckoutBillId?: string; settlementGroupId?: string }>;
      settlement_expectations: Array<{ billId: string; expectedStatus: string; expectedAmountDue: number; settlementAmount: number; intendedAmountDue: number }>;
      audit_logs: Array<{ id: string; action: string; entityId: string; entityType?: string; message?: string }>;
      stock_movements: Array<{ id: string }>;
      source_session_ids: string[];
      session_updates: Array<{
        id: string;
        startedAt?: string;
        endedAt?: string;
        customerName?: string;
        customerPhone?: string;
      }>;
    };
  };
};

type CommittedCheckout = {
  label: "source" | "current";
  envelope: CheckoutEnvelope;
  responseStatus: number;
  responseBody: Record<string, unknown>;
  result: RpcEvidence;
  preparedPath: string;
  responsePath: string;
  captureCount: 1;
  submissionCount: 1;
  timings: BrowserMutationTiming;
};

type TimingPoint = { iso: string; monotonicMs: number };
type BrowserMutationTiming = {
  uiAction: TimingPoint;
  submission: TimingPoint;
  response: TimingPoint;
  uiTerminal: TimingPoint;
  responseMs: number;
  browserCompletionMs: number;
  uiActionToTerminalMs: number;
};

const root = process.cwd();
const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const selectedCase = process.env.E2E_PAYMENT_MATRIX_CASE ?? "missing-case";
const allowedCases = ["upi", "split", "partial_previous_dues"] as const;
if (!allowedCases.includes(selectedCase as (typeof allowedCases)[number])) {
  throw new Error("E2E_PAYMENT_MATRIX_CASE must be exactly upi, split, or partial_previous_dues.");
}
const station = "8 Ball Pool";
const organizationId = "org-primary";
const customerName = `QA Payment Matrix ${selectedCase.replaceAll("_", " ")} ${runId}`;
const evidenceDirectory = path.join(root, "test-artifacts", "evidence");

function timingPoint(): TimingPoint {
  return { iso: new Date().toISOString(), monotonicMs: performance.now() };
}

function elapsed(start: TimingPoint, end: TimingPoint) {
  return Number((end.monotonicMs - start.monotonicMs).toFixed(3));
}

function sanitizedErrorMessage(error: unknown) {
  if (error === undefined) return undefined;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/((?:api[-_]?key|authorization|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .slice(0, 2_000);
}

function assertEvidenceContainsNoSecrets(value: unknown) {
  const forbidden: string[] = [];
  const scan = (entry: unknown, currentPath: string) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => scan(item, `${currentPath}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      const childPath = `${currentPath}.${key}`;
      if (/^(authorization|apikey|password|access_token|refresh_token)$/i.test(key)) forbidden.push(childPath);
      scan(child, childPath);
    }
  };
  scan(value, "evidence");
  if (forbidden.length) throw new Error(`Refusing to persist sensitive payment-matrix evidence: ${forbidden.join(", ")}`);
}

function writeEvidence(stage: string, evidence: Record<string, unknown>) {
  const value = {
    runId,
    selectedCase,
    stage,
    recordedAt: new Date().toISOString(),
    productionAllowed: false,
    safeForAutomaticRetry: false,
    ...evidence
  };
  assertEvidenceContainsNoSecrets(value);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const target = path.join(evidenceDirectory, `checkout-payment-matrix-${selectedCase}-${stage}-${runId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
  return path.relative(root, target);
}

function commandSummary(envelope: CheckoutEnvelope) {
  return {
    mutationId: envelope.payload.mutation_id,
    mutationKind: envelope.payload.mutation_kind,
    organizationId: envelope.payload.organization_id,
    entityId: envelope.payload.entity_id,
    billId: envelope.payload.payload.primary_bill.id,
    billNumber: envelope.payload.payload.primary_bill.billNumber,
    billLineIds: envelope.payload.payload.primary_bill.lines.map((entry) => entry.id),
    paymentIds: envelope.payload.payload.payments.map((entry) => entry.id),
    auditIds: envelope.payload.payload.audit_logs.map((entry) => entry.id),
    movementIds: envelope.payload.payload.stock_movements.map((entry) => entry.id),
    settlementBillIds: envelope.payload.payload.settlement_expectations.map((entry) => entry.billId)
  };
}

function assertCapturedCheckoutEnvelope(value: unknown) {
  const envelope = structuredClone(value) as CheckoutEnvelope;
  expect(envelope.payload.organization_id).toBe(organizationId);
  expect(envelope.payload.mutation_kind).toBe("commitCheckoutBill");
  expect(envelope.payload.mutation_id).toBeTruthy();
  expect(envelope.payload.entity_id).toBeTruthy();
  expect(envelope.payload.payload.primary_bill.id).toBeTruthy();
  expect(envelope.payload.payload.primary_bill.billNumber).toBeTruthy();
  expect(envelope.payload.payload.bill_updates.some((bill) => bill.id === envelope.payload.payload.primary_bill.id)).toBe(true);
  return envelope;
}

async function appStateSnapshot(page: Page, identity: AuthoritativeOrganizationIdentity) {
  const rows = await readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
    id: "eq.primary",
    select: "version,data"
  });
  expect(rows).toHaveLength(1);
  return {
    version: rows[0].version,
    hash: createHash("sha256").update(JSON.stringify(rows[0].data)).digest("hex")
  };
}

async function readBill(page: Page, identity: AuthoritativeOrganizationIdentity, billId: string) {
  const rows = await readRestRows<Record<string, unknown>>(page, identity.restBase, identity.headers, "bills", {
    organization_id: `eq.${organizationId}`,
    id: `eq.${billId}`,
    select: "id,bill_number,status,payment_mode,total,amount_paid,amount_due,customer_name"
  });
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function openBillRegisterRow(page: Page, billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  return row;
}

async function readCheckoutTotal(checkout: Locator) {
  const total = checkout.getByText("Total", { exact: true }).locator("..").locator("strong");
  let amount = 0;
  await expect.poll(async () => {
    amount = Number((await total.innerText()).replace(/[^\d.-]/g, ""));
    return amount;
  }, { message: "Checkout total must reflect the edited session timing before payment is configured." }).toBeGreaterThan(10);
  return amount;
}

async function startSessionDespitePendingBill(page: Page) {
  const card = stationCard(page, station);
  await expect(card).toContainText("Available");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  const start = page.getByRole("dialog", { name: "Start New Session", exact: true });
  await start.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const playMode = start.getByLabel("Play Mode", { exact: true });
  if (await playMode.count()) await playMode.selectOption("group");
  await start.getByRole("button", { name: "Start Session", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Outstanding Pending Bills", exact: true });
  await expect(warning).toContainText(customerName);
  await warning.getByRole("button", { name: "Continue Anyway", exact: true }).click();
  await expect(warning).toBeHidden();
  await expect(start).toBeHidden();
  await waitForSynced(page);
  await expect(card).toContainText(customerName);
}

async function prepareTimedCheckout(page: Page, continueDespitePending = false) {
  if (continueDespitePending) await startSessionDespitePendingBill(page);
  else await startSession(page, station, customerName);
  const sessionDialog = await openManagedSession(page, station);
  await sessionDialog.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
  const expectedStart = await browserDateTimeLocal(page, -10);
  await sessionDialog.getByLabel("Session Start Time", { exact: true }).fill(expectedStart);
  const saveResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes("/rest/v1/rpc/save_live_session_details")
  );
  await sessionDialog.getByRole("button", { name: "Save Session Details", exact: true }).click();
  expect((await saveResponse).status(), "The edited start time must be acknowledged before checkout opens.").toBe(200);
  await waitForSynced(page);
  await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
  const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
  await expect(checkout.getByLabel("Session Start Time", { exact: true })).toHaveValue(expectedStart);
  const expectedEnd = await browserDateTimeLocal(page, -1);
  await checkout.getByLabel("Session End Time", { exact: true }).fill(expectedEnd);
  await expect(checkout.getByLabel("Session End Time", { exact: true })).toHaveValue(expectedEnd);
  await readCheckoutTotal(checkout);
  return checkout;
}

async function waitForExactRpcEvidence(rpcEvidence: RpcEvidence[], mutationId: string) {
  await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.mutationId === mutationId).length)
    .toBe(1);
  return rpcEvidence.find((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.mutationId === mutationId)!;
}

async function commitCheckoutOnce(
  page: Page,
  checkout: Locator,
  label: "source" | "current",
  rpcEvidence: RpcEvidence[],
  identity: AuthoritativeOrganizationIdentity,
  preparedContext: Record<string, unknown>
): Promise<CommittedCheckout> {
  const command = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/commit_checkout_bill_v2");
  let captured = false;
  try {
    const uiAction = timingPoint();
    await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
    const request = await command.captured;
    captured = true;
    expect(command.captureCount()).toBe(1);
    expect(command.wasSubmitted()).toBe(false);
    const envelope = assertCapturedCheckoutEnvelope(request.body);
    const summary = commandSummary(envelope);
    const authoritativePreSubmitSessions = await readRestRows<Record<string, unknown>>(
      page,
      identity.restBase,
      identity.headers,
      "sessions",
      {
        organization_id: `eq.${organizationId}`,
        id: `in.(${envelope.payload.payload.source_session_ids.join(",")})`,
        select: "id,started_at,ended_at,customer_name,customer_phone,status,closed_bill_id,close_disposition"
      }
    );
    expect(authoritativePreSubmitSessions).toHaveLength(envelope.payload.payload.source_session_ids.length);
    const preparedPath = writeEvidence(`${label}-prepared`, {
      status: "captured-not-submitted",
      customerName,
      command: envelope,
      commandSummary: summary,
      captureCount: command.captureCount(),
      submissionCount: 0,
      authoritativePreSubmitSessions,
      ...preparedContext
    });

    const submission = timingPoint();
    const response = await command.submit(envelope);
    const responseBody = await readApiResponseBody(response);
    const responseReceived = timingPoint();
    expect(command.wasSubmitted()).toBe(true);
    expect(command.captureCount()).toBe(1);
    const responsePath = writeEvidence(`${label}-response`, {
      status: "response-received",
      customerName,
      preparedPath,
      commandSummary: summary,
      captureCount: command.captureCount(),
      submissionCount: 1,
      response: { status: response.status(), body: responseBody },
      timings: {
        uiAction,
        submission,
        response: responseReceived,
        responseMs: elapsed(submission, responseReceived)
      }
    });
    expect(response.status()).toBe(200);
    expect(responseBody.mutation_id).toBe(summary.mutationId);
    expect(responseBody.bill_id).toBe(summary.billId);
    expect(responseBody.bill_number).toBe(summary.billNumber);
    await expect(checkout).toBeHidden();
    await waitForSynced(page);
    const uiTerminal = timingPoint();
    const timings: BrowserMutationTiming = {
      uiAction,
      submission,
      response: responseReceived,
      uiTerminal,
      responseMs: elapsed(submission, responseReceived),
      browserCompletionMs: elapsed(submission, uiTerminal),
      uiActionToTerminalMs: elapsed(uiAction, uiTerminal)
    };
    expect(timings.responseMs).toBeGreaterThanOrEqual(0);
    expect(timings.browserCompletionMs).toBeGreaterThanOrEqual(timings.responseMs);
    expect(timings.browserCompletionMs).toBeLessThan(7_000);
    const result = await waitForExactRpcEvidence(rpcEvidence, summary.mutationId);
    expect(result.status).toBe(200);
    expect(result.billId).toBe(summary.billId);
    expect(result.billNumber).toBe(summary.billNumber);
    expect(result.eventId).toBe(responseBody.event_id);
    return { label, envelope, responseStatus: response.status(), responseBody, result, preparedPath, responsePath, captureCount: 1, submissionCount: 1, timings };
  } finally {
    if (!captured || !command.wasSubmitted()) command.cancel();
    await command.dispose();
    expect(command.captureCount()).toBeLessThanOrEqual(1);
  }
}

test("selected payment and previous-dues path commits once and reconciles after refresh", async ({ browser, page }, testInfo) => {
  const observer = await createObserver(browser);
  const rpcEvidence: RpcEvidence[] = [];
  const authenticatedRequests: CapturedRpcRequest[] = [];
  captureAuthenticatedRestRequests(page, authenticatedRequests);
  const originErrors = capturePageErrors(page);
  const observerErrors = capturePageErrors(observer.page);
  captureRpcEvidence(page, "origin", rpcEvidence);
  captureRpcEvidence(observer.page, "observer", rpcEvidence);
  let originIdentity: AuthoritativeOrganizationIdentity | undefined;
  let currentSessionStarted = false;
  let currentIssueClicked = false;
  let sourceSessionStarted = false;
  let sourceIssueClicked = false;
  let sourceCommit: CommittedCheckout | undefined;
  let currentCommit: CommittedCheckout | undefined;
  let primaryError: unknown;
  const financialWindows: Array<{ label: string; before: unknown; after?: unknown }> = [];

  try {
    await signIn(page, credentials("A"));
    originIdentity = await assertAuthoritativeOrganizationIdentity(page, authenticatedRequests, "admin", organizationId);
    await page.waitForTimeout(1_200);
    await signIn(observer.page, credentials("B"));
    await observer.page.waitForTimeout(1_200);
    expect(await stationCard(page, station).innerText(), "The payment-matrix station is occupied.").toContain("Available");

    if (selectedCase === "partial_previous_dues") {
      sourceSessionStarted = true;
      const sourceCheckout = await prepareTimedCheckout(page);
      await sourceCheckout.locator("label").filter({ hasText: "Payment Mode" }).locator("select").selectOption("deferred");
      const sourceBefore = await appStateSnapshot(page, originIdentity);
      financialWindows.push({ label: "deferred_source", before: sourceBefore });
      sourceIssueClicked = true;
      sourceCommit = await commitCheckoutOnce(page, sourceCheckout, "source", rpcEvidence, originIdentity, { financialWindowBefore: sourceBefore });
      financialWindows[0].after = await appStateSnapshot(page, originIdentity);
      expect(financialWindows[0].after).toEqual(sourceBefore);
      const sourceBill = await readBill(page, originIdentity, String(sourceCommit.responseBody.bill_id));
      expect(sourceBill.status).toBe("pending");
      const sourceTotal = Number(sourceBill.total);
      expect(sourceTotal).toBeGreaterThan(10);
      writeEvidence("source-committed", {
        status: "source-confirmed",
        customerName,
        sourceCommit,
        sourceBill,
        financialWindows
      });

      currentSessionStarted = true;
      const currentCheckout = await prepareTimedCheckout(page, true);
      await expect(currentCheckout.getByText("Previous Dues", { exact: true })).toBeVisible();
      await expect(currentCheckout).toContainText(String(sourceCommit.responseBody.bill_number));
      await currentCheckout.locator("label").filter({ hasText: "Payment Mode" }).locator("select").selectOption("deferred");
      const collectUpfront = currentCheckout.getByLabel("Collect Upfront (optional)", { exact: true });
      await collectUpfront.fill("20");
      await collectUpfront.blur();
      await expect(collectUpfront).toHaveValue("20");
      const upfrontMode = currentCheckout.getByRole("combobox", { name: "Upfront Mode", exact: true });
      await expect(upfrontMode).toBeEnabled();
      await upfrontMode.selectOption("upi");
      await expect(upfrontMode).toHaveValue("upi");
      const previousDuesMode = currentCheckout.getByRole("combobox", { name: "Previous Dues Payment", exact: true });
      await previousDuesMode.selectOption("split");
      await expect(previousDuesMode).toHaveValue("split");
      const previousCash = currentCheckout.getByRole("textbox", { name: "Previous Cash", exact: true });
      await previousCash.fill("10");
      await previousCash.blur();
      await expect(previousCash).toHaveValue("10");
      const previousUpiAmount = String(sourceTotal - 10);
      const previousUpi = currentCheckout.getByRole("textbox", { name: "Previous UPI", exact: true });
      await previousUpi.fill(previousUpiAmount);
      await previousUpi.blur();
      await expect(previousUpi).toHaveValue(previousUpiAmount);
      const currentBefore = await appStateSnapshot(page, originIdentity);
      financialWindows.push({ label: "partial_with_previous_dues", before: currentBefore });
      currentIssueClicked = true;
      currentCommit = await commitCheckoutOnce(page, currentCheckout, "current", rpcEvidence, originIdentity, {
        sourceCommandSummary: commandSummary(sourceCommit.envelope),
        sourceResponse: sourceCommit.responseBody,
        sourceBill,
        financialWindowBefore: currentBefore
      });
      financialWindows[1].after = await appStateSnapshot(page, originIdentity);
      expect(financialWindows[1].after).toEqual(currentBefore);
      const currentBill = await readBill(page, originIdentity, String(currentCommit.responseBody.bill_id));
      expect(currentBill.status).toBe("pending");
      expect(Number(currentBill.amount_paid)).toBe(20);
      expect(Number(currentBill.amount_due)).toBe(Number(currentBill.total) - 20);
    } else {
      currentSessionStarted = true;
      const checkout = await prepareTimedCheckout(page);
      await checkout.locator("label").filter({ hasText: "Payment Mode" }).locator("select").selectOption(selectedCase);
      if (selectedCase === "split") {
        const total = await readCheckoutTotal(checkout);
        const upiAmount = Math.round((total - 10) * 100) / 100;
        await checkout.getByLabel("UPI Amount", { exact: true }).fill(String(upiAmount));
        await expect(checkout.getByLabel("Cash Amount", { exact: true })).toHaveValue("10");
        await expect(checkout.getByLabel("UPI Amount", { exact: true })).toHaveValue(String(upiAmount));
      }
      const before = await appStateSnapshot(page, originIdentity);
      financialWindows.push({ label: selectedCase, before });
      currentIssueClicked = true;
      currentCommit = await commitCheckoutOnce(page, checkout, "current", rpcEvidence, originIdentity, { financialWindowBefore: before });
      financialWindows[0].after = await appStateSnapshot(page, originIdentity);
      expect(financialWindows[0].after).toEqual(before);
    }

    const commits = [sourceCommit, currentCommit].filter((entry): entry is CommittedCheckout => Boolean(entry));
    expect(commits).toHaveLength(selectedCase === "partial_previous_dues" ? 2 : 1);
    expect(new Set(commits.map((entry) => entry.envelope.payload.mutation_id)).size).toBe(commits.length);
    expect(rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" &&
      commits.some((commit) => commit.envelope.payload.mutation_id === entry.mutationId))).toHaveLength(commits.length);
    for (const commit of commits) {
      expect(commit.result.eventId).toBeTruthy();
      expect(commit.responseBody.event_id).toBe(commit.result.eventId);
      expect(commit.responseBody.changed_rows).toEqual(commit.result.changedRows);
    }
    await observer.page.reload({ waitUntil: "domcontentloaded" });
    for (const commit of commits) {
      const row = await openBillRegisterRow(observer.page, String(commit.responseBody.bill_number));
      await expect(row).toBeVisible();
    }
    assertNoPageErrors(originErrors, observerErrors);
    const finalArtifact = writeEvidence("final", {
      status: "browser-passed",
      customerName,
      sourceCommit,
      currentCommit,
      financialWindows,
      rpcEvidence
    });
    await attachJson(testInfo, "checkout-payment-matrix-final", { finalArtifact, selectedCase, sourceCommit, currentCommit, financialWindows });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (primaryError) {
      try {
        writeEvidence("failure", {
          status: "browser-failed",
          customerName,
          sourceSessionStarted,
          currentSessionStarted,
          sourceIssueClicked,
          currentIssueClicked,
          sourceCommit,
          currentCommit,
          financialWindows,
          error: sanitizedErrorMessage(primaryError),
          rpcEvidence
        });
      } catch {
        // Preserve the first immutable failure artifact if teardown also fails.
      }
    }
    await attachFailureScreenshot(testInfo, page, `payment-matrix-${selectedCase}-origin-failure`);
    await attachFailureScreenshot(testInfo, observer.page, `payment-matrix-${selectedCase}-observer-failure`);
    await observer.context.close();
  }
});
