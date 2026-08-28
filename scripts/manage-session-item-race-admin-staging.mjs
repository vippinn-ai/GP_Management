import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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
import { SESSION_ITEM_RACE_ADMIN_FILE } from "./session-item-race-admin-env.mjs";

const root = process.cwd();
const command = process.argv[2];
if (!new Set(["create", "deactivate"]).has(command) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/manage-session-item-race-admin-staging.mjs create|deactivate");
}

const baseEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
const credentialPath = path.join(root, SESSION_ITEM_RACE_ADMIN_FILE);
const storedEnv = parseEnvFile(credentialPath);
const env = { ...baseEnv, ...process.env };
const baseURL = assertStagingBaseUrl(env.E2E_BASE_URL || STAGING_APP_URL);
const UI_TIMEOUT_MS = 20_000;

assertStagingSupabaseEnvironment(stagingEnv, true);
if (env.E2E_CONFIRM_STAGING_MUTATIONS !== STAGING_MUTATION_CONFIRMATION) {
  throw new Error(`Set E2E_CONFIRM_STAGING_MUTATIONS=${STAGING_MUTATION_CONFIRMATION} before staging account administration.`);
}
if (!env.E2E_USER_A?.trim() || !env.E2E_PASSWORD_A?.trim()) {
  throw new Error("The ignored staging admin credentials are incomplete.");
}
if (command === "deactivate" && !existsSync(credentialPath)) {
  throw new Error(`The exact ignored ${SESSION_ITEM_RACE_ADMIN_FILE} file is required before deactivation.`);
}

const runId = sanitizeRunId(command === "create" ? env.E2E_RUN_ID : storedEnv.E2E_SESSION_ITEM_ADMIN_RUN_ID);
const suffix = runId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
const artifactDirectory = path.join(root, "test-artifacts", "account-lifecycle");
const createArtifactPath = path.join(artifactDirectory, `session-item-race-admin-create-${runId}.json`);
const deactivateArtifactPath = path.join(artifactDirectory, `session-item-race-admin-deactivate-${runId}.json`);

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
  const clearPasswordFields = () => page.locator('input[type="password"]').evaluateAll((inputs) => {
    for (const input of inputs) {
      const field = input;
      field.value = "";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }).catch(() => undefined);
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Username", { exact: true }).fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await clearPasswordFields();
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
  } catch (error) {
    await clearPasswordFields();
    throw error;
  }
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
  return {
    restBase: `${url.origin}${url.pathname.slice(0, markerAt)}/rest/v1`,
    headers: {
      apikey: captured.headers.apikey,
      authorization: captured.headers.authorization,
      "content-type": "application/json"
    }
  };
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

async function authoritativeProfile(page, captured, username) {
  const { restBase, headers } = authenticatedRest(captured);
  const response = await page.request.get(`${restBase}/profiles`, {
    headers,
    params: { select: "id,name,username,role,active", username: `eq.${username}` }
  });
  expect(response.status()).toBe(200);
  const profiles = await response.json();
  expect(profiles.length).toBeLessThanOrEqual(1);
  return profiles[0] || null;
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
  await form.locator("select").selectOption("admin");
  const passwordField = form.getByLabel("Password", { exact: true });
  try {
    await passwordField.fill(account.password);
    await form.getByRole("button", { name: "Create User", exact: true }).click();
  } finally {
    await passwordField.fill("", { timeout: 1_000 }).catch(() => form.locator('input[type="password"]').evaluateAll((inputs) => {
      for (const input of inputs) {
        const field = input;
        field.value = "";
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }).catch(() => undefined));
  }
  const row = userRow(page, account.username);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("admin");
  await expect(row).toContainText("Active");
}

async function disableUser(page, captured, account, { allowMissing = false } = {}) {
  const profile = await authoritativeProfile(page, captured, account.username);
  if (!profile) {
    if (allowMissing) return { username: account.username, actorId: account.actorId || null, status: "absent" };
    throw new Error(`The exact staging QA admin ${account.username} must exist before deactivation.`);
  }
  if (account.actorId && account.actorId !== "pending" && profile.id !== account.actorId) {
    throw new Error("The staging QA admin actor no longer matches the bound credential checkpoint.");
  }
  expect(profile).toMatchObject({ name: account.name, username: account.username, role: "admin" });
  await adminPage.reload({ waitUntil: "domcontentloaded" });
  await expect(adminPage.getByRole("heading", { name: "Live Dashboard", exact: true })).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await expect(adminPage.getByText(/^Synced(?:\s|$)/).first()).toBeVisible({ timeout: UI_TIMEOUT_MS });
  await openUsers(adminPage);
  const row = userRow(adminPage, account.username);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(account.name);
  await expect(row).toContainText("admin");
  if (profile.active) await row.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(row).toContainText("Inactive", { timeout: 30_000 });
  await expect(row.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
  await expect.poll(async () => (await authoritativeProfile(page, captured, account.username))?.active).toBe(false);
  return { username: account.username, actorId: profile.id, role: profile.role, status: "inactive" };
}

async function verifyAccount(account) {
  const context = await browser.newContext({ baseURL, locale: "en-IN", timezoneId: "Asia/Calcutta" });
  const page = await context.newPage();
  try {
    const request = await signIn(page, account.username, account.password);
    return await authoritativeRole(page, request, "admin");
  } finally {
    await context.close();
  }
}

function writeCredentialFile(account, state) {
  writeFileSync(credentialPath, [
    "# Generated staging-only session-item race admin credentials. Ignored by Git.",
    `E2E_SESSION_ITEM_ADMIN_STATE=${state}`,
    `E2E_SESSION_ITEM_ADMIN_RUN_ID=${runId}`,
    `E2E_SESSION_ITEM_ADMIN_USER=${account.username}`,
    `E2E_SESSION_ITEM_ADMIN_PASSWORD=${account.password}`,
    `E2E_SESSION_ITEM_ADMIN_ACTOR_ID=${account.actorId || "pending"}`,
    `E2E_SESSION_ITEM_ADMIN_PROJECT_REF=${STAGING_PROJECT_REF}`,
    `E2E_SESSION_ITEM_ADMIN_BASE_URL=${STAGING_APP_URL}`,
    `E2E_CONFIRM_STAGING_MUTATIONS=${STAGING_MUTATION_CONFIRMATION}`,
    ""
  ].join("\n"), "utf8");
}

function exactStoredAccount() {
  const account = {
    name: `QA Session Item Race Admin ${runId}`,
    username: storedEnv.E2E_SESSION_ITEM_ADMIN_USER?.trim(),
    password: storedEnv.E2E_SESSION_ITEM_ADMIN_PASSWORD,
    actorId: storedEnv.E2E_SESSION_ITEM_ADMIN_ACTOR_ID?.trim()
  };
  if (!account.username || !account.password || !account.actorId) {
    throw new Error("The ignored session-item admin credential file is incomplete.");
  }
  if (account.username !== `qa_item_admin_${suffix}`) {
    throw new Error("The ignored session-item admin username does not match its exact run identity.");
  }
  if (storedEnv.E2E_SESSION_ITEM_ADMIN_PROJECT_REF !== STAGING_PROJECT_REF || storedEnv.E2E_SESSION_ITEM_ADMIN_BASE_URL !== STAGING_APP_URL) {
    throw new Error("The ignored session-item admin credential is not staging-bound.");
  }
  return account;
}

function writeArtifact(filePath, payload) {
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function sanitizedErrorMessage(error, secret) {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.replaceAll(secret, "[REDACTED]") : message;
}

try {
  const adminRequest = await signIn(adminPage, env.E2E_USER_A.trim(), env.E2E_PASSWORD_A);
  const adminIdentity = await authoritativeRole(adminPage, adminRequest, "admin");
  await openUsers(adminPage);

  if (command === "create") {
    if (existsSync(credentialPath)) throw new Error(`${SESSION_ITEM_RACE_ADMIN_FILE} already exists; deactivate or reconcile it first.`);
    if (existsSync(createArtifactPath) || existsSync(deactivateArtifactPath)) {
      throw new Error("The temporary-admin run identity collides with immutable lifecycle evidence.");
    }
    const account = {
      name: `QA Session Item Race Admin ${runId}`,
      username: `qa_item_admin_${suffix}`,
      password: `${randomBytes(18).toString("base64url")}A9!`,
      actorId: "pending"
    };
    const existing = await authoritativeProfile(adminPage, adminRequest, account.username);
    if (existing) throw new Error("The exact temporary-admin username already exists.");
    writeCredentialFile(account, "provisioning");
    try {
      await createUser(adminPage, account);
      const identity = await verifyAccount(account);
      account.actorId = identity.actorId;
      const profile = await authoritativeProfile(adminPage, adminRequest, account.username);
      expect(profile).toMatchObject({
        id: account.actorId,
        name: account.name,
        username: account.username,
        role: "admin",
        active: true
      });
      writeCredentialFile(account, "active");
      const evidence = {
        command,
        runId,
        checkedAt: new Date().toISOString(),
        projectRef: STAGING_PROJECT_REF,
        baseUrl: baseURL,
        adminActorId: adminIdentity.actorId,
        account: { username: account.username, actorId: account.actorId, role: "admin", active: true },
        credentialFile: SESSION_ITEM_RACE_ADMIN_FILE,
        passwordsPrinted: false,
        productionAllowed: false
      };
      writeArtifact(createArtifactPath, evidence);
      process.stdout.write(`${JSON.stringify({ ...evidence, artifact: path.relative(root, createArtifactPath) }, null, 2)}\n`);
    } catch (error) {
      let cleanup;
      try {
        const candidate = await authoritativeProfile(adminPage, adminRequest, account.username);
        if (candidate) {
          expect(candidate).toMatchObject({ name: account.name, username: account.username, role: "admin" });
          account.actorId = candidate.id;
        }
        cleanup = await disableUser(adminPage, adminRequest, account, { allowMissing: true });
        unlinkSync(credentialPath);
      } catch (cleanupError) {
        writeCredentialFile(account, "recovery_required");
        throw new Error(`${sanitizedErrorMessage(error, account.password)} Cleanup is unresolved: ${sanitizedErrorMessage(cleanupError, account.password)}`);
      }
      throw new Error(`${sanitizedErrorMessage(error, account.password)} Deterministic candidate reconciled: ${JSON.stringify(cleanup)}.`);
    }
  } else {
    const state = storedEnv.E2E_SESSION_ITEM_ADMIN_STATE?.trim();
    if (!new Set(["active", "provisioning", "recovery_required", "deactivation_incomplete"]).has(state)) {
      throw new Error("The ignored session-item admin file has an invalid lifecycle state.");
    }
    if (existsSync(deactivateArtifactPath)) throw new Error("Immutable temporary-admin deactivation evidence already exists.");
    const account = exactStoredAccount();
    let result;
    try {
      result = await disableUser(adminPage, adminRequest, account, { allowMissing: state !== "active" });
    } catch (error) {
      writeCredentialFile(account, "deactivation_incomplete");
      throw error;
    }
    const evidence = {
      command,
      runId,
      checkedAt: new Date().toISOString(),
      projectRef: STAGING_PROJECT_REF,
      baseUrl: baseURL,
      adminActorId: adminIdentity.actorId,
      account: result,
      credentialFileRemoved: true,
      passwordsPrinted: false,
      productionAllowed: false
    };
    unlinkSync(credentialPath);
    if (existsSync(credentialPath)) throw new Error("The temporary-admin credential file still exists after deletion.");
    writeArtifact(deactivateArtifactPath, evidence);
    process.stdout.write(`${JSON.stringify({ ...evidence, artifact: path.relative(root, deactivateArtifactPath) }, null, 2)}\n`);
  }
} finally {
  await adminContext.close();
  await browser.close();
}
