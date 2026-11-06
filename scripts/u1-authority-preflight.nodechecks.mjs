import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildAuthorityPreflight,extractAuthorityPreflight,decodeAuthorityCapture,bindActorAuthority} from './u1-authority-preflight.mjs';
import {draftIdentityPlan,APPLICATION_COMMIT,HARNESS_BASE_COMMIT} from './u1-package-builder.mjs';
import {PROTECTED_TABLES} from './u1-protected-reader.mjs';
import {buildCommandPlan} from './u1-command-plan.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const request={runId:'u1-authority-offline',applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,actorIds:{A:'00000000-0000-4000-8000-000000000001',B:'00000000-0000-4000-8000-000000000002'},stationIds:['station-a','station-b']};
const emptyFingerprint=()=>Object.fromEntries(PROTECTED_TABLES.map(t=>[t,{count:0,md5:'d41d8cd98f00b204e9800998ecf8427e'}]));

function fixture(fn){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-authority-')));
 try{
  const generated=buildAuthorityPreflight(request),actors=Object.fromEntries(['A','B'].map((slot,i)=>[slot,{id:request.actorIds[slot],role:i?'manager':'admin',active:true,organization:'org-primary'}]));
  const preflight={schema:'u1-package-preflight-v1',runId:request.runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,project:'tkbdyzxwwbhkpztgjjxh',organization:'org-primary',systemIdentifier:'7623125441096521075',identityNonce:'f9bc0aed-b6c4-410f-ba2a-572522d03869',readOnly:true,capturedAt:'2026-11-04T12:00:00Z',scope:draftIdentityPlan(request.runId).scope,actors,stations:request.stationIds.map(id=>({id,organization_id:'org-primary',active:true,mode:'timed'})),collisions:{sessionIds:0,customerIds:0,customerNames:0,mutationIds:0,auditIds:0},floor:{openSessions:0,openTabs:0,unbilledHops:0,incompleteOperationalMutations:0,incompleteFinancialMutations:0,customerNameCollisions:0},appState:{id:'primary',version:735,updated_by:null,updated_at:'2026-11-04T11:00:00Z',data:{sessions:[],auditLogs:[],unrelated:{keep:true}}},protectedRows:{...Object.fromEntries(PROTECTED_TABLES.map(t=>[t,[]])),_unowned:emptyFingerprint()}};
  const actorDisplays=Object.fromEntries(['A','B'].map(slot=>[slot,{id:actors[slot].id,name:`Actor ${slot}`,username:`actor-${slot.toLowerCase()}`,profileRole:actors[slot].role,membershipRole:actors[slot].role,resolvedRole:actors[slot].role,profileActive:true,membershipActive:true,organization:'org-primary'}]));
  const stationPricing=request.stationIds.map((id,i)=>({id,organization_id:'org-primary',name:`Station ${i+1}`,active:true,mode:'timed',ltpEnabled:false,overrides:{mode:null,active:null,ltpEnabled:null}}));
  const pricingRules=request.stationIds.map((stationId,i)=>({id:`price-${i+1}`,stationId,label:'Standard',startMinute:0,endMinute:1440,hourlyRate:120+i,overrides:{stationId:null,startMinute:null,endMinute:null,hourlyRate:null}}));
  const capture={schema:'u1-authority-preflight-v1',preflight,actorDisplays,stationPricing,pricingRules};
  const decode=(value=capture)=>{
   const bytes=Buffer.from(JSON.stringify(value)),preBytes=extractAuthorityPreflight(bytes),preFile=path.join(dir,'preflight.json');fs.writeFileSync(preFile,preBytes);
   return decodeAuthorityCapture(bytes,{generated,expectedSqlSha256:generated.sha256,elapsedMs:100,preparation:{...request,actors,baseURL:'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev',now:Date.parse('2026-11-04T12:01:00Z'),preflightFile:preFile,preflightSha256:sha(preBytes)}});
  };
  fn({dir,generated,actors,preflight,actorDisplays,stationPricing,pricingRules,capture,decode});
 }finally{assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
}

test('authority SQL remains one bounded read-only snapshot with full fallback inputs',()=>{
 const g=buildAuthorityPreflight(request);assert.deepEqual(g,buildAuthorityPreflight(request));assert.equal(g.executorImplemented,false);
 assert.equal((g.sql.match(/BEGIN ISOLATION/g)||[]).length,1);assert.equal((g.sql.match(/ROLLBACK;/g)||[]).length,1);
 for(const token of ["statement_timeout='5s'","lock_timeout='1s'",'REPEATABLE READ READ ONLY','row_security=off',"s.raw_data->'ltpEnabled'","r.raw_data->'stationId'",'limit 257',"'profileActive'","'membershipActive'","'organization'"])assert.ok(g.sql.includes(token),token);
 assert.ok(!/\b(COMMIT|INSERT|UPDATE|DELETE|CALL|CREATE|ALTER|GRANT|REVOKE)\b/i.test(g.sql));
 for(const patch of [{runId:"x';drop table x;--"},{stationIds:["x');--",'s']},{stationIds:['s','s']},{actorIds:{...request.actorIds,A:'bad'}}])assert.throws(()=>buildAuthorityPreflight({...request,...patch}));
});

test('fallback normalization, full decode and actual command-plan authority bind are exact',()=>fixture(({dir,capture,decode})=>{
 const moved=structuredClone(capture);
 moved.stationPricing[0].overrides={mode:'timed',active:'true',ltpEnabled:'false'};
 moved.pricingRules[0].stationId='outside';moved.pricingRules[0].overrides={stationId:'station-a',startMinute:'0',endMinute:'1440',hourlyRate:'125'};
 moved.pricingRules.push({id:'moved-out',stationId:'station-a',label:'Ignored',startMinute:0,endMinute:30,hourlyRate:1,overrides:{stationId:'outside',startMinute:null,endMinute:null,hourlyRate:null}});
 const decoded=decode(moved),preflight=JSON.parse(fs.readFileSync(path.join(dir,'preflight.json')));assert.equal(decoded.status,'prepared-not-admitted');assert.equal(decoded.stationAuthority.stations[0].pricingSnapshot[0].hourlyRate,125);assert.equal(Object.isFrozen(decoded),true);
 const write=(name,value)=>{const file=path.join(dir,name),bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(file,bytes);return {file,sha256:sha(bytes)};};
 const d=write('draft.json',decoded.draft),a=write('authority.json',decoded.stationAuthority);
 const inputs={schema:'u1-command-inputs-v1',runId:request.runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,preflightSha256:decoded.preflightSha256,draftSha256:d.sha256,initialAppState:preflight.appState,initialProtectedRows:preflight.protectedRows,stationAuthority:{path:a.file,sha256:a.sha256},clock:{earliest:'2026-11-04T12:00:00Z',latest:'2026-11-04T12:15:00Z'},timings:Array.from({length:50},(_,index)=>({index,startA:'2026-11-04T12:00:00.000001Z',startB:'2026-11-04T12:00:00.000002Z',saveB:'2026-11-04T12:00:00.000003Z',endA:'2026-11-04T12:00:00.000004Z',endB:'2026-11-04T12:00:00.000005Z'})),closeReason:'U1 approved test'},i=write('inputs.json',inputs),commandInputs={draftFile:d.file,draftSha256:d.sha256,inputsFile:i.file,inputsSha256:i.sha256};
 const bound=bindActorAuthority(decoded,commandInputs);assert.equal(bound.planHash,buildCommandPlan(commandInputs).planHash);assert.deepEqual(Object.keys(bound.actors.A).sort(),['id','membershipRole','name','profileRole','resolvedRole','username'].sort());assert.equal(Object.isFrozen(bound.actors.A),true);
 assert.throws(()=>bindActorAuthority(structuredClone(decoded),commandInputs),/Validated capture instance/);
 const changed=structuredClone(decoded.stationAuthority);changed.stations[0].name='Changed Station';const changedAuthority=write('authority.json',changed);inputs.stationAuthority.sha256=changedAuthority.sha256;const changedInputs=write('inputs.json',inputs);commandInputs.inputsSha256=changedInputs.sha256;
 assert.throws(()=>bindActorAuthority(decoded,commandInputs),/Plan pricing differs/);
}));

test('roles, pricing, capture bytes and authority bindings fail closed',()=>fixture(({capture,decode,generated})=>{
 const reject=mutate=>{const value=structuredClone(capture);mutate(value);assert.throws(()=>decode(value));};
 for(const mutate of [
  v=>v.actorDisplays.A.profileActive=false,v=>v.actorDisplays.A.membershipActive=false,v=>v.actorDisplays.A.organization='other',v=>v.actorDisplays.A.profileRole='manager',v=>v.actorDisplays.A.membershipRole='manager',v=>v.actorDisplays.A.resolvedRole='manager',
  v=>v.stationPricing[0].overrides.active='false',v=>v.stationPricing[0].overrides.mode='unit',v=>v.stationPricing[0].overrides.ltpEnabled='true',
  v=>v.pricingRules[0].overrides.endMinute='0',v=>v.pricingRules[1].overrides.stationId='station-a',v=>v.pricingRules.push({...v.pricingRules[0]}),
  v=>{v.pricingRules[0].overrides.endMinute='100';v.pricingRules.push({...v.pricingRules[0],id:'same-source-distinct-effective',overrides:{...v.pricingRules[0].overrides,startMinute:'100',endMinute:'200'}});},
  v=>{v.pricingRules=[...Array.from({length:33},(_,i)=>({id:`a-${i}`,stationId:'station-a',label:'Minute',startMinute:i,endMinute:i+1,hourlyRate:1,overrides:{stationId:null,startMinute:null,endMinute:null,hourlyRate:null}})),v.pricingRules[1]];},
  v=>v.stationPricing[1].id='unrequested',
  v=>v.preflight.floor.openSessions=1,v=>v.preflight.actors.A.active=false,
  v=>{v.pricingRules=Array.from({length:257},(_,i)=>({...v.pricingRules[0],id:`p-${i}`}));},v=>v.extra='x',v=>v.stationPricing[0].overrides.extra='x'
 ])reject(mutate);
 assert.throws(()=>extractAuthorityPreflight(Buffer.from('{}')));assert.throws(()=>extractAuthorityPreflight(Buffer.alloc(0)));assert.throws(()=>extractAuthorityPreflight(Buffer.from([0xff])));assert.throws(()=>extractAuthorityPreflight(Buffer.alloc(32*1024*1024+1)));
 reject(v=>v.preflight.capturedAt='2026-11-04T11:00:00Z');
 const bytes=Buffer.from(JSON.stringify(capture)),preBytes=extractAuthorityPreflight(bytes);
 assert.throws(()=>decodeAuthorityCapture(bytes,{generated,expectedSqlSha256:'0'.repeat(64),elapsedMs:1,preparation:{preflightSha256:sha(preBytes)}}));
 const changedSql={...generated,sql:generated.sql+' '};changedSql.sha256=sha(changedSql.sql);
 assert.throws(()=>decodeAuthorityCapture(bytes,{generated:changedSql,expectedSqlSha256:changedSql.sha256,elapsedMs:1,preparation:{preflightSha256:sha(preBytes)}}));
}));
