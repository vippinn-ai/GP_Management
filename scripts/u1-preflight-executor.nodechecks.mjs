import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {observeFakeChildForTests,executePreflight} from './u1-preflight-executor.mjs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildCombinedPreflight} from './u1-preflight-collector.mjs';
import {APPLICATION_COMMIT,HARNESS_BASE_COMMIT} from './u1-package-builder.mjs';
import {PROTECTED_TABLES} from './u1-protected-reader.mjs';
function fake(){
 let time=0,id=0,kills=0;const timers=new Map();const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=s=>{child.sql=s;};
 const deps={now:()=>time,setTimer:(fn,ms)=>{timers.set(++id,{at:time+ms,fn});return id;},clearTimer:id=>timers.delete(id),terminate:c=>{assert.equal(c,child);kills++;}};
 const advance=(ms,fire=true)=>{time+=ms;if(fire)for(const [id,t]of [...timers])if(t.at<=time){timers.delete(id);t.fn();}};
 return {child,deps,advance,kills:()=>kills};
}
test('normal completion invokes exactly one stdin write and preserves bytes',async()=>{
 const f=fake();const p=observeFakeChildForTests(f.child,'reviewed SQL',f.deps);assert.equal(f.child.sql,'reviewed SQL');
 f.child.stdout.emit('data',Buffer.from('{}'));f.advance(10);f.child.emit('close',0);const r=await p;assert.equal(r.status,'passed');assert.equal(r.stdout.toString(),'{}');assert.equal(r.terminationConfirmed,true);assert.equal(f.kills(),0);
});
test('nonzero, child error and stdin error retain only fixed categories',async()=>{
 for(const kind of ['nonzero','child','stdin']){const f=fake();const p=observeFakeChildForTests(f.child,'sql',f.deps);
  if(kind==='nonzero')f.child.emit('close',1);else{(kind==='child'?f.child:f.child.stdin).emit('error',new Error('SECRET'));f.child.emit('close',1);}
  const r=await p;assert.equal(r.status,'failed');assert.ok(!JSON.stringify(r).includes('SECRET'));assert.equal(f.kills(),kind==='nonzero'?0:1);
 }
});
test('timeout settles after two-second no-close grace; late success cannot flip verdict',async()=>{
 const f=fake();const p=observeFakeChildForTests(f.child,'sql',f.deps);f.advance(15000);assert.equal(f.kills(),1);f.advance(2000);const r=await p;
 assert.equal(r.failure,'deadline-exceeded');assert.equal(r.terminationConfirmed,false);assert.equal(r.elapsedMs,17000);f.child.emit('close',0);assert.equal(r.status,'failed');assert.equal(r.terminationConfirmed,false);
});
test('delayed timer does not admit success after monotonic deadline',async()=>{
 const f=fake();const p=observeFakeChildForTests(f.child,'sql',f.deps);f.advance(15001,false);f.child.emit('close',0);assert.equal((await p).failure,'deadline-exceeded');
});
test('spawn elapsed time consumes deadline before stdin submission',async()=>{
 const f=fake();f.advance(15001,false);const p=observeFakeChildForTests(f.child,'sql',{...f.deps,startedAt:0});
 assert.equal(f.child.sql,undefined);assert.equal(f.kills(),1);f.child.emit('close',0);assert.equal((await p).failure,'deadline-exceeded');
});
test('output counts bytes, overflow terminates once, stderr discarded',async()=>{
 const f=fake();const p=observeFakeChildForTests(f.child,'sql',f.deps);f.child.stderr.emit('data',Buffer.from('SECRET'));
 f.child.stdout.emit('data',Buffer.alloc(32*1024*1024+1));f.child.emit('error',new Error('SECRET'));f.child.emit('close',0);
 const r=await p;assert.equal(r.failure,'stdout-limit');assert.equal(f.kills(),1);assert.equal(r.stdout.length,0);assert.equal(r.receivedBytes,32*1024*1024+1);
});
test('production API has fixed spawn, clean env, fatal UTF8 and exclusive attempt before spawn',()=>{
 const s=fs.readFileSync(new URL('./u1-preflight-executor.mjs',import.meta.url),'utf8');
 assert.ok(!s.includes('taskkill'));assert.ok(!s.includes('...process.env'));assert.ok(!s.includes('PGOPTIONS:'));
 assert.ok(s.includes("PGHOST:'db.tkbdyzxwwbhkpztgjjxh.supabase.co'"));assert.ok(s.includes("PGSSLMODE:'verify-full'"));assert.ok(s.includes("new TextDecoder('utf-8',{fatal:true})"));
 assert.ok(s.indexOf("write('attempt.json'")<s.indexOf('const child=spawn('));assert.ok(s.includes("flag:'wx'"));
 assert.ok(!s.slice(s.indexOf('export async function executePreflight')).includes('observeFakeChildForTests'));
 assert.throws(()=>new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from([0xc3,0x28])));
});
test('public executor handoff mocked at builtin boundary: fixed env, reservation, raw policy and zero retry',async()=>{
 const base=fs.realpathSync(path.resolve(import.meta.dirname,'../test-artifacts'));const dir=fs.mkdtempSync(path.join(base,'executor-offline-'));
 const original=cp.spawn;let calls=0;const outputs=[];
 try{
  const exe=path.join(dir,'psql.exe'),cert=path.join(dir,'root.crt');fs.writeFileSync(exe,'NOT AN EXECUTABLE');fs.writeFileSync(cert,'SYNTHETIC CERT');
  const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const request={runId:'u1-executor-offline-check',applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,actorIds:{A:'00000000-0000-4000-8000-000000000001',B:'00000000-0000-4000-8000-000000000002'},stationIds:['station-a','station-b']};
  let generated=buildCombinedPreflight(request);
  const actors=Object.fromEntries(['A','B'].map(s=>[s,{id:request.actorIds[s],role:'admin',active:true,organization:'org-primary'}]));
  const evidence={schema:'u1-package-preflight-v1',runId:request.runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,project:'tkbdyzxwwbhkpztgjjxh',organization:'org-primary',systemIdentifier:'7623125441096521075',identityNonce:'f9bc0aed-b6c4-410f-ba2a-572522d03869',readOnly:true,capturedAt:new Date().toISOString(),scope:generated.scope,actors,stations:request.stationIds.map(id=>({id,organization_id:'org-primary',active:true,mode:'timed'})),collisions:{sessionIds:0,customerIds:0,customerNames:0,mutationIds:0,auditIds:0},floor:{openSessions:0,openTabs:0,unbilledHops:0,incompleteOperationalMutations:0,incompleteFinancialMutations:0,customerNameCollisions:0},appState:{id:'primary',version:1,data:{}},protectedRows:{...Object.fromEntries(PROTECTED_TABLES.map(t=>[t,[]])),_unowned:Object.fromEntries(PROTECTED_TABLES.map(t=>[t,{count:0,md5:'d41d8cd98f00b204e9800998ecf8427e'}]))}};
  for(const mode of ['nonzero','invalid-utf8','semantic-failure','spawn-error','valid','tool-drift','cert-drift']){
   fs.writeFileSync(exe,'NOT AN EXECUTABLE');fs.writeFileSync(cert,'SYNTHETIC CERT');
   request.runId=`u1-executor-offline-${path.basename(dir)}-${mode}`;generated=buildCombinedPreflight(request);evidence.runId=request.runId;evidence.scope=generated.scope;
   const parent=path.join(base,'u1-preflight');fs.mkdirSync(parent,{recursive:true});const out=path.join(parent,request.runId);fs.mkdirSync(out);outputs.push(out);let intercepted=false;
   cp.spawn=(file,args,opts)=>{calls++;intercepted=true;assert.equal(file,exe);assert.ok(fs.existsSync(path.join(out,'attempt.json')));
    assert.deepEqual(args,['-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1']);assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);
    assert.deepEqual(Object.keys(opts.env).sort(),['SystemRoot','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','PGCONNECT_TIMEOUT'].sort());
    assert.equal(opts.env.PGHOST,'db.tkbdyzxwwbhkpztgjjxh.supabase.co');
    if(mode==='spawn-error')throw new Error('SYNTHETIC SECRET');
    const f=fake();queueMicrotask(()=>{if(mode==='tool-drift')fs.appendFileSync(exe,'changed');if(mode==='cert-drift')fs.appendFileSync(cert,'changed');f.child.stdout.emit('data',mode==='invalid-utf8'?Buffer.from([0xc3,0x28]):Buffer.from(mode==='valid'?JSON.stringify(evidence):'{}'));f.child.emit('close',mode==='nonzero'?1:0);});return f.child;
   };syncBuiltinESMExports();
   const options={request,expectedSqlSha256:generated.sha256,executable:exe,executableSha256:hash(exe),sslRootCert:cert,sslRootCertSha256:hash(cert),user:'synthetic',password:'SYNTHETIC SECRET',evidenceDirectory:out,preparation:{runId:request.runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,stationIds:request.stationIds,actors,baseURL:'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev'}};
   for(const patch of [{evidenceDirectory:dir},{executableSha256:'0'.repeat(64)},{sslRootCertSha256:'0'.repeat(64)},{preparation:{...options.preparation,baseURL:'https://wrong.invalid'}},{preparation:{...options.preparation,secret:'no'}},{preparation:{...options.preparation,actors:{...actors,A:{...actors.A,role:'bad'}}}}]){const before=calls;await assert.rejects(executePreflight({...options,...patch}));assert.equal(calls,before);assert.equal(fs.existsSync(path.join(out,'attempt.json')),false);}
   for(const name of ['attempt.json','preflight.json','draft.json','result.json']){const file=path.join(out,name);fs.writeFileSync(file,'preserve');const before=calls;await assert.rejects(executePreflight(options));assert.equal(calls,before);assert.equal(fs.readFileSync(file,'utf8'),'preserve');fs.unlinkSync(file);}
   const result=await executePreflight(options);assert.equal(intercepted,true,'Mock must intercept; dummy executable is deliberately invalid');assert.equal(result.status,mode==='valid'?'captured-not-admitted':'failed');
   assert.equal(fs.existsSync(path.join(out,'preflight.json')),['semantic-failure','valid'].includes(mode));assert.ok(!fs.readFileSync(path.join(out,'result.json'),'utf8').includes('SECRET'));
   if(mode==='valid')assert.equal(JSON.parse(fs.readFileSync(path.join(out,'draft.json'),'utf8')).admitted,false);
   if(mode.endsWith('-drift'))assert.equal(result.failure,'dependency-drift');
   assert.equal(result.attemptSha256,hash(path.join(out,'attempt.json')));
   if(mode==='valid'){assert.equal(result.preflightSha256,hash(path.join(out,'preflight.json')));assert.equal(result.draftSha256,hash(path.join(out,'draft.json')));}
   const prior=calls;await assert.rejects(executePreflight(options));assert.equal(calls,prior);
  }
  assert.equal(calls,7);
 }finally{cp.spawn=original;syncBuiltinESMExports();for(const out of outputs)fs.rmSync(out,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});
