import { expect, test, type Page } from "@playwright/test";
import {
  expectTargetsAbsent,
  expectTargetsVisible,
  type LiveTarget
} from "../staging/support/liveTargets";

const activeSession: LiveTarget = {
  type: "session",
  id: "session-active",
  displayName: "QA Active Customer"
};
const pausedSession: LiveTarget = {
  type: "session",
  id: "session-paused",
  displayName: "QA Paused Customer"
};
const customerTab: LiveTarget = {
  type: "customer_tab",
  id: "tab-open",
  displayName: "QA Open Tab"
};

function sessionCard(target: LiveTarget, state: "active" | "paused" = "active") {
  return `
    <article class="station-card is-${state}" data-fixture-id="${target.id}">
      <div class="station-card-header"><div><h3>8 Ball Pool</h3><p>${state === "paused" ? "Paused" : "Running"}</p></div></div>
      <div class="station-metrics"><div><span class="muted">Customer</span><strong>${target.displayName}</strong></div></div>
    </article>`;
}

function customerTabCard(target: LiveTarget) {
  return `
    <article class="station-card is-active customer-tab-live-card" data-fixture-id="${target.id}">
      <div class="station-card-header"><div><h3>${target.displayName}</h3><p>Consumables tab</p></div></div>
    </article>`;
}

function historyEntries(name: string) {
  return Array.from({ length: 4 }, (_, index) => `
    <article class="activity-card">
      <strong>${index % 2 === 0 ? "Open Customer Tab" : `Rejected customer tab for ${name}.`}</strong>
      <span>${name}</span>
    </article>`).join("");
}

function dashboard(options: { cards?: string; historyName?: string; historyNames?: string[]; hiddenGrid?: boolean; includeGrid?: boolean } = {}) {
  const includeGrid = options.includeGrid ?? true;
  const retainedHistoryNames = options.historyNames ?? (options.historyName ? [options.historyName] : []);
  const availableStation = `
    <article class="station-card is-available">
      <div class="station-card-header"><div><h3>Available Station</h3><p>Available</p></div></div>
    </article>`;
  return `<!doctype html><html><body>
    <section class="section-grid dashboard-grid">
      <div class="panel dashboard-column">
        <div class="dashboard-tile">
          <div class="panel-header"><div><h2>Live Sessions</h2><p>Monitor gaming sessions and open consumables tabs.</p></div></div>
          <div class="dashboard-tile-body panel-scroll">
            ${includeGrid ? `<div class="station-grid"${options.hiddenGrid ? " hidden" : ""}>${options.cards ?? availableStation}</div>` : ""}
          </div>
        </div>
        <div class="dashboard-tile">
          <div class="panel-header"><h2>Recent Activity</h2></div>
          <div>${retainedHistoryNames.map(historyEntries).join("")}</div>
        </div>
      </div>
    </section>
  </body></html>`;
}

async function installOfflinePage(page: Page, html: string) {
  const attemptedUrls: string[] = [];
  await page.route("**/*", async (route) => {
    attemptedUrls.push(route.request().url());
    await route.abort("blockedbyclient");
  });
  await page.setContent(html);
  expect(attemptedUrls).toEqual([]);
}

test.describe("live target selectors", () => {
  test("finds active and paused sessions plus a customer tab only in the unique visible Live Sessions grid", async ({ page }) => {
    await installOfflinePage(page, dashboard({
      cards: [sessionCard(activeSession), sessionCard(pausedSession, "paused"), customerTabCard(customerTab)].join(""),
      historyNames: [activeSession.displayName, pausedSession.displayName]
    }));

    await expect(page.getByText(activeSession.displayName, { exact: true })).toHaveCount(5);
    await expect(page.getByText(pausedSession.displayName, { exact: true })).toHaveCount(5);
    await expectTargetsVisible(page, [activeSession, pausedSession, customerTab]);
  });

  test("ignores four historical name occurrences when the active customer-tab card is absent", async ({ page }) => {
    await installOfflinePage(page, dashboard({ historyName: customerTab.displayName }));

    await expect(page.getByText(customerTab.displayName, { exact: true })).toHaveCount(4);
    await expectTargetsAbsent(page, [customerTab]);
  });

  test("fails closed for wrong target type and prefix-only names", async ({ page }) => {
    await installOfflinePage(page, dashboard({
      cards: `${sessionCard({ ...activeSession, displayName: `${activeSession.displayName} Extra` })}${customerTabCard(customerTab)}`
    }));

    await expect(expectTargetsVisible(page, [{ ...customerTab, type: "session" }])).rejects.toThrow();
    await expect(expectTargetsVisible(page, [activeSession])).rejects.toThrow();
  });

  test("history-only names cannot satisfy active target presence", async ({ page }) => {
    await installOfflinePage(page, dashboard({ historyName: customerTab.displayName }));

    await expect(page.getByText(customerTab.displayName, { exact: true })).toHaveCount(4);
    await expect(expectTargetsVisible(page, [customerTab])).rejects.toThrow();
  });

  test("fails closed for duplicate active cards", async ({ page }) => {
    await installOfflinePage(page, dashboard({ cards: `${customerTabCard(customerTab)}${customerTabCard(customerTab)}` }));

    await expect(expectTargetsVisible(page, [customerTab])).rejects.toThrow();
  });

  test("fails closed when the Live Sessions grid is missing or hidden for absence", async ({ page }) => {
    await installOfflinePage(page, dashboard({ includeGrid: false, historyName: activeSession.displayName }));
    await expect(expectTargetsAbsent(page, [activeSession])).rejects.toThrow();

    await page.setContent(dashboard({ hiddenGrid: true, cards: sessionCard(activeSession) }));
    await expect(expectTargetsAbsent(page, [customerTab])).rejects.toThrow();
  });

  test("absence fails closed when two Live Sessions grids match", async ({ page }) => {
    await installOfflinePage(page, `${dashboard()}${dashboard()}`);

    await expect(expectTargetsAbsent(page, [customerTab])).rejects.toThrow();
  });

  test("absence fails while a stale active card remains even with matching history", async ({ page }) => {
    await installOfflinePage(page, dashboard({ cards: customerTabCard(customerTab), historyName: customerTab.displayName }));

    await expect(expectTargetsAbsent(page, [customerTab])).rejects.toThrow();
  });
});
