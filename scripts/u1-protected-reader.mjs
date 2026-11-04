import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const PROTECTED_TABLES = Object.freeze(['inventory_categories', 'stations', 'pricing_rules', 'customers',
  'inventory_items', 'sale_variants', 'combos', 'combo_station_targets', 'combo_fixed_items', 'combo_choice_groups',
  'combo_choice_options', 'sessions', 'session_pause_logs', 'session_items', 'session_combo_applications',
  'customer_tabs', 'customer_tab_items', 'customer_tab_combo_applications', 'bills', 'bill_lines',
  'bill_line_discounts', 'bill_discounts', 'payments', 'stock_movements', 'audit_logs', 'expenses',
  'expense_templates', 'expense_template_overrides', 'operational_events', 'activity_events', 'financial_mutations',
  'operational_mutations', 'analytics_dirty_dates']);
const check = (ok, message) => { if (!ok) throw new Error(message); };
function ids(values, max) {
  check(Array.isArray(values) && values.length <= max && new Set(values).size === values.length &&
    values.every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)), 'Invalid owned IDs');
  return values.length ? `(${values.map(value => `'${value}'`).join(',')})` : "('__u1_no_owned_id__')";
}
export function buildProtectedRead(scope) {
  const sessions = ids(scope.sessionIds, 100), customers = ids(scope.customerIds, 100);
  const audits = ids(scope.auditIds, 250), mutations = ids(scope.mutationIds, 250);
  const customerNames = ids(scope.customerNames.map(name => name.toLowerCase()), 150);
  const eventIds = `(select e.id from public.operational_events e where e.organization_id='org-primary' and e.metadata->>'mutation_id' in ${mutations})`;
  function owned(table) {
    // Shared date rows are collected in full and reconciled from preimages. They
    // are never session-owned cleanup data or excluded from verification.
    if (table === 'analytics_dirty_dates') return 'true';
    if (table === 'sessions') return `t.id in ${sessions}`;
    if (table === 'customers') return `t.id in ${customers}`;
    if (table === 'audit_logs') return `t.id in ${audits}`;
    if (table === 'operational_events') return `t.metadata->>'mutation_id' in ${mutations}`;
    if (table === 'activity_events') return `((t.source_kind='audit_log' and t.source_id in ${audits}) or (t.source_kind='operational_event' and t.source_id in ${eventIds}))`;
    if (['session_pause_logs', 'session_items', 'session_combo_applications'].includes(table)) return `t.session_id in ${sessions}`;
    return 'false';
  }
  const rowParts = PROTECTED_TABLES.map(table => `'${table}',(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from public.${table} t where t.organization_id='org-primary' and (${owned(table)}))`);
  const fingerprintParts = PROTECTED_TABLES.map(table => `'${table}',(select jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text),''))) from public.${table} t where ${table === 'analytics_dirty_dates' ? "t.organization_id<>'org-primary'" : `t.organization_id='org-primary' and not coalesce((${owned(table)}),false)`})`);
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL TIME ZONE 'UTC';
DO $u1$ BEGIN
IF current_database()<>'postgres' OR current_setting('transaction_read_only')<>'on'
 OR (SELECT system_identifier::text FROM pg_control_system())<>'7623125441096521075'
 OR (SELECT count(*) FROM public.deployment_environment_identity WHERE environment='staging' AND project_ref='tkbdyzxwwbhkpztgjjxh' AND identity_nonce='f9bc0aed-b6c4-410f-ba2a-572522d03869'::uuid)<>1
THEN RAISE EXCEPTION 'U1 staging guard failed'; END IF; END $u1$;
SELECT jsonb_build_object('appState',(select to_jsonb(a) from public.app_state a where id='primary'),
'protectedRows',jsonb_build_object(${rowParts.join(',')},'_unowned',jsonb_build_object(${fingerprintParts.join(',')})),
'floor',jsonb_build_object(
'openSessions',(select count(*) from public.sessions where organization_id='org-primary' and status<>'closed'),
'openTabs',(select count(*) from public.customer_tabs where organization_id='org-primary' and status='open'),
'unbilledHops',(select count(*) from public.sessions where organization_id='org-primary' and close_disposition='hopped' and closed_bill_id is null),
'incompleteOperationalMutations',(select count(*) from public.operational_mutations where status<>'committed'),
'incompleteFinancialMutations',(select count(*) from public.financial_mutations where status<>'committed'),
'customerNameCollisions',(select count(*) from public.customers where organization_id='org-primary' and lower(trim(name)) in ${customerNames})));
ROLLBACK;`;
}

// Uses the already pinned restore-tool psql binary. No install, migration, provider
// API, secret discovery or interactive password prompt is performed.
export function createProtectedReader({ executable, executableSha256, scope, password, user, sslRootCert }) {
  check(typeof password === 'string' && password && typeof user === 'string' && /^[A-Za-z0-9_]+$/.test(user), 'Missing explicit staging read credentials');
  check(typeof sslRootCert === 'string' && fs.existsSync(sslRootCert), 'Explicit TLS trust certificate required');
  check(createHash('sha256').update(fs.readFileSync(executable)).digest('hex') === executableSha256, 'Read tool bytes changed');
  const sql = buildProtectedRead(scope);
  return () => new Promise((resolve, reject) => {
    const child = spawn(executable, ['-X', '-q', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        PGHOST: 'db.tkbdyzxwwbhkpztgjjxh.supabase.co', PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: user,
        PGPASSWORD: password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: sslRootCert, PGCONNECT_TIMEOUT: '10' },
    });
    let output = ''; let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 15000);
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 32 * 1024 * 1024) { failed = true; child.kill(); } });
    child.stderr.on('data', () => { /* Raw diagnostics may contain environment details; do not publish them. */ });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Protected staging reader unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (failed || code !== 0) return reject(new Error('Protected staging read failed'));
      try { resolve(JSON.parse(output.trim())); } catch { reject(new Error('Invalid protected snapshot')); } });
    child.stdin.on('error', () => { failed = true; }); child.stdin.end(sql);
  });
}
