import { expect, test } from "@playwright/test";
import {
  assertNoPageErrors,
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  attachJson,
  capturePageErrors,
  captureAuthenticatedRestRequests,
  createObserver,
  credentials,
  openManagedSession,
  rejectSessionIfOpen,
  signIn,
  startSession,
  stationCard,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_CUSTOMER_PROFILE_STATION?.trim() || "8 Ball Pool";

test("customer directory edits converge without rewriting live transaction snapshots", async ({ browser, page }, testInfo) => {
  const observer = await createObserver(browser);
  const errors = [capturePageErrors(page), capturePageErrors(observer.page)];
  const originalName = `QA Profile Original ${runId}`;
  const directoryName = `QA Profile Directory ${runId}`;
  const sessionName = `QA Session Explicit ${runId}`;
  const directoryPhone = `9${Date.now().toString().slice(-9)}`;
  const forbiddenAppStateRequests: Array<{ method: string; url: string }> = [];
  const authenticatedRequests: import("./support/app").CapturedRpcRequest[] = [];
  let sessionStarted = false;
  let cleanupConfirmed = false;

  const captureForbiddenAppState = (request: import("@playwright/test").Request) => {
    const url = new URL(request.url());
    if (!url.pathname.includes("/rest/v1/app_state")) return;
    const select = url.searchParams.get("select") ?? "";
    if (request.method() !== "GET" || select === "*" || select.split(",").includes("data")) {
      forbiddenAppStateRequests.push({ method: request.method(), url: request.url() });
    }
  };
  page.on("request", captureForbiddenAppState);
  observer.page.on("request", captureForbiddenAppState);
  captureAuthenticatedRestRequests(page, authenticatedRequests);

  async function openCustomerDirectory(target: import("@playwright/test").Page, search: string) {
    await target.getByRole("button", { name: "Customers", exact: true }).click();
    await expect(target.getByRole("heading", { name: "Customer History", exact: true }).or(
      target.getByRole("heading", { name: "Customer Analytics", exact: true })
    )).toBeVisible();
    await expect(target.getByRole("heading", { name: "Customer Analytics", exact: true })).toBeVisible();
    const input = target.getByPlaceholder("Search by name or phone", { exact: true });
    await input.fill(search);
    const profile = target.locator("button.tab-chip").filter({ hasText: search });
    await expect(profile).toHaveCount(1);
    return profile;
  }

  try {
    await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("A"))]);
    await assertAuthoritativeOrganizationIdentity(page, authenticatedRequests, "admin");
    await startSession(page, station, originalName);
    sessionStarted = true;
    await expect(stationCard(observer.page, station)).toContainText(originalName);

    const profile = await openCustomerDirectory(page, originalName);
    await profile.click();
    await page.getByRole("button", { name: "Edit Profile", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit Customer Profile", exact: true });
    await editor.getByLabel("Customer Name", { exact: true }).fill(directoryName);
    await editor.getByLabel("Customer Phone", { exact: true }).fill(directoryPhone);
    await editor.getByRole("button", { name: "Save Profile", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(page.locator("button.tab-chip").filter({ hasText: directoryName })).toHaveCount(1);

    await openCustomerDirectory(observer.page, directoryName);
    await observer.page.reload({ waitUntil: "domcontentloaded" });
    await openCustomerDirectory(observer.page, directoryName);

    await page.getByRole("button", { name: "Live Dashboard", exact: true }).click();
    await expect(stationCard(page, station)).toContainText(originalName);
    await observer.page.getByRole("button", { name: "Live Dashboard", exact: true }).click();
    await expect(stationCard(observer.page, station)).toContainText(originalName);

    const managed = await openManagedSession(page, station);
    await managed.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
    await managed.getByLabel("Customer Name", { exact: true }).fill(sessionName);
    await managed.getByRole("button", { name: "Save Session Details", exact: true }).click();
    await waitForSynced(page);
    await expect(stationCard(observer.page, station)).toContainText(sessionName);

    await openCustomerDirectory(page, directoryName);
    await page.getByRole("button", { name: "Live Dashboard", exact: true }).click();
    cleanupConfirmed = await rejectSessionIfOpen(page, station, sessionName, `QA profile cleanup ${runId}`);
    expect(cleanupConfirmed).toBe(true);
    await expect(stationCard(observer.page, station)).toContainText("Available");
    expect(forbiddenAppStateRequests).toEqual([]);
    assertNoPageErrors(...errors);
    await attachJson(testInfo, "customer-profile-snapshot-parity-evidence", {
      runId, originalName, directoryName, sessionName, directoryPhone,
      directoryConvergedInTwoBrowsers: true,
      directorySurvivedReload: true,
      liveSnapshotPreservedUntilExplicitEdit: true,
      forbiddenAppStateRequests,
      cleanupConfirmed
    });
  } finally {
    if (sessionStarted && !cleanupConfirmed) {
      await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
      await rejectSessionIfOpen(page, station, sessionName, `QA profile fallback cleanup ${runId}`).catch(() => false);
      await rejectSessionIfOpen(page, station, originalName, `QA profile fallback cleanup ${runId}`).catch(() => false);
    }
    await attachFailureScreenshot(testInfo, page, "customer-profile-snapshot-parity-failure");
    await observer.context.close();
  }
});
