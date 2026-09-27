import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorAccounts, executeActorGatedSuite, loadLifecycleRoleEnvironment, verifyLifecycleActors } from './lifecycle-actor-preflight.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const run = 'normops-20260927-1000-roles';
const admin = { E2E_RUN_ID: run, E2E_USER_A: 'admin-one', E2E_PASSWORD_A: 'private-a', E2E_USER_B: 'admin-two', E2E_PASSWORD_B: 'private-b' };
const roles = { E2E_RUN_ID: run, E2E_ROLE_ACCOUNT_STATE: 'active', E2E_RECEPTIONIST_USER: 'qa_role_rec_normops_20260927_1000_roles', E2E_RECEPTIONIST_PASSWORD: 'private-r', E2E_MANAGER_USER: 'qa_role_mgr_normops_20260927_1000_roles', E2E_MANAGER_PASSWORD: 'private-m' };
Object.assign(roles, { E2E_OBSERVER_ADMIN_USER: 'qa_role_admin_normops_20260927_1000_roles', E2E_OBSERVER_ADMIN_PASSWORD: 'private-o',
  E2E_OBSERVER_ADMIN_ACTOR_ID: '00000000-0000-4000-8000-000000000002', E2E_RECEPTIONIST_ACTOR_ID: '00000000-0000-4000-8000-000000000003', E2E_MANAGER_ACTOR_ID: '00000000-0000-4000-8000-000000000004' });
const env = () => loadLifecycleRoleEnvironment(admin, roles);
const identity = (account, n) => ({ actorId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, role: account.role, active: true, organizationId: 'org-primary', projectRef: 'tkbdyzxwwbhkpztgjjxh' });
test('dedicated credentials preserve admin A and wire generated admin B, ignoring ambient overrides', () => {
  const e = loadLifecycleRoleEnvironment({ ...admin, E2E_MANAGER_USER: 'spoof' }, roles);
  assert.equal(e.E2E_USER_A, admin.E2E_USER_A);
  assert.equal(e.E2E_USER_B, roles.E2E_OBSERVER_ADMIN_USER);
  assert.equal(e.E2E_PASSWORD_B, roles.E2E_OBSERVER_ADMIN_PASSWORD);
  assert.equal(e.E2E_MANAGER_USER, roles.E2E_MANAGER_USER);
  assert.equal(actorAccounts(e).length, 4);
});
test('invalid state/run/pattern/incomplete or duplicate credentials fail before login', () => {
  for (const patch of [{ E2E_ROLE_ACCOUNT_STATE: 'provisioning' }, { E2E_RUN_ID: 'other' }, { E2E_RECEPTIONIST_USER: 'wrong' }, { E2E_MANAGER_PASSWORD: '' }, { E2E_OBSERVER_ADMIN_USER: 'wrong' }, { E2E_OBSERVER_ADMIN_ACTOR_ID: '' }, { E2E_OBSERVER_ADMIN_PASSWORD: '' }]) assert.throws(() => loadLifecycleRoleEnvironment(admin, { ...roles, ...patch }));
  assert.throws(() => actorAccounts({ ...env(), E2E_USER_B: admin.E2E_USER_A.toUpperCase() }));
  assert.throws(() => actorAccounts({ ...admin }));
});
test('authoritative four-actor preflight exports only sanitized evidence', async () => {
  let calls = 0;
  const result = await verifyLifecycleActors(env(), async a => ({ ...identity(a, ++calls), token: 'secret-token', password: a.password }));
  assert.equal(calls, 4);
  assert.equal(result.status, 'passed');
  assert.equal(/private|secret-token|password|username/.test(JSON.stringify(result)), false);
});
test('wrong role/activity/org/project/id and duplicate actor fail closed without retry', async () => {
  for (const patch of [{ role: 'manager' }, { active: false }, { organizationId: 'other' }, { projectRef: 'rrdwbxvuwrbxefarxnse' }, { actorId: '' }, { actorId: 'a'.repeat(36) }, { actorId: '-'.repeat(36) }]) {
    let calls = 0;
    await assert.rejects(verifyLifecycleActors(env(), async a => ({ ...identity(a, ++calls), ...patch })));
    assert.equal(calls, 1);
  }
  await assert.rejects(verifyLifecycleActors(env(), async a => identity(a, 1)));
  let calls = 0;
  await assert.rejects(verifyLifecycleActors(env(), async () => { calls++; throw new Error('network'); }));
  assert.equal(calls, 1);
});
test('real orchestration reserves before login, blocks failure and launches once only after a bound receipt', async () => {
  for (const pass of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-actors-'));
    try {
      const e = { ...env(), E2E_EXPECTED_COMMIT: 'a'.repeat(40) };
      const reservationPath = path.join(dir, 'reservation.json'), receiptPath = path.join(dir, 'receipt.json');
      let logins = 0, launches = 0;
      const args = { env: e, reservationPath, receiptPath, preflight: async () => {
        logins++;
        if (!pass) throw new Error('private-password-token');
        let i = 0;
        const result = await verifyLifecycleActors(e, async a => identity(a, ++i));
        return { ...result, password: 'private-secret' };
      }, launch: () => { launches++; assert.equal(JSON.parse(fs.readFileSync(receiptPath)).status, 'passed'); return { status: 0 }; } };
      await assert.rejects(executeActorGatedSuite(args));
      assert.equal(logins, 0);
      fs.writeFileSync(reservationPath, JSON.stringify({ runId: e.E2E_RUN_ID, candidateCommit: e.E2E_EXPECTED_COMMIT }));
      const result = await executeActorGatedSuite(args);
      assert.equal(logins, 1);
      assert.equal(launches, pass ? 1 : 0);
      const bytes = fs.readFileSync(receiptPath);
      assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(JSON.parse(bytes).reservationSha256, createHash('sha256').update(fs.readFileSync(reservationPath)).digest('hex'));
      assert.equal(/private|password|token/.test(bytes.toString()), false);
      await assert.rejects(executeActorGatedSuite(args));
      assert.equal(logins, 1);
    } finally { fs.rmSync(dir, { recursive: true }); }
  }
});
test('runner binds receipt into manifest and role spec has no generic login path', () => {
  const runner = fs.readFileSync(new URL('./run-operational-v2-staging-e2e.mjs', import.meta.url), 'utf8');
  assert.ok(runner.indexOf('fs.writeFileSync(reservationPath') < runner.indexOf('= await executeActorGatedSuite'));
  assert.ok(runner.includes('actorPreflight: { path: actorPreflightPath, sha256: actorPreflightSha256, status: actorPreflight.status }'));
  assert.ok(runner.includes('Actor preflight receipt changed during testing.'));
  const spec = fs.readFileSync(new URL('../tests/e2e/staging/release-b-role-checkout-hop-timing-v2.e2e.ts', import.meta.url), 'utf8');
  assert.equal(/\bcredentials\(/.test(spec), false);
  assert.equal((spec.match(/roleCredentials\(/g) || []).length, 4);
});
