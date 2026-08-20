import { expect, test } from "@playwright/test";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  capturePageErrors,
  captureRpcEvidence,
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
const station = process.env.E2E_V2_PERFORMANCE_STATION?.trim() || "Arcade 1";
const requestedCount = Number(process.env.E2E_V2_PERFORMANCE_COUNT || 0);

function percentile(values: number[], quantile: number) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

test.describe.serial("Release B financial v2 performance", () => {
  test.skip(!Number.isInteger(requestedCount) || requestedCount <= 0, "Set E2E_V2_PERFORMANCE_COUNT explicitly.");

  test("runs sequential representative checkouts within acceptance limits", async ({ page }, testInfo) => {
    test.setTimeout(Math.max(300_000, requestedCount * 20_000));
    const errors = capturePageErrors(page);
    const rpcEvidence: RpcEvidence[] = [];
    captureRpcEvidence(page, "origin", rpcEvidence);
    const browserDurations: number[] = [];
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      // Cleanup owns the rejection prompt through a one-shot listener.
      if (dialog.type() === "prompt") return;
      await dialog.dismiss();
    });
    let activeCustomer: string | undefined;
    let completed = 0;
    let cleanupError: string | undefined;

    try {
      await signIn(page, credentials("A"));
      await page.waitForTimeout(1_200);
      const initialCard = stationCard(page, station);
      if (!(await initialCard.textContent())?.includes("Available")) {
        const staleCustomer = (await initialCard.getByText(/^QA V2 Perf \d{14} \d{2}$/).textContent())?.trim();
        expect(staleCustomer, "Performance preflight refuses to clean a non-QA session.").toMatch(
          /^QA V2 Perf \d{14} \d{2}$/
        );
        await rejectSessionIfOpen(
          page,
          station,
          staleCustomer!,
          `Playwright Release B stale performance cleanup ${runId}`
        );
      }
      await expect(initialCard).toContainText("Available");

      for (let index = 1; index <= requestedCount; index += 1) {
        activeCustomer = `QA V2 Perf ${runId} ${String(index).padStart(2, "0")}`;
        await startSession(page, station, activeCustomer);
        const sessionDialog = await openManagedSession(page, station);
        await sessionDialog.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();

        const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
        await expect(checkout.getByRole("button", { name: "Issue Bill", exact: true })).toBeEnabled();
        const startedAt = Date.now();
        await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
        await expect(checkout).toBeHidden();
        await waitForSynced(page);
        browserDurations.push(Date.now() - startedAt);
        await expect.poll(() => rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300).length)
          .toBe(index);
        completed = index;
        activeCustomer = undefined;
      }

      const commits = rpcEvidence.filter((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300);
      const serverDurations = commits.map((entry) => entry.serverDurationMs).filter((value): value is number => typeof value === "number");
      expect(commits).toHaveLength(requestedCount);
      expect(serverDurations).toHaveLength(requestedCount);
      const metrics = {
        count: requestedCount,
        databaseP95Ms: percentile(serverDurations, 0.95),
        databaseMaxMs: Math.max(...serverDurations),
        browserP95Ms: percentile(browserDurations, 0.95),
        browserMaxMs: Math.max(...browserDurations)
      };
      expect(metrics.databaseP95Ms).toBeLessThan(2_000);
      expect(metrics.databaseMaxMs).toBeLessThan(5_000);
      expect(metrics.browserMaxMs).toBeLessThan(7_000);
      assertNoPageErrors(errors);
      await attachJson(testInfo, "release-b-performance-v2-evidence", { runId, station, metrics, browserDurations, commits });
    } finally {
      if (activeCustomer) {
        try {
          for (let index = 0; index < 3 && await page.getByRole("dialog").count(); index += 1) {
            const dialog = page.getByRole("dialog").last();
            const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
            const close = dialog.getByRole("button", { name: "Close", exact: true });
            if (await cancel.isVisible()) await cancel.click();
            else if (await close.isVisible()) await close.click();
            else break;
          }
          await rejectSessionIfOpen(page, station, activeCustomer, `Playwright Release B performance cleanup ${runId}`);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : "Unknown performance cleanup failure";
        }
      }
      await attachJson(testInfo, "release-b-performance-v2-cleanup", {
        runId,
        station,
        requestedCount,
        completed,
        activeCustomer,
        cleanupError,
        dialogMessages,
        remoteErrors: await page.locator(".remote-error-banner").allTextContents().catch(() => []),
        rpcEvidence
      });
      await attachFailureScreenshot(testInfo, page, "performance-failure");
    }
  });
});
