import { isDeepStrictEqual } from 'node:util';
import { expectedAnalyticsDirtyDates, expectedStartEventMetadata, analyticsBusinessDate } from './u1-installed-contract.mjs';
import { materializeProtected, compareGeneratedProtected, timestampMicros } from './u1-generated-fields.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
// Prepared entirely from the previous EXPECTED projection and frozen command.
// No observed postimage contributes a business field or an allowed date.
export function prepareInstalledPhase(previous, operation, command) {
  check(previous && Array.isArray(previous.analytics_dirty_dates) && Array.isArray(previous.sessions), 'Missing installed preimage');
  check(previous.analytics_dirty_dates.length <= 10000 && previous.analytics_dirty_dates.every(row => row.organization_id === 'org-primary'),
    'Unexpected analytics preimage scope or size');
  check(command?.organization_id === 'org-primary', 'Wrong installed command organization');
  const id = operation === 'save_live_session_details' ? command.payload?.sessionId : command.payload?.session?.id;
  const matches = previous.sessions.filter(row => row.id === id);
  let oldStartedAt = null, newStartedAt, startMetadata = null;
  if (operation === 'start_session') {
    check(matches.length === 0, 'Start session already exists');
    startMetadata = expectedStartEventMetadata(command, 'event-pending'); // sealed before POST; only event ID is generated
    check(command.payload.session.closedBillId == null, 'Billed fixture forbidden');
    newStartedAt = command.payload.session.startedAt;
  } else {
    check(['save_live_session_details', 'reject_session'].includes(operation) && matches.length === 1,
      'Missing installed session preimage');
    const row = matches[0];
    check(row.organization_id === 'org-primary' && row.closed_bill_id === null && row.status === 'active', 'Non-plain fixture preimage');
    oldStartedAt = row.started_at;
    newStartedAt = operation === 'save_live_session_details' ? (command.payload.startedAt || oldStartedAt) : oldStartedAt;
    if (operation === 'reject_session') check(command.payload.session.closedBillId == null, 'Billed rejection forbidden');
  }
  timestampMicros(newStartedAt);
  if (oldStartedAt !== null) timestampMicros(oldStartedAt);
  const freeze = value => { if(value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  return freeze(structuredClone({ before: previous.analytics_dirty_dates, organizationId: 'org-primary', operation, oldStartedAt, newStartedAt,
    oldClosedBillId: null, newClosedBillId: null, startMetadata }));
}

export function compareInstalledPhase(template, actual, bindings, phaseId, intent) {
  check(bindings[phaseId], 'Missing installed phase binding');
  bindings[phaseId] = Object.freeze({ ...bindings[phaseId], analyticsDates:
    [...new Set([intent.oldStartedAt, intent.newStartedAt].filter(Boolean).map(analyticsBusinessDate))] });
  const expected = materializeProtected(template, bindings);
  const analytics = expectedAnalyticsDirtyDates({ ...intent, transactionTimestamp: bindings[phaseId].serverTime });
  // A package may not provide a contradictory postimage or hide extra rows.
  check(Array.isArray(expected.analytics_dirty_dates), 'Missing analytics template');
  const normalized = rows => rows.map(row => ({ ...row, updated_at: timestampMicros(row.updated_at).toString() }))
    .sort((a,b) => a.business_date.localeCompare(b.business_date));
  check(isDeepStrictEqual(normalized(expected.analytics_dirty_dates), normalized(analytics)), 'Analytics template differs from command-derived delta');
  check(isDeepStrictEqual(normalized(actual.analytics_dirty_dates), normalized(analytics)), 'Unexpected analytics date delta');
  compareGeneratedProtected(expected, actual, bindings);
  return expected;
}
