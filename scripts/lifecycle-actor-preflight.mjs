import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { assertStagingBaseUrl, STAGING_PROJECT_REF } from './playwright-staging-env.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadLifecycleRoleEnvironment(env, roles) {
  if (roles.E2E_ROLE_ACCOUNT_STATE !== 'active' || roles.E2E_RUN_ID !== env.E2E_RUN_ID) throw new Error('Role fixture state/run identity mismatch.');
  const suffix = env.E2E_RUN_ID.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const result = { ...env };
  for (const [role, short] of [['RECEPTIONIST', 'rec'], ['MANAGER', 'mgr'], ['OBSERVER_ADMIN', 'admin']]) {
    if (roles[`E2E_${role}_USER`] !== `qa_role_${short}_${suffix}` || !roles[`E2E_${role}_PASSWORD`]?.trim() || !UUID.test(roles[`E2E_${role}_ACTOR_ID`] ?? '')) throw new Error('Incomplete or mismatched role fixture credentials.');
    result[`E2E_${role}_USER`] = roles[`E2E_${role}_USER`];
    result[`E2E_${role}_PASSWORD`] = roles[`E2E_${role}_PASSWORD`];
    result[`E2E_${role}_ACTOR_ID`] = roles[`E2E_${role}_ACTOR_ID`];
  }
  result.E2E_USER_B = result.E2E_OBSERVER_ADMIN_USER;
  result.E2E_PASSWORD_B = result.E2E_OBSERVER_ADMIN_PASSWORD;
  actorAccounts(result);
  return result;
}

export function actorAccounts(env) {
  const entries = [['adminA', 'admin', 'E2E_USER_A', 'E2E_PASSWORD_A'], ['adminB', 'admin', 'E2E_USER_B', 'E2E_PASSWORD_B'],
    ['receptionist', 'receptionist', 'E2E_RECEPTIONIST_USER', 'E2E_RECEPTIONIST_PASSWORD'], ['manager', 'manager', 'E2E_MANAGER_USER', 'E2E_MANAGER_PASSWORD']];
  const expected = { adminB: env.E2E_OBSERVER_ADMIN_ACTOR_ID, receptionist: env.E2E_RECEPTIONIST_ACTOR_ID, manager: env.E2E_MANAGER_ACTOR_ID };
  const accounts = entries.map(([slot, role, user, password]) => ({ slot, role, username: env[user]?.trim(), password: env[password], expectedActorId: expected[slot] }));
  if (accounts.some(a => !a.username || !a.password?.trim()) || new Set(accounts.map(a => a.username.toLowerCase())).size !== 4) throw new Error('Four complete distinct staging actor credentials are required.');
  return accounts;
}

export async function verifyLifecycleActors(env, probe) {
  const identities = [];
  for (const account of actorAccounts(env)) {
    const identity = await probe(account);
    if (!identity || !UUID.test(identity.actorId ?? '') || (account.expectedActorId && identity.actorId !== account.expectedActorId) || identity.role !== account.role || identity.active !== true || identity.organizationId !== 'org-primary' || identity.projectRef !== STAGING_PROJECT_REF) throw new Error('Authoritative staging actor validation failed.');
    identities.push({ slot: account.slot, actorId: identity.actorId, role: identity.role, active: true, organizationId: 'org-primary', projectRef: STAGING_PROJECT_REF });
  }
  if (new Set(identities.map(i => i.actorId)).size !== 4) throw new Error('Staging actors resolve to duplicate authenticated identities.');
  return { runId: env.E2E_RUN_ID, status: 'passed', identities };
}

export async function executeActorGatedSuite({ env, reservationPath, receiptPath, preflight, launch }) {
  const reservation = JSON.parse(fs.readFileSync(reservationPath, 'utf8'));
  if (reservation.runId !== env.E2E_RUN_ID || reservation.candidateCommit !== env.E2E_EXPECTED_COMMIT || fs.existsSync(receiptPath)) throw new Error('Actor preflight reservation mismatch or receipt reused.');
  const reservationSha256 = createHash('sha256').update(fs.readFileSync(reservationPath)).digest('hex');
  let receipt;
  try {
    const checked = await preflight(env);
    // Re-validate and select only safe identity fields, never copy unknown properties.
    let index = 0;
    receipt = await verifyLifecycleActors(env, async () => checked.identities?.[index++]);
    if (checked.status !== 'passed' || checked.runId !== env.E2E_RUN_ID) throw new Error('Invalid preflight result.');
  } catch { receipt = { runId: env.E2E_RUN_ID, status: 'failed', reason: 'Authoritative actor preflight failed; no acceptance tests launched.' }; }
  if (createHash('sha256').update(fs.readFileSync(reservationPath)).digest('hex') !== reservationSha256) throw new Error('Actor preflight reservation changed.');
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, candidateCommit: env.E2E_EXPECTED_COMMIT, reservationSha256, createdAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  const sha256 = createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex');
  const result = receipt.status === 'passed' ? launch() : { status: 1 };
  return { receipt, sha256, result };
}

// Read-only application preflight: login and authoritative profile/membership reads;
// no business mutation, screenshots, traces, credentials or HTTP headers exported.
export async function runLifecycleActorPreflight(env) {
  const baseURL = assertStagingBaseUrl(env.E2E_BASE_URL);
  const browser = await chromium.launch({ channel: env.E2E_BROWSER_CHANNEL || 'chrome', headless: env.E2E_HEADLESS !== 'false' });
  try {
    return await verifyLifecycleActors(env, async account => {
      const context = await browser.newContext({ baseURL, locale: 'en-IN', timezoneId: 'Asia/Calcutta' });
      context.setDefaultTimeout(20_000);
      try {
        const page = await context.newPage();
        let headers;
        page.on('request', request => {
          const url = new URL(request.url());
          if (url.origin === `https://${STAGING_PROJECT_REF}.supabase.co` && url.pathname.startsWith('/rest/v1/')) {
            const value = request.headers();
            if (value.apikey && value.authorization) headers = { apikey: value.apikey, authorization: value.authorization };
          }
        });
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.getByLabel('Username', { exact: true }).fill(account.username);
        await page.getByLabel('Password', { exact: true }).fill(account.password);
        await page.getByRole('button', { name: 'Sign In', exact: true }).click();
        await page.getByRole('heading', { name: 'Live Dashboard', exact: true }).waitFor();
        await page.getByText(/^Synced(?:\s|$)/).first().waitFor();
        if (!headers) throw new Error('Missing authenticated staging request.');
        const actorId = JSON.parse(Buffer.from(headers.authorization.replace(/^Bearer\s+/i, '').split('.')[1], 'base64url').toString()).sub;
        const rest = `https://${STAGING_PROJECT_REF}.supabase.co/rest/v1`;
        const roleResponse = await page.request.post(`${rest}/rpc/current_user_org_role`, { headers, data: { target_organization_id: 'org-primary' }, timeout: 20_000 });
        const profileResponse = await page.request.get(`${rest}/profiles`, { headers, params: { id: `eq.${actorId}`, select: 'id,role,active' }, timeout: 20_000 });
        if (roleResponse.status() !== 200 || profileResponse.status() !== 200) throw new Error('Staging actor read failed.');
        const role = await roleResponse.json();
        const profiles = await profileResponse.json();
        if (profiles.length !== 1 || profiles[0].id !== actorId || profiles[0].role !== role) throw new Error('Staging profile mismatch.');
        return { actorId, role, active: profiles[0].active, organizationId: 'org-primary', projectRef: STAGING_PROJECT_REF };
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
}
