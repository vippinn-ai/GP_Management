import { createHash } from 'node:crypto';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const id = value => typeof value === 'string' && value.trim().length > 0;

// Restricted wire-JSON domain: PostgreSQL jsonb keys sort by UTF8 byte length,
// then byte value, not JS lexical ordering. Reject anything not proven here.
export function postgresJsonbText(value) {
  const ancestors = new Set();
  function string(value) {
    check(/^[\x01-\x7f]*$/.test(value), 'Unsupported JSONB unicode or NUL');
    return JSON.stringify(value);
  }
  function visit(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return string(value);
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'number') {
      check(Number.isSafeInteger(value) && !Object.is(value, -0), 'Unsupported JSONB numeric shape');
      return String(value);
    }
    check(Array.isArray(value) || plain(value), 'Unsupported JSONB value');
    check(!ancestors.has(value), 'Cyclic JSONB value'); ancestors.add(value);
    check(Object.getOwnPropertySymbols(value).length === 0, 'Symbol keys unsupported');
    let result;
    if (Array.isArray(value)) {
      check(Object.keys(value).length === value.length && Object.keys(value).every((key, index) => key === String(index)), 'Sparse or decorated array');
      check(Object.getOwnPropertyNames(value).length === value.length + 1 && Object.keys(value).every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')), 'Accessor or hidden array property');
      result = `[${Array.from(value, visit).join(', ')}]`;
    } else {
      const keys = Object.keys(value);
      check(Object.getOwnPropertyNames(value).length === keys.length, 'Hidden JSONB keys');
      for (const key of keys) {
        string(key);
        check(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'), 'Accessor JSONB property');
      }
      keys.sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
      result = `{${keys.map(key => `${string(key)}: ${visit(value[key])}`).join(', ')}}`;
    }
    ancestors.delete(value); return result;
  }
  return visit(value);
}
export function postgresJsonbMd5(value) { return createHash('md5').update(postgresJsonbText(value), 'utf8').digest('hex'); }

// Caller must preflight that the named customer's canonical ID equals the intent
// ID; SQL can otherwise resolve an existing customer by phone/name.
export function expectedStartEventMetadata(command, eventId) {
  postgresJsonbText(command);
  check(command.mutation_kind === 'startSession' && id(command.mutation_id) && id(eventId), 'Invalid start identity');
  const p = command.payload; const s = p?.session; const c = p?.customer;
  check(plain(p) && plain(s) && plain(c) && id(s.id) && id(s.stationId) && id(c.id) && id(c.name), 'Explicit named start fixture required');
  check(s.customerId == null || s.customerId === c.id, 'Customer identity mismatch');
  for (const collection of [s.items, s.comboApplications, s.continuedFromSessionIds, p.stockMovements])
    check(Array.isArray(collection) && collection.length === 0, 'Only empty first50 child collections supported');
  check(Array.isArray(p.auditLogs) && p.auditLogs.length === 1 && id(p.auditLogs[0]?.id), 'Exactly one start audit required');
  const auditIds = [p.auditLogs[0].id];
  return {
    mutation_id: command.mutation_id, mutation_kind: command.mutation_kind,
    request_fingerprint: postgresJsonbMd5({ mutation_kind: command.mutation_kind, session: s, customer: c, stock_movements: p.stockMovements, audit_logs: p.auditLogs }),
    station_id: s.stationId, customer_id: c.id, session_item_ids: [], stock_movement_ids: [], audit_log_ids: auditIds,
    changed_rows: { sessions: [s.id], customers: [c.id], session_items: [], session_combo_applications: [], stock_movements: [], audit_logs: [...auditIds], operational_events: [eventId] }
  };
}

function micros(value) {
  check(typeof value === 'string', 'Timestamp required');
  const m = /^(20\d\d)-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  check(m, 'Unsupported timestamp shape');
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0;
  check(month >= 1 && month <= 12 && day >= 1 && day <= [31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1] && hour < 24 && minute < 60 && second < 60, 'Invalid calendar timestamp');
  let offset = 0;
  if (m[8] !== 'Z') {
    const h = Number(m[8].slice(1,3)), min = Number(m[8].slice(4));
    check(h <= 14 && min < 60 && (h !== 14 || min === 0), 'Invalid timestamp offset');
    offset = (h * 60 + min) * (m[8][0] === '+' ? 1 : -1);
  }
  return BigInt(Date.UTC(year,month-1,day,hour,minute,second) - offset*60000)*1000n + BigInt((m[7]??'').padEnd(6,'0'));
}
export function analyticsBusinessDate(timestamp) {
  if (timestamp === null) return null; // installed STRICT function
  // All admitted modern dates have fixed Kolkata UTC+05:30; minus7h => UTC-01:30.
  const shifted = micros(timestamp) - 90n*60n*1000000n;
  return new Date(Number(shifted / 1000n)).toISOString().slice(0,10);
}
export function expectedAnalyticsDirtyDates({ before, organizationId, operation, oldStartedAt, newStartedAt, transactionTimestamp, oldClosedBillId, newClosedBillId }) {
  check(Array.isArray(before) && id(organizationId), 'Analytics preimage required');
  check(['start_session','save_live_session_details','reject_session'].includes(operation), 'Unsupported analytics operation');
  check(oldClosedBillId === null && newClosedBillId === null, 'Only explicitly unbilled fixtures supported');
  micros(transactionTimestamp);
  check(operation !== 'start_session' || oldStartedAt === null, 'Start must not have an old row');
  const dates = [...new Set((operation === 'start_session' ? [newStartedAt] : [oldStartedAt,newStartedAt]).map(analyticsBusinessDate).filter(date => date !== null))];
  const keys = new Set();
  const rows = before.map(row => {
    check(plain(row) && Object.keys(row).sort().join(',') === 'business_date,organization_id,reason,updated_at' && id(row.organization_id) && typeof row.reason === 'string', 'Invalid analytics preimage row');
    check(/^20\d\d-\d\d-\d\d$/.test(row.business_date), 'Invalid analytics business date');
    micros(`${row.business_date}T12:00:00Z`); micros(row.updated_at);
    const key = JSON.stringify([row.organization_id,row.business_date]); check(!keys.has(key), 'Duplicate analytics date'); keys.add(key);
    return { ...row };
  });
  for (const date of dates) {
    const index = rows.findIndex(row => row.organization_id === organizationId && row.business_date === date);
    const row = { organization_id: organizationId, business_date: date, reason: 'session_change', updated_at: transactionTimestamp };
    if (index < 0) rows.push(row); else rows[index] = row;
  }
  return rows;
}
