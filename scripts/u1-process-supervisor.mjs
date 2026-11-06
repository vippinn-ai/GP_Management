import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';
import {setTimeout as emergencyTimer,clearTimeout as clearEmergencyTimer} from 'node:timers';

// Pure lifecycle component, NOT an executable launcher. Injected I/O must own
// the exact returned child and provide monotonic clock/timers. No command,
// arguments, environment, credentials, PID lookup, filesystem or network here.
// Per-instance one-shot only; immutable run reservation belongs to the launcher.
// Synchronous blocking I/O/event-loop stalls cannot be preempted by this module.
// Real Windows tree ownership/termination and bounded JSON capture remain
// separate integration gates. Raw output is deliberately discarded.
const claimedChildren=new WeakSet();
const ioKeys=['startOwned','terminateOwned','now','setTimer','clearTimer'];
export function createProcessSupervisor(io){
 if(!io||Object.keys(io).sort().join(',')!==[...ioKeys].sort().join(',')||ioKeys.some(k=>typeof io[k]!=='function'))throw new Error('Exact lifecycle I/O required');
 const {startOwned,terminateOwned,now,setTimer,clearTimer}=io;
 let consumed=false;
 return Object.freeze({run(mode){
  if(consumed)return Promise.reject(new Error('Supervisor already consumed'));
  if(mode!=='run'&&mode!=='discovery')return Promise.reject(new Error('Fixed supervisor mode required'));
  consumed=true;
  const deadline=mode==='run'?LAUNCH_LIMITS.processMs:LAUNCH_LIMITS.discoveryMs;
  return new Promise(resolve=>{
   let child,done=false,failure=null,closed=false,code=null,killStatus='not-requested',killSettled=false;
   let start,last,stdoutBytes=0,stderrBytes=0,deadlineTimer,killTimer,exitTimer,cleanupFailed=false;
   // An injected scheduler failure must not strand an already-owned child.
   // Native emergency timers provide the same bound, never a larger deadline.
   const schedule=(fn,ms)=>{try{return {id:setTimer(fn,ms),clear:clearTimer};}catch{failure='lifecycle-io-error';return {id:emergencyTimer(fn,ms),clear:clearEmergencyTimer};}};
   const elapsed=()=>{try{const n=now();if(!Number.isFinite(n)||n<last)throw new Error();last=n;return n-start;}catch{failure??='clock-invalid';return Math.max(0,(last??0)-(start??0));}};
   const finish=()=>{
    if(done)return;done=true;
    for(const timer of [deadlineTimer,killTimer,exitTimer])if(timer!==undefined)try{timer.clear(timer.id);}catch{cleanupFailed=true;}
    for(const resource of [child?.stdout,child?.stderr])try{resource?.destroy?.();}catch{cleanupFailed=true;}
    try{child?.unref?.();}catch{cleanupFailed=true;}
    const elapsedMs=elapsed();
    if(cleanupFailed)failure??='cleanup-failed';
    resolve(Object.freeze({schema:'u1-process-supervision-v1',mode,status:!failure&&closed&&code===0?'process-completed':'inconclusive',failure,exitCode:code,exitObserved:closed,killStatus,terminationConfirmed:closed&&killStatus==='confirmed',elapsedMs,stdoutBytes,stderrBytes,observedBytesUntilFailure:stdoutBytes+stderrBytes,cleanupFailed}));
   };
   const maybeFinish=()=>{if(closed&&killSettled)finish();};
   const fail=kind=>{
    if(done||killStatus!=='not-requested')return;
    failure??=kind;
    if(closed||!child){killStatus='not-needed';killSettled=true;finish();return;}
    killStatus='pending';
    killTimer=schedule(()=>{if(done||killSettled)return;killStatus='timed-out';killSettled=true;maybeFinish();},LAUNCH_LIMITS.killMs);
    exitTimer=schedule(()=>{if(done)return;if(!killSettled){killStatus='timed-out';killSettled=true;}finish();},LAUNCH_LIMITS.killMs+LAUNCH_LIMITS.exitMs);
    try{
     Promise.resolve(terminateOwned(child)).then(ok=>{if(done||killSettled)return;killStatus=ok===true?'confirmed':'failed';killSettled=true;maybeFinish();},()=>{if(done||killSettled)return;killStatus='failed';killSettled=true;maybeFinish();});
    }catch{killStatus='failed';killSettled=true;maybeFinish();}
   };
   try{start=now();if(!Number.isFinite(start))throw new Error();last=start;}catch{failure='clock-invalid';finish();return;}
   try{child=startOwned();}catch{failure='spawn-error';finish();return;}
   // Returned ownership must be a fresh stream-bearing child; no PID-based kill.
   if(!child||typeof child!=='object'||claimedChildren.has(child)){
    failure='invalid-owned-child';child=undefined;finish();return;
   }
   claimedChildren.add(child);
   try{if(typeof child.once!=='function'||typeof child.stdout?.on!=='function'||typeof child.stderr?.on!=='function'){fail('invalid-owned-child');return;}}
   catch{fail('invalid-owned-child');return;}
   const data=(stream,b)=>{
    if(done||failure)return;
    if(!Buffer.isBuffer(b)&&typeof b!=='string'){fail('invalid-output');return;}
    const bytes=Buffer.byteLength(b);
    if(stream==='stdout')stdoutBytes+=bytes;else stderrBytes+=bytes;
    if(stdoutBytes+stderrBytes>LAUNCH_LIMITS.outputBytes)fail('output-limit');
   };
   try{
   child.once('close',c=>{
    if(done)return;closed=true;code=Number.isInteger(c)?c:null;
    const duration=elapsed();
    if(killStatus==='not-requested'){
     if(failure||c!==0||duration>=deadline){fail(failure??(c!==0?'child-failed':'deadline-exceeded'));return;}
     killSettled=true;finish();
    }else maybeFinish();
   });
   child.once('error',()=>fail('spawn-error'));
   child.stdout.on('error',()=>fail('stream-error'));child.stderr.on('error',()=>fail('stream-error'));
   child.stdout.on('data',b=>data('stdout',b));child.stderr.on('data',b=>data('stderr',b));
   }catch{fail('lifecycle-io-error');return;}
   const duration=elapsed();
   if(failure||duration>=deadline)fail(failure??'deadline-exceeded');
   else {deadlineTimer=schedule(()=>fail('deadline-exceeded'),deadline-duration);if(failure)fail(failure);}
  });
 }});
}
