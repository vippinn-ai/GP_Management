import test from 'node:test';
import assert from 'node:assert/strict';
import { runBaselinePairs, verifyDiscovery, verifyLimits, verifyTarget, U1_IDENTITY, U1_LIMITS } from './u1-playwright-runner.mjs';
import { canonicalHash, verifyPairIdentities, planPhase } from './u1-data-reconciler.mjs';

const pairs = () => Array.from({ length: 50 }, (_, index) => ({ index, aId: `a-${index}`, bId: `b-${index}` }));
function fake() {
  const events = []; let time = 0;
  let state = { id: 'primary', version: 0, data: { sessions: [], auditLogs: [] }, updated_by: 'old', updated_at: '2026-10-24T00:00:00Z' };
  const receipt = (operation, id) => {
    const plan = planPhase({ operation, outcome: 'committed', before: state, actor: 'actor-b',
      serverTime: '2026-10-24T01:00:00Z', ...(operation === 'reject_session' ? { patches: { sessions: [{ id, status: 'closed' }] } } : {}) });
    state = structuredClone(plan.expected);
    return { plan, after: structuredClone(state), expectedProtectedRows: { fixture: id }, actualProtectedRows: { fixture: id } };
  };
  const intents = pairs().map(pair => ({ rpc: 'save_live_session_details', entityId: pair.bId,
    mutationId: `m-${pair.index}`, auditId: `audit-${pair.index}`, actorId: 'actor-b', payload: { sessionId: pair.bId } }));
  const manifest = { baseURL: 'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/',
    project: 'tkbdyzxwwbhkpztgjjxh', organization: 'org-primary', pairs: pairs(), intents, initialAppStateHash: canonicalHash(state) };
  const adapter = {
    preflight: async () => ({ pairs: pairs(), appState: structuredClone(state) }),
    setup: async index => { events.push(`setup:${index}`); const pair = pairs()[index]; return { ...pair,
      receipts: [receipt('start_session', pair.aId), receipt('start_session', pair.bId)] }; },
    freezeIntent: async (pair, index) => structuredClone(intents[index]),
    reloadOrigin: async pair => { events.push(`reload:${pair.index}`); },
    saveObserver: async pair => { events.push(`save:${pair.index}`); },
    convergeAndReconcile: async (pair, intent) => { events.push(`parity:${pair.index}`); time += 100;
      return { receipts: [receipt('save_live_session_details', pair.bId)], pendingQueuesEmpty: true,
        acknowledged: true, errorPriorityViolation: false, mutationId: intent.mutationId,
        entityId: intent.entityId, actorId: intent.actorId,
        parity: { aId: pair.aId, bId: pair.bId } }; },
    cleanupReconciledPair: async pair => { events.push(`cleanup:${pair.index}`);
      return { receipts: [receipt('reject_session', pair.aId), receipt('reject_session', pair.bId)] }; },
    postflight: async result => { events.push(`postflight:${result.failed}`);
      if (result.failed) return { status: 'safety-unverified', ownedIds: [], residueIds: [],
        appStateHash: canonicalHash(state), protectedRowsHash: canonicalHash({ fixture: 'failed' }) };
      return { appState: structuredClone(state), expectedProtectedRows: { fixture: 'final' }, actualProtectedRows: { fixture: 'final' } }; },
    record: async record => { events.push(record.phase); },
  };
  const clock = () => time;
  return { adapter, events, clock, options: { clock, manifest, manifestHash: canonicalHash(manifest),
    discovery: [U1_IDENTITY], limits: U1_LIMITS } };
}
test('exact discovery, environment, and limits fail closed', () => {
  verifyDiscovery([U1_IDENTITY]); verifyLimits(U1_LIMITS);
  verifyTarget('https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/');
  for (const identities of [[], [U1_IDENTITY, U1_IDENTITY], [{ ...U1_IDENTITY, title: 'other' }], [{ ...U1_IDENTITY, project: 'other' }]])
    assert.throws(() => verifyDiscovery(identities));
  for (const url of ['https://management.breakperfectgaminglounge.workers.dev/', 'http://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/',
    'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/?x=1', 'https://user@gp-management-staging-pages.breakperfectgaminglounge.workers.dev/'])
    assert.throws(() => verifyTarget(url));
  for (const [key, value] of [['retries', 1], ['workers', 2], ['completionMs', 7001], ['caseTimeout', 900001], ['pairs', 49]])
    assert.throws(() => verifyLimits({ ...U1_LIMITS, [key]: value }));
});
test('coordinator runs all 50 once and cleans up only after parity', async () => {
  const { adapter, events, options } = fake();
  const result = await runBaselinePairs(adapter, options);
  assert.equal(result.samples.count, 50);
  assert.equal(result.status, 'completed-unverified');
  for (let index = 0; index < 50; index++) {
    assert.equal(events.filter(e => e === `save:${index}`).length, 1);
    assert.ok(events.indexOf(`cleanup:${index}`) > events.indexOf(`parity:${index}`));
  }
  assert.ok(events.includes('postflight:false'));
});
test('failure drains in-flight sibling, preserves failure and does not retry/cleanup ambiguity', async () => {
  const { adapter, events, options } = fake();
  let release;
  const drained = new Promise(resolve => { release = resolve; });
  adapter.reloadOrigin = async () => { throw new Error('reload failed'); };
  adapter.saveObserver = async () => { await drained; events.push('save finished'); };
  adapter.postflight = async () => { assert.ok(events.includes('save finished')); events.push('postflight'); throw new Error('postflight failed'); };
  const pending = runBaselinePairs(adapter, options);
  release();
  await assert.rejects(pending, error => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(events.filter(e => e.startsWith('setup:')).length, 1);
  assert.equal(events.filter(e => e.startsWith('cleanup:')).length, 0);
});
test('7000ms fails without replacing the sample', async () => {
  const { adapter, events, options } = fake(); let t = 0;
  let retained;
  adapter.postflight = async result => { retained = result.samples; };
  await assert.rejects(runBaselinePairs(adapter, { ...options, clock: () => { t += 7000; return t; } }));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].outcome, 'incomplete');
  assert.ok(retained[0].elapsedMs >= 7000);
  assert.equal(events.filter(e => e.startsWith('setup:')).length, 1);
});
test('substitution and operational-v2 measured writer are rejected', async () => {
  const expected = pairs(); const changed = pairs(); changed[2].aId = 'new-unique';
  assert.throws(() => verifyPairIdentities(changed, expected));
  const one = fake(); one.adapter.setup = async () => changed[2];
  await assert.rejects(runBaselinePairs(one.adapter, one.options));
  const two = fake(); two.adapter.freezeIntent = async pair => ({ rpc: 'reject_session_v2', entityId: pair.bId, mutationId: 'm' });
  await assert.rejects(runBaselinePairs(two.adapter, two.options));
  assert.equal(two.events.filter(e => e.startsWith('save:')).length, 0);
});
test('failed postflight cannot yield a passing terminal run', async () => {
  const { adapter, events, options } = fake();
  adapter.postflight = async () => { throw new Error('residue'); };
  adapter.record = async record => { if (record.phase === 'terminal') events.push(record.status); };
  await assert.rejects(runBaselinePairs(adapter, options));
  assert.ok(events.includes('failed')); assert.ok(!events.includes('passed'));
});
test('duplicate mutations/audits and changed manifests fail before preflight', async () => {
  for (const field of ['mutationId', 'auditId']) {
    const { adapter, options } = fake(); let called = false;
    adapter.preflight = async () => { called = true; };
    options.manifest.intents[1][field] = options.manifest.intents[0][field];
    options.manifestHash = canonicalHash(options.manifest);
    await assert.rejects(runBaselinePairs(adapter, options)); assert.equal(called, false);
  }
  const { adapter, options } = fake(); options.manifest.organization = 'other';
  await assert.rejects(runBaselinePairs(adapter, options));
});
test('record failure can never leave a terminal passed result and errors are sanitized', async () => {
  const { adapter, options } = fake(); const statuses = [];
  adapter.record = async record => { if (record.phase === 'terminal') { statuses.push(record.status); throw new Error('secret-token'); } };
  await assert.rejects(runBaselinePairs(adapter, options), error => {
    assert.ok(!JSON.stringify(error.errors.map(e => e.message)).includes('secret-token')); return true;
  });
  assert.deepEqual(statuses, ['completed-unverified']);
});
test('no-op parity and cleanup receipts cannot complete a run', async () => {
  for (const method of ['convergeAndReconcile', 'cleanupReconciledPair']) {
    const { adapter, options } = fake(); adapter[method] = async () => ({});
    await assert.rejects(runBaselinePairs(adapter, options));
  }
});

test('deferred protected evidence must reconcile before cleanup for all 50 measured samples', async () => {
  const { adapter, events, options } = fake(); const original = adapter.convergeAndReconcile;
  let pending;
  adapter.convergeAndReconcile = async (...args) => {
    const result = await original(...args); pending = result.receipts;
    const { receipts, ...convergence } = result;
    return { ...convergence, deferredDatabaseEvidence: true };
  };
  adapter.finalizeMeasured = async () => { events.push('finalize'); return { receipts: pending }; };
  const result = await runBaselinePairs(adapter, options);
  assert.equal(result.samples.count, 50); assert.equal(events.filter(event => event === 'finalize').length, 50);
  for (let index = 0; index < 50; index++) {
    const parity = events.indexOf(`parity:${index}`), cleanup = events.indexOf(`cleanup:${index}`);
    assert.equal(events.slice(parity + 1, cleanup).filter(event => event === 'finalize').length, 1);
  }
});

test('missing or failed deferred evidence never permits cleanup or another pair', async () => {
  for (const fail of [false, true]) {
    const { adapter, events, options } = fake(); const original = adapter.convergeAndReconcile;
    adapter.convergeAndReconcile = async (...args) => {
      const { receipts, ...result } = await original(...args); return { ...result, deferredDatabaseEvidence: true };
    };
    if (fail) adapter.finalizeMeasured = async () => { throw new Error('protected mismatch'); };
    await assert.rejects(runBaselinePairs(adapter, options));
    assert.equal(events.filter(event => event.startsWith('cleanup:')).length, 0);
    assert.equal(events.filter(event => event.startsWith('setup:')).length, 1);
  }
});
