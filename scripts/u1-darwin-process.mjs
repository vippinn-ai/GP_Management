// OS containment adapter for browser-free discovery. This is NOT admission;
// the supervised launcher binds command/tools/source before calling it.
// No shell, inherited environment, PID lookup, retry or configurable limits.
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createProcessSupervisor} from './u1-process-supervisor.mjs';
import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function runDarwinOwnedProcess(options){
 if(process.platform!=='darwin')throw new Error('Darwin containment only');
 if(!options||Object.keys(options).sort().join(',')!=='args,captureJson,cwd,env,file,mode')throw new Error('Exact containment options required');
 const {file,args,cwd,env,mode,captureJson}=options;
 if(typeof captureJson!=='boolean')throw new Error('Explicit JSON capture choice required');
 if(typeof file!=='string'||!path.isAbsolute(file)||typeof cwd!=='string'||!path.isAbsolute(cwd)||!Array.isArray(args)||args.some(a=>typeof a!=='string')||!env||Object.getPrototypeOf(env)!==Object.prototype||Object.values(env).some(v=>typeof v!=='string')||!['run','discovery'].includes(mode))throw new Error('Explicit command and environment required');
 let child,closed=false,killInvoked=false,termination=null,groupUnknown=false,captured=0;const chunks=[];
 const groupExists=()=>{
  if(!child||!Number.isSafeInteger(child.pid)||child.pid<=1||child.pid===process.pid)return null;
  try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;groupUnknown=true;return null;}
 };
 const terminate=owned=>{
  if(owned!==child)return Promise.resolve(false);
  if(termination)return termination;
  termination=(async()=>{
   const exists=groupExists();
   if(exists===null)return false;
   if(exists){
    killInvoked=true;
    try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH'){groupUnknown=true;return false;}}
   }
   const deadline=performance.now()+LAUNCH_LIMITS.killMs;
   while(performance.now()<deadline){
    const remaining=groupExists();
    if(closed&&remaining===false)return true;
    if(remaining===null)return false;
    await pause(Math.min(20,Math.max(1,deadline-performance.now())));
   }
   return closed&&groupExists()===false;
  })();
  return termination;
 };
 const supervisor=createProcessSupervisor({
  startOwned(){
   child=spawn(file,args,{cwd,env,shell:false,detached:true,stdio:['ignore','pipe','pipe']});
   child.once('close',()=>{closed=true;});
   if(captureJson)child.stdout.on('data',bytes=>{captured+=bytes.length;if(captured<=LAUNCH_LIMITS.outputBytes)chunks.push(Buffer.from(bytes));});
   return child;
  },
  terminateOwned:terminate,
  now:()=>performance.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:id=>clearTimeout(id),
 });
 const result=await supervisor.run(mode);
 // Root close is not proof that its group is empty. A leftover descendant
 // invalidates even exit(0), is killed once, and cannot become a passing run.
 const groupAtRootClose=groupExists();
 const leftover=result.status==='process-completed'&&groupAtRootClose!==false;
 if(groupAtRootClose===true&&!termination)await terminate(child);
 else if(termination)await termination;
 const groupGone=groupExists()===false;
 const neverSpawned=child?.pid===undefined&&closed;
 const cleanupConfirmed=(closed&&groupGone)||neverSpawned;
 const completed=result.status==='process-completed'&&!leftover&&cleanupConfirmed&&!groupUnknown;
 let json=null,parseFailed=false;
 if(completed&&captureJson)try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{parseFailed=true;}
 return Object.freeze({schema:'u1-darwin-containment-v1',result,
  status:completed?'process-completed':'inconclusive',
  failure:leftover?'descendant-after-root-close':result.failure,
  childPid:child?.pid??null,killInvoked,rootCloseObserved:closed,
  groupGone,cleanupConfirmed,manualCleanupRequired:!cleanupConfirmed||groupUnknown,json,parseFailed,
 });
}
