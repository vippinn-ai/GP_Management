import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildCommandPlan} from './u1-command-plan.mjs';
import {prepareDraft,draftIdentityPlan,APPLICATION_COMMIT,HARNESS_BASE_COMMIT} from './u1-package-builder.mjs';
import {PROTECTED_TABLES} from './u1-protected-reader.mjs';
import {canonicalHash,patchArrayById} from './u1-data-reconciler.mjs';
import {loadBrowserPackage} from './u1-browser-database-adapter.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(fn,large=false,setup={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-command-')));
 try{
 const save=(name,obj)=>{const file=path.join(dir,name),bytes=JSON.stringify(obj);fs.writeFileSync(file,bytes);return {file,sha256:sha(bytes)};};
 const runId='u1-command-offline',actors={A:{id:'00000000-0000-4000-8000-000000000001',role:'admin',active:true,organization:'org-primary'},B:{id:'00000000-0000-4000-8000-000000000002',role:'manager',active:true,organization:'org-primary'}};
 const e={schema:'u1-package-preflight-v1',runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,project:'tkbdyzxwwbhkpztgjjxh',organization:'org-primary',systemIdentifier:'7623125441096521075',identityNonce:'f9bc0aed-b6c4-410f-ba2a-572522d03869',readOnly:true,capturedAt:'2026-11-04T12:00:00Z',scope:draftIdentityPlan(runId).scope,actors,stations:['station-a','station-b'].map(id=>({id,organization_id:'org-primary',active:true,mode:'timed'})),floor:{openSessions:0,openTabs:0,unbilledHops:0,incompleteOperationalMutations:0,incompleteFinancialMutations:0,customerNameCollisions:0},collisions:{sessionIds:0,customerIds:0,customerNames:0,mutationIds:0,auditIds:0},appState:{id:'primary',version:735,updated_by:null,updated_at:'2026-11-04T11:00:00Z',data:{sessions:[{id:'unrelated',nested:{preserve:true}}],auditLogs:[{id:'old-audit'}],unrelated:{blob:large?'x'.repeat(1024*1024):'retained'}}},protectedRows:{...Object.fromEntries(PROTECTED_TABLES.map(t=>[t,[]])),_unowned:Object.fromEntries(PROTECTED_TABLES.map(t=>[t,{count:0,md5:'d41d8cd98f00b204e9800998ecf8427e'}]))}};
 setup.preflight?.(e);
 const pre=save('pre.json',e),draft=prepareDraft({runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,baseURL:'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev',preflightFile:pre.file,preflightSha256:pre.sha256,now:Date.parse(e.capturedAt),actors,stationIds:['station-a','station-b']}),d=save('draft.json',draft);
 const authority={schema:'u1-approved-station-pricing-v1',runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,preflightSha256:pre.sha256,stations:e.stations.map(s=>({...s,name:`Name ${s.id}`,ltpEnabled:false,pricingSnapshot:[{id:`price-${s.id}`,stationId:s.id,label:'Standard',startMinute:0,endMinute:1440,hourlyRate:120}]}))},a=save('authority.json',authority);
 const input={schema:'u1-command-inputs-v1',runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,preflightSha256:pre.sha256,draftSha256:d.sha256,initialAppState:e.appState,initialProtectedRows:e.protectedRows,stationAuthority:{path:a.file,sha256:a.sha256},clock:{earliest:'2026-11-04T12:00:00Z',latest:'2026-11-04T12:15:00Z'},timings:Array.from({length:50},(_,index)=>({index,startA:'2026-11-04T12:00:00.000001Z',startB:'2026-11-04T12:00:00.000002Z',saveB:'2026-11-04T12:00:00.000003Z',endA:'2026-11-04T12:00:00.000004Z',endB:'2026-11-04T12:00:00.000005Z'})),closeReason:'U1 approved test'};
 setup.inputs?.(input);
 const build=()=>{const x=save('inputs.json',input);return buildCommandPlan({draftFile:d.file,draftSha256:d.sha256,inputsFile:x.file,inputsSha256:x.sha256});};
 fn({build,input,draft,authority,save,d,a});
 }finally{assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
}
import {fileURLToPath} from 'node:url';
import {buildResultExpectations,protectedTemplateAt,materializeResultAt,postgresUtcTimestamp} from './u1-result-expectations.mjs';
import {compareInstalledPhase,prepareInstalledPhase} from './u1-phase-expectations.mjs';
import {bindGeneratedPhase} from './u1-generated-fields.mjs';
const catalogFile=fileURLToPath(new URL('../../../evidence/u1-catalog-20261103-1615/catalog.csv',import.meta.url));
const helperCatalogFile=fileURLToPath(new URL('../../../evidence/u1-helper-catalog-20261103/catalog.csv',import.meta.url));
function oracleFixture(fn,setup={}){fixture(f=>{
 const plan=f.build(),inp=f.save('inputs.json',f.input);
 const authority={schema:'u1-actor-display-authority-v1',runId:f.input.runId,applicationCommit:f.input.applicationCommit,harnessCommit:f.input.harnessCommit,preflightSha256:f.input.preflightSha256,planHash:plan.planHash,actors:Object.fromEntries(['A','B'].map(s=>[s,{id:f.draft.inputManifest.actors[s].id,name:s==='A'?'Actor A':'Actor B',username:s==='A'?'qa_a':'qa_b',profileRole:f.draft.inputManifest.actors[s].role,membershipRole:f.draft.inputManifest.actors[s].role,resolvedRole:f.draft.inputManifest.actors[s].role}]))};
 const a=f.save('actors.json',authority),options={commandInputs:{draftFile:f.d.file,draftSha256:f.d.sha256,inputsFile:inp.file,inputsSha256:inp.sha256},actorAuthorityFile:a.file,actorAuthoritySha256:a.sha256,catalogFile,helperCatalogFile};
 fn({...f,plan,authority,options,oracle:buildResultExpectations(options)});
 },false,setup);}
test('PostgreSQL business timestamp format preserves offsets and microseconds',()=>{
 assert.equal(postgresUtcTimestamp('2026-11-04T07:00:00.120000+05:30'),'2026-11-04T01:30:00.12+00:00');
 assert.equal(postgresUtcTimestamp('2026-11-04T01:29:59.999999Z'),'2026-11-04T01:29:59.999999+00:00');
 assert.equal(postgresUtcTimestamp('2026-11-04T12:00:00Z'),'2026-11-04T12:00:00+00:00');
 assert.throws(()=>postgresUtcTimestamp('2026-02-30T12:00:00Z'));
});
test('all250 complete row deltas, snapshots, lazy final and UI projection',()=>oracleFixture(({oracle,plan,input})=>{
 assert.throws(()=>protectedTemplateAt(structuredClone(oracle),0));assert.throws(()=>materializeResultAt(oracle,0,{}));
 assert.equal(oracle.phases.length,250);assert.equal(oracle.admitted,false);
 assert.deepEqual(protectedTemplateAt(oracle,249),oracle.finalProtectedRows);
 assert.deepEqual(protectedTemplateAt(oracle,-1),input.initialProtectedRows);
 assert.equal(oracle.finalProtectedRows.sessions.length,100);assert.equal(oracle.finalProtectedRows.customers.length,100);assert.equal(oracle.finalProtectedRows.audit_logs.length,250);assert.equal(oracle.finalProtectedRows.operational_events.length,250);assert.equal(oracle.finalProtectedRows.activity_events.length,500);
 const start=oracle.phases[1],save=oracle.phases[2],row=save.delta.customers[0];
 assert.equal(row.first_seen_at,'2026-11-04T12:00:00.000002+00:00');assert.equal(row.last_visit_at,'2026-11-04T12:00:00.000003+00:00');
 assert.equal(row.raw_data.name,plan.pairs[0].customerBAfter);assert.equal(row.raw_data.visitAt,input.timings[0].saveB);assert.equal(row.created_at.phase,plan.phases[1].id);assert.equal(row.updated_at.phase,plan.phases[2].id);
 assert.equal(start.delta.activity_events[0].entity_label,'Name station-b · '+plan.pairs[0].customerBBefore);
 assert.deepEqual(oracle.finalProtectedRows.activity_events.find(r=>r.source_kind==='audit_log'&&r.source_id===plan.phases[1].auditId),start.delta.activity_events[0]);
 assert.equal(save.delta.activity_events[0].entity_label,'Name station-b · '+plan.pairs[0].customerBAfter);
 assert.equal(start.delta.activity_events[0].search_text,('U1 start-b Actor B qa_b Name station-b · '+plan.pairs[0].customerBBefore+' '+plan.pairs[0].bId+' session_started').toLowerCase());
 assert.equal(save.delta.activity_events[1].summary,'Save Live Session Details');
 assert.deepEqual(save.delta.activity_events[1].details,{event_id:{$generated:'eventId',phase:plan.phases[2].id},source:'operational_event',actor_identity_provenance:'server_authenticated',context_provenance:'server_operation'});
 assert.deepEqual(save.uiParity.A,save.uiParity.B);assert.deepEqual(save.uiParity.A.B,{sessionId:plan.pairs[0].bId,customerName:plan.pairs[0].customerBAfter,station:'Name station-b'});
 assert.deepEqual(oracle.finalProtectedRows._unowned,input.initialProtectedRows._unowned);assert.deepEqual(oracle.finalProtectedRows.bills,[]);
 assert.ok(oracle.phases.every(p=>p.delta.analytics_dirty_dates.every(r=>r.reason==='session_change'&&r.updated_at.phase===p.id)));
}));
test('all250 lazy rows bind through actual generated and installed comparators',()=>oracleFixture(({oracle,plan,input})=>{
 const bindings={};let previous=input.initialProtectedRows;
 for(let i=0;i<250;i++){
  const p=plan.phases[i],e=oracle.phases[i],number=String(i+1).padStart(12,'0');
  const binding={eventId:'event-00000000-0000-4000-8000-'+number,auditActivityId:'activity-10000000-0000-4000-8000-'+number,operationalActivityId:'activity-20000000-0000-4000-8000-'+number,serverTime:'2026-11-04T12:00:01.'+String(i+1).padStart(6,'0')+'Z',operation:p.operation,entityId:p.entityId,auditId:p.auditId,mutationId:p.mutationId,customerId:p.operation==='reject_session'?null:p.customerId,customerWrite:p.operation==='start_session'?'insert':p.operation==='save_live_session_details'?'update':null,analyticsDates:e.analyticsDates,...(p.operation==='reject_session'?{serverDurationMs:1.234}:{})};
  bindings[p.id]=binding;
  const actual=materializeResultAt(oracle,i,bindings),changed={sessions:[p.entityId],audit_logs:[p.auditId],operational_events:[binding.eventId]};
  if(p.operation==='reject_session')changed.session_pause_logs=[];else{changed.customers=[p.customerId];if(p.operation==='start_session')Object.assign(changed,{session_items:[],session_combo_applications:[],stock_movements:[]});}
  const response={mutation_id:p.mutationId,organization_id:'org-primary',entity_type:'session',entity_id:p.entityId,event_id:binding.eventId,server_time:binding.serverTime,changed_rows:changed,...(p.operation==='reject_session'?{app_state_version:p.compatibility.expectedVersion,server_duration_ms:1.234}:{})};
  const contract={...p,earliestServerTime:'2026-11-04T12:00:00Z',latestServerTime:'2026-11-04T12:00:15Z',customerWrite:binding.customerWrite};
  if(p.operation==='reject_session')delete contract.customerId;
  const bound=bindGeneratedPhase(contract,response,actual,p.command);assert.equal(bound.eventId,binding.eventId);
  if(i===1){assert.throws(()=>bindGeneratedPhase(contract,{...response,event_id:'event-00000000-0000-4000-8000-999999999999'},actual,p.command));assert.throws(()=>bindGeneratedPhase(contract,{...response,server_time:'2026-11-04T12:00:16Z'},actual,p.command));const borrowed=structuredClone(actual);borrowed.sessions[0].created_at=binding.serverTime;assert.throws(()=>compareInstalledPhase(protectedTemplateAt(oracle,i),borrowed,bindings,p.id,prepareInstalledPhase(previous,p.operation,p.command)));}
  const intent=prepareInstalledPhase(previous,p.operation,p.command);
  compareInstalledPhase(protectedTemplateAt(oracle,i),actual,bindings,p.id,intent);
  if(i<3){for(const mutate of [r=>delete r.sessions[0].ltp_outcome,r=>r.sessions[0].extra=1,r=>r.audit_logs[0].user_id='other',r=>r.activity_events[0].search_text='tampered',r=>r.activity_events[0].actor_name_snapshot='wrong actor',r=>r.activity_events[0].details.context_provenance='tampered',r=>r.activity_events[0].entity_label='wrong session']){const bad=structuredClone(actual);mutate(bad);assert.throws(()=>compareInstalledPhase(protectedTemplateAt(oracle,i),bad,bindings,p.id,intent));}}
  previous=actual;
 }
}));
test('capture and actor authority tampering fails before expected rows',()=>oracleFixture(({options,authority,save})=>{
 assert.throws(()=>buildResultExpectations({...options,actorAuthoritySha256:'0'.repeat(64)}));assert.throws(()=>buildResultExpectations({...options,commandInputs:{...options.commandInputs,extra:'secret'}}));
 for(const mutate of [a=>a.planHash='0'.repeat(64),a=>a.actors.A.name='é',a=>a.actors.A.username='x'.repeat(129),a=>a.actors.A.id=a.actors.B.id,a=>a.actors.A.profileRole='manager',a=>a.extra='secret']){
  const a=structuredClone(authority);mutate(a);const f=save('actors.json',a);assert.throws(()=>buildResultExpectations({...options,actorAuthoritySha256:f.sha256}));
 }
 const fake=save('fake.csv',{evidence:'not authority'});assert.throws(()=>buildResultExpectations({...options,catalogFile:fake.file}));
}));
test('7AM Kolkata boundary touches old/new start dates and preserves unrelated analytics',()=>oracleFixture(({oracle})=>{
 assert.equal(oracle.phases[0].delta.sessions[0].started_at,'2026-11-04T01:29:59.999998+00:00');
 assert.equal(oracle.phases[0].delta.sessions[0].raw_data.startedAt,'2026-11-04T06:59:59.999998+05:30');
 assert.equal(oracle.phases[3].delta.sessions[0].ended_at,'2026-11-04T01:31:00+00:00');
 assert.equal(oracle.phases[3].delta.sessions[0].raw_data.endedAt,'2026-11-04T07:01:00+05:30');
 assert.deepEqual(oracle.phases[0].analyticsDates,['2026-11-03']);
 assert.deepEqual(oracle.phases[2].analyticsDates,['2026-11-03','2026-11-04']);
 assert.deepEqual(oracle.phases[3].analyticsDates,['2026-11-03']);
 assert.deepEqual(oracle.phases[4].analyticsDates,['2026-11-04']);
 assert.deepEqual(oracle.finalProtectedRows.analytics_dirty_dates.find(r=>r.business_date==='2026-10-01'),{organization_id:'org-primary',business_date:'2026-10-01',reason:'untouched',updated_at:'2026-10-01T01:00:00Z'});
 assert.equal(oracle.finalProtectedRows.analytics_dirty_dates.find(r=>r.business_date==='2026-11-03').updated_at.phase,oracle.phases[248].id);
 assert.equal(oracle.finalProtectedRows.analytics_dirty_dates.find(r=>r.business_date==='2026-11-04').updated_at.phase,oracle.phases[249].id);
},{preflight:e=>{e.capturedAt='2026-11-04T01:29:00Z';e.protectedRows.analytics_dirty_dates=[{organization_id:'org-primary',business_date:'2026-10-01',reason:'untouched',updated_at:'2026-10-01T01:00:00Z'},{organization_id:'org-primary',business_date:'2026-11-03',reason:'existing',updated_at:'2026-11-04T01:00:00Z'}];},inputs:i=>{i.clock={earliest:'2026-11-04T01:29:00Z',latest:'2026-11-04T01:40:00Z'};for(const t of i.timings)Object.assign(t,{startA:'2026-11-04T06:59:59.999998+05:30',startB:'2026-11-04T06:59:59.999999+05:30',saveB:'2026-11-04T07:00:00.000001+05:30',endA:'2026-11-04T07:01:00+05:30',endB:'2026-11-04T07:01:01+05:30'});}}));

