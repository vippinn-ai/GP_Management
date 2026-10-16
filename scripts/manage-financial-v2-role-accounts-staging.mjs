import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { authStatusFromResponse, runSignInStages, closeBrowserResources, withBoundedContext, SYNCED_LABEL } from "./role-account-browser-safety.mjs";
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
import {
  assertExactUsernameAbsence,
  assertOwnedDeactivationTargets,
  assertSuccessfulCreateResponse,
  createRoleReceiptStore,
  ownedCleanupTargets,
  roleOperationFailure,
  settleCreateAction
} from "./role-account-provisioning-safety.mjs";

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
if (command === "create" && existsSync(rolePath)) {
  throw new Error(".env.e2e.roles.local already exists; deactivate or reconcile it before provisioning again.");
}
const suffix = runId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
const accounts = command === "create" ? [
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
  },
  {
    name: `QA Admin Observer ${runId}`,
    username: `qa_role_admin_${suffix}`,
    password: `${randomBytes(18).toString("base64url")}A9!`,
    role: "admin"
  }
] : exactAccountsFromRoleFile();
const receiptStore = createRoleReceiptStore({
  root,
  runId,
  command,
  secrets: [env.E2E_PASSWORD_A, env.E2E_PASSWORD_B, ...accounts.map((account) => account.password)].filter(Boolean)
});
receiptStore.write("reservation", {
  createdAtUtc: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  organizationId: "org-primary",
  targets: accounts.map(({ username, role, profileId }) => ({ username, role, profileId: profileId ?? null })),
  credentialFile: ".env.e2e.roles.local",
  productionAllowed: false
});

let browser;
let adminContext;
let adminPage;
let adminRequest;
let adminIdentity;
const attemptedUsernames = [];
const cleanupOutcomes = [];
const cleanupErrors = [];
const signInDiagnostics = [];
const verificationCleanup = [];
let failureStage = "browser-launch";
let operationFailed = false;
let terminalReceiptWritten = false;
let terminalReceiptUnavailable = false;
let finalError;

async function signIn(page, username, password, actorSlot = "admin") {
  const requests = [];
  const diagnostic = { actorSlot, substage: "navigation", outcome: "running", authStatus: null, errorCode: null };
  signInDiagnostics.push(diagnostic);
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.origin !== `https://${STAGING_PROJECT_REF}.supabase.co` || !url.pathname.startsWith("/rest/v1/")) return;
    const headers = request.headers();
    if (headers.apikey && headers.authorization) requests.push({ url: request.url(), headers });
  };
  const onResponse = (response) => {
    const status = authStatusFromResponse(response, STAGING_PROJECT_REF);
    if (status !== null) diagnostic.authStatus = status;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    await runSignInStages({
      navigation: () => page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 }),
      "username-fill": () => page.getByLabel("Username", { exact: true }).fill(username, { timeout: UI_TIMEOUT_MS }),
      "password-fill": () => page.getByLabel("Password", { exact: true }).fill(password, { timeout: UI_TIMEOUT_MS }),
      submit: () => page.getByRole("button", { name: "Sign In", exact: true }).click({ timeout: UI_TIMEOUT_MS }),
      dashboard: async () => {
        const dashboard = page.getByRole("heading", { name: "Live Dashboard", exact: true });
        const loginError = page.locator(".login-form-panel .error-text");
        const outcome = await Promise.race([
          dashboard.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).then(() => "dashboard"),
          loginError.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS }).then(() => "error")
        ]);
        if (outcome === "error") throw new Error("Staging account sign-in rejected.");
      },
      sync: () => expect(page.getByText(SYNCED_LABEL).first()).toBeVisible({ timeout: UI_TIMEOUT_MS }),
      "authenticated-request-capture": () => expect.poll(() => requests.length, { timeout: UI_TIMEOUT_MS }).toBeGreaterThan(0)
    }, diagnostic);
    return requests.at(-1);
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
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

async function authoritativeUsernameAbsence(page, captured, usernames) {
  const { restBase, headers } = authenticatedRest(captured);
  const rowsByUsername = {};
  for (const username of usernames) {
    const response = await page.request.get(`${restBase}/profiles`, {
      headers,
      params: { select: "username", username: `eq.${username}` }
    });
    expect(response.status()).toBe(200);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.some((row) => row?.username !== username)) {
      throw new Error(`Authoritative username lookup returned invalid evidence for ${username}.`);
    }
    rowsByUsername[username] = rows;
  }
  assertExactUsernameAbsence(usernames, rowsByUsername);
  return rowsByUsername;
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
  const createResponsePromise = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "POST" || !new URL(response.url()).pathname.endsWith("/functions/v1/admin-create-user")) return false;
    try {
      return request.postDataJSON()?.username === account.username;
    } catch {
      return false;
    }
  }, { timeout: UI_TIMEOUT_MS });
  const createResponse = await settleCreateAction(
    createResponsePromise,
    form.getByRole("button", { name: "Create User", exact: true }).click()
  );
  assertSuccessfulCreateResponse(createResponse.status(), await createResponse.json());
  const row = userRow(page, account.username);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(account.role);
  await expect(row).toContainText("Active");
}

async function disableUser(page, captured, account, allowMissing = false, expectedProfileId) {
  const profile = await authoritativeProfile(page, captured, account);
  if (!profile) {
    if (allowMissing) return { username: account.username, status: "absent" };
    throw new Error(`The exact staging QA user ${account.username} must exist before deactivation.`);
  }
  if (!expectedProfileId || profile.id !== expectedProfileId) {
    throw new Error(`The staging QA user ${account.username} does not match the owned profile identity; cleanup was refused.`);
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
  return withBoundedContext(context, async () => {
    const page = await context.newPage();
    const request = await signIn(page, account.username, account.password, account.role);
    return await authoritativeRole(page, request, account.role);
  }, (cleanup) => verificationCleanup.push({actorSlot: account.role, ...cleanup}));
}

function writeRoleFile(accounts, state) {
  writeFileSync(rolePath, [
    "# Generated staging-only role credentials. Ignored by Git.",
    `E2E_ROLE_ACCOUNT_STATE=${state}`,
    `E2E_RECEPTIONIST_USER=${accounts[0].username}`,
    `E2E_RECEPTIONIST_PASSWORD=${accounts[0].password}`,
    ...(accounts[0].profileId ? [`E2E_RECEPTIONIST_ACTOR_ID=${accounts[0].profileId}`] : []),
    `E2E_MANAGER_USER=${accounts[1].username}`,
    `E2E_MANAGER_PASSWORD=${accounts[1].password}`,
    ...(accounts[1].profileId ? [`E2E_MANAGER_ACTOR_ID=${accounts[1].profileId}`] : []),
    `E2E_OBSERVER_ADMIN_USER=${accounts[2].username}`,
    `E2E_OBSERVER_ADMIN_PASSWORD=${accounts[2].password}`,
    ...(accounts[2].profileId ? [`E2E_OBSERVER_ADMIN_ACTOR_ID=${accounts[2].profileId}`] : []),
    `E2E_CONFIRM_STAGING_MUTATIONS=${STAGING_MUTATION_CONFIRMATION}`,
    `E2E_RUN_ID=${runId}`,
    "E2E_HEADLESS=true",
    "E2E_V2_ROLE_HOP_STATION=Playstation",
    ""
  ].join("\n"), "utf8");
}

function exactAccountsFromRoleFile() {
  const accounts = [
    {
      name: `QA Role Receptionist ${runId}`,
      username: roleEnv.E2E_RECEPTIONIST_USER?.trim(),
      password: roleEnv.E2E_RECEPTIONIST_PASSWORD,
      profileId: roleEnv.E2E_RECEPTIONIST_ACTOR_ID?.trim(),
      role: "receptionist"
    },
    {
      name: `QA Role Manager ${runId}`,
      username: roleEnv.E2E_MANAGER_USER?.trim(),
      password: roleEnv.E2E_MANAGER_PASSWORD,
      profileId: roleEnv.E2E_MANAGER_ACTOR_ID?.trim(),
      role: "manager"
    },
    {
      name: `QA Admin Observer ${runId}`,
      username: roleEnv.E2E_OBSERVER_ADMIN_USER?.trim(),
      password: roleEnv.E2E_OBSERVER_ADMIN_PASSWORD,
      profileId: roleEnv.E2E_OBSERVER_ADMIN_ACTOR_ID?.trim(),
      role: "admin"
    }
  ];
  if (!accounts.every((account) => account.username && account.password)) {
    throw new Error("The ignored role credential file is incomplete.");
  }
  if (new Set(accounts.map((account) => account.username)).size !== accounts.length) throw new Error("The QA role account targets must be distinct.");
  if (
    accounts[0].username !== `qa_role_rec_${suffix}`
    || accounts[1].username !== `qa_role_mgr_${suffix}`
    || accounts[2].username !== `qa_role_admin_${suffix}`
  ) {
    throw new Error("The ignored role credential file does not match the exact generated QA username/run-ID pattern.");
  }
  return accounts;
}

try {
  browser = await chromium.launch({
    channel: env.E2E_BROWSER_CHANNEL || "chrome",
    headless: env.E2E_HEADLESS !== "false"
  });
  adminContext = await browser.newContext({ baseURL, locale: "en-IN", timezoneId: "Asia/Calcutta" });
  adminPage = await adminContext.newPage();
  failureStage = "admin-sign-in";
  adminRequest = await signIn(adminPage, env.E2E_USER_A.trim(), env.E2E_PASSWORD_A);
  failureStage = "admin-role";
  adminIdentity = await authoritativeRole(adminPage, adminRequest, "admin");
  if (command === "create") {
    writeRoleFile(accounts, "provisioning");
    failureStage = "precreate-absence";
    await authoritativeUsernameAbsence(adminPage, adminRequest, accounts.map((account) => account.username));
    await openUsers(adminPage);
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index];
      attemptedUsernames.push(account.username);
      failureStage = `create-${account.role}`;
      await createUser(adminPage, account);
      const profile = await authoritativeProfile(adminPage, adminRequest, account);
      if (!profile?.id || profile.active !== true) {
        throw new Error(`The new staging QA user ${account.username} has no authoritative active profile identity.`);
      }
      accounts[index] = { ...account, profileId: profile.id };
      writeRoleFile(accounts, "provisioning");
    }
    failureStage = "verify-created-identities";
    const verified = await Promise.allSettled(accounts.map(verifyAccount));
    const failedVerification = verified.find((entry) => entry.status === "rejected");
    if (failedVerification) throw failedVerification.reason;
    const identities = verified.map((entry) => entry.value);
    expect(new Set(identities.map((identity) => identity.actorId)).size).toBe(accounts.length);
    for (let index = 0; index < accounts.length; index += 1) {
      expect(identities[index].actorId).toBe(accounts[index].profileId);
    }
    writeRoleFile(accounts, "active");
    const receiptAccounts = accounts.map((account, index) => ({
      username: account.username,
      role: account.role,
      profileId: identities[index].actorId,
      active: true
    }));
    receiptStore.write("success", {
      completedAtUtc: new Date().toISOString(),
      adminActorId: adminIdentity.actorId,
      accounts: receiptAccounts,
      credentialFileState: "active",
      signInDiagnostics,
      verificationCleanup,
      cleanupOutcomes
    });
    terminalReceiptWritten = true;
    process.stdout.write(`${JSON.stringify({
      command,
      runId,
      adminActorId: adminIdentity.actorId,
      accounts: receiptAccounts,
      credentialFile: ".env.e2e.roles.local",
      credentialsPrinted: false
    }, null, 2)}\n`);
  } else {
    const state = roleEnv.E2E_ROLE_ACCOUNT_STATE?.trim();
    if (!new Set(["active", "provisioning", "provisioning_failed_reconciled", "recovery_required", "deactivation_incomplete"]).has(state)) {
      throw new Error("The ignored role credential file has an invalid lifecycle state.");
    }
    const deactivationTargets = assertOwnedDeactivationTargets(accounts);
    failureStage = "deactivate-owned-profiles";
    await openUsers(adminPage);
    const results = [];
    for (const target of deactivationTargets) {
      const account = accounts.find((entry) => entry.username === target.username);
      results.push(await disableUser(adminPage, adminRequest, account, state !== "active", target.profileId));
    }
    receiptStore.write("success", {
      completedAtUtc: new Date().toISOString(),
      adminActorId: adminIdentity.actorId,
      accounts: results,
      credentialFileState: "preserved-until-success-receipt",
      signInDiagnostics,
      verificationCleanup,
      cleanupOutcomes: results
    });
    terminalReceiptWritten = true;
    failureStage = "remove-credential-file";
    unlinkSync(rolePath);
    receiptStore.write("closeout", {
      completedAtUtc: new Date().toISOString(),
      accounts: results,
      credentialFileRemoved: true
    });
    process.stdout.write(`${JSON.stringify({
      command,
      runId,
      adminActorId: adminIdentity.actorId,
      accounts: results,
      credentialFileRemoved: true,
      credentialsPrinted: false
    }, null, 2)}\n`);
  }
} catch {
  operationFailed = true;
  if (command === "create") {
    if (adminPage && adminRequest) {
      for (const target of [...ownedCleanupTargets(accounts)].reverse()) {
        const account = accounts.find((entry) => entry.username === target.username);
        try {
          cleanupOutcomes.push(await disableUser(adminPage, adminRequest, account, true, target.profileId));
        } catch {
          cleanupErrors.push({
            username: target.username,
            errorCode: "owned_profile_cleanup_failed"
          });
        }
      }
    }
    const unownedAttempt = attemptedUsernames.some((username) => !accounts.find((account) => account.username === username)?.profileId);
    const state = cleanupErrors.length || unownedAttempt ? "recovery_required" : "provisioning_failed_reconciled";
    writeRoleFile(accounts, state);
  } else if (accounts.length === 3) {
    writeRoleFile(accounts, "deactivation_incomplete");
  }
  const failure = {
    completedAtUtc: new Date().toISOString(),
    adminActorId: adminIdentity?.actorId ?? null,
    errorCode: "role_account_operation_failed",
    failureStage,
    signInDiagnostics,
    verificationCleanup,
    attemptedUsernames,
    ownedProfiles: ownedCleanupTargets(accounts),
    cleanupOutcomes,
    cleanupErrors,
    credentialFilePreserved: existsSync(rolePath),
    productionAllowed: false
  };
  if (!terminalReceiptWritten) {
    try {
      receiptStore.write("failure", failure);
      terminalReceiptWritten = true;
    } catch {
      terminalReceiptUnavailable = true;
    }
  }
} finally {
  const cleanup = await closeBrowserResources(adminContext, browser);
  try {
    receiptStore.write("browser-cleanup", {
      completedAtUtc: new Date().toISOString(), operationFailed, failureStage,
      signInDiagnostics, verificationCleanup,
      resources: [{resource: "admin-context", ...cleanup[0]}, {resource: "browser", ...cleanup[1]}]
    });
  } catch { terminalReceiptUnavailable = true; }
  finalError = roleOperationFailure({
    operationFailed,
    terminalReceiptUnavailable,
    failureStage,
    cleanupStatuses: cleanup.map((result) => result.status)
  });
}
if (finalError) throw finalError;
