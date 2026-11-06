import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {draftIdentityPlan,prepareDraft,writeDraft,APPLICATION_COMMIT,HARNESS_BASE_COMMIT} from './u1-package-builder.mjs';
import {PROTECTED_TABLES} from './u1-protected-reader.mjs';
import {loadBrowserPackage} from './u1-browser-database-adapter.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const runId='u1-offline-builder-check';
const actors={A:{id:'00000000-0000-4000-8000-000000000001',role:'admin',active:true,organization:'org-primary'},B:{id:'00000000-0000-4000-8000-000000000002',role:'manager',active:true,organization:'org-primary'}};
function fixture(){return {schema:'u1-package-preflight-v1',runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,project:'tkbdyzxwwbhkpztgjjxh',organization:'org-primary',systemIdentifier:'7623125441096521075',identityNonce:'f9bc0aed-b6c4-410f-ba2a-572522d03869',readOnly:true,capturedAt:'2026-11-04T12:00:00Z',scope:draftIdentityPlan(runId).scope,actors:structuredClone(actors),stations:['station-a','station-b'].map(id=>({id,organization_id:'org-primary',active:true,mode:'timed'})),floor:{openSessions:0,openTabs:0,unbilledHops:0,incompleteOperationalMutations:0,incompleteFinancialMutations:0,customerNameCollisions:0},appState:{id:'primary',version:1,data:{sessions:[]}},protectedRows:{...Object.fromEntries(PROTECTED_TABLES.map(t=>[t,[]])),_unowned:Object.fromEntries(PROTECTED_TABLES.map(t=>[t,{count:0,md5:'d41d8cd98f00b204e9800998ecf8427e'}]))}};}
function withFixture(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'u1-builder-'));try{const file=path.join(dir,'preflight.json');const save=e=>{e.collisions??={sessionIds:0,customerIds:0,customerNames:0,mutationIds:0,auditIds:0};const bytes=JSON.stringify(e);fs.writeFileSync(file,bytes);return hash(bytes);};const e=fixture();const opts={runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,baseURL:'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev',preflightFile:fs.realpathSync(dir)+path.sep+'preflight.json',preflightSha256:save(e),now:Date.parse('2026-11-04T12:01:00Z'),actors,stationIds:['station-a','station-b']};run({dir,file,e,opts,save});}finally{fs.rmSync(dir,{recursive:true,force:true});}}
test('deterministic 50 pair and 250 ordered identity plan before preflight',()=>{
 const p=draftIdentityPlan(runId);assert.deepEqual(p,draftIdentityPlan(runId));assert.equal(p.pairs.length,50);assert.equal(p.phases.length,250);
 for(const [k,n] of [['sessionIds',100],['customerIds',100],['auditIds',250],['mutationIds',250],['customerNames',150]])assert.equal(new Set(p.scope[k]).size,n);
 for(let i=0;i<50;i++){const phases=p.phases.slice(i*5,i*5+5);assert.deepEqual(phases.map(p=>p.role),['start-a','start-b','save-b','reject-a','reject-b']);assert.equal(phases[1].customerId,phases[2].customerId);assert.equal(phases[2].entityId,p.pairs[i].bId);}
 assert.throws(()=>draftIdentityPlan('bad space'));assert.throws(()=>draftIdentityPlan('x'.repeat(61)));
});
test('draft deterministic immutable and explicitly not browser-admissible',()=>withFixture(({opts,file,dir})=>{
 const before=fs.readFileSync(file);const input=structuredClone(opts);const a=prepareDraft(opts),b=prepareDraft(opts);assert.deepEqual(a,b);assert.deepEqual(opts,input);assert.deepEqual(fs.readFileSync(file),before);
 assert.notEqual(a.schema,'u1-browser-package-v1');assert.equal(a.status,'draft-not-admitted');assert.equal(a.proofs,null);assert.equal(a.finalExpectedProtectedHash,null);assert.ok(a.phaseIdentities.every(p=>p.command===null&&p.expectedProtectedRows===null));
 const output=path.join(dir,'draft.json');const receipt=writeDraft(output,a);assert.throws(()=>loadBrowserPackage(output,receipt.sha256),/Wrong package schema/);assert.throws(()=>writeDraft(output,a));assert.throws(()=>writeDraft(path.join(dir,'bad.json'),{...a,proofs:{reviewer:'fake'}}));
}));
test('wrong source, run, target, actors, station or hash fails',()=>withFixture(({opts})=>{
 for(const patch of [{applicationCommit:'0'.repeat(40)},{harnessCommit:'0'.repeat(40)},{runId:'other-run'},{baseURL:'https://production.invalid'},{preflightSha256:'0'.repeat(64)},{actors:{...actors,B:actors.A}},{stationIds:['station-a','station-a']},{stationIds:['station-a','absent']},{now:Date.parse('2026-11-04T12:16:00Z')},{now:0},{maxAgeMs:900001}])assert.throws(()=>prepareDraft({...opts,...patch}));
}));
test('rehashed malformed preflight cannot pass scope, identity, floor or row checks',()=>withFixture(({opts,save})=>{
 for(const mutate of [e=>e.schema='catalog-only',e=>e.identityNonce='wrong',e=>e.readOnly=false,e=>e.scope.auditIds.pop(),e=>e.scope.mutationIds[0]='other',e=>e.scope.customerNames[0]='other',e=>e.floor.openSessions=1,e=>e.floor.customerNameCollisions=1,e=>e.protectedRows.audit_logs.push({id:'collision'}),e=>delete e.protectedRows.payments,e=>e.protectedRows._unowned.payments.count=null,e=>e.appState.data.sessions.push({id:e.scope.sessionIds[0]}),e=>e.appState.data.auditLogs=[{id:e.scope.auditIds[0]}],e=>e.stations[1].active=false,e=>e.actors.B.role='customer']){const e=fixture();mutate(e);assert.throws(()=>prepareDraft({...opts,preflightSha256:save(e)}));}
}));
// Synthetic fixtures test preparation, never constitute actual preflight evidence.
test('exact collision count keys and zero values required',()=>withFixture(({opts,save})=>{
 for(const collisions of [{},{sessionIds:0,customerIds:0,customerNames:0,mutationIds:1,auditIds:0},{sessionIds:0,customerIds:0,customerNames:0,mutationIds:0,auditIds:false}]){const e=fixture();e.collisions=collisions;assert.throws(()=>prepareDraft({...opts,preflightSha256:save(e)}));}
}));
test('strict actors do not embed extra slots, secrets or malformed UUIDs',()=>withFixture(({opts,save})=>{
 for(const mutate of [a=>a.A.id='-'.repeat(36),a=>a.A.id='00000000000040008000000000000001----',a=>a.A.password='secret',a=>a.A.email='private',a=>a.C={...a.A}]){
  const e=fixture();mutate(e.actors);assert.throws(()=>prepareDraft({...opts,actors:e.actors,preflightSha256:save(e)}),/actor bindings/);
 }
}));
test('masked station duplicates and protected table/scope drift rejected',()=>withFixture(({opts,save})=>{
 const analytics={organization_id:'org-primary',business_date:'2026-11-04',reason:'data_change',updated_at:'2026-11-04T12:00:00Z'};
 for(const mutate of [e=>e.stations.push({...e.stations[0],active:false}),e=>e.stations.push({...e.stations[0],organization_id:'other'}),e=>e.protectedRows._unowned.extra={count:0,md5:'a'.repeat(32)},e=>e.protectedRows.analytics_dirty_dates=[{...analytics,organization_id:'other'}],e=>e.protectedRows.analytics_dirty_dates=Array(10001).fill(analytics),e=>e.protectedRows.analytics_dirty_dates=[{...analytics,extra:1}]]){
  const e=fixture();mutate(e);assert.throws(()=>prepareDraft({...opts,preflightSha256:save(e)}));
 }
}));
test('zero and oversized preflight rejected before parse',()=>withFixture(({opts,file})=>{
 fs.truncateSync(file,0);assert.throws(()=>prepareDraft(opts),/byte bound/);
 fs.truncateSync(file,32*1024*1024+1);assert.throws(()=>prepareDraft(opts),/byte bound/);
}));
test('analytics dates require actual calendar dates and unique organization/date keys',()=>withFixture(({opts,save})=>{
 const row={organization_id:'org-primary',business_date:'2026-11-04',reason:'data_change',updated_at:'2026-11-04T12:00:00Z'};
 for(const rows of [[row,{...row}],[{...row,business_date:'2026-02-30'}],[{...row,business_date:'2026-13-01'}]]){
  const e=fixture();e.protectedRows.analytics_dirty_dates=rows;assert.throws(()=>prepareDraft({...opts,preflightSha256:save(e)}),/analytics/);
 }
 const e=fixture();e.protectedRows.analytics_dirty_dates=[{...row,business_date:'2024-02-29'}];assert.doesNotThrow(()=>prepareDraft({...opts,preflightSha256:save(e)}));
}));
