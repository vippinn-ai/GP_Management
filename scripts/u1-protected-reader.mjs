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
const READ_CODES = Object.freeze(['U1_READ_TIMEOUT', 'U1_READ_OUTPUT_LIMIT', 'U1_READ_SQL_TIMEOUT',
  'U1_READ_EXIT', 'U1_READ_PROCESS', 'U1_READ_STDIN', 'U1_READ_FORMAT']);
const READ_NUMBERS = Object.freeze(['readOrdinal', 'elapsedMs', 'stdoutBytes', 'stderrBytes', 'stdoutLines']);
export const READ_PHASE_MARKERS=Object.freeze(['guard','part0','part1','part2','part3'].flatMap(s=>[s+'_before',s+'_after']));
const PHASE_PREFIX='U1_READ_PHASE_V1 ';
const CLIENT_MARKS=['spawnMs','stdinMs','firstStdoutMs','firstStderrMs','closeMs'];
function safePhases(raw){
 const p={...raw};check(Object.keys(p).sort().join(',')===[...CLIENT_MARKS,'valid','complete','markers'].sort().join(','),'Phase keys');
 check(typeof p.valid==='boolean'&&typeof p.complete==='boolean'&&Array.isArray(p.markers)&&p.markers.length<=10,'Phase shape');
 check(CLIENT_MARKS.every(k=>p[k]===null||(Number.isSafeInteger(p[k])&&p[k]>=0)),'Client timestamps');
 let last=0;const markers=p.markers.map((v,i)=>{const m={...v};check(Object.keys(m).sort().join(',')==='elapsedMs,stage'&&m.stage===READ_PHASE_MARKERS[i]&&Number.isSafeInteger(m.elapsedMs)&&m.elapsedMs>=last,'Ordered phase prefix');last=m.elapsedMs;return {stage:m.stage,elapsedMs:m.elapsedMs};});
 check((p.valid||markers.length===0)&&p.complete===(p.valid&&markers.length===10),'Phase completeness');
 return {valid:p.valid,complete:p.complete,markers,...Object.fromEntries(CLIENT_MARKS.map(k=>[k,p[k]]))};
}
// Client arrival times only: psql-local markers add no server statements.
// Unknown stderr is withheld; malformed markers invalidate only phase metadata.
export function createReadPhaseObserver(){
 let pending=Buffer.alloc(0),bytes=0,valid=true,last=0;const markers=[];
 function line(b,elapsedMs){let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(b).replace(/\r$/,'');}catch{valid=false;return;}
  if(!s.startsWith(PHASE_PREFIX)){if(s.includes('U1_READ_PHASE'))valid=false;return;}
  const stage=s.slice(PHASE_PREFIX.length);if(stage!==READ_PHASE_MARKERS[markers.length]||!Number.isSafeInteger(elapsedMs)||elapsedMs<last){valid=false;return;}
  last=elapsedMs;markers.push({stage,elapsedMs});
 }
 return {consume(chunk,elapsedMs){bytes+=chunk.length;if(bytes>32768){valid=false;pending=Buffer.alloc(0);return;}pending=Buffer.concat([pending,chunk]);let at;while((at=pending.indexOf(10))>=0){line(pending.subarray(0,at),elapsedMs);pending=pending.subarray(at+1);}},
  finish(client){if(pending.length){try{if(new TextDecoder('utf-8',{fatal:true}).decode(pending).includes('U1_READ_PHASE'))valid=false;}catch{valid=false;}pending=Buffer.alloc(0);}return safePhases({valid,complete:valid&&markers.length===10,markers:valid?markers:[],...client});}};
}
// Only this fixed schema may leave the reader. Never retain raw diagnostics or credentials.
export function readFailureDiagnostic(error) {
  try {
  const raw = error?.readDiagnostic;
  const d = raw && { ...raw }; // Read fields once, then validate the copied values.
  if (!d || !READ_CODES.includes(d.code) ||
    Object.keys(d).sort().join(',') !== [...READ_NUMBERS, 'code', 'exitCode',...(Object.hasOwn(d,'phases')?['phases']:[])].sort().join(',') ||
    !READ_NUMBERS.every(k => Number.isSafeInteger(d[k]) && d[k] >= 0) ||
    !(d.exitCode === null || (Number.isSafeInteger(d.exitCode) && d.exitCode >= 0 && d.exitCode <= 255))) return null;
  return { code: d.code, ...Object.fromEntries(READ_NUMBERS.map(k => [k, d[k]])), exitCode: d.exitCode,
    ...(Object.hasOwn(d,'phases')?{phases:safePhases(d.phases)}:{}) };
  } catch { return null; }
}
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
// uses the four-part plan below, with the exact same per-table expressions.
export function buildProtectedRead(scope) { return protectedComponents(scope).sql; }
export const PROTECTED_GROUPS=Object.freeze([
 Object.freeze(['activity_events']),
 Object.freeze(['bill_line_discounts','bills','combo_choice_groups','combo_choice_options','combo_fixed_items','customer_tab_combo_applications','customer_tabs','financial_mutations','inventory_categories','inventory_items','sale_variants','session_combo_applications','session_items','sessions','stations','stock_movements']),
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
 check(['protected','preflight','authority'].includes(plan.kind)&&plan.parts.length===4&&plan.header.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'),'Fixed read plan');
 return plan.header+plan.parts.map((p,i)=>p.prefix+"SELECT jsonb_build_object('schema','u1-protected-fragment-v1','kind','"+plan.kind+"','part',"+i+",'snapshot',pg_current_snapshot()::text,'backend',pg_backend_pid(),'transactionAt',transaction_timestamp(),'payload',"+p.expression+");\n").join('')+'ROLLBACK;';
}
export function renderProtectedReadExecution(plan){
 const original=renderProtectedReadParts(plan),guard=plan.header.indexOf('DO $u1$ BEGIN\n');
 check(guard>0&&!original.includes(PHASE_PREFIX)&&!/^\s*\\/m.test(original),'Fixed execution marker boundary');
 const warn=id=>'\\warn '+PHASE_PREFIX+id+'\n';
 // Only the fixed four startup statements share a dispatch. Guard/data queries
 // retain their original dispatch boundaries and per-statement timeout budgets.
 const startup="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL TIME ZONE 'UTC';\n";
 check(plan.header.slice(0,guard)===startup,'Fixed startup statements');
 const startupWire=startup.replaceAll(';','\\;')+'\\g\n';
 let output=startupWire+warn('guard_before')+plan.header.slice(guard)+warn('guard_after'),rest=original.slice(plan.header.length);
 for(let i=0;i<4;i++){const end=rest.indexOf(');\n')+3;check(end>=3,'Fixed statement boundary');const statement=rest.slice(0,end);check(statement.startsWith(plan.parts[i].prefix+'SELECT jsonb_build_object('),'Fixed part statement');output+=warn('part'+i+'_before')+statement+warn('part'+i+'_after');rest=rest.slice(end);}
 check(rest==='ROLLBACK;','Fixed transaction tail');output+=rest;
 let stripped=output;for(const id of READ_PHASE_MARKERS)stripped=stripped.replace(warn(id),'');check(stripped.startsWith(startupWire),'Fixed startup transport');stripped=startup+stripped.slice(startupWire.length);check(stripped===original,'Original SQL preserved');return output;
}
export function reassembleProtectedRead(bytes,{kind='protected'}={}) {
 check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=32*1024*1024,'Protected fragment byte bound');
 check(['protected','preflight','authority'].includes(kind),'Fixed fragment kind');
 const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim().split('\n');check(lines.length===4,'Exactly four fragments');
 const rows=lines.map(l=>JSON.parse(l)),keys=v=>Object.keys(v).sort().join(',');
 const first=rows[0];check(typeof first.snapshot==='string'&&/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(first.snapshot)&&Number.isSafeInteger(first.backend)&&first.backend>0&&typeof first.transactionAt==='string'&&Number.isFinite(Date.parse(first.transactionAt)),'Snapshot identity');
 for(let i=0;i<4;i++){const r=rows[i];check(r&&keys(r)==='backend,kind,part,payload,schema,snapshot,transactionAt'&&r.schema==='u1-protected-fragment-v1'&&r.kind===kind&&r.part===i&&r.snapshot===first.snapshot&&r.backend===first.backend&&r.transactionAt===first.transactionAt,'Fragment order/snapshot mismatch');check(r.payload&&typeof r.payload==='object'&&!Array.isArray(r.payload),'Object payload');}
 const output=first.payload,target=kind==='authority'?output.preflight:output;
 check(target&&typeof target==='object'&&!Array.isArray(target)&&!Object.hasOwn(target,'protectedRows'),'First payload cannot supply partial tables');
 if(kind==='protected')check(keys(target)==='appState,floor','Exact protected first payload');
 const protectedRows={_unowned:{}};
 for(let i=1;i<4;i++){const p=rows[i].payload,group=PROTECTED_GROUPS[i-1];check(keys(p)==='protectedRows'&&p.protectedRows&&keys(p.protectedRows)===[...group,'_unowned'].sort().join(',')&&keys(p.protectedRows._unowned)===group.slice().sort().join(','),'Exact fragment table coverage');for(const t of group){check(Array.isArray(p.protectedRows[t]),'Owned row array');const u=p.protectedRows._unowned[t];check(u&&keys(u)==='count,md5'&&Number.isSafeInteger(u.count)&&u.count>=0&&/^[a-f0-9]{32}$/.test(u.md5),'Unowned fingerprint');protectedRows[t]=p.protectedRows[t];protectedRows._unowned[t]=u;}}
 target.protectedRows=protectedRows;const result=Buffer.from(JSON.stringify(output)+'\n');check(result.length<=32*1024*1024,'Reconstructed capture byte bound');return result;
}

// Uses the already pinned restore-tool psql binary. No install, migration, provider
// API, secret discovery or interactive password prompt is performed.
export function createProtectedReader({ executable, executableSha256, scope, password, user, sslRootCert }) {
  check(typeof password === 'string' && password && typeof user === 'string' && /^[A-Za-z0-9_]+$/.test(user), 'Missing explicit staging read credentials');
  check(typeof sslRootCert === 'string' && fs.existsSync(sslRootCert), 'Explicit TLS trust certificate required');
  check(createHash('sha256').update(fs.readFileSync(executable)).digest('hex') === executableSha256, 'Read tool bytes changed');
  const sql = renderProtectedReadExecution(buildProtectedReadParts(scope));
  let readOrdinal = 0;
  return () => new Promise((resolve, reject) => {
    const ordinal = ++readOrdinal, started = performance.now();
    const phases=createReadPhaseObserver(),client={spawnMs:0,stdinMs:null,firstStdoutMs:null,firstStderrMs:null,closeMs:null};
    const elapsed=()=>Math.max(0,Math.round(performance.now()-started));
    let outputBytes = 0, stderrBytes = 0, stdoutLines = 0, stderrTail = '', sqlTimeout = false;
    const failure = (code, exitCode = null) => {
      const error = new Error(code);
      error.readDiagnostic = Object.freeze({ code, readOrdinal: ordinal,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        stdoutBytes: outputBytes, stderrBytes, stdoutLines, exitCode,phases:phases.finish(client) });
      return error;
    };
    const child = spawn(executable, ['-X', '-q', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        PGHOST: 'db.tkbdyzxwwbhkpztgjjxh.supabase.co', PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: user,
        PGPASSWORD: password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: sslRootCert, PGCONNECT_TIMEOUT: '10' },
    });
    const chunks=[]; let failed = null;
    const timer = setTimeout(() => { failed ??= 'U1_READ_TIMEOUT'; child.kill(); }, 15000);
    child.stdout.on('data', bytes => { client.firstStdoutMs??=elapsed();outputBytes+=bytes.length;
      for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) stdoutLines++;
      if (outputBytes+stderrBytes > 32 * 1024 * 1024) { failed ??= 'U1_READ_OUTPUT_LIMIT'; child.kill(); } else if(!failed)chunks.push(Buffer.from(bytes)); });
    child.stderr.on('data', bytes => {
      stderrBytes += bytes.length;
      client.firstStderrMs??=elapsed();phases.consume(Buffer.from(bytes),elapsed());
      if(outputBytes+stderrBytes>32*1024*1024){failed??='U1_READ_OUTPUT_LIMIT';child.kill();}
      const text = stderrTail + bytes.toString('utf8');
      sqlTimeout ||= text.includes('canceling statement due to statement timeout');
      stderrTail = text.slice(-64); // Bounded marker carry across chunks; never serialized.
    });
    child.on('error', () => { clearTimeout(timer); reject(failure('U1_READ_PROCESS')); });
    child.on('close', code => { client.closeMs=elapsed();clearTimeout(timer); stderrTail = '';
      if (failed || code !== 0) return reject(failure(failed ?? (sqlTimeout ? 'U1_READ_SQL_TIMEOUT' : 'U1_READ_EXIT'), code));
      try { resolve(JSON.parse(reassembleProtectedRead(Buffer.concat(chunks)))); } catch { reject(failure('U1_READ_FORMAT', code)); } });
    child.stdin.on('error', () => { failed ??= 'U1_READ_STDIN'; });client.stdinMs=elapsed(); child.stdin.end(sql);
  });
}
