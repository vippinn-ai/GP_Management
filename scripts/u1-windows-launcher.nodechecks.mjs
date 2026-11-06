import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {launchStagingOnce,runLocalContainmentProof,observeKillToolForTests} from './u1-windows-launcher.mjs';
const ROOT=path.resolve(import.meta.dirname,'..');
async function sha(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
test('staging is unconditionally disabled, including poison inputs',async()=>{
 let accesses=0;const input=new Proxy({}, {get(){accesses++;throw new Error('secret');},ownKeys(){accesses++;throw new Error('secret');}});
 await assert.rejects(launchStagingOnce(input),/staging admission integration incomplete/);assert.equal(accesses,0);
});
test('local entry rejects arbitrary command hooks, identity and missing approval hashes',async()=>{
 await assert.rejects(runLocalContainmentProof({command:'anything'}),/Invalid diagnostic fields/);
 if(process.platform!=='win32')return;
 await assert.rejects(runLocalContainmentProof({runId:'other',confirmation:'x',hashes:{}}),/Fixed local diagnostic/);
 await assert.rejects(runLocalContainmentProof({runId:'u1-windows-proof-offline',confirmation:'LOCAL CONTAINMENT ONLY u1-windows-proof-offline',hashes:{}}),/Invalid diagnostic fields/);
});
test('kill tool timeout waits for bounded close and never assumes process death',async()=>{
 for(const closes of [true,false]){
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();let killed=0,finished=false;
  child.kill=signal=>{assert.equal(signal,'SIGKILL');killed++;};child.unref=()=>{};child.stdout.destroy=()=>{};child.stderr.destroy=()=>{};
  const pending=new Map();let id=0;
  const p=observeKillToolForTests(child,{setTimer(fn,ms){pending.set(++id,{fn,ms});return id;},clearTimer(n){pending.delete(n);}});p.then(()=>{finished=true;});
  const deadline=[...pending.values()].find(x=>x.ms===5000);deadline.fn();await Promise.resolve();assert.equal(killed,1);assert.equal(finished,false);
  if(closes)child.emit('close',0);else [...pending.values()].find(x=>x.ms===3000).fn();
  assert.deepEqual(await p,{ok:false,exitObserved:closes});assert.equal(killed,1);
 }
});
test('real benign Windows tree containment; sibling survives and one attempt is immutable',{skip:process.env.U1_RUN_BENIGN_WINDOWS_PROOF!=='1'||process.platform!=='win32',timeout:90000},async()=>{
 // This opt-in is exclusively the fixed local fixture, never staging/browser/DB.
 const runId=`u1-windows-proof-${Date.now()}-${randomBytes(4).toString('hex')}`;
 const hashes={};
 for(const [role,file]of Object.entries({node:process.execPath,taskkill:'C:\\Windows\\System32\\taskkill.exe',fixture:path.join(ROOT,'scripts/u1-windows-containment.fixture.mjs'),supervisor:path.join(ROOT,'scripts/u1-process-supervisor.mjs'),module:path.join(ROOT,'scripts/u1-windows-launcher.mjs')}))hashes[role]=await sha(file);
 fs.mkdirSync(path.join(ROOT,'test-artifacts/u1-windows-proof'),{recursive:true});
 const options={runId,confirmation:`LOCAL CONTAINMENT ONLY ${runId}`,hashes};
 const result=await runLocalContainmentProof(options);
 console.log(JSON.stringify({localEvidence:path.join(ROOT,'test-artifacts/u1-windows-proof',runId,'result.json'),status:result.status}));
 assert.equal(result.status,'local-containment-demonstrated');assert.equal(result.stagingAdmission,false);assert.equal(result.descendantGone,true);assert.equal(result.siblingWasAlive,true);assert.equal(result.siblingCleaned,true);assert.equal(result.supervision.failure,'output-limit');assert.equal(result.supervision.terminationConfirmed,true);assert.equal(result.killToolExitObserved,true);
 assert.equal(result.rootCleanupConfirmed,true);assert.equal(result.descendantCleanupConfirmed,true);assert.equal(result.cleanupFallbackUsed,false);
 assert.ok(result.diagnosticElapsedMs<30000);assert.equal(result.fixtureSelfExpiryMs,60000);
 const attempt=path.join(ROOT,'test-artifacts/u1-windows-proof',runId,'attempt.json'),before=await sha(attempt);
 await assert.rejects(runLocalContainmentProof(options),/EEXIST/);assert.equal(await sha(attempt),before);
});
