import { expect, test, type Request } from "@playwright/test";
import { attachJson, capturePageErrors, credentials, signIn } from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";

test("activity ledger is readable, filterable, stable, and reachable from dashboard", async ({ page }, testInfo) => {
  const errors = capturePageErrors(page);
  const activityResponses: Array<{ status: number; durationMs: number }> = [];
  const activityRequestStartedAt = new WeakMap<Request, number>();
  page.on("request", (request) => {
    if (request.url().includes("/rest/v1/rpc/list_activity_events")) {
      activityRequestStartedAt.set(request, Date.now());
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("/rest/v1/rpc/list_activity_events")) {
      const startedAt = activityRequestStartedAt.get(response.request());
      activityResponses.push({ status: response.status(), durationMs: startedAt ? Date.now() - startedAt : -1 });
    }
  });

  await signIn(page, credentials("A"));
  const activityNav = page.getByRole("button", { name: "Activity", exact: true });
  await expect(activityNav).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent Activity", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show All", exact: true }).click();

  const panel = page.locator("section.activity-panel");
  await expect(panel.getByRole("heading", { name: "Detailed Activity", exact: true })).toBeVisible();
  await expect(panel.getByText("Server activity", { exact: true })).toBeVisible();
  await expect.poll(() => activityResponses.length).toBeGreaterThan(0);
  expect(activityResponses.every((response) => response.status === 200)).toBe(true);

  const search = panel.getByPlaceholder("Customer, bill, action, session, item...");
  await search.focus();
  const inputHandle = await search.elementHandle();
  if (!inputHandle) throw new Error("Activity search input was not attached.");
  await page.keyboard.type("BI");
  await expect(search).toHaveValue("BI");
  await expect(search).toBeFocused();
  expect(await inputHandle.evaluate((element) => element.isConnected)).toBe(true);

  const beforeApplyCount = activityResponses.length;
  await panel.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect.poll(() => activityResponses.length).toBeGreaterThan(beforeApplyCount);
  await expect(search).toHaveValue("BI");
  expect(await inputHandle.evaluate((element) => element.isConnected)).toBe(true);
  const filteredRows = panel.locator(".activity-event");
  await expect(filteredRows.first()).toBeVisible();
  const filteredText = await filteredRows.allTextContents();
  expect(filteredText.length).toBeGreaterThan(0);
  expect(filteredText.every((row) => /bi/i.test(row))).toBe(true);

  await panel.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(panel.locator(".activity-event").first()).toBeVisible();
  const firstEvent = panel.locator(".activity-event").first();
  await expect(firstEvent.locator("time")).toContainText("IST");
  await expect(firstEvent.locator(".activity-event-attribution")).toBeVisible();

  const disclosure = firstEvent.getByText("View record details", { exact: true });
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(firstEvent.locator("pre")).toBeVisible();

  const visibleIdsBefore = await panel.locator(".activity-event").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-activity-id")));
  const loadMore = panel.getByRole("button", { name: "Load more activity", exact: true });
  if (await loadMore.count()) {
    await loadMore.click();
    await expect.poll(async () => panel.locator(".activity-event").count()).toBeGreaterThan(visibleIdsBefore.length);
    const visibleIdsAfter = await panel.locator(".activity-event").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-activity-id")));
    expect(new Set(visibleIdsAfter).size).toBe(visibleIdsAfter.length);
  }

  expect(await panel.getByRole("button", { name: /delete|edit|save/i }).count()).toBe(0);
  await attachJson(testInfo, "activity-feed-ui", {
    runId,
    viewport: page.viewportSize(),
    activityResponses,
    visibleIdsBefore,
    consoleErrors: errors.consoleErrors,
    pageErrors: errors.pageErrors
  });
  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});

test("a second authorized account sees the same read-only Activity navigation", async ({ page }) => {
  await signIn(page, credentials("B"));
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const panel = page.locator("section.activity-panel");
  await expect(panel.getByRole("heading", { name: "Detailed Activity", exact: true })).toBeVisible();
  await expect(panel.getByText("Server activity", { exact: true })).toBeVisible();
  expect(await panel.getByRole("button", { name: /delete|edit|save/i }).count()).toBe(0);
});
