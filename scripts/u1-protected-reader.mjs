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
function protectedComponents(scope) {
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
  // Serialize each composite row once for both consumers. Preserve typed
  // ownership, default collation, and analytics' cross-organization proof.
  // NULL analytics organizations belong to neither original predicate.
  // Literal-false ownership has no owned consumer: avoid materializing and
  // rescanning every row merely to establish the invariant empty array.
  const cachedRows = PROTECTED_TABLES.map(table => `q_${table} AS ${owned(table) === 'false' ? 'NOT MATERIALIZED' : 'MATERIALIZED'} (select to_jsonb(t)::text as jt,${table === 'analytics_dirty_dates' ? "t.organization_id='org-primary' as is_owned,t.organization_id<>'org-primary' as is_unowned" : `(${owned(table)}) as is_owned`} from public.${table} t where ${table === 'analytics_dirty_dates' ? 't.organization_id is not null' : "t.organization_id='org-primary'"})`);
  const rowParts = PROTECTED_TABLES.map(table => owned(table) === 'false' ? `'${table}','[]'::jsonb` : `'${table}',(select coalesce(jsonb_agg(jt::jsonb order by jt),'[]'::jsonb) from q_${table} where is_owned)`);
  const fingerprintParts = PROTECTED_TABLES.map(table => `'${table}',(select jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(jt,E'\\n' order by jt),''))) from q_${table} where ${table === 'analytics_dirty_dates' ? 'is_unowned' : 'not coalesce(is_owned,false)'})`);
  const sql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL TIME ZONE 'UTC';
DO $u1$ BEGIN
IF current_database()<>'postgres' OR current_setting('transaction_read_only')<>'on'
 OR (SELECT system_identifier::text FROM pg_control_system())<>'7623125441096521075'
 OR (SELECT count(*) FROM public.deployment_environment_identity WHERE environment='staging' AND project_ref='tkbdyzxwwbhkpztgjjxh' AND identity_nonce='f9bc0aed-b6c4-410f-ba2a-572522d03869'::uuid)<>1
THEN RAISE EXCEPTION 'U1 staging guard failed'; END IF; END $u1$;
WITH ${cachedRows.join(',\n')}
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
  return {sql,cachedRows,rowParts,fingerprintParts};
}

// Retained single-envelope reference for native equivalence checks. Execution
// uses the three-part plan below, with the exact same per-table expressions.
export function buildProtectedRead(scope) { return protectedComponents(scope).sql; }
export const PROTECTED_GROUPS=Object.freeze([
 Object.freeze(['activity_events','bill_line_discounts','bills','combo_choice_groups','combo_choice_options','combo_fixed_items','customer_tab_combo_applications','customer_tabs','financial_mutations','inventory_categories','inventory_items','sale_variants','session_combo_applications','session_items','sessions','stations','stock_movements']),
 Object.freeze(['audit_logs','bill_discounts','bill_lines','combo_station_targets','combos','customer_tab_items','customers','expense_template_overrides','expense_templates','expenses','operational_events','operational_mutations','payments','pricing_rules','session_pause_logs','analytics_dirty_dates'])]);
export function buildProtectedReadParts(scope) {
 const c=protectedComponents(scope),start=c.sql.indexOf('WITH q_'),floorStart=c.sql.indexOf("'floor',")+8,end=c.sql.lastIndexOf(');\nROLLBACK;');
 check(start>0&&floorStart>8&&end>floorStart,'Protected expression boundary');
 check(PROTECTED_GROUPS.flat().length===33&&new Set(PROTECTED_GROUPS.flat()).size===33&&PROTECTED_TABLES.every(t=>PROTECTED_GROUPS.flat().includes(t)),'Exact table partition');
 const parts=[{tables:[],prefix:'',expression:"jsonb_build_object('appState',(select to_jsonb(a) from public.app_state a where id='primary'),'floor',"+c.sql.slice(floorStart,end)+')'}];
 for(const group of PROTECTED_GROUPS){const indices=group.map(t=>PROTECTED_TABLES.indexOf(t));parts.push({tables:[...group],prefix:'WITH '+indices.map(i=>c.cachedRows[i]).join(',\n')+'\n',expression:"jsonb_build_object('protectedRows',jsonb_build_object("+indices.map(i=>c.rowParts[i]).join(',')+",'_unowned',jsonb_build_object("+indices.map(i=>c.fingerprintParts[i]).join(',')+')))'});}
 return {header:c.sql.slice(0,start),kind:'protected',parts};
}
export function renderProtectedReadParts(plan) {
 check(['protected','preflight','authority'].includes(plan.kind)&&plan.parts.length===3&&plan.header.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'),'Fixed read plan');
 return plan.header+plan.parts.map((p,i)=>p.prefix+"SELECT jsonb_build_object('schema','u1-protected-fragment-v1','kind','"+plan.kind+"','part',"+i+",'snapshot',pg_current_snapshot()::text,'backend',pg_backend_pid(),'transactionAt',transaction_timestamp(),'payload',"+p.expression+");\n").join('')+'ROLLBACK;';
}
export function reassembleProtectedRead(bytes,{kind='protected'}={}) {
 check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=32*1024*1024,'Protected fragment byte bound');
 check(['protected','preflight','authority'].includes(kind),'Fixed fragment kind');
 const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim().split('\n');check(lines.length===3,'Exactly three fragments');
 const rows=lines.map(l=>JSON.parse(l)),keys=v=>Object.keys(v).sort().join(',');
 const first=rows[0];check(typeof first.snapshot==='string'&&/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(first.snapshot)&&Number.isSafeInteger(first.backend)&&first.backend>0&&typeof first.transactionAt==='string'&&Number.isFinite(Date.parse(first.transactionAt)),'Snapshot identity');
 for(let i=0;i<3;i++){const r=rows[i];check(r&&keys(r)==='backend,kind,part,payload,schema,snapshot,transactionAt'&&r.schema==='u1-protected-fragment-v1'&&r.kind===kind&&r.part===i&&r.snapshot===first.snapshot&&r.backend===first.backend&&r.transactionAt===first.transactionAt,'Fragment order/snapshot mismatch');check(r.payload&&typeof r.payload==='object'&&!Array.isArray(r.payload),'Object payload');}
 const output=first.payload,target=kind==='authority'?output.preflight:output;
 check(target&&typeof target==='object'&&!Array.isArray(target)&&!Object.hasOwn(target,'protectedRows'),'First payload cannot supply partial tables');
 if(kind==='protected')check(keys(target)==='appState,floor','Exact protected first payload');
 const protectedRows={_unowned:{}};
 for(let i=1;i<3;i++){const p=rows[i].payload,group=PROTECTED_GROUPS[i-1];check(keys(p)==='protectedRows'&&p.protectedRows&&keys(p.protectedRows)===[...group,'_unowned'].sort().join(',')&&keys(p.protectedRows._unowned)===group.slice().sort().join(','),'Exact fragment table coverage');for(const t of group){check(Array.isArray(p.protectedRows[t]),'Owned row array');const u=p.protectedRows._unowned[t];check(u&&keys(u)==='count,md5'&&Number.isSafeInteger(u.count)&&u.count>=0&&/^[a-f0-9]{32}$/.test(u.md5),'Unowned fingerprint');protectedRows[t]=p.protectedRows[t];protectedRows._unowned[t]=u;}}
 target.protectedRows=protectedRows;const result=Buffer.from(JSON.stringify(output)+'\n');check(result.length<=32*1024*1024,'Reconstructed capture byte bound');return result;
}

// Uses the already pinned restore-tool psql binary. No install, migration, provider
// API, secret discovery or interactive password prompt is performed.
export function createProtectedReader({ executable, executableSha256, scope, password, user, sslRootCert }) {
  check(typeof password === 'string' && password && typeof user === 'string' && /^[A-Za-z0-9_]+$/.test(user), 'Missing explicit staging read credentials');
  check(typeof sslRootCert === 'string' && fs.existsSync(sslRootCert), 'Explicit TLS trust certificate required');
  check(createHash('sha256').update(fs.readFileSync(executable)).digest('hex') === executableSha256, 'Read tool bytes changed');
  const sql = renderProtectedReadParts(buildProtectedReadParts(scope));
  return () => new Promise((resolve, reject) => {
    const child = spawn(executable, ['-X', '-q', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        PGHOST: 'db.tkbdyzxwwbhkpztgjjxh.supabase.co', PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: user,
        PGPASSWORD: password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: sslRootCert, PGCONNECT_TIMEOUT: '10' },
    });
    const chunks=[]; let outputBytes=0; let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 15000);
    child.stdout.on('data', bytes => { outputBytes+=bytes.length; if (outputBytes > 32 * 1024 * 1024) { failed = true; child.kill(); } else if(!failed)chunks.push(Buffer.from(bytes)); });
    child.stderr.on('data', () => { /* Raw diagnostics may contain environment details; do not publish them. */ });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Protected staging reader unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (failed || code !== 0) return reject(new Error('Protected staging read failed'));
      try { resolve(JSON.parse(reassembleProtectedRead(Buffer.concat(chunks)))); } catch { reject(new Error('Invalid protected snapshot')); } });
    child.stdin.on('error', () => { failed = true; }); child.stdin.end(sql);
  });
}
