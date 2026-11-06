// Local Windows containment diagnostic ONLY. Staging execution is disabled.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createProcessSupervisor} from './u1-process-supervisor.mjs';
import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';
const ROOT=path.resolve(import.meta.dirname,'..');
const FIXTURE=path.join(ROOT,'scripts','u1-windows-containment.fixture.mjs');
const TASKKILL='C:\\Windows\\System32\\taskkill.exe';
const check=(v,m)=>{if(!v)throw new Error(m);};
const keys=(v,w)=>check(v&&Object.keys(v).sort().join(',')===[...w].sort().join(','),'Invalid diagnostic fields');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
async function hash(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
function canonical(file){check(path.isAbsolute(file)&&fs.realpathSync(file)===path.resolve(file)&&!fs.lstatSync(file).isSymbolicLink(),'Canonical local file required');return file;}
const write=(dir,name,obj)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(obj,null,2)+'\n',{flag:'wx',mode:0o600});
const env=()=>({SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows'});
export async function launchStagingOnce(){throw new Error('U1 Windows staging admission integration incomplete');}

function monitorKillTool(child,{setTimer=setTimeout,clearTimer=clearTimeout}={}){
 return new Promise(resolve=>{
  let done=false,failed=false,closed=false,bytes=0,deadline,exit;
  const finish=code=>{if(done)return;done=true;clearTimer(deadline);clearTimer(exit);child.stdout?.destroy();child.stderr?.destroy();child.unref();resolve({ok:!failed&&closed&&code===0,exitObserved:closed});};
  const stop=()=>{if(done||failed)return;failed=true;try{child.kill('SIGKILL');}catch{}exit=setTimer(()=>finish(null),LAUNCH_LIMITS.exitMs);};
  child.once('close',code=>{closed=true;finish(code);});child.once('error',stop);
  for(const stream of [child.stdout,child.stderr]){stream.on('data',b=>{bytes+=b.length;if(bytes>LAUNCH_LIMITS.outputBytes)stop();});stream.on('error',stop);}
  deadline=setTimer(stop,LAUNCH_LIMITS.killMs);
 });
}
// Pure fake-child lifecycle seam only; cannot select or spawn any executable.
export function observeKillToolForTests(child,timers){return monitorKillTool(child,timers);}

// No arbitrary executable/argument/environment API is exported. These exact
// source and binary pins must be independently reviewed before local invocation.
export async function runLocalContainmentProof(options){
 keys(options,['runId','confirmation','hashes']);
 check(process.platform==='win32','Windows diagnostic only');
 check(/^u1-windows-proof-[A-Za-z0-9_-]{6,50}$/.test(options.runId),'Fixed local diagnostic identity required');
 check(options.confirmation===`LOCAL CONTAINMENT ONLY ${options.runId}`,'Explicit local diagnostic confirmation required');
 keys(options.hashes,['node','taskkill','fixture','supervisor','module']);
 const files={node:canonical(process.execPath),taskkill:canonical(TASKKILL),fixture:canonical(FIXTURE),supervisor:canonical(path.join(ROOT,'scripts/u1-process-supervisor.mjs')),module:canonical(path.join(ROOT,'scripts/u1-windows-launcher.mjs'))};
 const verify=async()=>{for(const [role,file]of Object.entries(files))check(/^[a-f0-9]{64}$/.test(options.hashes[role]??'')&&await hash(file)===options.hashes[role],'Diagnostic source/tool drift');};
 await verify();
 const parent=path.join(ROOT,'test-artifacts','u1-windows-proof');canonical(parent);check(fs.statSync(parent).isDirectory(),'Pre-existing private proof root required');
 const dir=path.join(parent,options.runId);fs.mkdirSync(dir); // Exclusive, no reuse.
 const attempt={schema:'u1-local-windows-attempt-v1',runId:options.runId,mode:'local-containment-only',attempt:1,retry:0,hashes:options.hashes,limits:LAUNCH_LIMITS,startedAt:new Date().toISOString()};
 write(dir,'attempt.json',attempt);write(dir,'result.reservation.json',{schema:'u1-local-result-reservation-v1',runId:options.runId,file:'result.json'});
 const diagnosticStarted=performance.now();
 let root,sibling,rootClosed=false,siblingClosed=false,descendant=null,siblingReady=false,ipcInvalid=false,killInvoked=false,killOk=false,supervision=null,failure=null,siblingWasAlive=false,siblingCleaned=false,descendantGone=false,killToolExitObserved=false,terminationPromise=null,rootCleanupConfirmed=false,descendantCleanupConfirmed=false,cleanupFallbackUsed=false;
 const terminate=child=>{
  if(child!==root||killInvoked||rootClosed||!Number.isSafeInteger(child.pid)||child.pid<=0||child.pid===process.pid||child.exitCode!==null||child.signalCode!==null)return false;
  killInvoked=true;const pid=child.pid;
  terminationPromise=(async()=>{
  let taskResult=false;
  try{const killer=spawn(files.taskkill,['/PID',String(pid),'/T','/F'],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:env()});const outcome=await monitorKillTool(killer);taskResult=outcome.ok;killToolExitObserved=outcome.exitObserved;}catch{}
  const end=performance.now()+LAUNCH_LIMITS.exitMs;
  while(taskResult&&!rootClosed&&performance.now()<end)await pause(20);
  killOk=taskResult&&rootClosed;return killOk;
  })();return terminationPromise;
 };
 const start=mode=>spawn(files.node,[files.fixture,mode],{cwd:ROOT,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:env()});
 try{
  sibling=start('leaf');sibling.once('close',()=>{siblingClosed=true;});sibling.on('error',()=>{ipcInvalid=true;});
  sibling.on('message',m=>{if(siblingReady||!m||Object.keys(m).sort().join(',')!=='pid,schema'||m.schema!=='u1-local-leaf-v1'||m.pid!==sibling.pid){ipcInvalid=true;return;}siblingReady=true;});
  const readyEnd=performance.now()+LAUNCH_LIMITS.exitMs;
  while(!siblingReady&&!ipcInvalid&&!siblingClosed&&performance.now()<readyEnd)await pause(20);
  check(siblingReady&&!ipcInvalid&&!siblingClosed,'Local sibling readiness failed');
  const supervisor=createProcessSupervisor({startOwned(){root=start('overflow-tree');root.once('close',()=>{rootClosed=true;});root.on('message',m=>{if(descendant!==null||!m||Object.keys(m).sort().join(',')!=='pid,schema'||m.schema!=='u1-local-descendant-v1'||!Number.isSafeInteger(m.pid)||m.pid<=0||[process.pid,root.pid,sibling.pid].includes(m.pid)){ipcInvalid=true;return;}descendant=m.pid;});return root;},terminateOwned:terminate,now:()=>performance.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:id=>clearTimeout(id)});
  supervision=await supervisor.run('discovery');
  if(terminationPromise)await terminationPromise;
  if(descendant!==null){const end=performance.now()+LAUNCH_LIMITS.exitMs;while(alive(descendant)&&performance.now()<end)await pause(20);descendantGone=!alive(descendant);}
  siblingWasAlive=!siblingClosed&&alive(sibling.pid);
  check(!ipcInvalid&&descendant!==null&&descendantGone&&siblingWasAlive&&supervision.failure==='output-limit'&&supervision.terminationConfirmed&&killOk&&killToolExitObserved,'Local containment inconclusive');
  await verify();
 }catch{failure='local-containment-inconclusive';}
 finally{
  if(root&&!rootClosed&&!killInvoked)try{await terminate(root);}catch{}
  // Cleanup only, never another proof attempt or a promotion of failed proof.
  if(root&&!rootClosed){cleanupFallbackUsed=true;failure??='local-containment-inconclusive';try{root.kill('SIGKILL');}catch{}const end=performance.now()+LAUNCH_LIMITS.exitMs;while(!rootClosed&&performance.now()<end)await pause(20);}
  rootCleanupConfirmed=!root||rootClosed;
  if(descendant!==null&&alive(descendant)){
   cleanupFallbackUsed=true;failure??='local-containment-inconclusive';
   try{const cleaner=spawn(files.taskkill,['/PID',String(descendant),'/T','/F'],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:env()});await monitorKillTool(cleaner);}catch{}
   const end=performance.now()+LAUNCH_LIMITS.exitMs;while(alive(descendant)&&performance.now()<end)await pause(20);
  }
  descendantCleanupConfirmed=!root||(descendant!==null&&!alive(descendant));
  if(sibling){try{if(!siblingClosed)sibling.kill('SIGKILL');}catch{}const end=performance.now()+LAUNCH_LIMITS.exitMs;while(!siblingClosed&&performance.now()<end)await pause(20);siblingCleaned=siblingClosed;for(const stream of [sibling.stdout,sibling.stderr])try{stream?.destroy();}catch{}try{if(sibling.connected)sibling.disconnect();sibling.unref();}catch{failure='local-cleanup-unconfirmed';}}
  try{if(root?.connected)root.disconnect();}catch{}
 }
 if(!siblingCleaned||!rootCleanupConfirmed||!descendantCleanupConfirmed)failure='manual-cleanup-required';
 const diagnosticElapsedMs=performance.now()-diagnosticStarted;
 if(diagnosticElapsedMs>=30000)failure??='fixture-self-expiry-window';
 const result={schema:'u1-local-windows-result-v1',runId:options.runId,status:failure?'inconclusive':'local-containment-demonstrated',stagingAdmission:false,failure,attemptSha256:await hash(path.join(dir,'attempt.json')),supervision,rootPid:root?.pid??null,descendantPid:descendant,siblingPid:sibling?.pid??null,descendantGone,siblingWasAlive,siblingCleaned,killInvoked,killOk,killToolExitObserved,rootCleanupConfirmed,descendantCleanupConfirmed,cleanupFallbackUsed,diagnosticElapsedMs,fixtureSelfExpiryMs:60000};
 write(dir,'result.json',result);return Object.freeze(result);
}
