import { canonicalHash, verifySamples, verifyPairIdentities, reconcilePhase, reconcileProtectedRows, reconcileRun } from './u1-data-reconciler.mjs';

export const U1_IDENTITY = Object.freeze({
  file: 'ui-read-speed-baseline-50-reload-pairs.e2e.ts', project: 'u1-baseline',
  title: '50 baseline reload-versus-unrelated-mutation pairs preserve parity and write availability',
});
export const U1_LIMITS = Object.freeze({ pairs: 50, completionMs: 7000, workers: 1,
  retries: 0, maxFailures: 1, actionTimeout: 15000, navigationTimeout: 30000,
  expectTimeout: 20000, caseTimeout: 900000 });
const origin = 'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev';
function check(ok, message) { if (!ok) throw new Error(message); }
export function verifyDiscovery(actual) {
  check(Array.isArray(actual) && actual.length === 1 &&
    canonicalHash(actual[0]) === canonicalHash(U1_IDENTITY), 'Exact U1 discovery mismatch');
}
export function verifyTarget(url) {
  const parsed = new URL(url);
  check(parsed.origin === origin && parsed.pathname === '/' && !parsed.search && !parsed.hash &&
    !parsed.username && !parsed.password, 'Only exact staging app origin admitted');
  return parsed.origin;
}
export function verifyLimits(limits) {
  check(canonicalHash(limits) === canonicalHash(U1_LIMITS), 'U1 limits cannot be overridden');
}

// Transport-independent coordinator for a dedicated Playwright adapter. The adapter
// owns UI selectors and protected DB reads. It is NOT a live-admission approval.
// No parallel setup, inline blind rejection, retries, or success-only finalization.
export async function runBaselinePairs(adapter, { manifest, manifestHash, discovery, limits,
  clock = () => performance.now() } = {}) {
  check(manifest && canonicalHash(manifest) === manifestHash, 'Approved manifest hash mismatch');
  verifyTarget(manifest.baseURL); verifyDiscovery(discovery); verifyLimits(limits);
  check(manifest.project === 'tkbdyzxwwbhkpztgjjxh' && manifest.organization === 'org-primary', 'Wrong DB identity');
  const approved = structuredClone(manifest);
  verifyPairIdentities(approved.pairs, approved.pairs);
  check(Array.isArray(approved.intents) && approved.intents.length === 50, 'Missing bound intents');
  const mutationIds = new Set(); const auditIds = new Set();
  for (let index = 0; index < 50; index++) {
    const intent = approved.intents[index];
    check(intent.rpc === 'save_live_session_details' && intent.entityId === approved.pairs[index].bId &&
      typeof intent.actorId === 'string' && intent.actorId.trim() && intent.payload &&
      typeof intent.mutationId === 'string' && intent.mutationId.trim() && !mutationIds.has(intent.mutationId) &&
      typeof intent.auditId === 'string' && intent.auditId.trim() && !auditIds.has(intent.auditId), 'Invalid or duplicate bound command');
    mutationIds.add(intent.mutationId); auditIds.add(intent.auditId);
  }
  for (const name of ['preflight', 'setup', 'freezeIntent', 'reloadOrigin', 'saveObserver',
    'convergeAndReconcile', 'cleanupReconciledPair', 'postflight', 'record']) {
    check(typeof adapter[name] === 'function', `Missing adapter method ${name}`);
  }
  const samples = []; const seen = new Set(); const failures = [];
  const supervised = adapter.evidenceMode === 'u1-supervised-numbered-v1';
  check(adapter.evidenceMode === undefined || supervised, 'Unknown adapter evidence mode');
  let verifiedPhases = 0, compatibilityCommits = 0;
  const ledger = []; let initial; let current;
  let activePair = null;
  if (supervised) {
    check(typeof adapter.setSupervisedCoordinatorState === 'function' && typeof adapter.assertSupervisedWorking === 'function', 'Missing supervised resource guard');
    adapter.setSupervisedCoordinatorState(() => ({ approved, initial, current, samples, activePair }));
  }
  const guard = (...values) => { if (supervised) adapter.assertSupervisedWorking(...values); };
  const verifyReceipts = (receipts, operations) => {
    guard(receipts);
    check(Array.isArray(receipts) && receipts.length === operations.length, 'Missing phase receipts');
    receipts.forEach((receipt, index) => {
      check(receipt.plan?.operation === operations[index] && receipt.plan.outcome === 'committed', 'Wrong phase operation');
      check(canonicalHash(receipt.plan.before) === canonicalHash(current), 'Unexplained phase gap');
      reconcilePhase(receipt.plan, receipt.after);
      reconcileProtectedRows(receipt.expectedProtectedRows, receipt.actualProtectedRows);
      if (!supervised) ledger.push({ plan: receipt.plan, after: structuredClone(receipt.after) });
      verifiedPhases++; compatibilityCommits += Number(receipt.plan.compatibilityCommit);
      current = structuredClone(supervised ? receipt.plan.expected : receipt.after);
      guard(receipts);
    });
  };
  let approvedPairs;
  try {
    const preflight = await adapter.preflight();
    approvedPairs = approved.pairs;
    verifyPairIdentities(preflight.pairs, approvedPairs);
    check(canonicalHash(preflight.appState) === approved.initialAppStateHash, 'Preflight state does not match admitted baseline');
    initial = structuredClone(preflight.appState); current = structuredClone(initial);
    guard(preflight);
    for (let index = 0; index < U1_LIMITS.pairs; index += 1) {
      guard();
      activePair = await adapter.setup(index);
      verifyReceipts(activePair.receipts, ['start_session', 'start_session']);
      check(activePair?.aId === approvedPairs[index].aId && activePair?.bId === approvedPairs[index].bId,
        'Setup substituted an approved fixture');
      for (const id of [activePair?.aId, activePair?.bId]) {
        check(typeof id === 'string' && id.trim() && !seen.has(id), 'Fixture IDs must be unique');
        seen.add(id);
      }
      const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
      const { receipts: ignoredReceipts, ...pairFields } = activePair;
      activePair = deepFreeze(structuredClone(pairFields));
      const intent = await adapter.freezeIntent(activePair, index);
      check(intent?.rpc === 'save_live_session_details' && intent?.entityId === activePair.bId &&
        typeof intent.mutationId === 'string' && intent.mutationId.length > 0, 'Wrong measured writer or intent');
      check(canonicalHash(intent) === canonicalHash(approved.intents[index]), 'Prepared command differs from approved intent');
      const intentHash = canonicalHash(intent);
      await adapter.record({ phase: 'prepared', index, aId: activePair.aId, bId: activePair.bId, intentHash });
      const start = clock();
      const sample = { index, aId: activePair.aId, bId: activePair.bId, elapsedMs: null, outcome: 'incomplete' };
      samples.push(sample);
      guard();
      try {
      // allSettled drains BOTH branches on failure before any cleanup decision.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => adapter.reloadOrigin(activePair)),
        Promise.resolve().then(() => adapter.saveObserver(activePair, intent)),
      ]);
      check(canonicalHash(intent) === intentHash, 'Command changed after preparation');
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      const measured = await adapter.convergeAndReconcile(activePair, intent, results.map(result => result.value));
      check(measured.pendingQueuesEmpty === true && measured.parity && typeof measured.parity === 'object', 'Missing UI convergence proof');
      check(measured.acknowledged === true && measured.errorPriorityViolation === false &&
        measured.mutationId === intent.mutationId && measured.entityId === intent.entityId &&
        measured.actorId === intent.actorId, 'Missing canonical writer acknowledgement');
      if (!measured.deferredDatabaseEvidence) verifyReceipts(measured.receipts, ['save_live_session_details']);
      sample.intentHash = intentHash;
      sample.parityHash = canonicalHash(measured.parity);
      sample.pendingQueuesEmpty = true;
      sample.acknowledged = true; sample.errorPriorityViolation = false;
      sample.mutationId = intent.mutationId; sample.entityId = intent.entityId; sample.actorId = intent.actorId;
      const elapsedMs = clock() - start;
      sample.elapsedMs = elapsedMs;
      check(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < U1_LIMITS.completionMs,
        'Pair exceeded strict 7000ms limit');
      if (measured.deferredDatabaseEvidence) {
        check(typeof adapter.finalizeMeasured === 'function', 'Missing post-budget complete data verifier');
        const finalized = await adapter.finalizeMeasured(activePair);
        verifyReceipts(finalized.receipts, ['save_live_session_details']);
      }
      sample.outcome = 'completed';
      } finally {
        if (sample.elapsedMs === null) sample.elapsedMs = clock() - start;
        await adapter.record({ phase: 'measured', ...sample, intentHash });
      }
      const cleanup = await adapter.cleanupReconciledPair(activePair);
      verifyReceipts(cleanup.receipts, ['reject_session', 'reject_session']);
      activePair = null;
      guard();
    }
    verifySamples(samples);
    verifyPairIdentities(samples, approvedPairs);
  } catch (error) {
    failures.push(new Error('U1 execution failed; inspect protected phase evidence'));
  } finally {
    // Read-only reconciliation of partial/ambiguous work belongs here. The adapter
    // must not resend, blindly clean up, or erase retained history in postflight.
    try {
      const postflight = await adapter.postflight({ samples, activePair, failed: failures.length > 0 });
      if (!failures.length) {
        if (supervised) {
          check(verifiedPhases === 250 && compatibilityCommits === 100, 'Incomplete supervised phase/commit fold');
          reconcileProtectedRows(current, postflight.appState);
          check(postflight.appState.version === initial.version + compatibilityCommits, 'Incorrect compatibility commit count');
        } else reconcileRun(initial, ledger, postflight.appState);
        reconcileProtectedRows(postflight.expectedProtectedRows, postflight.actualProtectedRows);
      } else {
        check(postflight?.status === 'safety-unverified' || postflight?.status === 'reconciled-failure', 'Missing failure-safety status');
        check(Array.isArray(postflight.ownedIds) && Array.isArray(postflight.residueIds) &&
          /^[a-f0-9]{64}$/.test(postflight.appStateHash) && /^[a-f0-9]{64}$/.test(postflight.protectedRowsHash), 'Missing failure-safety evidence');
        const validIds = ids => ids.length <= 100 && new Set(ids).size === ids.length &&
          ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id));
        check(validIds(postflight.ownedIds) && validIds(postflight.residueIds) &&
          postflight.residueIds.every(id => postflight.ownedIds.includes(id)), 'Invalid failure-safety identities');
        if (postflight.status === 'reconciled-failure') {
          check(canonicalHash(postflight.appState) === postflight.appStateHash &&
            canonicalHash(postflight.protectedRows) === postflight.protectedRowsHash, 'Failure-safety hash mismatch');
          if (supervised) {
            reconcileProtectedRows(current, postflight.appState);
            check(postflight.appState.version === initial.version + compatibilityCommits, 'Incorrect failure-prefix commit count');
          } else reconcileRun(initial, ledger, postflight.appState);
          reconcileProtectedRows(postflight.expectedProtectedRows, postflight.protectedRows);
        }
        await adapter.record({ phase: 'failure-safety', status: postflight.status,
          ownedIds: postflight.ownedIds, residueIds: postflight.residueIds,
          appStateHash: postflight.appStateHash, protectedRowsHash: postflight.protectedRowsHash });
      }
    }
    catch { failures.push(new Error('U1 postflight failed')); }
    try { await adapter.record({ phase: 'terminal', status: failures.length ? 'failed' : 'completed-unverified', samples }); }
    catch { failures.push(new Error('U1 evidence recording failed')); }
  }
  if (failures.length) throw new AggregateError(failures, 'U1 run failed; preserve evidence, no automatic rerun');
  return { status: 'completed-unverified', samples: verifySamples(samples) };
}
