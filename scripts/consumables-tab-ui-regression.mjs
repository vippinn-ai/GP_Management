import { chromium } from "playwright";
import fs from "node:fs";

const baseUrl = process.env.UI_BASE_URL ?? "http://127.0.0.1:4173";
const headless = process.env.HEADLESS !== "false";
const STORAGE_KEY = "game-parlour-management-system/v1";
const chromeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));

function nowIso(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

function seedAppData({ duplicateTabs = false } = {}) {
  const customerTabs = duplicateTabs
    ? [
        { id: "tab-dup-1", customerName: "VANSH", status: "open", createdAt: nowIso(-20), items: [] },
        { id: "tab-dup-2", customerName: "VANSH", status: "open", createdAt: nowIso(-10), items: [] }
      ]
    : [
        { id: "tab-a", customerName: "Customer A", customerPhone: "9000000001", status: "open", createdAt: nowIso(-30), items: [] },
        { id: "tab-b", customerName: "Customer B", customerPhone: "9000000002", status: "open", createdAt: nowIso(-20), items: [] },
        { id: "tab-c", customerName: "Customer C", customerPhone: "9000000003", status: "open", createdAt: nowIso(-10), items: [] }
      ];

  return {
    users: [{ id: "user-admin", name: "Codex Admin", username: "admin", password: "admin123", role: "admin", active: true }],
    businessProfile: {
      name: "BreakPerfect",
      logoText: "BP",
      address: "Test address",
      primaryPhone: "9999999999",
      receiptFooter: "Thank you"
    },
    inventoryCategories: ["Beverages", "Food"],
    stations: [{ id: "station-snooker", name: "Snooker Star Table", mode: "timed", active: true, ltpEnabled: false }],
    pricingRules: [{ id: "pricing-snooker", stationId: "station-snooker", label: "Default", startMinute: 0, endMinute: 1439, hourlyRate: 300 }],
    sessions: [
      {
        id: "session-live",
        stationId: "station-snooker",
        stationNameSnapshot: "Snooker Star Table",
        mode: "timed",
        startedAt: nowIso(-45),
        status: "active",
        customerName: "Session Customer",
        customerPhone: "9111111111",
        playMode: "group",
        ltpEligible: false,
        pricingSnapshot: [{ id: "pricing-snooker", stationId: "station-snooker", label: "Default", startMinute: 0, endMinute: 1439, hourlyRate: 300 }],
        items: [],
        pauseLogIds: []
      }
    ],
    sessionPauseLogs: [],
    customers: [],
    customerTabs,
    inventoryItems: [
      { id: "item-redbull", name: "REDBULL", category: "Beverages", price: 100, stockQty: 50, lowStockThreshold: 5, unit: "piece", isReusable: false, active: true },
      { id: "item-pasta", name: "Pasta Sandwich", category: "Food", price: 120, stockQty: 50, lowStockThreshold: 5, unit: "piece", isReusable: false, active: true }
    ],
    stockMovements: [],
    bills: [],
    payments: [],
    auditLogs: [],
    expenses: [],
    expenseTemplates: [],
    expenseTemplateOverrides: []
  };
}

async function login(page, appData) {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: STORAGE_KEY, value: appData }
  );
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("label", { hasText: "Username" }).locator("input").fill("admin");
  await page.locator("label", { hasText: "Password" }).locator("input").fill("admin123");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.getByRole("heading", { name: "Live Dashboard" }).waitFor();
}

async function expectText(locator, text, label) {
  const content = await locator.textContent();
  if (!content?.includes(text)) {
    throw new Error(`${label}: expected text ${JSON.stringify(text)}, got ${JSON.stringify(content)}`);
  }
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function assertNoCardOverlap(page, leftName, rightName) {
  const left = await page.locator("article.station-card", { hasText: leftName }).first().boundingBox();
  const right = await page.locator("article.station-card", { hasText: rightName }).first().boundingBox();
  if (!left || !right) throw new Error("Could not locate live cards for overlap check.");
  if (boxesOverlap(left, right)) {
    throw new Error(`Live cards overlap: ${leftName} and ${rightName}`);
  }
}

async function getStoredData(page) {
  return page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "{}"), STORAGE_KEY);
}

async function runStandardFlow(browser, viewport, label) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.includes("Failed to load resource")) errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await login(page, seedAppData());
  await assertNoCardOverlap(page, "Snooker Star Table", "Customer A");

  await page.getByRole("button", { name: "Consumables Tab" }).click();
  await page.getByText("No customer tab selected").waitFor();
  const disabledRedbull = page.locator("button.catalog-card", { hasText: "REDBULL" }).first();
  if (!(await disabledRedbull.isDisabled())) {
    throw new Error(`${label}: REDBULL catalog card should be disabled before tab selection.`);
  }

  await page.getByRole("button", { name: "Live Dashboard" }).click();
  const customerACard = page.locator("article.station-card", { hasText: "Customer A" }).first();
  await customerACard.getByRole("button", { name: "Manage", exact: true }).click();
  await expectText(page.locator(".active-tab-banner"), "Customer A", `${label}: dashboard Manage should target Customer A`);
  await page.locator("button.catalog-card", { hasText: "REDBULL" }).click();
  await page.getByText("Added REDBULL").waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
  await page.getByText("REDBULL").first().waitFor();

  const customerBChip = page.locator(".tab-chip", { hasText: "Customer B" });
  await customerBChip.click();
  await expectText(page.locator(".active-tab-banner"), "Customer B", `${label}: chip click should target Customer B`);
  await page.locator("button.catalog-card", { hasText: "Pasta Sandwich" }).click();
  await page.getByText("Pasta Sandwich").first().waitFor();

  if (label === "mobile") {
    await page.locator("button.catalog-card", { hasText: "Pasta Sandwich" }).scrollIntoViewIfNeeded().catch(() => undefined);
    await page.locator(".active-tab-banner").getByRole("button", { name: "Change Tab" }).click();
    await page.locator(".active-tab-banner .inline-tab-switcher").waitFor();
    await expectText(page.locator(".active-tab-banner .inline-tab-switcher"), "Customer A", "mobile sticky Change Tab switcher");
    await page.locator(".active-tab-banner .tab-chip", { hasText: "Customer A" }).click();
    await expectText(page.locator(".active-tab-banner"), "Customer A", "mobile sticky Change Tab selection");
    await page.locator(".tab-chip", { hasText: "Customer B" }).click();
  }

  const stored = await getStoredData(page);
  const tabA = stored.customerTabs.find((tab) => tab.id === "tab-a");
  const tabB = stored.customerTabs.find((tab) => tab.id === "tab-b");
  if (!tabA?.items.some((item) => item.name === "REDBULL")) throw new Error(`${label}: Customer A did not receive REDBULL.`);
  if (tabA.items.some((item) => item.name === "Pasta Sandwich")) throw new Error(`${label}: Customer A incorrectly received Pasta Sandwich.`);
  if (!tabB?.items.some((item) => item.name === "Pasta Sandwich")) throw new Error(`${label}: Customer B did not receive Pasta Sandwich.`);

  await customerBChip.click();
  await page.getByRole("button", { name: "Proceed to Checkout" }).click();
  const checkoutCustomer = page.locator(".modal-card label", { hasText: "Customer Name" }).locator("input");
  const checkoutCustomerValue = await checkoutCustomer.inputValue();
  if (checkoutCustomerValue !== "Customer B") {
    throw new Error(`${label}: checkout should show Customer B, got ${JSON.stringify(checkoutCustomerValue)}`);
  }
  await expectText(page.locator(".modal-card"), "Pasta Sandwich", `${label}: checkout should include Customer B item`);
  await page.locator(".modal-card").getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Live Dashboard" }).click();
  const sessionCard = page.locator("article.station-card", { hasText: "Snooker Star Table" }).first();
  await sessionCard.getByRole("button", { name: "Consumables" }).click();
  await page.getByText("Session Consumables").waitFor();
  await page.locator(".session-item-adder select").first().selectOption("item-redbull");
  await page.locator(".session-item-adder").getByRole("button", { name: "Add Item" }).click();
  await page.locator(".modal-card .session-item-row", { hasText: "REDBULL" }).waitFor();
  await page.locator(".modal-card").getByRole("button", { name: "Remove" }).click();
  await page.locator(".modal-card").getByText("No consumables added yet.").waitFor();

  if (errors.length) {
    throw new Error(`${label}: browser console errors:\n${errors.join("\n")}`);
  }
  await context.close();
}

async function runDuplicateNameFlow(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page, seedAppData({ duplicateTabs: true }));

  const duplicateCards = page.locator("article.station-card", { hasText: "VANSH" });
  await duplicateCards.nth(1).getByRole("button", { name: "Manage", exact: true }).click();
  await expectText(page.locator(".active-tab-banner"), "VANSH", "duplicate-name banner");
  await page.locator("button.catalog-card", { hasText: "REDBULL" }).click();

  const stored = await getStoredData(page);
  const first = stored.customerTabs.find((tab) => tab.id === "tab-dup-1");
  const second = stored.customerTabs.find((tab) => tab.id === "tab-dup-2");
  if (first.items.length !== 0) throw new Error("Duplicate-name flow wrote to the first VANSH tab.");
  if (!second.items.some((item) => item.name === "REDBULL")) throw new Error("Duplicate-name flow did not write to the managed VANSH tab.");
  await context.close();
}

async function main() {
  const browser = await chromium.launch({ headless, executablePath });
  try {
    await runStandardFlow(browser, { width: 1366, height: 900 }, "desktop");
    await runStandardFlow(browser, { width: 390, height: 844 }, "mobile");
    await runDuplicateNameFlow(browser);
  } finally {
    await browser.close();
  }
  console.log("Consumables tab UI regression passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
