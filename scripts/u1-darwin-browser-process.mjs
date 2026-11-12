// Fixed parent-owned Chrome boundary. Admission remains in the supervised
// launcher. Browser and runner share one supervisor clock/output budget.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createProcessSupervisor} from './u1-process-supervisor.mjs';
import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function runDarwinBrowserProcess({node,playwright,chrome,root,args,env}){
 if(process.platform!=='darwin'||chrome!==fs.realpathSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))throw new Error('Fixed Darwin Chrome required');
 if(![node,playwright,root].every(p=>typeof p==='string'&&path.isAbsolute(p))||!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw new Error('Explicit admitted command required');
 const {chromium}=await import(pathToFileURL(path.join(root,'node_modules/playwright/index.mjs')).href);
 const facade=new EventEmitter();facade.stdout=new EventEmitter();facade.stderr=new EventEmitter();
 facade.stdout.destroy=()=>{};facade.stderr.destroy=()=>{};facade.unref=()=>{};
 const owned=[];let stopped=false,facadeClosed=false,server,runner,interceptor,originalSpawn,termination,spawnCount=0,unexpected=false,closingNormally=false,launchSettled=false,failureLatched=false;
 const restore=()=>{if(interceptor&&cp.spawn===interceptor)cp.spawn=originalSpawn;};
 const exists=o=>{
  if(!Number.isSafeInteger(o.child.pid)||o.child.pid<=1||o.child.pid===process.pid)return o.closed?false:null;
  try{process.kill(-o.child.pid,0);return true;}catch(e){return e.code==='ESRCH'?false:null;}
 };
 const clean=()=>owned.every(o=>o.closed&&exists(o)===false);
 const finish=code=>{if(!facadeClosed){facadeClosed=true;facade.emit('close',code);}};
 const fail=()=>{if(!facadeClosed&&!failureLatched){failureLatched=true;facade.emit('error',new Error('Owned browser or runner failed'));}};
 const own=(child,role)=>{
  const o={child,role,closed:false,killed:false};owned.push(o);
  child.once('close',()=>{o.closed=true;if(role==='browser'&&!stopped&&!closingNormally)fail();});child.on('error',fail);
  for(const stream of ['stdout','stderr']){
   child[stream].on('data',b=>facade[stream].emit('data',b));
   child[stream].on('error',fail);
  }
  return o;
 };
 const terminate=()=>{
  if(termination)return termination;
  stopped=true;
  termination=(async()=>{
   for(const o of owned){if(exists(o)===true&&!o.killed){o.killed=true;try{process.kill(-o.child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')unexpected=true;}}}
   const end=performance.now()+LAUNCH_LIMITS.killMs;
   while((!clean()||!launchSettled)&&performance.now()<end)await pause(20);
   if(clean()&&launchSettled)finish(1);
   return clean()&&launchSettled&&!unexpected;
  })();return termination;
 };
 const start=async()=>{
  try{
   originalSpawn=cp.spawn;
   interceptor=(file,argv,options)=>{
    if(stopped||spawnCount!==0||file!==chrome||options?.detached!==true||options?.shell)throw new Error('Unexpected browser subprocess');
    spawnCount++;
    const child=originalSpawn(file,argv,options);own(child,'browser');return child;
   };
   cp.spawn=interceptor;
   const browserEnv={CI:'1',PATH:'/usr/bin:/bin'};for(const k of ['HOME','TMPDIR'])if(env[k])browserEnv[k]=env[k];
   try{server=await chromium.launchServer({channel:'chrome',headless:true,host:'127.0.0.1',timeout:LAUNCH_LIMITS.processMs,env:browserEnv});}
   finally{launchSettled=true;restore();}
   if(stopped){void server.close().catch(()=>{});return;}
   if(spawnCount!==1||server.process()!==owned[0]?.child)throw new Error('Browser ownership mismatch');
   const endpoint=server.wsEndpoint();
   if(!/^ws:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_-]+$/.test(endpoint))throw new Error('Loopback browser endpoint required');
   runner=cp.spawn(node,[playwright,...args],{cwd:root,env:{...env,U1_SUPERVISED_DARWIN:'owned-browser-v1',U1_DARWIN_BROWSER_WS_ENDPOINT:endpoint},shell:false,detached:true,stdio:['ignore','pipe','pipe']});
   own(runner,'runner');
   runner.once('close',async code=>{
    if(stopped)return;
    if(code!==0){fail();return;}
    try{
     closingNormally=true;await server.close();
     if(stopped)return;
     // Root and browser close do not prove their groups have drained. A
     // residual group is failure, never a successful cleanup exemption.
     if(!clean()){fail();return;}
     finish(0);
    }catch{fail();}
   });
  }catch{if(launchSettled)restore();fail();}
 };
 const supervisor=createProcessSupervisor({startOwned(){queueMicrotask(start);return facade;},terminateOwned:terminate,now:()=>performance.now(),setTimer:(f,ms)=>setTimeout(f,ms),clearTimer:id=>clearTimeout(id)});
 const result=await supervisor.run('run');
 if(termination)await termination;
 // If a library promise cannot settle within the existing bounds, retain its
 // stopped interceptor: a late spawn must still be rejected. This is an
 // inconclusive host requiring manual closeout, never permission to continue.
 if(launchSettled)restore();
 const cleanupConfirmed=clean()&&launchSettled&&!unexpected;
 return Object.freeze({result,childPid:runner?.pid??null,browserPid:owned.find(o=>o.role==='browser')?.child.pid??null,killInvoked:owned.some(o=>o.killed),killToolExitObserved:null,rootCleanupConfirmed:owned.find(o=>o.role==='runner')?.closed??false,groupCleanupConfirmed:cleanupConfirmed,spawnInterceptionReleased:launchSettled,cleanupFallbackUsed:false,manualCleanupRequired:!cleanupConfirmed,json:null,parseFailed:false});
}
