import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { timestampMicros, rpcTimestamp } from './u1-generated-fields.mjs';

// Pure offline oracle. No network, credentials, SQL, retries, or cleanup writes.
const normalized = new Set(['start_session', 'save_live_session_details',
  'save_live_customer_tab_details', 'pause_session', 'resume_session',
  'open_customer_tab', 'link_customer_tab_continuation', 'add_session_item',
  'remove_session_item', 'add_customer_tab_item', 'update_customer_tab_item_quantity',
  'remove_customer_tab_item', 'repeat_session_combo', 'apply_customer_tab_combo',
  'edit_pause_log', 'delete_pause_log', 'record_session_audit',
  'commit_checkout_bill_v2', 'commit_financial_adjustment_v2']);
const compatibility = {
  hop_session: ['sessions', 'sessionPauseLogs', 'auditLogs'],
  reject_session: ['sessions', 'sessionPauseLogs', 'auditLogs'],
  reject_customer_tab: ['customerTabs', 'auditLogs'],
};
const plans = new WeakSet();
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { requireThat(Number.isFinite(value), 'Non-finite JSON number'); return value; }
  if (Array.isArray(value)) return value.map(canonical);
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'Only plain JSON values admitted');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function clone(value) { canonicalHash(value); return structuredClone(value); }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function validRows(rows) {
  requireThat(Array.isArray(rows), 'Expected an array');
  const ids = rows.map(row => row?.id);
  requireThat(ids.every(id => typeof id === 'string' && id.trim().length > 0), 'Every row requires a nonempty ID');
  requireThat(new Set(ids).size === ids.length, 'Duplicate row ID');
}
export function patchArrayById(existing, patches) {
  validRows(existing); validRows(patches);
  const byId = new Map(patches.map(row => [row.id, row]));
  const existingIds = new Set(existing.map(row => row.id));
  return clone([...patches.filter(row => !existingIds.has(row.id)),
    ...existing.map(row => byId.get(row.id) ?? row)]);
}

// Low-level final comparison plan. Command-derived patches must be sealed before
// submission; transaction timestamps are finalized separately using sealPhaseIntent.
// This layer verifies supplied full-object expectations; operation-specific builders
// and installed-body review remain required admission gates.
export function planPhase({ operation, outcome, before, patches = {}, actor, serverTime }) {
  requireThat(normalized.has(operation) || Object.hasOwn(compatibility, operation), 'Unclassified writer');
  requireThat(['committed', 'replayed', 'rejected'].includes(outcome), 'Ambiguous outcome cannot be reconciled as success');
  requireThat(typeof actor === 'string' && actor.trim().length > 0, 'Missing actor');
  requireThat(typeof serverTime === 'string' && Number.isFinite(Date.parse(serverTime)), 'Missing bounded server timestamp');
  const preimage = clone(before);
  requireThat(Number.isSafeInteger(preimage.version) && preimage.version >= 0, 'Unsafe version');
  requireThat(preimage.data && !Array.isArray(preimage.data) && typeof preimage.data === 'object', 'Missing data object');
  const expected = clone(before);
  const isC = Object.hasOwn(compatibility, operation) && outcome === 'committed';
  if (isC) {
    requireThat(typeof actor === 'string' && actor.length > 0, 'Missing actor');
    requireThat(typeof serverTime === 'string' && Number.isFinite(Date.parse(serverTime)), 'Missing bounded server timestamp');
    requireThat(preimage.version < Number.MAX_SAFE_INTEGER, 'Version overflow');
    const allowed = compatibility[operation];
    requireThat(patches && Object.getPrototypeOf(patches) === Object.prototype, 'Invalid patches');
    requireThat(Object.keys(patches).every(key => allowed.includes(key)), 'Unapproved collection');
    const target = allowed[0];
    requireThat(Array.isArray(patches[target]) && patches[target].length === 1, 'Exactly one target required');
    for (const [key, rows] of Object.entries(patches)) {
      requireThat(rows.length === 1, 'At most one patch row per collection');
      expected.data[key] = patchArrayById(expected.data[key] ?? [], rows);
    }
    expected.version += 1;
    expected.updated_by = actor;
    expected.updated_at = serverTime;
  } else {
    requireThat(Object.keys(patches).length === 0, 'Invariant phase cannot include patches');
  }
  const plan = freeze({ operation, outcome, before: preimage, expected,
    beforeHash: canonicalHash(preimage), expectedHash: canonicalHash(expected), compatibilityCommit: isC });
  plans.add(plan);
  return plan;
}
export function reconcilePhase(plan, after) {
  requireThat(plans.has(plan), 'Expectation must be prepared by planPhase, not loaded from result data');
  requireThat(isDeepStrictEqual(plan.expected, after), 'Complete app_state mismatch');
  return freeze({ passed: true, beforeHash: plan.beforeHash, afterHash: canonicalHash(after),
    compatibilityCommit: plan.compatibilityCommit });
}
export function reconcileRun(initial, entries, final) {
  requireThat(Array.isArray(entries) && entries.length > 0, 'No phase evidence');
  let current = clone(initial); let commits = 0;
  for (const { plan, after } of entries) {
    requireThat(plans.has(plan) && isDeepStrictEqual(current, plan.before), 'Broken phase/commit order');
    reconcilePhase(plan, after); current = clone(after);
    commits += Number(plan.compatibilityCommit);
  }
  requireThat(isDeepStrictEqual(current, final), 'Unexplained end-of-run delta');
  requireThat(final.version === initial.version + commits, 'Incorrect compatibility commit count');
  return freeze({ passed: true, phases: entries.length, compatibilityCommits: commits, finalHash: canonicalHash(final) });
}

// Separate normalized evidence: a full protected projection, not a success-field mask.
// Expected tables are prepared from preimages+reviewed commands independently of actual.
export function reconcileProtectedRows(expected, actual) {
  requireThat(expected && Object.keys(expected).length > 0, 'Missing protected projection');
  requireThat(isDeepStrictEqual(expected, actual), 'Protected normalized rows/events/audits mismatch');
  return canonicalHash(actual);
}
export function verifySamples(samples) {
  requireThat(Array.isArray(samples) && samples.length === 50, 'Exactly 50 samples required');
  const ids = new Set();
  samples.forEach((sample, index) => {
    requireThat(sample.index === index, 'Excluded, reordered, or replaced sample');
    requireThat(Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0 && sample.elapsedMs < 7000, 'Pair exceeded strict 7000ms limit');
    for (const id of [sample.aId, sample.bId]) {
      requireThat(typeof id === 'string' && id.trim() && !ids.has(id), 'Missing or reused session ID'); ids.add(id);
    }
  });
  return freeze({ passed: true, count: 50, maxMs: Math.max(...samples.map(sample => sample.elapsedMs)) });
}

export function verifyPairIdentities(actual, expected) {
  requireThat(Array.isArray(expected) && expected.length === 50, 'Missing approved pair identities');
  requireThat(Array.isArray(actual) && actual.length === 50, 'Missing actual pair identities');
  const project = pairs => pairs.map(({ index, aId, bId }) => ({ index, aId, bId }));
  requireThat(isDeepStrictEqual(project(actual), project(expected)), 'Replaced fixture identity');
  verifySamples(expected.map(pair => ({ ...pair, elapsedMs: 0 })));
  return true;
}

// First U1 fixture cleanup: reject a preflight-owned session. No financial,
// hopped, or already-closed entity may be coerced into cleanup.
export function prepareSessionReject({ before, command, normalizedSession, actor, ownedIds, serverTime }) {
  const exactKeys = (value, allowed) => value && Object.keys(value).every(key => allowed.includes(key));
  requireThat(exactKeys(command, ['organization_id', 'mutation_id', 'mutation_kind', 'user_id', 'base_app_state_version', 'payload']) &&
    exactKeys(command.payload, ['session', 'auditLog', 'pauseLog']), 'Unexpected cleanup command field');
  requireThat(command?.organization_id === 'org-primary' && command.user_id === actor &&
    command.mutation_kind === 'rejectSession' && typeof command.mutation_id === 'string' &&
    command.mutation_id.trim().length > 0, 'Invalid bound rejection command');
  requireThat(command.base_app_state_version === before.version, 'Stale cleanup version');
  const session = clone(command.payload?.session);
  const audit = clone(command.payload?.auditLog);
  requireThat(Array.isArray(ownedIds) && new Set(ownedIds).size === ownedIds.length && ownedIds.includes(session.id), 'Unowned cleanup target');
  requireThat(normalizedSession?.id === session.id && normalizedSession.organization_id === 'org-primary' &&
    ['active', 'paused'].includes(normalizedSession.status) && normalizedSession.closed_bill_id === null &&
    normalizedSession.close_disposition === null, 'Cleanup target is not an owned open session');
  requireThat(session.status === 'closed' && session.closeDisposition === 'rejected', 'Invalid terminal session');
  requireThat(typeof audit.id === 'string' && audit.id.trim() && audit.entityId === session.id &&
    audit.userId === actor && audit.action === 'session_rejected' && audit.entityType === 'session', 'Invalid bound audit');
  requireThat(exactKeys(audit, ['id', 'action', 'entityType', 'entityId', 'userId', 'createdAt', 'message']), 'Unexpected audit field');
  requireThat(typeof session.endedAt === 'string' && Number.isFinite(Date.parse(session.endedAt)), 'Missing close time');
  requireThat(normalizedSession.raw_data && typeof normalizedSession.raw_data === 'object', 'Missing normalized preimage');
  const unchanged = row => Object.fromEntries(Object.entries(row).filter(([key]) =>
    !['status', 'endedAt', 'closeDisposition', 'closeReason', 'continuedFromSessionIds', 'closedBillId'].includes(key)));
  requireThat(isDeepStrictEqual(unchanged(session), unchanged(normalizedSession.raw_data)), 'Cleanup changed unrelated session fields');
  requireThat(typeof session.closeReason === 'string' && session.closeReason.trim().length > 0, 'Missing cleanup reason');
  requireThat(typeof audit.createdAt === 'string' && Date.parse(audit.createdAt) === Date.parse(session.endedAt), 'Audit time does not match prepared close');
  requireThat(Number.isFinite(Date.parse(normalizedSession.raw_data.startedAt)) &&
    Date.parse(session.endedAt) >= Date.parse(normalizedSession.raw_data.startedAt) &&
    Date.parse(session.endedAt) <= Date.parse(serverTime), 'Invalid cleanup chronology');
  session.continuedFromSessionIds = [];
  session.closedBillId = null;
  const released = normalizedSession.continued_from_session_ids;
  requireThat(Array.isArray(released), 'Missing continuation preimage');
  requireThat(isDeepStrictEqual(released, normalizedSession.raw_data.continuedFromSessionIds), 'Raw/normalized continuation mismatch');
  const reason = session.closeReason?.trim() || 'No reason provided.';
  audit.message = `Rejected ${normalizedSession.station_name_snapshot || 'session'}. Reason: ${reason}` +
    (released.length ? ` Released ${released.length} prior game continuation${released.length === 1 ? '' : 's'}.` : '');
  const patches = { sessions: [session], auditLogs: [audit] };
  // Paused cleanup requires a separate pause-preimage builder, not a guessed row.
  requireThat(normalizedSession.status !== 'paused' && !command.payload.pauseLog,
    'Paused cleanup requires the separately reviewed pause builder');
  return planPhase({ operation: 'reject_session', outcome: 'committed', before, patches, actor, serverTime });
}

const intents = new WeakSet();
export function sealSessionReject(input) {
  // Build from the frozen command and normalized preimage before submission;
  // earliest time is only a validation placeholder, never the expected DB result.
  const prepared = prepareSessionReject({ ...input, serverTime: input.earliestServerTime });
  const sessionId = input.command.payload.session.id;
  const auditId = input.command.payload.auditLog.id;
  return sealPhaseIntent({ operation: 'reject_session', outcome: 'committed', before: input.before,
    actor: input.actor, earliestServerTime: input.earliestServerTime, latestServerTime: input.latestServerTime,
    patches: {
      sessions: [prepared.expected.data.sessions.find(row => row.id === sessionId)],
      auditLogs: [prepared.expected.data.auditLogs.find(row => row.id === auditId)],
    } });
}
export function sealPhaseIntent({ operation, outcome, before, patches = {}, actor, earliestServerTime, latestServerTime }) {
  const low = Date.parse(earliestServerTime); const high = Date.parse(latestServerTime);
  requireThat(Number.isFinite(low) && Number.isFinite(high) && high >= low && high - low <= 15000,
    'Timestamp window must be bounded by the unchanged 15s request limit');
  // Validate all non-time fields before submitting. Only the timestamp slot can change.
  const plan = planPhase({ operation, outcome, before, patches, actor, serverTime: earliestServerTime });
  const intent = freeze({ operation, outcome, before: plan.before, patches: clone(patches), actor,
    earliestServerTime, latestServerTime });
  intents.add(intent); return intent;
}
export function finalizePhaseIntent(intent, { responseTime, databaseTime }) {
  requireThat(intents.has(intent), 'Intent was not sealed before submission');
  const time = Date.parse(databaseTime);
  requireThat(Number.isFinite(time) && time >= Date.parse(intent.earliestServerTime) &&
    time <= Date.parse(intent.latestServerTime) && timestampMicros(rpcTimestamp(responseTime)) === timestampMicros(databaseTime), 'Uncorrelated or out-of-window server timestamp');
  intents.delete(intent);
  return planPhase({ ...intent, serverTime: databaseTime });
}
