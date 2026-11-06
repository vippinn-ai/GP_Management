// Deliberately NOT a runnable browser package: no receipts, POSTs or expected-row fold.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalHash} from './u1-data-reconciler.mjs';
import {PROTECTED_TABLES} from './u1-protected-reader.mjs';
import {U1_LIMITS,verifyTarget} from './u1-playwright-runner.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const APPLICATION_COMMIT='70ee5ab00bd758c3de2b86e4f68ae76e69c82f1e';
export const HARNESS_BASE_COMMIT='5d8fac7bc2a4cce8b65158941869ea80180687b1';
export function draftIdentityPlan(runId){
 check(/^[A-Za-z0-9_-]{6,60}$/.test(runId??''),'Invalid fresh run ID');
 const pairs=Array.from({length:50},(_,index)=>{
  const prefix=`${runId}-p${String(index+1).padStart(2,'0')}`;
  return {index,aId:`${prefix}-session-a`,bId:`${prefix}-session-b`,customerIdA:`${prefix}-customer-a`,customerIdB:`${prefix}-customer-b`,customerA:`${prefix}-name-a`,customerBBefore:`${prefix}-name-b`,customerBAfter:`${prefix}-name-b-edit`};
 });
 const phases=pairs.flatMap(pair=>['start-a','start-b','save-b','reject-a','reject-b'].map((role,offset)=>({
  id:`${runId}-p${String(pair.index+1).padStart(2,'0')}-${role}`,pairIndex:pair.index,role,
  operation:['start_session','start_session','save_live_session_details','reject_session','reject_session'][offset],
  actorSlot:offset===0||offset===3?'A':'B',entityId:offset===0||offset===3?pair.aId:pair.bId,
  customerId:offset===0||offset===3?pair.customerIdA:pair.customerIdB,
  mutationId:`${runId}-p${String(pair.index+1).padStart(2,'0')}-${role}-mutation`,
  auditId:`${runId}-p${String(pair.index+1).padStart(2,'0')}-${role}-audit`,
  command:null,expectedProtectedRows:null
 })));
 return {pairs,phases,scope:{sessionIds:pairs.flatMap(p=>[p.aId,p.bId]),customerIds:pairs.flatMap(p=>[p.customerIdA,p.customerIdB]),customerNames:pairs.flatMap(p=>[p.customerA,p.customerBBefore,p.customerBAfter]),mutationIds:phases.map(p=>p.mutationId),auditIds:phases.map(p=>p.auditId)}};
}
// Input schema intentionally requires a reviewed combined preflight, not a
// catalogue alone. No existing capture is silently promoted to this schema.
export function prepareDraft({runId,applicationCommit,harnessCommit,baseURL,preflightFile,preflightSha256,now,maxAgeMs=900000,actors,stationIds}){
 check(applicationCommit===APPLICATION_COMMIT&&harnessCommit===HARNESS_BASE_COMMIT,'Exact application/harness baseline required');
 verifyTarget(baseURL);
 check(Number.isSafeInteger(now)&&Number.isSafeInteger(maxAgeMs)&&maxAgeMs>0&&maxAgeMs<=900000,'Bounded explicit clock required');
 check(typeof preflightFile==='string'&&path.isAbsolute(preflightFile)&&fs.realpathSync(preflightFile)===path.resolve(preflightFile),'Canonical preflight path required');
 check(/^[a-f0-9]{64}$/.test(preflightSha256??''),'Approved preflight hash required');
 const size=fs.statSync(preflightFile).size;check(size>0&&size<=32*1024*1024,'Preflight exceeds byte bound');
 const bytes=fs.readFileSync(preflightFile);check(bytes.length===size,'Preflight size changed');check(sha(bytes)===preflightSha256,'Preflight bytes changed');
 const e=JSON.parse(bytes.toString('utf8'));
 check(e.schema==='u1-package-preflight-v1'&&e.runId===runId,'Missing run-scoped combined preflight schema');
 check(e.applicationCommit===applicationCommit&&e.harnessCommit===harnessCommit,'Preflight source mismatch');
 check(e.project==='tkbdyzxwwbhkpztgjjxh'&&e.organization==='org-primary'&&e.systemIdentifier==='7623125441096521075'&&e.identityNonce==='f9bc0aed-b6c4-410f-ba2a-572522d03869'&&e.readOnly===true,'Staging identity mismatch');
 const captured=Date.parse(e.capturedAt);check(Number.isFinite(captured)&&captured<=now&&now-captured<=maxAgeMs,'Stale/future preflight');
 const plan=draftIdentityPlan(runId);
 check(canonicalHash(e.scope)===canonicalHash(plan.scope),'Preflight did not check exact planned IDs');
 const collisionKeys=['sessionIds','customerIds','customerNames','mutationIds','auditIds'];
 check(e.collisions&&canonicalHash(Object.keys(e.collisions).sort())===canonicalHash([...collisionKeys].sort())&&collisionKeys.every(k=>e.collisions[k]===0),'Explicit full-scope collision counts required');
 check(actors&&Object.keys(actors).sort().join(',')==='A,B'&&canonicalHash(e.actors)===canonicalHash(actors)&&['A','B'].every(slot=>
  actors[slot]&&Object.keys(actors[slot]).sort().join(',')==='active,id,organization,role'&&actors[slot].active===true&&actors[slot].organization==='org-primary'&&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(actors[slot].id)&&['admin','manager','receptionist'].includes(actors[slot].role))&&actors.A.id!==actors.B.id,'Invalid authoritative actor bindings');
 check(Array.isArray(stationIds)&&stationIds.length===2&&new Set(stationIds).size===2&&stationIds.every(id=>typeof id==='string'&&id.length>0),'Two distinct stations required');
 check(Array.isArray(e.stations)&&stationIds.every(id=>{const matches=e.stations.filter(s=>s.id===id);return matches.length===1&&matches[0].organization_id==='org-primary'&&matches[0].active===true&&matches[0].mode==='timed';}),'Insufficient or duplicate timed station capacity');
 const floors=['openSessions','openTabs','unbilledHops','incompleteOperationalMutations','incompleteFinancialMutations','customerNameCollisions'];
 check(e.floor&&canonicalHash(Object.keys(e.floor).sort())===canonicalHash([...floors].sort())&&floors.every(k=>e.floor[k]===0),'Floor/collision failure');
 const rows=e.protectedRows;
 check(rows&&canonicalHash(Object.keys(rows).sort())===canonicalHash([...PROTECTED_TABLES,'_unowned'].sort()),'Incomplete protected projection');
 check(rows._unowned&&canonicalHash(Object.keys(rows._unowned).sort())===canonicalHash([...PROTECTED_TABLES].sort()),'Unowned fingerprint table set mismatch');
 check(Array.isArray(rows.analytics_dirty_dates)&&rows.analytics_dirty_dates.length<=10000&&rows.analytics_dirty_dates.every(row=>
  row&&Object.keys(row).sort().join(',')==='business_date,organization_id,reason,updated_at'&&row.organization_id==='org-primary'&&
  /^20\d\d-\d\d-\d\d$/.test(row.business_date)&&Number.isFinite(Date.parse(`${row.business_date}T00:00:00Z`))&&new Date(`${row.business_date}T00:00:00Z`).toISOString().slice(0,10)===row.business_date&&typeof row.reason==='string'&&typeof row.updated_at==='string'&&Number.isFinite(Date.parse(row.updated_at))), 'Invalid analytics preimage scope or shape');
 check(new Set(rows.analytics_dirty_dates.map(row=>row.business_date)).size===rows.analytics_dirty_dates.length,'Duplicate analytics organization/date');
 for(const table of PROTECTED_TABLES){
  check(Array.isArray(rows[table]),'Protected table missing');
  if(table!=='analytics_dirty_dates')check(rows[table].length===0,'Owned-row collision');
  const fp=rows._unowned?.[table];check(fp&&Number.isSafeInteger(fp.count)&&fp.count>=0&&/^[a-f0-9]{32}$/.test(fp.md5??''),'Missing unowned fingerprint');
 }
 check(e.appState?.id==='primary'&&Number.isSafeInteger(e.appState.version)&&e.appState.version>=0&&e.appState.data&&typeof e.appState.data==='object'&&!Array.isArray(e.appState.data),'Missing full app_state');
 const reserved=new Set([...plan.scope.sessionIds,...plan.scope.customerIds,...plan.scope.auditIds,...plan.scope.mutationIds,...plan.scope.customerNames.map(n=>n.toLowerCase())]);
 const checkLegacy=value=>{if(typeof value==='string')check(!reserved.has(value)&&!reserved.has(value.trim().toLowerCase()),'Legacy app_state identity collision');else if(value&&typeof value==='object')for(const entry of Object.values(value))checkLegacy(entry);};
 checkLegacy(e.appState.data);
 const pairs=plan.pairs.map(p=>({...p,stationIdA:stationIds[0],stationIdB:stationIds[1]}));
 const phases=plan.phases.map(p=>({...p,actorId:actors[p.actorSlot].id,stationId:stationIds[p.actorSlot==='A'?0:1]}));
 const inputManifest={runId,applicationCommit,harnessCommit,baseURL,project:e.project,organization:e.organization,preflight:{path:preflightFile,sha256:preflightSha256,capturedAt:e.capturedAt},actors:structuredClone(actors),pairs,scope:plan.scope,limits:U1_LIMITS,initialAppStateHash:canonicalHash(e.appState),initialProtectedHash:canonicalHash(rows)};
 // In-memory draft remains editable; only exclusive persisted bytes+returned SHA
 // are immutable evidence. It must never be passed as a live admitted package.
 return {schema:'u1-package-preparation-draft-v1',status:'draft-not-admitted',admitted:false,inputManifest,inputManifestHash:canonicalHash(inputManifest),phaseIdentities:phases,
  missing:['reviewed combined preflight collector and catalog closure','complete command payload construction from station/pricing/session preimages','250 phase full protected/app_state expectation fold','generated-field templates and correlation windows','catalog/source/build/rollback evidence receipts','outer one-shot launcher','independent run reviewer and tester admission'],proofs:null,proofFiles:null,finalExpectedProtectedHash:null};
}
export function writeDraft(file,draft){
 check(draft?.schema==='u1-package-preparation-draft-v1'&&draft.status==='draft-not-admitted'&&draft.admitted===false,'Draft only');
 check(draft.proofs===null&&draft.proofFiles===null&&draft.finalExpectedProtectedHash===null,'Cannot manufacture admission');
 const bytes=JSON.stringify(draft,null,2)+'\n';fs.writeFileSync(file,bytes,{flag:'wx'});return {path:path.resolve(file),sha256:sha(bytes),status:'draft-not-admitted'};
}
