import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createProcessSupervisor} from './u1-process-supervisor.mjs';
import {LAUNCH_LIMITS,launchOnce} from './u1-guarded-launcher.mjs';

function harness({spawnError=false,spawnDuration=0,kill='pending'}={}){
 let clock=0,next=0,starts=0,kills=0,settled=false,answer;
 const timers=new Map(),child=new EventEmitter();
 child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.unrefs=0;
 for(const s of [child.stdout,child.stderr]){s.destroyed=false;s.destroy=()=>{s.destroyed=true;};}
 child.unref=()=>{child.unrefs++;};
 let killResolve,killReject;
 const killPromise=new Promise((resolve,reject)=>{killResolve=resolve;killReject=reject;});
 const io={startOwned(){starts++;clock+=spawnDuration;if(spawnError)throw new Error('PRIVATE spawn error');return child;},terminateOwned(c){assert.equal(c,child);kills++;if(kill==='throw')throw new Error('PRIVATE kill error');if(kill==='true')return true;if(kill==='false')return false;return killPromise;},now:()=>clock,setTimer(fn,delay){const id=++next;timers.set(id,{at:clock+delay,fn});return id;},clearTimer:id=>timers.delete(id)};
 const supervisor=createProcessSupervisor(io);
 const flush=async()=>{await Promise.resolve();await Promise.resolve();};
 return {child,io,supervisor,killResolve,killReject,flush,get starts(){return starts;},get kills(){return kills;},get settled(){return settled;},get answer(){return answer;},get timers(){return timers.size;},setClock(n){clock=n;},start(mode='run'){const p=supervisor.run(mode);p.then(r=>{settled=true;answer=r;});return p;},async tick(ms){const end=clock+ms;for(;;){const due=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;clock=due[1].at;timers.delete(due[0]);due[1].fn();await flush();}clock=end;await flush();}};
}
function assertSanitized(r){assert.equal(JSON.stringify(r).includes('PRIVATE'),false);assert.equal('stdout'in r,false);assert.equal('stderr'in r,false);assert.equal(Object.isFrozen(r),true);}

test('one-shot normal completion is metadata only, with both streams counted and cleanup',async()=>{
 const h=harness(),p=h.start();h.child.stdout.emit('data',Buffer.from('PRIVATE'));h.child.stderr.emit('data','secret');h.setClock(10);h.child.emit('close',0);
 const r=await p;assert.equal(r.status,'process-completed');assert.equal(r.exitObserved,true);assert.equal(r.terminationConfirmed,false);assert.equal(r.observedBytesUntilFailure,13);assert.equal(h.kills,0);assert.equal(h.starts,1);assert.equal(h.timers,0);assert.equal(h.child.stdout.destroyed,true);assert.equal(h.child.stderr.destroyed,true);assert.equal(h.child.unrefs,1);assertSanitized(r);
 await assert.rejects(h.supervisor.run('run'),/already consumed/);assert.equal(h.starts,1);
 await assert.rejects(launchOnce({}),/admission contract incomplete/);
});

test('nonzero, signal close, sync spawn error and malformed ownership fail closed',async()=>{
 for(const code of [1,null]){const h=harness(),p=h.start();h.child.emit('close',code);const r=await p;assert.equal(r.failure,'child-failed');assert.equal(h.kills,0);assertSanitized(r);}
 const h=harness({spawnError:true});const r=await h.start();assert.equal(r.failure,'spawn-error');assert.equal(r.exitObserved,false);assert.equal(h.kills,0);await assert.rejects(h.supervisor.run('run'),/consumed/);assertSanitized(r);
 const bad=harness();bad.io.startOwned=()=>null;assert.equal((await createProcessSupervisor(bad.io).run('run')).failure,'invalid-owned-child');
});

test('close-before-kill waits for outcome, and kill-before-close waits for exit',async()=>{
 for(const order of ['close-first','kill-first']){
  const h=harness(),p=h.start();await h.tick(LAUNCH_LIMITS.processMs);assert.equal(h.kills,1);assert.equal(h.settled,false);
  if(order==='close-first'){h.child.emit('close',0);await h.flush();assert.equal(h.settled,false);h.killResolve(true);}else{h.killResolve(true);await h.flush();assert.equal(h.settled,false);h.child.emit('close',null);}
  const r=await p;assert.equal(r.failure,'deadline-exceeded');assert.equal(r.status,'inconclusive');assert.equal(r.killStatus,'confirmed');assert.equal(r.terminationConfirmed,true);assert.equal(r.exitObserved,true);assert.equal(h.timers,0);
 }
});

test('failed/rejected/thrown kill cannot claim termination; no-close settles bounded',async()=>{
 for(const kill of ['false','throw','pending']){const h=harness({kill}),p=h.start('discovery');await h.tick(LAUNCH_LIMITS.discoveryMs);if(kill==='pending')h.killReject(new Error('PRIVATE'));await h.flush();h.child.emit('close',null);const r=await p;assert.equal(r.killStatus,'failed');assert.equal(r.terminationConfirmed,false);assert.equal(r.exitObserved,true);assertSanitized(r);}
 const h=harness({kill:'true'}),p=h.start();await h.tick(LAUNCH_LIMITS.processMs+LAUNCH_LIMITS.killMs+LAUNCH_LIMITS.exitMs);const r=await p;assert.equal(r.exitObserved,false);assert.equal(r.terminationConfirmed,false);assert.equal(r.killStatus,'confirmed');assert.equal(r.elapsedMs,1208000);assert.equal(h.child.stdout.destroyed,true);assert.equal(h.child.unrefs,1);
});

test('missing kill outcome is bounded with or without close and late events cannot promote result',async()=>{
 for(const closes of [true,false]){const h=harness(),p=h.start();await h.tick(LAUNCH_LIMITS.processMs);if(closes)h.child.emit('close',null);await h.tick(closes?LAUNCH_LIMITS.killMs:LAUNCH_LIMITS.killMs+LAUNCH_LIMITS.exitMs);const r=await p;assert.equal(r.killStatus,'timed-out');assert.equal(r.terminationConfirmed,false);assert.equal(r.exitObserved,closes);h.killResolve(true);h.child.emit('close',0);h.child.emit('error',new Error('PRIVATE late'));h.child.stdout.emit('data','PRIVATE late');await h.flush();assert.equal(h.answer,r);assert.equal(h.kills,1);assertSanitized(r);}
});

test('combined 32MiB output bound includes stderr; exact boundary allowed, excess stops once',async()=>{
 const chunk=Buffer.alloc(1024*1024);
 const ok=harness(),p=ok.start();for(let i=0;i<32;i++)ok.child.stderr.emit('data',chunk);ok.child.emit('close',0);assert.equal((await p).status,'process-completed');
 const h=harness({kill:'true'}),q=h.start();for(let i=0;i<16;i++){h.child.stdout.emit('data',chunk);h.child.stderr.emit('data',chunk);}h.child.stderr.emit('data',Buffer.from('!'));h.child.stdout.emit('data','ignored');await h.flush();h.child.emit('close',null);const r=await q;assert.equal(r.failure,'output-limit');assert.equal(r.observedBytesUntilFailure,LAUNCH_LIMITS.outputBytes+1);assert.equal(h.kills,1);assertSanitized(r);
});

test('monotonic elapsed includes synchronous spawn duration and delayed close cannot pass',async()=>{
 const h=harness({spawnDuration:LAUNCH_LIMITS.discoveryMs,kill:'true'}),p=h.start('discovery');await h.flush();assert.equal(h.kills,1);h.child.emit('close',0);assert.equal((await p).failure,'deadline-exceeded');
 const late=harness(),q=late.start();late.setClock(LAUNCH_LIMITS.processMs);late.child.emit('close',0);const r=await q;assert.equal(r.failure,'deadline-exceeded');assert.equal(late.kills,0);
 const backwards=harness({spawnDuration:10}),b=backwards.start();backwards.setClock(9);backwards.child.emit('close',0);assert.equal((await b).failure,'clock-invalid');
});

test('child/stream errors and invalid bytes are sanitized, terminate once, and never retry',async()=>{
 for(const which of ['child','stdout','stderr','invalid']){const h=harness({kill:'true'}),p=h.start();if(which==='invalid')h.child.stdout.emit('data',{});else(which==='child'?h.child:h.child[which]).emit('error',new Error('PRIVATE'));await h.flush();h.child.emit('close',null);const r=await p;assert.equal(r.status,'inconclusive');assert.equal(h.kills,1);assert.equal(h.starts,1);assertSanitized(r);}
});

test('fixed API rejects overrides and reused child ownership without second termination',async()=>{
 const h=harness();assert.throws(()=>createProcessSupervisor({...h.io,args:['arbitrary']}),/Exact/);await assert.rejects(h.supervisor.run({deadline:1}),/Fixed/);assert.equal(h.starts,0);
 const p=h.start();h.child.emit('close',0);await p;
 const second=createProcessSupervisor(h.io);const r=await second.run('run');assert.equal(r.failure,'invalid-owned-child');assert.equal(h.kills,0);
});

test('post-ownership listener and timer exceptions sanitize, terminate once and settle',async()=>{
 for(const kind of ['deadline-timer','all-timers','stream-listener','child-listener']){
  const h=harness({kill:'true'});let schedules=0;
  const originalSchedule=h.io.setTimer;
  if(kind.includes('timer'))h.io.setTimer=(fn,delay)=>{schedules++;if(kind==='all-timers'||schedules===1)throw new Error('PRIVATE timer');return originalSchedule(fn,delay);};
  if(kind==='stream-listener')h.child.stdout.on=()=>{throw new Error('PRIVATE listener');};
  if(kind==='child-listener')h.child.once=()=>{throw new Error('PRIVATE child listener');};
  const supervisor=createProcessSupervisor(h.io),p=supervisor.run('run');await h.flush();assert.equal(h.kills,1);
  if(kind==='child-listener')await h.tick(LAUNCH_LIMITS.killMs+LAUNCH_LIMITS.exitMs);else h.child.emit('close',null);
  const r=await p;assert.equal(r.failure,'lifecycle-io-error');assert.equal(r.status,'inconclusive');assert.equal(h.kills,1);assertSanitized(r);
 }
});

test('fresh malformed owned object is terminated once, unlike null or reused ownership',async()=>{
 const h=harness({kill:'true'});h.child.stdout.on=null;
 const p=h.start();await h.flush();assert.equal(h.kills,1);
 await h.tick(LAUNCH_LIMITS.killMs+LAUNCH_LIMITS.exitMs);
 const r=await p;assert.equal(r.failure,'invalid-owned-child');assert.equal(r.exitObserved,false);assert.equal(r.terminationConfirmed,false);assert.equal(r.elapsedMs,8000);assert.equal(h.kills,1);assertSanitized(r);
});
