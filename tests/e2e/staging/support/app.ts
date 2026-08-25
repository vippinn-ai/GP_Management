import { expect, type APIResponse, type Browser, type BrowserContext, type Page, type Route, type TestInfo } from "@playwright/test";
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
  serverDurationMs?: number;
  changedRows?: Record<string, unknown>;
}

export interface PageErrorCapture {
  consoleErrors: string[];
  pageErrors: string[];
}

export interface CapturedRpcRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type OperationalRole = "admin" | "manager" | "receptionist";

export interface AuthoritativeOrganizationIdentity {
  actorId: string;
  role: OperationalRole;
  restBase: string;
  headers: Record<string, string>;
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
  await expect(page.getByText(/^Synced(?:\s|$)/).first()).toBeVisible();
  await expect(page.getByText("Pending sync.", { exact: false })).toHaveCount(0);
}

export async function readPendingOperationalMutations(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("game-parlour-management-system/pending-operations/v1");
    if (!raw) return [];
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return { invalidJson: raw };
    }
  });
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
  const manageButton = card.getByRole("button", { name: "Manage", exact: true });
  await expect(manageButton).toBeVisible();
  await expect(manageButton).toBeEnabled();
  await manageButton.focus();
  await manageButton.press("Enter");
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
      serverDurationMs: typeof body.server_duration_ms === "number" ? body.server_duration_ms : undefined,
      changedRows: body.changed_rows && typeof body.changed_rows === "object" ? body.changed_rows as Record<string, unknown> : undefined
    });
  });
}

export function captureAuthenticatedRestRequests(page: Page, target: CapturedRpcRequest[]) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.includes("/rest/v1/")) return;
    const headers = request.headers();
    if (!headers.apikey || !headers.authorization) return;
    let body: unknown = null;
    const postData = request.postData();
    if (postData) {
      try {
        body = request.postDataJSON();
      } catch {
        body = postData;
      }
    }
    target.push({
      url: request.url(),
      headers,
      body
    });
  });
}

export async function assertAuthoritativeOrganizationIdentity(
  page: Page,
  requests: CapturedRpcRequest[],
  expectedRole: OperationalRole,
  organizationId = "org-primary"
): Promise<AuthoritativeOrganizationIdentity> {
  const captured = [...requests].reverse().find((entry) => {
    const url = new URL(entry.url);
    return url.pathname.includes("/rest/v1/") && Boolean(entry.headers.apikey && entry.headers.authorization);
  });
  if (!captured) throw new Error(`No authenticated REST request was captured for the expected ${expectedRole} account.`);

  const actorId = authenticatedJwtSubject(captured.headers);
  const restUrl = new URL(captured.url);
  const restMarker = "/rest/v1";
  const markerAt = restUrl.pathname.indexOf(restMarker);
  if (markerAt < 0) throw new Error("The authenticated request did not resolve to a Supabase REST endpoint.");
  const restBase = `${restUrl.origin}${restUrl.pathname.slice(0, markerAt)}${restMarker}`;
  const headers = {
    apikey: captured.headers.apikey,
    authorization: captured.headers.authorization,
    "content-type": "application/json"
  };
  const roleResponse = await page.request.post(`${restBase}/rpc/current_user_org_role`, {
    headers,
    data: { target_organization_id: organizationId }
  });
  expect(roleResponse.status(), `current_user_org_role status for ${expectedRole}`).toBe(200);
  const role = await roleResponse.json() as OperationalRole | null;
  expect(role, `The authenticated account must have authoritative ${expectedRole} membership in ${organizationId}.`)
    .toBe(expectedRole);

  const profiles = await readRestRows<{ id: string; role: OperationalRole; active: boolean }>(
    page,
    restBase,
    headers,
    "profiles",
    { id: `eq.${actorId}`, select: "id,role,active" }
  );
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({ id: actorId, role: expectedRole, active: true });
  return { actorId, role, restBase, headers };
}

export async function readApiResponseBody(response: APIResponse) {
  const body = await response.text();
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { raw: body };
  }
}

export function rpcRejectionCode(body: Record<string, unknown>) {
  try {
    return (JSON.parse(String(body.details)) as { code?: string }).code ?? null;
  } catch {
    return null;
  }
}

export function authenticatedJwtSubject(headers: Record<string, string>) {
  const token = headers.authorization?.replace(/^Bearer\s+/i, "");
  const payload = token?.split(".")[1];
  if (!payload) throw new Error("The captured RPC request omitted its authenticated JWT.");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string };
  if (!decoded.sub) throw new Error("The captured authenticated JWT omitted its subject.");
  return decoded.sub;
}

export async function readRestRows<T>(
  page: Page,
  restBase: string,
  headers: Record<string, string>,
  table: string,
  query: Record<string, string>
) {
  const params = new URLSearchParams(query);
  const response = await page.request.get(`${restBase}/${table}?${params.toString()}`, { headers });
  expect(response.status(), `${table} reconciliation status`).toBe(200);
  return await response.json() as T[];
}

export async function interceptSingleRpcCommand(page: Page, pattern: string) {
  let captureCount = 0;
  let submitted = false;
  let decided = false;
  let primaryCaptured = false;
  let settledResolved = false;
  let resolveCaptured!: (value: CapturedRpcRequest) => void;
  let resolveDecision!: (value: { action: "submit"; body: unknown } | { action: "cancel" }) => void;
  let resolveResponse!: (value: APIResponse) => void;
  let rejectResponse!: (reason: unknown) => void;
  let resolveSettled!: () => void;
  const captured = new Promise<CapturedRpcRequest>((resolve) => { resolveCaptured = resolve; });
  const decision = new Promise<{ action: "submit"; body: unknown } | { action: "cancel" }>((resolve) => {
    resolveDecision = resolve;
  });
  const response = new Promise<APIResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });

  const settleOnce = () => {
    if (settledResolved) return;
    settledResolved = true;
    resolveSettled();
  };

  const abortIgnoringHandledRoute = async (route: Route, errorCode: string) => {
    try {
      await route.abort(errorCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Route is already handled!?/i.test(message)) throw error;
    }
  };

  const handler = async (route: Route) => {
    captureCount += 1;
    const isPrimaryCapture = captureCount === 1;
    try {
      if (!isPrimaryCapture) {
        await abortIgnoringHandledRoute(route, "blockedbyclient");
        return;
      }
      primaryCaptured = true;
      const request = route.request();
      resolveCaptured({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
      const next = await decision;
      if (next.action === "cancel") {
        await abortIgnoringHandledRoute(route, "aborted");
        return;
      }
      try {
        const serverResponse = await route.fetch({ postData: JSON.stringify(next.body), timeout: 30_000 });
        await route.fulfill({ response: serverResponse });
        resolveResponse(serverResponse);
      } catch (error) {
        await abortIgnoringHandledRoute(route, "aborted");
        rejectResponse(error);
      }
    } finally {
      if (isPrimaryCapture) {
        settleOnce();
      }
    }
  };

  await page.route(pattern, handler);

  return {
    captured,
    settled,
    submit(body: unknown) {
      if (submitted || decided) throw new Error(`The intercepted ${pattern} command can only be submitted once.`);
      submitted = true;
      decided = true;
      resolveDecision({ action: "submit", body });
      return response;
    },
    cancel() {
      if (decided) return;
      decided = true;
      resolveDecision({ action: "cancel" });
    },
    async dispose() {
      if (!decided) {
        decided = true;
        resolveDecision({ action: "cancel" });
      }
      await page.unroute(pattern, handler);
      if (!primaryCaptured) settleOnce();
      await settled;
    },
    captureCount: () => captureCount,
    wasSubmitted: () => submitted
  };
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

export async function rejectSessionIfOpen(page: Page, stationName: string, customerName: string, reason: string) {
  await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
  const card = stationCard(page, stationName);
  if (!(await card.count()) || (await card.textContent())?.includes("Available")) return false;
  await expect(card, "Cleanup refused because the station no longer belongs to the exact QA customer.").toContainText(customerName);
  const modal = await openManagedSession(page, stationName);
  await modal.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
  const customerField = modal.getByLabel("Customer Name", { exact: true });
  await expect(customerField, "Cleanup refused because the stored session customer no longer matches the exact QA customer.").toHaveValue(customerName);
  await customerField.locator("xpath=ancestor::form").getByRole("button", { name: "Cancel", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept(reason));
  await modal.getByRole("button", { name: "Reject Session", exact: true }).click();
  await expect(modal).toBeHidden();
  await waitForSynced(page);
  await expect(stationCard(page, stationName)).toContainText("Available");
  return true;
}
