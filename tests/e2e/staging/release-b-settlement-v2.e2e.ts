import { expect, test, type APIResponse } from "@playwright/test";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  browserDateTimeLocal,
  capturePageErrors,
  captureRpcEvidence,
  createObserver,
  credentials,
  openManagedSession,
  rejectSessionIfOpen,
  signIn,
  startSession,
  stationCard,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_V2_SETTLEMENT_STATION?.trim() || "8 Ball Pool";

async function responseBody(response: APIResponse) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

async function openBillRegisterRow(page: Parameters<typeof capturePageErrors>[0], billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  return row;
}

test.describe.serial("Release B deferred settlement v2", () => {
  test("deferred checkout and later settlement use the two v2 transactions", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const rpcEvidence: RpcEvidence[] = [];
    const originErrors = capturePageErrors(page);
    const observerErrors = capturePageErrors(observer.page);
    captureRpcEvidence(page, "origin", rpcEvidence);
    captureRpcEvidence(observer.page, "observer", rpcEvidence);
    const customerName = `QA V2 Deferred ${runId}`;
    let sessionStarted = false;
    let checkoutCommitted = false;
    let settlementCommitted = false;
    let billNumber: string | undefined;
    let cleanupError: string | undefined;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      const currentStationText = await stationCard(page, station).innerText();
      if (currentStationText.includes(customerName)) {
        sessionStarted = true;
      } else {
        expect(currentStationText, "The selected settlement station is occupied by a non-QA session.").toContain("Available");
        await startSession(page, station, customerName);
        sessionStarted = true;
      }

      const sessionDialog = await openManagedSession(page, station);
      await sessionDialog.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await sessionDialog.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await sessionDialog.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();

      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await checkout.locator("label").filter({ hasText: "Payment Mode" }).locator("select").selectOption("deferred");
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(checkout).toBeHidden();
      await waitForSynced(page);

      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300).length).toBe(1);
      const checkoutResult = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300)!;
      billNumber = checkoutResult.billNumber;
      expect(billNumber).toBeTruthy();
      expect(checkoutResult.changedRows?.payments).toEqual([]);
      checkoutCommitted = true;

      const pendingRow = await openBillRegisterRow(page, billNumber!);
      await expect(pendingRow).toContainText("Pending");
      await expect(pendingRow).toContainText("Deferred");
      await pendingRow.getByRole("button", { name: "Settle", exact: true }).click();
      const settlement = page.getByRole("dialog", { name: `Settle Bill - ${billNumber}`, exact: true });
      await settlement.getByRole("button", { name: /^Pay Full Amount/ }).click();
      await settlement.getByRole("button", { name: "Confirm Settlement", exact: true }).click();
      await expect(settlement).toBeHidden();

      await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_financial_adjustment_v2" && entry.status < 300).length).toBe(1);
      const settlementResult = rpcEvidence.findLast((entry) => entry.rpc === "commit_financial_adjustment_v2" && entry.status < 300)!;
      expect(settlementResult.changedRows?.bills).toHaveLength(1);
      expect(settlementResult.changedRows?.payments).toHaveLength(1);
      settlementCommitted = true;

      const settledRow = await openBillRegisterRow(page, billNumber!);
      await expect(settledRow).toContainText("Issued");
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      const observerRow = await openBillRegisterRow(observer.page, billNumber!);
      await expect(observerRow).toContainText("Issued");
      await expect(observerRow.locator("td").nth(6)).toContainText("₹30.00");
      await expect(observerRow.locator("td").nth(7)).toHaveText("-");
      assertNoPageErrors(originErrors, observerErrors);

      await attachJson(testInfo, "release-b-deferred-settlement-v2-evidence", {
        runId,
        customerName,
        billNumber,
        checkoutResult,
        settlementResult,
        rpcEvidence
      });
    } finally {
      if (sessionStarted && !checkoutCommitted) {
        try {
          for (let index = 0; index < 3 && await page.getByRole("dialog").count(); index += 1) {
            const dialog = page.getByRole("dialog").last();
            const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
            const close = dialog.getByRole("button", { name: "Close", exact: true });
            if (await cancel.isVisible()) await cancel.click();
            else if (await close.isVisible()) await close.click();
            else break;
          }
          await rejectSessionIfOpen(page, station, customerName, `Playwright Release B settlement cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown settlement cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-deferred-settlement-v2-cleanup", {
        runId,
        customerName,
        billNumber,
        checkoutCommitted,
        settlementCommitted,
        cleanupError,
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "settlement-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "settlement-observer-failure");
      await observer.context.close();
    }
  });

  test("two different settlement mutations cannot over-collect one pending bill", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const customerName = `QA V2 Settle Race ${runId}`;
    const mutationIds = [`financial-settle-a-${runId}`, `financial-settle-b-${runId}`];
    let sessionStarted = false;
    let checkoutCommitted = false;
    let settlementCommitted = false;
    let billNumber: string | undefined;
    let cleanupError: string | undefined;
    let raceEvidence: Record<string, unknown> | undefined;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all([page.waitForTimeout(1_200), observer.page.waitForTimeout(1_200)]);
      expect(await stationCard(page, station).innerText(), "The selected settlement-race station is occupied.").toContain("Available");
      await startSession(page, station, customerName);
      sessionStarted = true;

      const sessionDialog = await openManagedSession(page, station);
      await sessionDialog.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await sessionDialog.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -10));
      await sessionDialog.getByRole("button", { name: "Save Session Details", exact: true }).click();
      await waitForSynced(page);
      await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await checkout.locator("label").filter({ hasText: "Payment Mode" }).locator("select").selectOption("deferred");
      await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(checkout).toBeHidden();
      await waitForSynced(page);

      const issuedRow = await openBillRegisterRow(page, customerName);
      await expect(issuedRow).toContainText("Pending");
      billNumber = (await issuedRow.locator("td").first().innerText()).trim();
      expect(billNumber).toMatch(/^BILL-/);
      checkoutCommitted = true;
      await issuedRow.getByRole("button", { name: "Settle", exact: true }).click();
      const settlement = page.getByRole("dialog", { name: `Settle Bill - ${billNumber}`, exact: true });
      await settlement.getByRole("button", { name: /^Pay Full Amount/ }).click();

      type CapturedRequest = { url: string; headers: Record<string, string>; body: unknown };
      let resolveCaptured!: (value: CapturedRequest) => void;
      const capturedRequest = new Promise<CapturedRequest>((resolve) => { resolveCaptured = resolve; });
      await page.route("**/rest/v1/rpc/commit_financial_adjustment_v2", async (route) => {
        const request = route.request();
        resolveCaptured({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
        await route.abort("aborted");
      });
      page.on("dialog", (dialog) => void dialog.dismiss());
      await settlement.getByRole("button", { name: "Confirm Settlement", exact: true }).click();
      const captured = await capturedRequest;
      const requestHeaders = {
        apikey: captured.headers.apikey,
        authorization: captured.headers.authorization,
        "content-type": "application/json",
        prefer: captured.headers.prefer || "return=representation"
      };
      const envelopes = mutationIds.map((mutationId) => {
        const envelope = structuredClone(captured.body) as { payload: { mutation_id: string } };
        envelope.payload.mutation_id = mutationId;
        return envelope;
      });
      const responses = await Promise.all([
        page.request.post(captured.url, { headers: requestHeaders, data: envelopes[0], timeout: 30_000 }),
        observer.context.request.post(captured.url, { headers: requestHeaders, data: envelopes[1], timeout: 30_000 })
      ]);
      const bodies = await Promise.all(responses.map(responseBody));
      const successes = responses.map((response, index) => ({ response, body: bodies[index], mutationId: mutationIds[index] }))
        .filter(({ response }) => response.status() === 200);
      const failures = responses.map((response, index) => ({ response, body: bodies[index], mutationId: mutationIds[index] }))
        .filter(({ response }) => response.status() >= 400);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const loserEnvelope = envelopes[mutationIds.indexOf(failures[0].mutationId)] as {
        payload: { organization_id: string; mutation_kind: string };
      };
      const loserStatus = await page.request.post(
        captured.url.replace("commit_financial_adjustment_v2", "get_financial_mutation_result"),
        {
          headers: requestHeaders,
          data: {
            payload: {
              organization_id: loserEnvelope.payload.organization_id,
              mutation_id: failures[0].mutationId,
              mutation_kind: loserEnvelope.payload.mutation_kind
            }
          }
        }
      );
      expect(loserStatus.status()).toBe(200);
      expect(await loserStatus.json()).toBeNull();
      settlementCommitted = true;
      raceEvidence = {
        statuses: responses.map((response) => response.status()),
        bodies,
        winnerMutationId: successes[0].mutationId,
        loserMutationId: failures[0].mutationId,
        loserMutationRolledBack: true
      };

      await page.unroute("**/rest/v1/rpc/commit_financial_adjustment_v2");
      await page.reload({ waitUntil: "domcontentloaded" });
      const settledRow = await openBillRegisterRow(page, billNumber!);
      await expect(settledRow).toContainText("Issued");
      await expect(settledRow.locator("td").nth(6)).toContainText("₹30.00");
      await expect(settledRow.locator("td").nth(7)).toHaveText("-");
    } finally {
      if (sessionStarted && !checkoutCommitted) {
        try {
          await rejectSessionIfOpen(page, station, customerName, `Playwright Release B settlement-race cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown settlement-race cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-over-settlement-v2-evidence", {
        runId,
        customerName,
        billNumber,
        checkoutCommitted,
        settlementCommitted,
        cleanupError,
        raceEvidence
      });
      await attachFailureScreenshot(testInfo, page, "over-settlement-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "over-settlement-observer-failure");
      await observer.context.close();
    }
  });
});
