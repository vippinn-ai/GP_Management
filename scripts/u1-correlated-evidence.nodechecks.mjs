import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalHash } from './u1-data-reconciler.mjs';
import { PROTECTED_TABLES } from './u1-protected-reader.mjs';
import { REQUIRED_PROOF_CHECKS, loadBrowserPackage } from './u1-browser-database-adapter.mjs';
import { main, reconcileEvidence } from './reconcile-u1-evidence.mjs';
import { expectedStartEventMetadata } from './u1-installed-contract.mjs';
import { prepareInstalledPhase } from './u1-phase-expectations.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
const TIME = '2026-10-25T08:00:00.123456Z';
const RUN = 'u1-correlated-offline-001';
const ORG = 'org-primary';
const PROJECT = 'tkbdyzxwwbhkpztgjjxh';
const uuid = number => `11111111-1111-4111-8111-${String(number).padStart(12, '0')}`;
function write(directory, file, data) {
  const bytes = JSON.stringify(data); fs.writeFileSync(path.join(directory, file), bytes); return sha(bytes);
}

// Independent synthetic data: no browser, database, secrets, or live evidence.
// The compatibility fold below is constructed directly rather than using the
// implementation's plan/finalize functions to manufacture its expected result.
function fixture(directory) {
  const initial = { id: 'primary', version: 40, updated_at: TIME, updated_by: 'old-actor',
    data: { sessions: [], auditLogs: [], sessionPauseLogs: [] } };
  let current = copy(initial);
  const actors = { A: { id: 'actor-a', role: 'admin' }, B: { id: 'actor-b', role: 'admin' } };
  const pairs = Array.from({ length: 50 }, (_, index) => ({ index, aId: `session-${index}-a`, bId: `session-${index}-b`,
    stationIdA: 'station-a', stationIdB: 'station-b',
    customerA: `${RUN}-customer-${index}-A`, customerBBefore: `${RUN}-customer-${index}-B`, customerBAfter: `${RUN}-customer-${index}-B-edited` }));
  const phases = [], observations = [], prepared = [];
  const rows = Object.fromEntries(PROTECTED_TABLES.map(table => [table, []]));
  rows._unowned = {};
  const initialProtected = copy(rows);
  for (let index = 0; index < 250; index++) {
    const offset = index % 5, pairIndex = Math.floor(index / 5), pair = pairs[pairIndex];
    const operation = ['start_session', 'start_session', 'save_live_session_details', 'reject_session', 'reject_session'][offset];
    const role = ['start-a', 'start-b', 'save-b', 'reject-a', 'reject-b'][offset];
    const actorSlot = offset === 0 || offset === 3 ? 'A' : 'B', actorId = actors[actorSlot].id;
    const entityId = actorSlot === 'A' ? pair.aId : pair.bId;
    const mutationId = `mutation-${index}`, auditId = `audit-${index}`, id = `phase-${index}`;
    const customerId = `customer-${pairIndex}-${actorSlot}`, eventId = `event-${uuid(index * 3 + 1)}`;
    const auditActivity = `activity-${uuid(index * 3 + 2)}`, eventActivity = `activity-${uuid(index * 3 + 3)}`;
    const identity = { id, pairIndex, role, entityId, actorId, mutationId, auditId };
    const audit = { id: auditId, userId: actorId, createdAt: TIME, action: 'session_rejected' };
    const session = { id: entityId, stationId: actorSlot === 'A' ? pair.stationIdA : pair.stationIdB,
      startedAt: TIME, closedBillId: null,
      status: offset >= 3 ? 'closed' : 'active', items: [], comboApplications: [], continuedFromSessionIds: [] };
    const customer = { id: customerId, name: `${RUN}-${customerId}${offset === 2 ? '-edited' : ''}` };
    const payload = offset < 2 ? { session, customer, auditLogs: [audit], stockMovements: [] }
      : offset === 2 ? { sessionId: entityId, customer, auditLog: audit } : { session, auditLog: audit };
    const command = { organization_id: ORG, mutation_id: mutationId, user_id: actorId,
      mutation_kind: offset < 2 ? 'startSession' : offset === 2 ? 'saveLiveSessionDetails' : 'rejectSession', payload };
    const installedIntent = prepareInstalledPhase(rows, operation, command);
    const sessionRow = { id: entityId, organization_id: ORG, started_at: TIME, closed_bill_id: null, status: offset >= 3 ? 'closed' : 'active' };
    const sessionIndex = rows.sessions.findIndex(row => row.id === entityId);
    if (sessionIndex < 0) rows.sessions.push(sessionRow); else rows.sessions[sessionIndex] = sessionRow;
    rows.analytics_dirty_dates = [{ organization_id: ORG, business_date: '2026-10-25', reason: 'session_change', updated_at: TIME }];
    const generated = { id, operation, entityId, actorId, mutationId, auditId,
      ...(offset < 3 ? { customerId, customerWrite: offset < 2 ? 'insert' : 'update' } : {}) };
    const patches = offset < 3 ? {} : { sessions: [session], auditLogs: [audit] };
    const plan = { operation, outcome: 'committed', actor: actorId, patches };
    const beforeHash = canonicalHash(current);
    if (offset >= 3) {
      current.version++; current.updated_by = actorId; current.updated_at = TIME;
      current.data.sessions.unshift(copy(session)); current.data.auditLogs.unshift(copy(audit));
    }
    const changed = { sessions: [entityId], audit_logs: [auditId], operational_events: [eventId] };
    if (offset < 3) changed.customers = [customerId]; else changed.session_pause_logs = [];
    if (offset < 2) Object.assign(changed, { session_items: [], session_combo_applications: [], stock_movements: [] });
    const response = { mutation_id: mutationId, organization_id: ORG, entity_type: 'session', entity_id: entityId,
      event_id: eventId, server_time: TIME.slice(0, -1), changed_rows: changed,
      ...(offset >= 3 ? { app_state_version: current.version, server_duration_ms: 1.5 } : {}) };
    const eventChanged = { sessions: [entityId], audit_logs: [auditId], session_pause_logs: [] };
    const metadata = { mutation_id: mutationId, ...(offset < 2
      ? expectedStartEventMetadata(command, eventId)
      : offset === 2 ? { customer_id: customerId, audit_log_id: auditId }
        : { changed_rows: eventChanged, app_state_version: current.version, server_duration_ms: 1.5, released_continued_from_session_ids: [] }) };
    rows.operational_events.push({ id: eventId, organization_id: ORG, event_type: operation, entity_type: 'session', entity_id: entityId,
      created_by: actorId, created_at: TIME, metadata });
    rows.audit_logs.push({ id: auditId, organization_id: ORG, user_id: actorId, entity_type: 'session', entity_id: entityId,
      audit_at: TIME, created_at: TIME, updated_at: TIME, raw_data: { userId: actorId, createdAt: TIME } });
    const activity = { organization_id: ORG, actor_user_id: actorId, entity_type: 'session', entity_id: entityId,
      legacy: false, occurred_at: TIME, created_at: TIME };
    rows.activity_events.push({ ...activity, id: auditActivity, source_kind: 'audit_log', source_id: auditId,
      mutation_id: null, details: { audit_id: auditId } }, { ...activity, id: eventActivity, source_kind: 'operational_event',
      source_id: eventId, mutation_id: mutationId, audit_reference_ids: [auditId], details: { event_id: eventId } });
    const uiParity = offset === 2 ? { A: { session: pair.aId }, B: { session: pair.bId } } : undefined;
    phases.push({ ...identity, operation, actorSlot, command, generated, plan, protectedRows: copy(rows), ...(uiParity ? { uiParity } : {}) });
    const expectedPhase = { ...identity, generated: { ...generated, earliestServerTime: TIME, latestServerTime: '2026-10-25T08:00:15.123456Z' },
      plan: { ...plan, ...(offset >= 3 ? { earliestServerTime: TIME, latestServerTime: '2026-10-25T08:00:15.123456Z' } : { serverTime: TIME }) },
      protectedRows: copy(rows), ...(uiParity ? { uiParity } : {}) };
    prepared.push({ phase: 'prepared-command', expectedPhase, command, beforeHash, installedIntent });
    observations.push({ ...identity, response, responseTime: response.server_time, databaseTime: current.updated_at,
      appState: copy(current), protectedRows: copy(rows), ...(uiParity ? { uiParity, pendingQueues: { origin: [], observer: [] } } : {}) });
  }
  const intents = pairs.map((pair, i) => ({ payload: phases[i * 5 + 2].command, mutationId: phases[i * 5 + 2].mutationId,
    actorId: phases[i * 5 + 2].actorId, entityId: pair.bId, auditId: phases[i * 5 + 2].auditId }));
  const manifest = { runId: RUN, applicationCommit: '70ee5ab00bd758c3de2b86e4f68ae76e69c82f1e',
    baseURL: 'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/', project: PROJECT,
    organization: ORG, pairs, intents, initialAppStateHash: canonicalHash(initial) };
  const pkg = { schema: 'u1-browser-package-v1', generatedFieldPolicy: 'u1-correlated-v1', manifest, actors, pairs, phases,
    protectedTables: PROTECTED_TABLES, proofs: {}, proofFiles: {}, assets: { '/assets/app.js': 'a'.repeat(64) }, finalProtectedRows: copy(rows), initialProtectedHash: canonicalHash(initialProtected) };
  for (const proof of ['catalog', 'rollback', 'source', 'build', 'reviewer', 'tester']) {
    const checks = (REQUIRED_PROOF_CHECKS[proof] ?? []).map(name => {
      const evidenceFile = `${proof}-${name}.json`, evidenceSha256 = write(directory, evidenceFile, { synthetic: true, name });
      return { name, status: 'passed', evidenceFile, evidenceSha256 };
    });
    const receipt = { runId: RUN, project: PROJECT, manifestHash: canonicalHash(manifest),
      ...(checks.length ? { schema: `u1-${proof}-receipt-v1`, status: 'passed', applicationCommit: manifest.applicationCommit,
        organization: ORG, checks } : { decision: 'approved', scope: 'u1-staging-run' }) };
    pkg.proofFiles[proof] = `${proof}.json`; pkg.proofs[proof] = write(directory, `${proof}.json`, receipt);
  }
  const packageFile = path.join(directory, 'package.json'), packageSha256 = write(directory, 'package.json', pkg);
  const authority = loadBrowserPackage(packageFile, packageSha256).authority;
  const expected = { schema: 'u1-expectations-v1', generatedFieldPolicy: 'u1-correlated-v1', authority,
    runId: RUN, project: PROJECT, organization: ORG, initial, phases: [],
    pairs: pairs.map((pair, i) => ({ ...pair, intentHash: canonicalHash(intents[i]) })), finalProtectedRows: copy(rows) };
  const actual = { schema: 'u1-observations-v1', authority, runId: RUN, project: PROJECT, organization: ORG,
    attempt: 1, retry: 0, status: 'completed-unverified', phases: [], final: current, finalProtectedRows: copy(rows),
    samples: pairs.map((pair, i) => ({ ...pair, elapsedMs: 500 + i, outcome: 'completed', pendingQueuesEmpty: true,
      acknowledged: true, errorPriorityViolation: false, mutationId: phases[i * 5 + 2].mutationId,
      entityId: pair.bId, actorId: phases[i * 5 + 2].actorId, intentHash: canonicalHash(intents[i]), parityHash: canonicalHash(phases[i * 5 + 2].uiParity) })) };
  let sequence = 0, previousRecordHash = null;
  const append = record => {
    const file = `${String(sequence++).padStart(5, '0')}-${record.phase}.json`;
    previousRecordHash = write(directory, file, { previousRecordHash, ...record }); return { file, sha256: previousRecordHash };
  };
  append({ phase: 'preflight', appState: initial, protectedRows: initialProtected });
  prepared.forEach((record, index) => {
    const preparedArtifact = append(record), observation = { ...observations[index], preparedArtifact };
    expected.phases.push({ ...record.expectedPhase, preparedArtifact });
    append({ phase: 'submission-attempt', mutationId: observation.mutationId, preparedArtifact });
    append({ phase: 'submission-response', mutationId: observation.mutationId, preparedArtifact, responseStatus: 200, response: observation.response,
      responseHash: sha(JSON.stringify(observation.response)), responseLength: Buffer.byteLength(JSON.stringify(observation.response)) });
    const observedArtifact = append({ phase: 'observed-command', ...observation });
    actual.phases.push({ ...observation, observedArtifact });
  });
  append({ phase: 'postflight', failed: false, appState: actual.final, protectedRows: actual.finalProtectedRows });
  actual.terminalRecord = append({ phase: 'terminal', status: actual.status, samples: actual.samples });
  return { expected, actual, pkg, prepared, initialProtected };
}

test('correlated CLI admits the complete 250-phase immutable synthetic chain and rejects authority/sample/chronology tampering', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'u1-correlated-'));
  try {
    const data = fixture(directory); let count = 0;
    const run = (expected = data.expected, actual = data.actual) => {
      const hash = write(directory, 'expected.json', expected); write(directory, 'observed.json', actual);
      return main([path.join(directory, 'expected.json'), hash, path.join(directory, 'observed.json'), path.join(directory, `report-${count++}.json`)]);
    };
    assert.equal(run(), 0, 'valid full correlated chain');
    const driftExpected=copy(data.expected), driftActual=copy(data.actual);
    driftExpected.phases[0].protectedRows._unowned.analytics_dirty_dates={count:1,md5:'drift'};
    driftActual.phases[0].protectedRows._unowned.analytics_dirty_dates={count:1,md5:'drift'};
    assert.throws(()=>reconcileEvidence(driftExpected,driftActual,data.prepared,data.initialProtected),/Non-owned data drift/);
    const finalExpected=copy(data.expected), finalActual=copy(data.actual);
    finalExpected.finalProtectedRows._unowned.analytics_dirty_dates={count:1,md5:'drift'};
    finalActual.finalProtectedRows._unowned.analytics_dirty_dates={count:1,md5:'drift'};
    assert.throws(()=>reconcileEvidence(finalExpected,finalActual,data.prepared,data.initialProtected),/Final non-owned data drift/);
    for (const mutate of [
      e => { delete e.generatedFieldPolicy; },
      e => { e.authority = { ...e.authority, packageSha256: '0'.repeat(64) }; },
      e => { e.pairs[0].intentHash = 'a'.repeat(64); },
      e => { e.phases[0].preparedArtifact.sha256 = '0'.repeat(64); },
      e => { e.phases[0].generated.latestServerTime = '2026-10-25T08:01:00Z'; },
    ]) { const expected = copy(data.expected); mutate(expected); assert.equal(run(expected), 1); }
    const altered = copy(data.actual); altered.samples[0].elapsedMs++; assert.equal(run(data.expected, altered), 1);
    const file = path.join(directory, '00002-submission-attempt.json'), bytes = fs.readFileSync(file);
    const record = JSON.parse(bytes); record.phase = 'submission-response'; fs.writeFileSync(file, JSON.stringify(record));
    assert.equal(run(), 1, 'altered chronology rejected'); fs.writeFileSync(file, bytes);
    const proofFile = path.join(directory, 'rollback.json'), proof = JSON.parse(fs.readFileSync(proofFile));
    proof.status = 'failed'; fs.writeFileSync(proofFile, JSON.stringify(proof));
    assert.equal(run(), 1, 'proof drift rejected');
  } finally {
    const resolved = path.resolve(directory), root = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert(resolved.startsWith(root) && path.basename(resolved).startsWith('u1-correlated-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
