import { expect, test, type APIResponse, type Page } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  createObserver,
  credentials,
  openManagedSession,
  rejectSessionIfOpen,
  signIn,
  startSession,
  stationCard
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const stations = ["Arcade 1", "Arcade 2"] as const;

type CapturedRequest = { url: string; headers: Record<string, string>; body: unknown };

async function responseBody(response: APIResponse) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

async function captureCheckout(page: Page, station: string): Promise<CapturedRequest> {
  const sessionDialog = await openManagedSession(page, station);
  await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();

  let resolveCaptured!: (value: CapturedRequest) => void;
  const capturedRequest = new Promise<CapturedRequest>((resolve) => { resolveCaptured = resolve; });
  await page.route("**/rest/v1/rpc/commit_checkout_bill_v2", async (route) => {
    const request = route.request();
    resolveCaptured({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
    await route.abort("aborted");
  });
  page.on("dialog", (dialog) => {
    if (dialog.type() === "prompt") return;
    void dialog.dismiss();
  });
  const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
  await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
  return capturedRequest;
}

test.describe.serial("Release B bill-number collision", () => {
  test("two valid checkouts sharing one bill number commit exactly one bill", async ({ browser, page }, testInfo) => {
    const observer = await createObserver(browser);
    const pages = [page, observer.page] as const;
    const customers = [`QA V2 Collision A ${runId}`, `QA V2 Collision B ${runId}`] as const;
    const started = [false, false];
    const committed = [false, false];
    const cleanupErrors: string[] = [];
    let collisionEvidence: Record<string, unknown> | undefined;

    try {
      await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
      await Promise.all(pages.map((currentPage) => currentPage.waitForTimeout(1_200)));
      for (let index = 0; index < pages.length; index += 1) {
        const currentCard = stationCard(pages[index], stations[index]);
        const currentText = await currentCard.innerText();
        if (!currentText.includes("Available")) {
          const staleCustomer = (await currentCard.getByText(/^QA V2 Collision [AB] \d{14}$/).textContent())?.trim();
          expect(staleCustomer, `Collision preflight refuses to clean a non-QA session on ${stations[index]}.`)
            .toMatch(/^QA V2 Collision [AB] \d{14}$/);
          await rejectSessionIfOpen(
            pages[index],
            stations[index],
            staleCustomer!,
            `Playwright Release B stale collision cleanup ${runId}`
          );
        }
        await expect(currentCard).toContainText("Available");
        await startSession(pages[index], stations[index], customers[index]);
        started[index] = true;
      }
      await Promise.all([
        expect(stationCard(page, stations[1])).toContainText(customers[1]),
        expect(stationCard(observer.page, stations[0])).toContainText(customers[0])
      ]);

      // Prepare the UI commands independently; only the database submissions
      // below are concurrent. This avoids testing unrelated modal-state races.
      const captures = [
        await captureCheckout(page, stations[0]),
        await captureCheckout(observer.page, stations[1])
      ];
      const envelopes = captures.map((capture) => capture.body as {
        payload: {
          mutation_id: string;
          payload: { primary_bill: { billNumber: string; id: string } };
        };
      });
      const billNumbers = envelopes.map((envelope) => envelope.payload.payload.primary_bill.billNumber);
      expect(new Set(billNumbers).size, "Both captured commands must exercise the same bill-number collision.").toBe(1);
      const requests = captures.map((capture) => ({
        headers: {
          apikey: capture.headers.apikey,
          authorization: capture.headers.authorization,
          "content-type": "application/json",
          prefer: capture.headers.prefer || "return=representation"
        }
      }));
      const responses = await Promise.all([
        page.request.post(captures[0].url, { headers: requests[0].headers, data: captures[0].body, timeout: 30_000 }),
        observer.context.request.post(captures[1].url, { headers: requests[1].headers, data: captures[1].body, timeout: 30_000 })
      ]);
      const bodies = await Promise.all(responses.map(responseBody));
      const successIndexes = responses.map((response, index) => response.status() === 200 ? index : -1).filter((index) => index >= 0);
      const failureIndexes = responses.map((response, index) => response.status() >= 400 ? index : -1).filter((index) => index >= 0);
      expect(successIndexes).toHaveLength(1);
      expect(failureIndexes).toHaveLength(1);
      const winnerIndex = successIndexes[0];
      const loserIndex = failureIndexes[0];
      committed[winnerIndex] = true;
      expect(bodies[winnerIndex].bill_id).toBe(envelopes[winnerIndex].payload.payload.primary_bill.id);
      expect(JSON.stringify(bodies[loserIndex])).toMatch(/duplicate_bill_number|duplicate.*bill/i);

      const loserStatus = await pages[loserIndex].request.post(
        captures[loserIndex].url.replace("commit_checkout_bill_v2", "get_financial_mutation_result"),
        {
          headers: requests[loserIndex].headers,
          data: {
            payload: {
              organization_id: (captures[loserIndex].body as { payload: { organization_id: string } }).payload.organization_id,
              mutation_id: envelopes[loserIndex].payload.mutation_id,
              mutation_kind: "checkout"
            }
          }
        }
      );
      expect(loserStatus.status()).toBe(200);
      expect(await loserStatus.json()).toBeNull();
      collisionEvidence = {
        billNumber: billNumbers[0],
        statuses: responses.map((response) => response.status()),
        bodies,
        winnerIndex,
        loserIndex,
        loserMutationRolledBack: true
      };

      await Promise.all(pages.map((currentPage) => currentPage.unroute("**/rest/v1/rpc/commit_checkout_bill_v2")));
      await Promise.all(pages.map((currentPage) => currentPage.reload({ waitUntil: "domcontentloaded" })));
      await expect(stationCard(pages[winnerIndex], stations[winnerIndex])).toContainText("Available");
      await expect(stationCard(pages[loserIndex], stations[loserIndex])).toContainText(customers[loserIndex]);
      await rejectSessionIfOpen(
        pages[loserIndex],
        stations[loserIndex],
        customers[loserIndex],
        `Playwright Release B collision cleanup ${runId}`
      );
      started[loserIndex] = false;
    } finally {
      for (let index = 0; index < pages.length; index += 1) {
        if (!started[index] || committed[index]) continue;
        try {
          await pages[index].unroute("**/rest/v1/rpc/commit_checkout_bill_v2").catch(() => undefined);
          await pages[index].reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
          await rejectSessionIfOpen(
            pages[index],
            stations[index],
            customers[index],
            `Playwright Release B collision cleanup ${runId}`
          );
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : `Unknown cleanup failure for ${stations[index]}`);
        }
      }
      await attachJson(testInfo, "release-b-bill-collision-v2-evidence", {
        runId,
        stations,
        customers,
        started,
        committed,
        cleanupErrors,
        collisionEvidence
      });
      await attachFailureScreenshot(testInfo, page, "bill-collision-origin-failure");
      await attachFailureScreenshot(testInfo, observer.page, "bill-collision-observer-failure");
      await observer.context.close();
    }
  });
});
