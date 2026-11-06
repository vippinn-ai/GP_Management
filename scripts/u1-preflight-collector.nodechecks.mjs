import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildCombinedPreflight,decodePreflightCapture,PREFLIGHT_CAPTURE_LIMITS} from './u1-preflight-collector.mjs';
import {APPLICATION_COMMIT,HARNESS_BASE_COMMIT} from './u1-package-builder.mjs';
import {PROTECTED_TABLES} from './u1-protected-reader.mjs';
const options={runId:'u1-offline-collector-check',applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,actorIds:{A:'00000000-0000-4000-8000-000000000001',B:'00000000-0000-4000-8000-000000000002'},stationIds:['station-a','station-b']};
test('one guarded snapshot embeds full protected query and sanitized authority',()=>{
 const g=buildCombinedPreflight(options);assert.deepEqual(g,buildCombinedPreflight(options));
 assert.equal((g.sql.match(/BEGIN ISOLATION/g)||[]).length,1);assert.equal((g.sql.match(/ROLLBACK;/g)||[]).length,1);
 for(const s of ['REPEATABLE READ READ ONLY',"statement_timeout='5s'","lock_timeout='1s'",'row_security=off','7623125441096521075','f9bc0aed-b6c4-410f-ba2a-572522d03869','p.active and m.active and p.role=m.role','public.financial_mutations','public.operational_mutations',"metadata->>'mutation_id'",'AS evidence;'])assert.ok(g.sql.includes(s));
 assert.ok(!/\b(COMMIT|INSERT|UPDATE|DELETE|CALL|CREATE|ALTER|GRANT|REVOKE)\b/i.test(g.sql));assert.ok(!/auth_email|username|p\.name/.test(g.sql));
 assert.equal(g.executorImplemented,false);assert.equal(PREFLIGHT_CAPTURE_LIMITS.processMs,15000);
});
test('malformed inputs never enter SQL literals',()=>{
 for(const patch of [{runId:"x';drop table x;--"},{stationIds:["x');--",'s']},{stationIds:['s','s']},{actorIds:{...options.actorIds,A:'-'.repeat(36)}},{applicationCommit:'0'.repeat(40)},{actorIds:{...options.actorIds,C:options.actorIds.A}}])assert.throws(()=>buildCombinedPreflight({...options,...patch}));
});
test('offline captured unwrapped bytes invoke full draft validator; never admit live',()=>{
 const generated=buildCombinedPreflight(options);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'u1-collector-'));
 try{
  const actors=Object.fromEntries(['A','B'].map(slot=>[slot,{id:options.actorIds[slot],role:'admin',active:true,organization:'org-primary'}]));
  const e={schema:'u1-package-preflight-v1',runId:options.runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,project:'tkbdyzxwwbhkpztgjjxh',organization:'org-primary',systemIdentifier:'7623125441096521075',identityNonce:'f9bc0aed-b6c4-410f-ba2a-572522d03869',readOnly:true,capturedAt:'2026-11-04T12:00:00Z',scope:generated.scope,actors,stations:options.stationIds.map(id=>({id,organization_id:'org-primary',active:true,mode:'timed'})),collisions:{sessionIds:0,customerIds:0,customerNames:0,mutationIds:0,auditIds:0},floor:{openSessions:0,openTabs:0,unbilledHops:0,incompleteOperationalMutations:0,incompleteFinancialMutations:0,customerNameCollisions:0},appState:{id:'primary',version:1,data:{}},protectedRows:{...Object.fromEntries(PROTECTED_TABLES.map(t=>[t,[]])),_unowned:Object.fromEntries(PROTECTED_TABLES.map(t=>[t,{count:0,md5:'d41d8cd98f00b204e9800998ecf8427e'}]))}};
  const bytes=Buffer.from(JSON.stringify(e));const file=path.join(fs.realpathSync(dir),'capture.json');fs.writeFileSync(file,bytes,{flag:'wx'});
  const args={generated,expectedSqlSha256:generated.sha256,elapsedMs:100,preparation:{...options,actors,baseURL:'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev',now:Date.parse('2026-11-04T12:01:00Z'),preflightFile:file,preflightSha256:createHash('sha256').update(bytes).digest('hex')}};
  assert.equal(decodePreflightCapture(bytes,args).draft.admitted,false);
  const forgedSql=generated.sql+' ';
  const forged={...generated,sql:forgedSql,sha256:createHash('sha256').update(forgedSql).digest('hex')};
  assert.throws(()=>decodePreflightCapture(bytes,{...args,generated:forged,expectedSqlSha256:forged.sha256}),/fixed requested/);
  assert.throws(()=>decodePreflightCapture(bytes,{...args,preparation:{...args.preparation,stationIds:[...options.stationIds].reverse()}}),/actor\/station/);
  assert.throws(()=>decodePreflightCapture(bytes,{...args,preparation:{...args.preparation,actors:{...actors,A:actors.B}}}),/actor\/station/);
  for(const mutate of [v=>v.private='unwanted',v=>v.stations[0].notes='unwanted']){
   const value=structuredClone(e);mutate(value);const changed=Buffer.from(JSON.stringify(value));fs.writeFileSync(file,changed);
   assert.throws(()=>decodePreflightCapture(changed,{...args,preparation:{...args.preparation,preflightSha256:createHash('sha256').update(changed).digest('hex')}}),/fields/);
  }
  const drift={...e,runId:'u1-coordinated-drift'};const driftBytes=Buffer.from(JSON.stringify(drift));fs.writeFileSync(file,driftBytes);
  assert.throws(()=>decodePreflightCapture(driftBytes,{...args,generated:{...generated,runId:drift.runId},preparation:{...args.preparation,runId:drift.runId,preflightSha256:createHash('sha256').update(driftBytes).digest('hex')}}),/authority metadata drift/);
  fs.writeFileSync(file,bytes);
  for(const patch of [{elapsedMs:15001},{elapsedMs:NaN},{expectedSqlSha256:'0'.repeat(64)},{generated:{...generated,sql:generated.sql+' '}},{preparation:undefined}])assert.throws(()=>decodePreflightCapture(bytes,{...args,...patch}));
  for(const b of [Buffer.from('{} {}'),Buffer.from('[]'),Buffer.alloc(0),Buffer.alloc(32*1024*1024+1),Buffer.from(JSON.stringify({...e,runId:'wrong-run'})),Buffer.from(JSON.stringify({...e,floor:{...e.floor,openSessions:1}}))])assert.throws(()=>decodePreflightCapture(b,args));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
