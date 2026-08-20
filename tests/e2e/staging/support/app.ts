import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

export interface StagingCredentials {
  username: string;
  password: string;
}

export interface RpcEvidence {
  page: "origin" | "observer";
  rpc: string;
  status: number;
  entityId?: string;
  billId?: string;
  billNumber?: string;
  eventId?: string;
  mutationId?: string;
  serverTime?: string;
  changedRows?: Record<string, unknown>;
}

export interface PageErrorCapture {
  consoleErrors: string[];
  pageErrors: string[];
}

export function credentials(slot: "A" | "B"): StagingCredentials {
  const username = process.env[`E2E_USER_${slot}`]?.trim();
  const password = process.env[`E2E_PASSWORD_${slot}`]?.trim();
  if (!username || !password) {
    throw new Error(`Missing staging credentials for browser ${slot}.`);
  }
  return { username, password };
}

export async function createObserver(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    locale: "en-IN",
    timezoneId: "Asia/Calcutta"
  });
  return { context, page: await context.newPage() };
}

export async function signIn(page: Page, account: StagingCredentials) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username", { exact: true }).fill(account.username);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Live Dashboard", exact: true })).toBeVisible();
  await waitForSynced(page);
}

export async function waitForSynced(page: Page) {
  await expect(page.getByText("Synced", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Pending sync.", { exact: false })).toHaveCount(0);
}

export function stationCard(page: Page, stationName: string) {
  return page.locator("article.station-card").filter({
    has: page.getByRole("heading", { name: stationName, exact: true })
  });
}

export async function startSession(page: Page, stationName: string, customerName: string) {
  const card = stationCard(page, stationName);
  await expect(card).toContainText("Available");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Start New Session", exact: true });
  await expect(modal).toBeVisible();
  await modal.getByLabel("Customer Name", { exact: true }).fill(customerName);
  const playMode = modal.getByLabel("Play Mode", { exact: true });
  if (await playMode.count()) await playMode.selectOption("group");
  await modal.getByRole("button", { name: "Start Session", exact: true }).click();
  await expect(modal).toBeHidden();
  await waitForSynced(page);
  await expect(stationCard(page, stationName)).toContainText(customerName);
}

export async function openManagedSession(page: Page, stationName: string) {
  const card = stationCard(page, stationName);
  await card.getByRole("button", { name: "Manage", exact: true }).click();
  const modal = page.getByRole("dialog", { name: stationName, exact: true });
  await expect(modal).toBeVisible();
  return modal;
}

export async function browserDateTimeLocal(page: Page, offsetMinutes: number) {
  return page.evaluate((offset) => {
    const date = new Date(Date.now() + offset * 60_000);
    const pad = (value: number) => `${value}`.padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, offsetMinutes);
}

export function capturePageErrors(page: Page): PageErrorCapture {
  const capture: PageErrorCapture = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      capture.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => capture.pageErrors.push(error.message));
  return capture;
}

export function captureRpcEvidence(page: Page, pageName: RpcEvidence["page"], target: RpcEvidence[]) {
  page.on("response", async (response) => {
    const url = new URL(response.url());
    const marker = "/rest/v1/rpc/";
    if (!url.pathname.includes(marker) || response.request().method() !== "POST") return;
    const rpc = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
    let body: Record<string, unknown> = {};
    try {
      const value = await response.json();
      if (value && typeof value === "object" && !Array.isArray(value)) body = value as Record<string, unknown>;
    } catch {
      // A non-JSON failure is still retained through status and the test error.
    }
    target.push({
      page: pageName,
      rpc,
      status: response.status(),
      entityId: typeof body.entity_id === "string" ? body.entity_id : undefined,
      billId: typeof body.bill_id === "string" ? body.bill_id : undefined,
      billNumber: typeof body.bill_number === "string" ? body.bill_number : undefined,
      eventId: typeof body.event_id === "string" ? body.event_id : undefined,
      mutationId: typeof body.mutation_id === "string" ? body.mutation_id : undefined,
      serverTime: typeof body.server_time === "string" ? body.server_time : undefined,
      changedRows: body.changed_rows && typeof body.changed_rows === "object" ? body.changed_rows as Record<string, unknown> : undefined
    });
  });
}

export function changedRowIds(entry: RpcEvidence, collection: string) {
  const values = entry.changedRows?.[collection];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

export async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  const fileName = `${name.replace(/[^A-Za-z0-9_-]+/g, "-")}.json`;
  const outputPath = testInfo.outputPath(fileName);
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await testInfo.attach(name, {
    path: outputPath,
    contentType: "application/json"
  });
}

export async function attachFailureScreenshot(testInfo: TestInfo, page: Page, name: string) {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
}

export function assertNoPageErrors(...captures: PageErrorCapture[]) {
  const consoleErrors = captures.flatMap((capture) => capture.consoleErrors);
  const pageErrors = captures.flatMap((capture) => capture.pageErrors);
  expect({ consoleErrors, pageErrors }).toEqual({ consoleErrors: [], pageErrors: [] });
}

export async function rejectSessionIfOpen(page: Page, stationName: string, reason: string) {
  await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
  const card = stationCard(page, stationName);
  if (!(await card.count()) || (await card.textContent())?.includes("Available")) return false;
  const modal = await openManagedSession(page, stationName);
  page.once("dialog", (dialog) => dialog.accept(reason));
  await modal.getByRole("button", { name: "Reject Session", exact: true }).click();
  await expect(modal).toBeHidden();
  await waitForSynced(page);
  await expect(stationCard(page, stationName)).toContainText("Available");
  return true;
}
