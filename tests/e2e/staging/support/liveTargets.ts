import { expect, type Page } from "@playwright/test";

export interface LiveTarget {
  type: "session" | "customer_tab";
  id: string;
  displayName: string;
}

function liveGrid(page: Page) {
  return page.locator(".dashboard-tile")
    .filter({ has: page.getByRole("heading", { name: "Live Sessions", exact: true, level: 2 }) })
    .locator(".station-grid");
}

function targetCard(page: Page, target: LiveTarget) {
  const grid = liveGrid(page);
  // Activity and receipt history intentionally retain customer names after closure.
  // Only the live card's own customer field establishes target presence.
  return target.type === "customer_tab"
    ? grid.locator(".station-card.is-active.customer-tab-live-card")
      .filter({ has: page.getByRole("heading", { name: target.displayName, exact: true, level: 3 }) })
    : grid.locator(".station-card.is-active:not(.customer-tab-live-card), .station-card.is-paused:not(.customer-tab-live-card)")
      .filter({ has: page.locator(".station-metrics").getByText(target.displayName, { exact: true }) });
}

async function expectLiveGrid(page: Page) {
  // A missing, hidden or duplicated dashboard must not turn absence into success.
  await expect(liveGrid(page)).toHaveCount(1);
  await expect(liveGrid(page)).toBeVisible();
}

export async function expectTargetsVisible(page: Page, targets: LiveTarget[]) {
  await expectLiveGrid(page);
  for (const target of targets) {
    const card = targetCard(page, target);
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
  }
}

export async function expectTargetsAbsent(page: Page, targets: LiveTarget[]) {
  await expectLiveGrid(page);
  for (const target of targets) {
    await expect(targetCard(page, target)).toHaveCount(0);
  }
}
