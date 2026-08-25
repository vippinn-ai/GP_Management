import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import {
  assertStagingBaseUrl,
  assertStagingSupabaseEnvironment,
  parseEnvFile,
  PRODUCTION_PROJECT_REF,
  sanitizeRunId,
  STAGING_APP_URL,
  STAGING_MUTATION_CONFIRMATION,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";

const root = process.cwd();
const command = process.argv[2];
if (!new Set(["create", "deactivate"]).has(command) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/manage-financial-v2-role-accounts-staging.mjs create|deactivate");
}

const baseEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const rolePath = path.join(root, ".env.e2e.roles.local");
const roleEnv = parseEnvFile(rolePath);
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
if (command === "deactivate" && !existsSync(rolePath)) {
  throw new Error("The exact ignored role credential file is required before deactivation.");
}
const env = { ...baseEnv, ...process.env };
const UI_TIMEOUT_MS = 20_000;
assertStagingSupabaseEnvironment(stagingEnv, true);
const baseURL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
if (env.E2E_CONFIRM_STAGING_MUTATIONS !== STAGING_MUTATION_CONFIRMATION) {
  throw new Error(`Set E2E_CONFIRM_STAGING_MUTATIONS=${STAGING_MUTATION_CONFIRMATION} before staging account administration.`);
}
if (!env.E2E_USER_A?.trim() || !env.E2E_PASSWORD_A?.trim()) {
  throw new Error("The ignored staging admin credentials are incomplete.");
}

const runId = sanitizeRunId(command === "deactivate" ? roleEnv.E2E_RUN_ID : env.E2E_RUN_ID);
const browser = await chromium.launch({
  channel: env.E2E_BROWSER_CHANNEL || "chrome",
  headless: env.E2E_HEADLESS !== "false"
});
const adminContext = await browser.newContext({ baseURL, locale: "en-IN", timezoneId: "Asia/Calcutta" });
const adminPage = await adminContext.newPage();

async function signIn(page, username, password) {
  const requests = [];
  page.on("request", (request) => {
    if (!request.url().includes("/rest/v1/")) return;
    const headers = request.headers();
    if (headers.apikey && headers.authorization) requests.push({ url: request.url(), headers });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  const dashboard = page.getByRole("heading", { name: "Live Dashboard", exact: true });
  const loginError = page.locator(".login-form-panel .error-text");
  const outcome = await Promise.race([
    dashboard.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).then(() => ({ kind: "dashboard" })),
    loginError.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).then(async () => ({
      kind: "error",
      message: (await loginError.textContent())?.trim() || "Unknown login error"
    }))
  ]);
  if (outcome.kind === "error") throw new Error(`Staging account sign-in failed: ${outcome.message}`);
  await expect(page.getByText(/^Synced(?:\s|$)/).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect.poll(() => requests.length, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0);
  return requests.at(-1);
}

function jwtSubject(authorization) {
  const payload = authorization?.replace(/^Bearer\s+/i, "").split(".")[1];
  if (!payload) throw new Error("The authenticated request omitted its JWT payload.");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!parsed.sub) throw new Error("The authenticated JWT omitted its subject.");
  return parsed.sub;
}

function authenticatedRest(captured) {
  const url = new URL(captured.url);
  if (url.hostname !== `${STAGING_PROJECT_REF}.supabase.co` || captured.url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("The authenticated browser request did not target the exact staging Supabase project.");
  }
  const markerAt = url.pathname.indexOf("/rest/v1");
  if (markerAt < 0) throw new Error("The authenticated request did not resolve to Supabase REST.");
  const restBase = `${url.origin}${url.pathname.slice(0, markerAt)}/rest/v1`;
  const headers = {
    apikey: captured.headers.apikey,
    authorization: captured.headers.authorization,
    "content-type": "application/json"
  };
  return { restBase, headers };
}

async function authoritativeRole(page, captured, expectedRole) {
  const { restBase, headers } = authenticatedRest(captured);
  const response = await page.request.post(`${restBase}/rpc/current_user_org_role`, {
    headers,
    data: { target_organization_id: "org-primary" }
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toBe(expectedRole);
  return { actorId: jwtSubject(headers.authorization), role: expectedRole };
}

async function authoritativeProfile(page, captured, account) {
  const { restBase, headers } = authenticatedRest(captured);
  const response = await page.request.get(`${restBase}/profiles`, {
    headers,
    params: {
      select: "id,name,username,role,active",
      username: `eq.${account.username}`
    }
  });
  expect(response.status()).toBe(200);
  const profiles = await response.json();
  expect(profiles.length).toBeLessThanOrEqual(1);
  if (!profiles.length) return null;
  expect(profiles[0]).toMatchObject({
    name: account.name,
    username: account.username,
    role: account.role
  });
  return profiles[0];
}

async function openUsers(page) {
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create User", exact: true })).toBeVisible();
}

function userRow(page, username) {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name: username, exact: true }) });
}

async function createUser(page, account) {
  const panel = page.getByRole("heading", { name: "Create User", exact: true })
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' panel ')][1]");
  const form = panel.locator("form");
  await form.getByLabel("Name", { exact: true }).fill(account.name);
  await form.getByLabel("Username", { exact: true }).fill(account.username);
  await form.getByLabel("Password", { exact: true }).fill(account.password);
  await form.locator("select").selectOption(account.role);
  await form.getByRole("button", { name: "Create User", exact: true }).click();
  const row = userRow(page, account.username);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(account.role);
  await expect(row).toContainText("Active");
}

async function disableUser(page, captured, account, allowMissing = false) {
  const profile = await authoritativeProfile(page, captured, account);
  if (!profile) {
    if (allowMissing) return { username: account.username, status: "absent" };
    throw new Error(`The exact staging QA user ${account.username} must exist before deactivation.`);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Live Dashboard", exact: true })).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(page.getByText(/^Synced(?:\s|$)/).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await openUsers(page);
  const row = userRow(page, account.username);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(account.name);
  await expect(row).toContainText(account.role);
  if (profile.active) {
    await row.getByRole("button", { name: "Disable", exact: true }).click();
  }
  await expect(row).toContainText("Inactive", { timeout: 30_000 });
  await expect(row.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
  await expect.poll(async () => (await authoritativeProfile(page, captured, account))?.active).toBe(false);
  return { username: account.username, status: "inactive" };
}

async function verifyAccount(account) {
  const context = await browser.newContext({ baseURL, locale: "en-IN", timezoneId: "Asia/Calcutta" });
  const page = await context.newPage();
  try {
    const request = await signIn(page, account.username, account.password);
    return await authoritativeRole(page, request, account.role);
  } finally {
    await context.close();
  }
}

function writeRoleFile(accounts, state) {
  writeFileSync(rolePath, [
    "# Generated staging-only role credentials. Ignored by Git.",
    `E2E_ROLE_ACCOUNT_STATE=${state}`,
    `E2E_RECEPTIONIST_USER=${accounts[0].username}`,
    `E2E_RECEPTIONIST_PASSWORD=${accounts[0].password}`,
    `E2E_MANAGER_USER=${accounts[1].username}`,
    `E2E_MANAGER_PASSWORD=${accounts[1].password}`,
    `E2E_CONFIRM_STAGING_MUTATIONS=${STAGING_MUTATION_CONFIRMATION}`,
    `E2E_RUN_ID=${runId}`,
    "E2E_HEADLESS=true",
    "E2E_V2_ROLE_HOP_STATION=Playstation",
    ""
  ].join("\n"), "utf8");
}

function exactAccountsFromRoleFile() {
  const suffix = runId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const accounts = [
    {
      name: `QA Role Receptionist ${runId}`,
      username: roleEnv.E2E_RECEPTIONIST_USER?.trim(),
      password: roleEnv.E2E_RECEPTIONIST_PASSWORD,
      role: "receptionist"
    },
    {
      name: `QA Role Manager ${runId}`,
      username: roleEnv.E2E_MANAGER_USER?.trim(),
      password: roleEnv.E2E_MANAGER_PASSWORD,
      role: "manager"
    }
  ];
  if (!accounts.every((account) => account.username && account.password)) {
    throw new Error("The ignored role credential file is incomplete.");
  }
  if (accounts[0].username === accounts[1].username) throw new Error("The QA role account targets must be distinct.");
  if (accounts[0].username !== `qa_role_rec_${suffix}` || accounts[1].username !== `qa_role_mgr_${suffix}`) {
    throw new Error("The ignored role credential file does not match the exact generated QA username/run-ID pattern.");
  }
  return accounts;
}

try {
  const adminRequest = await signIn(adminPage, env.E2E_USER_A.trim(), env.E2E_PASSWORD_A);
  const adminIdentity = await authoritativeRole(adminPage, adminRequest, "admin");
  await openUsers(adminPage);
  if (command === "create") {
    if (existsSync(rolePath)) throw new Error(".env.e2e.roles.local already exists; deactivate or reconcile it before provisioning again.");
    const suffix = runId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const accounts = [
      {
        name: `QA Role Receptionist ${runId}`,
        username: `qa_role_rec_${suffix}`,
        password: `${randomBytes(18).toString("base64url")}A9!`,
        role: "receptionist"
      },
      {
        name: `QA Role Manager ${runId}`,
        username: `qa_role_mgr_${suffix}`,
        password: `${randomBytes(18).toString("base64url")}A9!`,
        role: "manager"
      }
    ];
    writeRoleFile(accounts, "provisioning");
    try {
      for (const account of accounts) {
        await createUser(adminPage, account);
      }
      const identities = await Promise.all(accounts.map(verifyAccount));
      expect(identities[0].actorId).not.toBe(identities[1].actorId);
      writeRoleFile(accounts, "active");
      process.stdout.write(`${JSON.stringify({
        command,
        runId,
        adminActorId: adminIdentity.actorId,
        accounts: accounts.map((account, index) => ({
          username: account.username,
          role: account.role,
          actorId: identities[index].actorId,
          active: true
        })),
        credentialFile: ".env.e2e.roles.local",
        passwordsPrinted: false
      }, null, 2)}\n`);
    } catch (error) {
      const cleanupErrors = [];
      const cleanupResults = [];
      for (const account of [...accounts].reverse()) {
        try {
          cleanupResults.push(await disableUser(adminPage, adminRequest, account, true));
        } catch (cleanupFailure) {
          cleanupErrors.push({
            username: account.username,
            error: cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)
          });
        }
      }
      if (cleanupErrors.length) {
        writeRoleFile(accounts, "recovery_required");
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(`${original} Provisioning cleanup is unresolved: ${JSON.stringify({ cleanupResults, cleanupErrors })}`);
      }
      if (existsSync(rolePath)) unlinkSync(rolePath);
      const original = error instanceof Error ? error.message : String(error);
      throw new Error(`${original} Both deterministic candidates were reconciled: ${JSON.stringify(cleanupResults)}.`);
    }
  } else {
    const accounts = exactAccountsFromRoleFile();
    const state = roleEnv.E2E_ROLE_ACCOUNT_STATE?.trim();
    if (!new Set(["active", "provisioning", "recovery_required", "deactivation_incomplete"]).has(state)) {
      throw new Error("The ignored role credential file has an invalid lifecycle state.");
    }
    const allowMissing = state !== "active";
    const results = [];
    try {
      for (const account of accounts) results.push(await disableUser(adminPage, adminRequest, account, allowMissing));
    } catch (error) {
      writeRoleFile(accounts, "deactivation_incomplete");
      throw error;
    }
    unlinkSync(rolePath);
    process.stdout.write(`${JSON.stringify({
      command,
      runId,
      adminActorId: adminIdentity.actorId,
      accounts: results,
      credentialFileRemoved: true,
      passwordsPrinted: false
    }, null, 2)}\n`);
  }
} finally {
  await adminContext.close();
  await browser.close();
}
