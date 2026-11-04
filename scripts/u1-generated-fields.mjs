import { isDeepStrictEqual } from 'node:util';
import { expectedStartEventMetadata } from './u1-installed-contract.mjs';
const fail = (ok, message) => { if (!ok) throw new Error(message); };
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const eventId = new RegExp(`^event-${uuid}$`, 'i');
const activityId = new RegExp(`^activity-${uuid}$`, 'i');

// Preserve PostgreSQL microseconds; Date alone would collapse distinct timestamps.
export function timestampMicros(value) {
  fail(typeof value === 'string' && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value), 'Invalid timestamp');
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T :]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  fail(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60,
    'Invalid timestamp');
  const ms = Date.parse(value); fail(Number.isFinite(ms), 'Invalid timestamp');
  const fraction = (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0');
  return BigInt(ms) * 1000n + BigInt(fraction.slice(3));
}
export function rpcTimestamp(value) {
  fail(typeof value === 'string', 'Invalid RPC timestamp');
  const zoned = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?$/.test(value) ? `${value}Z` : value;
  timestampMicros(zoned); return zoned;
}
function one(rows, predicate, label) {
  fail(Array.isArray(rows), `Missing ${label} rows`);
  const found = rows.filter(predicate); fail(found.length === 1, `Expected exactly one ${label}`); return found[0];
}
export function bindGeneratedPhase(contract, response, rows, command) {
  fail(contract && ['start_session', 'save_live_session_details', 'reject_session'].includes(contract.operation), 'Unsupported generated-field writer');
  for (const key of ['id', 'entityId', 'actorId', 'mutationId', 'auditId'])
    fail(typeof contract[key] === 'string' && contract[key].trim(), 'Incomplete generated contract');
  const low = timestampMicros(contract.earliestServerTime); const high = timestampMicros(contract.latestServerTime);
  fail(high >= low && high - low <= 15000000n, 'Invalid generated timestamp window');
  // These are the successful baseline SQL return contracts, not a permissive
  // acknowledgement shape. In particular, replay/idempotent responses cannot
  // stand in for one newly committed fixture operation.
  const responseKeys = ['mutation_id', 'organization_id', 'entity_type', 'entity_id', 'event_id', 'server_time', 'changed_rows'];
  if (contract.operation === 'reject_session') responseKeys.push('app_state_version', 'server_duration_ms');
  fail(response && typeof response === 'object' && !Array.isArray(response) &&
    isDeepStrictEqual(Object.keys(response).sort(), responseKeys.sort()), 'Unexpected successful response keyset');
  const serverTime = rpcTimestamp(response.server_time); const time = timestampMicros(serverTime);
  fail(time >= low && time <= high && response.organization_id === 'org-primary' &&
    response.entity_id === contract.entityId && response.entity_type === 'session' &&
    response.mutation_id === contract.mutationId && response.idempotent !== true && eventId.test(response.event_id), 'Unbound canonical response');
  const event = one(rows.operational_events, row => row.metadata?.mutation_id === contract.mutationId, 'operational event');
  const changedRows = { sessions: [contract.entityId], audit_logs: [contract.auditId], operational_events: [response.event_id] };
  if (contract.operation === 'reject_session') changedRows.session_pause_logs = [];
  else {
    fail(typeof contract.customerId === 'string' && contract.customerId.length > 0, 'Missing changed customer identity');
    changedRows.customers = [contract.customerId];
    if (contract.operation === 'start_session') Object.assign(changedRows, {
      session_items: [], session_combo_applications: [], stock_movements: [],
    });
  }
  fail(isDeepStrictEqual(response.changed_rows, changedRows), 'Unexpected changed rows');
  if (contract.operation === 'start_session') {
    fail(command?.user_id === contract.actorId && command?.mutation_id === contract.mutationId &&
      command?.payload?.session?.id === contract.entityId && command?.payload?.customer?.id === contract.customerId,
    'Missing bound start command');
    fail(isDeepStrictEqual(event.metadata, expectedStartEventMetadata(command, response.event_id)),
      'Installed start metadata mismatch');
  }
  if (contract.operation === 'reject_session') {
    const { operational_events: ignored, ...eventChangedRows } = changedRows;
    fail(Number.isSafeInteger(response.app_state_version) && response.app_state_version >= 1 &&
      event.metadata?.app_state_version === response.app_state_version &&
      isDeepStrictEqual(event.metadata?.changed_rows, eventChangedRows) &&
      isDeepStrictEqual(event.metadata?.released_continued_from_session_ids, []), 'Unbound reject version or changed rows');
  } else {
    fail(event.metadata?.customer_id === contract.customerId, 'Event customer mismatch');
    if (contract.operation === 'start_session') fail(isDeepStrictEqual(event.metadata?.session_item_ids, []) &&
      isDeepStrictEqual(event.metadata?.stock_movement_ids, []), 'Unexpected start child rows');
  }
  const auditRefs = contract.operation === 'start_session' ? event.metadata?.audit_log_ids :
    contract.operation === 'reject_session' ? event.metadata?.changed_rows?.audit_logs : [event.metadata?.audit_log_id];
  fail(event.id === response.event_id && event.organization_id === 'org-primary' &&
    event.event_type === contract.operation && event.entity_id === contract.entityId && event.entity_type === 'session' &&
    event.created_by === contract.actorId && isDeepStrictEqual(auditRefs, [contract.auditId]) &&
    timestampMicros(event.created_at) === time, 'Operational event correlation mismatch');
  const audit = one(rows.audit_logs, row => row.id === contract.auditId, 'audit');
  fail(audit.organization_id === 'org-primary' && audit.user_id === contract.actorId &&
    audit.entity_id === contract.entityId && audit.entity_type === 'session' &&
    timestampMicros(audit.audit_at) === time && timestampMicros(audit.created_at) === time &&
    audit.raw_data?.userId === contract.actorId && timestampMicros(audit.raw_data.createdAt) === time,
    'Canonical audit identity/time mismatch');
  const auditActivity = one(rows.activity_events, row => row.source_kind === 'audit_log' && row.source_id === contract.auditId, 'audit Activity');
  const eventActivity = one(rows.activity_events, row => row.source_kind === 'operational_event' && row.source_id === event.id, 'operational Activity');
  for (const row of [auditActivity, eventActivity]) {
    fail(activityId.test(row.id) && row.organization_id === 'org-primary' && row.actor_user_id === contract.actorId &&
      row.entity_id === contract.entityId && row.entity_type === 'session' && row.legacy === false &&
      timestampMicros(row.occurred_at) === time && timestampMicros(row.created_at) === time, 'Activity correlation mismatch');
  }
  fail(auditActivity.id !== eventActivity.id && auditActivity.mutation_id === null && auditActivity.details?.audit_id === contract.auditId &&
    eventActivity.details?.event_id === event.id && eventActivity.mutation_id === contract.mutationId &&
    isDeepStrictEqual(eventActivity.audit_reference_ids, [contract.auditId]), 'Activity source identity mismatch');
  if (contract.operation === 'reject_session') fail(typeof response.server_duration_ms === 'number' &&
    Number.isFinite(response.server_duration_ms) && response.server_duration_ms >= 0 &&
    event.metadata.server_duration_ms === response.server_duration_ms, 'Unbound server duration');
  fail(contract.customerId == null || (typeof contract.customerId === 'string' && ['insert', 'update'].includes(contract.customerWrite)), 'Missing explicit customer write mode');
  return Object.freeze({ eventId: event.id, serverTime, operation: contract.operation, customerWrite: contract.customerWrite ?? null,
    entityId: contract.entityId, auditId: contract.auditId, mutationId: contract.mutationId,
    customerId: contract.customerId ?? null,
    ...(contract.operation === 'reject_session' ? { serverDurationMs: response.server_duration_ms } : {}),
    auditActivityId: auditActivity.id, operationalActivityId: eventActivity.id });
}

// No wildcard/dropped columns. Only these source-generated fields admit slots.
function allowed(path, key) {
  const [table, index, field, nested] = path;
  if (!Number.isInteger(index)) return false;
  if (key === 'eventId') return (table === 'operational_events' && field === 'id' && path.length === 3) ||
    (table === 'operational_events' && field === 'metadata' && nested === 'changed_rows' &&
      path[4] === 'operational_events' && path[5] === 0 && path.length === 6) ||
    (table === 'activity_events' && ((field === 'source_id' && path.length === 3) || (field === 'details' && nested === 'event_id' && path.length === 4)));
  if (['auditActivityId', 'operationalActivityId'].includes(key)) return table === 'activity_events' && field === 'id' && path.length === 3;
  if (key === 'serverDurationMs') return table === 'operational_events' && field === 'metadata' && nested === 'server_duration_ms' && path.length === 4;
  if (key !== 'serverTime') return false;
  if (path.length === 3) return ({ sessions: ['created_at', 'updated_at'], customers: ['created_at', 'updated_at'],
    audit_logs: ['created_at', 'updated_at', 'audit_at'], operational_events: ['created_at'], activity_events: ['created_at', 'occurred_at'],
    analytics_dirty_dates: ['updated_at'] })[table]?.includes(field) === true;
  return table === 'audit_logs' && field === 'raw_data' && nested === 'createdAt' && path.length === 4;
}
export function materializeProtected(template, bindings) {
  function visit(value, path) {
    if (value && typeof value === 'object' && Object.hasOwn(value, '$generated')) {
      fail(Object.keys(value).sort().join(',') === '$generated,phase' && allowed(path, value.$generated), 'Forbidden generated-field slot');
      fail(Object.hasOwn(bindings, value.phase) && Object.hasOwn(bindings[value.phase], value.$generated), 'Unbound generated-field phase');
      const binding = bindings[value.phase]; const [table, index] = path; const row = template[table][index];
      if (table === 'analytics_dirty_dates') fail(row.organization_id === 'org-primary' &&
        binding.analyticsDates?.includes(row.business_date), 'Unwritten analytics date slot');
      if (table === 'sessions') fail(row.id === binding.entityId &&
        (path[2] !== 'created_at' || binding.operation === 'start_session'), 'Unowned or unwritten session timestamp slot');
      if (table === 'customers') fail(binding.customerId && row.id === binding.customerId &&
        binding.operation !== 'reject_session' && (path[2] !== 'created_at' || binding.customerWrite === 'insert'), 'Unowned or unwritten customer timestamp slot');
      if (table === 'audit_logs') fail(row.id === binding.auditId, 'Unowned audit timestamp slot');
      if (table === 'operational_events') fail(row.metadata?.mutation_id === binding.mutationId, 'Unowned event slot');
      if (table === 'activity_events') {
        fail((row.source_kind === 'audit_log' && row.source_id === binding.auditId) ||
          (row.source_kind === 'operational_event' && (row.source_id === binding.eventId ||
            (row.source_id?.$generated === 'eventId' && row.source_id.phase === value.phase))), 'Unowned Activity slot');
        if (value.$generated === 'auditActivityId') fail(row.source_kind === 'audit_log', 'Wrong Activity ID slot');
        if (value.$generated === 'operationalActivityId') fail(row.source_kind === 'operational_event', 'Wrong Activity ID slot');
      }
      return binding[value.$generated];
    }
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, index]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry, [...path, key])]));
    return value;
  }
  return visit(template, []);
}
export function compareGeneratedProtected(template, actual, bindings) {
  const expected = materializeProtected(template, bindings);
  fail(isDeepStrictEqual(canonicalProtectedRows(expected), canonicalProtectedRows(actual)), 'Protected generated/business rows mismatch');
  return canonicalProtectedRows(expected);
}
export function canonicalProtectedRows(value) {
  function normalize(value, path = []) {
    if (typeof value === 'string' && allowed(path, 'serverTime')) return timestampMicros(value).toString();
    if (Array.isArray(value)) return value.map((entry, index) => normalize(entry, [...path, index]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, [...path, key])]));
    return value;
  }
  // DB row order is not meaningful. app_state arrays are handled separately and
  // are never passed through this table-row canonicalizer.
  function tables(value) {
    const result = normalize(value);
    for (const [table, rows] of Object.entries(result)) if (Array.isArray(rows)) {
      if (table === 'analytics_dirty_dates') {
        const keys = rows.map(row => `${row.organization_id}/${row.business_date}`);
        fail(rows.every(row => row.organization_id === 'org-primary' && /^\d{4}-\d\d-\d\d$/.test(row.business_date)) &&
          new Set(keys).size === rows.length, 'Missing or duplicate analytics key');
        rows.sort((a,b) => a.business_date.localeCompare(b.business_date));
        continue;
      }
      fail(rows.every(row => row && typeof row.id === 'string') && new Set(rows.map(row => row.id)).size === rows.length, 'Missing or duplicate protected row ID');
      rows.sort((a, b) => a.id.localeCompare(b.id));
    }
    return result;
  }
  return tables(value);
}
