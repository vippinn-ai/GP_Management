// Pure SQL preparation + offline capture decoding. No executor/credentials/network.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {buildProtectedReadParts,renderProtectedReadParts} from './u1-protected-reader.mjs';
import {draftIdentityPlan,prepareDraft,isComparisonApplicationCommit,HARNESS_BASE_COMMIT} from './u1-package-builder.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
export const PREFLIGHT_CAPTURE_LIMITS=Object.freeze({statementMs:5000,lockMs:1000,processMs:15000,maxBytes:32*1024*1024});
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const sourcePins=Object.freeze({'u1-protected-reader.mjs':'3d95f7b5e683886ad0b521f64a19443f37efc47df18c60c7ba58f137660bf3df','u1-package-builder.mjs':'0191e0780dcb616bd6f90632e41b2d5a664c1d5031ffa8a69a80385502686cd4'});
export function buildCombinedPreflight({runId,applicationCommit,harnessCommit,actorIds,stationIds}){
 for(const [file,hash] of Object.entries(sourcePins))check(createHash('sha256').update(fs.readFileSync(new URL(file,import.meta.url))).digest('hex')===hash,'Frozen collector input drift');
 check(isComparisonApplicationCommit(applicationCommit)&&harnessCommit===HARNESS_BASE_COMMIT,'Wrong source baseline');
 check(actorIds&&Object.keys(actorIds).sort().join(',')==='A,B'&&Object.values(actorIds).every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))&&actorIds.A!==actorIds.B,'Exact distinct UUID actors required');
 check(Array.isArray(stationIds)&&stationIds.length===2&&new Set(stationIds).size===2&&stationIds.every(id=>/^[A-Za-z0-9_-]{1,120}$/.test(id)),'Exact two station IDs required');
 const {scope}=draftIdentityPlan(runId);
 const plan=buildProtectedReadParts(scope);plan.kind='preflight';plan.header=plan.header.replace('SET LOCAL statement_timeout','SET LOCAL row_security=off;\nSET LOCAL statement_timeout');
 const list=values=>`(${values.map(q).join(',')})`;
 const count=(table,column,values)=>`(select count(*) from public.${table} where organization_id='org-primary' and ${column} in ${list(values)})`;
 const actor=slot=>`(select jsonb_build_object('id',p.id,'role',m.role,'active',(p.active and m.active and p.role=m.role),'organization',m.organization_id) from public.profiles p join public.organization_members m on m.user_id=p.id where p.id=${q(actorIds[slot])}::uuid and m.organization_id='org-primary')`;
 plan.parts[0].expression=`(${plan.parts[0].expression}) || jsonb_build_object(
 'schema','u1-package-preflight-v1','runId',${q(runId)},'applicationCommit',${q(applicationCommit)},'harnessCommit',${q(harnessCommit)},
 'project','tkbdyzxwwbhkpztgjjxh','organization','org-primary',
 'systemIdentifier',(select system_identifier::text from pg_control_system()),'identityNonce','f9bc0aed-b6c4-410f-ba2a-572522d03869',
 'readOnly',current_setting('transaction_read_only')='on','capturedAt',clock_timestamp(),
 'scope',${q(JSON.stringify(scope))}::jsonb,'actors',jsonb_build_object('A',${actor('A')},'B',${actor('B')}),
 'stations',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'organization_id',s.organization_id,'active',s.active,'mode',s.mode) order by s.id),'[]'::jsonb) from public.stations s where s.organization_id='org-primary' and s.id in ${list(stationIds)}),
 'collisions',jsonb_build_object(
 'sessionIds',${count('sessions','id',scope.sessionIds)},'customerIds',${count('customers','id',scope.customerIds)},
 'customerNames',${count('customers','lower(trim(name))',scope.customerNames.map(n=>n.toLowerCase()))},
 'auditIds',${count('audit_logs','id',scope.auditIds)},
 'mutationIds',${count('operational_mutations','mutation_id',scope.mutationIds)}+${count('financial_mutations','mutation_id',scope.mutationIds)}+${count('operational_events',"metadata->>'mutation_id'",scope.mutationIds)}))`;
 const sql=renderProtectedReadParts(plan);
 // Typographical target changes must fail locally before any SQL is exported.
 check(sql.includes("'project','tkbdyzxwwbhkpztgjjxh'"),'Wrong generated staging target');
 return {sql,sha256:createHash('sha256').update(sql).digest('hex'),plan,scope,runId,applicationCommit,harnessCommit,request:structuredClone({runId,applicationCommit,harnessCommit,actorIds,stationIds}),sourcePins,limits:PREFLIGHT_CAPTURE_LIMITS,executorImplemented:false};
}
export function decodePreflightCapture(bytes,{expectedSqlSha256,generated,elapsedMs,preparation}){
 // elapsedMs is caller-supplied evidence, NOT an enforced process watchdog.
 // Existing createProtectedReader executes different SQL and cannot be reused
 // implicitly. A separately reviewed bounded executor is still required.
 check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=PREFLIGHT_CAPTURE_LIMITS.maxBytes,'Capture byte bound');
 check(Number.isFinite(elapsedMs)&&elapsedMs>=0&&elapsedMs<=PREFLIGHT_CAPTURE_LIMITS.processMs,'Capture process bound');
 check(/^[a-f0-9]{64}$/.test(expectedSqlSha256??'')&&generated?.sha256===expectedSqlSha256&&createHash('sha256').update(generated.sql).digest('hex')===expectedSqlSha256,'SQL binding drift');
 const regenerated=buildCombinedPreflight(generated.request);
 check(regenerated.sql===generated.sql&&regenerated.sha256===expectedSqlSha256,'SQL does not match fixed requested specification');
 check(JSON.stringify(sort(regenerated))===JSON.stringify(sort(generated)),'Generated authority metadata drift');
 const e=JSON.parse(bytes.toString('utf8'));check(e&&typeof e==='object'&&!Array.isArray(e)&&!Object.hasOwn(e,'evidence'),'Exact unwrapped evidence object required');
 const fields=['appState','protectedRows','floor','schema','runId','applicationCommit','harnessCommit','project','organization','systemIdentifier','identityNonce','readOnly','capturedAt','scope','actors','stations','collisions'];
 check(Object.keys(e).sort().join(',')===fields.sort().join(','),'Unexpected capture top-level fields');
 check(Array.isArray(e.stations)&&e.stations.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).sort().join(',')==='active,id,mode,organization_id'),'Unexpected station fields');
 check(e?.schema==='u1-package-preflight-v1'&&e.project==='tkbdyzxwwbhkpztgjjxh'&&e.organization==='org-primary'&&e.readOnly===true&&e.systemIdentifier==='7623125441096521075'&&e.identityNonce==='f9bc0aed-b6c4-410f-ba2a-572522d03869','Capture identity mismatch');
 check(e.runId===regenerated.runId&&e.applicationCommit===regenerated.applicationCommit&&e.harnessCommit===regenerated.harnessCommit,'Capture source/run mismatch');
 check(JSON.stringify(sort(e.scope))===JSON.stringify(sort(regenerated.scope)),'Capture scope mismatch');
 // The caller must persist the exact unwrapped evidence JSON first (wx), then
 // supply its approved file/SHA and all prepareDraft bindings. This invokes the
 // existing full validator; parser success alone never admits a preflight.
 check(preparation&&preparation.runId===regenerated.runId&&preparation.applicationCommit===regenerated.applicationCommit&&preparation.harnessCommit===regenerated.harnessCommit,'Preparation binding required');
 check(['A','B'].every(slot=>preparation.actors?.[slot]?.id===regenerated.request.actorIds[slot])&&JSON.stringify(preparation.stationIds)===JSON.stringify(regenerated.request.stationIds),'Preparation actor/station request mismatch');
 check(preparation.preflightSha256===createHash('sha256').update(bytes).digest('hex'),'Exact unwrapped persisted evidence required');
 const draft=prepareDraft(preparation);
 return {evidence:e,draft,rawSha256:createHash('sha256').update(bytes).digest('hex'),collectorSqlSha256:expectedSqlSha256,sourcePins,status:'captured-not-admitted'};
}
function sort(value){return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;}
