// Fixed supervised U1 command. No provisioning, deployment, cleanup or restoration.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateLaunchAuthority,AUTHORITY_SOURCES} from './u1-launch-authority.mjs';
import {loadBrowserPackage} from './u1-browser-database-adapter.mjs';
import {prepareDraft} from './u1-package-builder.mjs';
import {canonicalHash} from './u1-data-reconciler.mjs';
import {createProcessSupervisor} from './u1-process-supervisor.mjs';
import {LAUNCH_LIMITS,validateDiscoveryReport} from './u1-guarded-launcher.mjs';
import {verifySupervisedEvidence} from './u1-supervised-evidence.mjs';
const ROOT=path.resolve(import.meta.dirname,'..');
const CHROME_RESOLVER=path.resolve(ROOT,'../../../node_modules/playwright-core/lib/server/registry/index.js');
const CHROME_RESOLVER_SHA='d4fdd6202217b64831787326948c06f541496d0add5c5fa5f75b5a72c3553067';
const FIXED=Object.freeze({node:process.execPath,git:'C:\\Program Files\\Git\\cmd\\git.exe',playwright:path.resolve(ROOT,'../../../node_modules/@playwright/test/cli.js'),taskkill:'C:\\Windows\\System32\\taskkill.exe'});
export const COMMAND_SOURCES=Object.freeze(['scripts/u1-supervised-launcher.mjs','scripts/u1-supervised-launcher.nodechecks.mjs']);
export const COMMAND_ARGS=Object.freeze(['test','--config=playwright.u1.config.ts','--project=u1-baseline','--workers=1','--retries=0','--repeat-each=1','--max-failures=1']);
const check=(v,m)=>{if(!v)throw new Error(m);};
const exact=(v,ks)=>check(v&&Object.keys(v).sort().join(',')===[...ks].sort().join(','),'Unexpected supervised command fields');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function digest(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
function canonical(file,directory=false){check(typeof file==='string'&&path.isAbsolute(file)&&!file.startsWith('\\\\')&&fs.realpathSync(file)===path.resolve(file),'Canonical local path required');const s=fs.lstatSync(file);check(!s.isSymbolicLink()&&(directory?s.isDirectory():s.isFile()),'Regular local path required');return path.resolve(file);}
function capture(root,ref){exact(ref,['file','sha256']);check(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(ref.file)&&!/(credential|password|secret|backup|\.env)/i.test(ref.file)&&/^[a-f0-9]{64}$/.test(ref.sha256),'Unsafe authority reference');const file=canonical(path.join(root,ref.file));check(fs.statSync(file).size<=32*1024*1024,'Authority capture bound');const b=fs.readFileSync(file);check(sha(b)===ref.sha256,'Authority capture drift');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}
function environment(){const env={SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',CI:'1',PATH:'C:\\Windows\\System32',PROGRAMFILES:'C:\\Program Files','PROGRAMFILES(X86)':'C:\\Program Files (x86)',HOMEDRIVE:'C:'};for(const k of ['USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];return env;}
// Exact Windows chrome-channel search order in the pinned Playwright registry.
// Resolve against the SAME allowlisted environment passed to the fixed child.
function chromeChannelPath(){const e=environment();for(const prefix of [e.LOCALAPPDATA,e.PROGRAMFILES,e['PROGRAMFILES(X86)'],e.HOMEDRIVE+'\\Program Files',e.HOMEDRIVE+'\\Program Files (x86)'].filter(Boolean)){const p=path.join(prefix,'\\Google\\Chrome\\Application\\chrome.exe');try{fs.accessSync(p);return canonical(p);}catch{}}throw new Error('Fixed Chrome channel unavailable');}
function git(tool,args){return new Promise((resolve,reject)=>execFile(tool,['-c',`safe.directory=${ROOT}`,...args],{cwd:ROOT,env:environment(),windowsHide:true,shell:false,timeout:10000,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout)=>error?reject(new Error('Fixed source check failed')):resolve(stdout.trim())));}
function write(dir,name,obj){const text=JSON.stringify(obj)+'\n';check(Buffer.byteLength(text)<=1024*1024,'Compact command result bound');const fd=fs.openSync(path.join(dir,name),'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return{file:name,sha256:sha(text)};}

async function admission(options,at){
 const root=canonical(options.artifactRoot,true);
 const authority=validateLaunchAuthority({artifactRoot:root,core:options.core,approvals:options.approvals,now:at});
 const core=capture(root,options.core),tools={};
 for(const role of ['node','git','playwright','psql','taskkill','tls']){
  const d=capture(root,core.tools[role]);exact(d,['schema','role','path','sha256','version','capturedAt']);
  check(d.schema==='u1-tool-descriptor-v1'&&d.role===role&&typeof d.version==='string'&&d.version.length>0&&d.version.length<=120&&/^[a-f0-9]{64}$/.test(d.sha256),'Invalid pinned tool descriptor');
  check(Number.isFinite(Date.parse(d.capturedAt))&&Date.parse(d.capturedAt)<=at,'Future or missing tool capture');
  const file=canonical(d.path);if(FIXED[role])check(file===canonical(FIXED[role]),'Wrong fixed executable');
  if(role==='psql')check(path.basename(file).toLowerCase()==='psql.exe','Wrong PostgreSQL executable');
  if(role==='tls')check(/\.(?:pem|crt|cer)$/i.test(file),'Wrong certificate type');
  check(await digest(file)===d.sha256,'Tool bytes changed');tools[role]=d;
 }
 check(await git(tools.git.path,['rev-parse','HEAD'])===core.harnessCommit&&await git(tools.git.path,['status','--porcelain','--untracked-files=normal'])==='','Exact clean harness commit required');
 for(const name of AUTHORITY_SOURCES)check(await digest(canonical(path.join(ROOT,name)))===core.sources[name].sha256,'Executed source differs from approved capture');
 check(await digest(path.join(ROOT,'playwright.u1.config.ts'))===core.config.sha256&&await digest(path.join(ROOT,'tests/e2e/u1/ui-read-speed-baseline-50-reload-pairs.e2e.ts'))===core.spec.sha256,'Config/spec capture mismatch');
 check(/^u1-[A-Za-z0-9_-]+\.json$/.test(core.package.file),'Fixed U1 package filename required');
 capture(root,core.package);const packageFile=path.join(root,core.package.file),pkg=loadBrowserPackage(packageFile,core.package.sha256);
 check(pkg.evidenceMode==='u1-supervised-numbered-v1'&&pkg.manifest.runId===core.runId,'Supervised package required');
 exact(pkg.supervisedCommandSourceHashes,COMMAND_SOURCES);
 for(const name of COMMAND_SOURCES)check(await digest(path.join(ROOT,name))===pkg.supervisedCommandSourceHashes[name],'Fixed command source drift');
 check(pkg.readTool?.path===tools.psql.path&&pkg.readTool.sha256===tools.psql.sha256,'Package read tool mismatch');
 const chrome=pkg.supervisedChrome;exact(chrome,['schema','channel','path','sha256','version','resolverSha256']);
 check(chrome.schema==='u1-supervised-chrome-v1'&&chrome.channel==='chrome'&&/^\d+\.\d+\.\d+\.\d+$/.test(chrome.version)&&/^[a-f0-9]{64}$/.test(chrome.sha256),'Invalid Chrome descriptor');
 check(chrome.resolverSha256===CHROME_RESOLVER_SHA&&await digest(canonical(CHROME_RESOLVER))===CHROME_RESOLVER_SHA,'Chrome resolver drift');
 check(canonical(chrome.path)===chromeChannelPath()&&await digest(chrome.path)===chrome.sha256,'Chrome channel executable drift');tools.chrome=chrome;
 const pre=capture(root,core.preflight);check(core.preflight.sha256===pkg.manifest.preflight.sha256,'Wrong fresh preflight capture');
 const draft=prepareDraft({runId:core.runId,applicationCommit:pkg.manifest.applicationCommit,harnessCommit:pkg.manifest.harnessCommit,baseURL:core.target,preflightFile:path.join(root,core.preflight.file),preflightSha256:core.preflight.sha256,now:at,actors:pkg.manifest.actors,stationIds:[pkg.pairs[0].stationIdA,pkg.pairs[0].stationIdB]});
 check(draft.inputManifest.initialAppStateHash===pkg.manifest.initialAppStateHash&&draft.inputManifest.initialProtectedHash===pkg.initialProtectedHash&&canonicalHash(pre.appState)===pkg.manifest.initialAppStateHash,'Fresh preimage mismatch');
 return{authority,core,pkg,tools,packageFile};
}

// Fixed OS adapter. All command choices originate in this module, not options.
async function processOnce(a,args,env,mode,captureJson){
 let child,closed=false,killInvoked=false,killToolClosed=false,termination=null;const chunks=[];let captured=0;
 const terminate=owned=>{
  if(owned!==child||killInvoked||closed||!Number.isSafeInteger(child.pid)||child.pid<=0||child.pid===process.pid||child.exitCode!==null||child.signalCode!==null)return false;
  killInvoked=true;
  termination=new Promise(resolve=>{
   let killer,done=false,failed=false,bytes=0,timer,exitTimer;
   const finish=ok=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(exitTimer);killer?.stdout?.destroy();killer?.stderr?.destroy();killer?.unref();resolve(ok&&closed&&killToolClosed);};
   const stop=()=>{if(done||failed)return;failed=true;try{killer?.kill('SIGKILL');}catch{}exitTimer=setTimeout(()=>finish(false),LAUNCH_LIMITS.exitMs);};
   try{killer=spawn(a.tools.taskkill.path,['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:environment()});
    timer=setTimeout(stop,LAUNCH_LIMITS.killMs);for(const s of [killer.stdout,killer.stderr]){s.on('data',b=>{bytes+=b.length;if(bytes>LAUNCH_LIMITS.outputBytes)stop();});s.on('error',stop);}
    killer.once('error',stop);killer.once('close',code=>{killToolClosed=true;if(failed||code!==0)return finish(false);if(closed)return finish(true);child.once('close',()=>finish(true));exitTimer=setTimeout(()=>finish(false),LAUNCH_LIMITS.exitMs);});
   }catch{finish(false);}
  });return termination;
 };
 const supervisor=createProcessSupervisor({startOwned(){child=spawn(a.tools.node.path,[a.tools.playwright.path,...args],{cwd:ROOT,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env});child.once('close',()=>{closed=true;});if(captureJson)child.stdout.on('data',b=>{captured+=b.length;if(captured<=LAUNCH_LIMITS.outputBytes)chunks.push(Buffer.from(b));});return child;},terminateOwned:terminate,now:()=>performance.now(),setTimer:(f,m)=>setTimeout(f,m),clearTimer:id=>clearTimeout(id)});
 const result=await supervisor.run(mode);if(termination)await termination;
 let cleanupFallbackUsed=false;
 if(child&&!closed){cleanupFallbackUsed=true;try{child.kill('SIGKILL');}catch{}const until=performance.now()+LAUNCH_LIMITS.exitMs;while(!closed&&performance.now()<until)await new Promise(r=>setTimeout(r,20));}
 let json=null,parseFailed=false;
 if(!result.failure&&captureJson)try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{parseFailed=true;}
 return{result,childPid:child?.pid??null,killInvoked,killToolExitObserved:killToolClosed,rootCleanupConfirmed:!child||closed,cleanupFallbackUsed,
   manualCleanupRequired:!closed||Boolean(killInvoked&&!result.terminationConfirmed),json,parseFailed};
}

export async function runSupervisedOnce(options){
 exact(options,['artifactRoot','core','approvals','confirmation','credentials']);check(process.platform==='win32','Windows supervised command only');
 exact(options.credentials,['U1_USER_A','U1_PASSWORD_A','U1_USER_B','U1_PASSWORD_B','U1_STAGING_DB_USER','U1_STAGING_DB_PASSWORD']);check(Object.values(options.credentials).every(v=>typeof v==='string'&&v.length>0),'Explicit credentials required');
 const admittedAt=Date.now(),a=await admission(options,admittedAt);
 check(options.confirmation===`RUN U1 SUPERVISED ONCE ${a.core.runId}`,'Exact supervised confirmation required');
 const parent=canonical(path.join(ROOT,'test-artifacts/u1-supervised-run'),true),dir=path.join(parent,a.core.runId);
 const evidence=path.join(ROOT,'test-artifacts/u1-evidence',a.core.runId),output=path.join(ROOT,'test-artifacts/u1-playwright',a.core.runId);
 check(!fs.existsSync(evidence)&&!fs.existsSync(output),'Existing run evidence forbids replay');fs.mkdirSync(dir);
 const discoveryArgs=Object.freeze([...COMMAND_ARGS,'--list','--reporter=json']),runArgs=Object.freeze([...COMMAND_ARGS,'--reporter=line',`--output=${output}`]);
 const binding={runId:a.core.runId,executedHarnessCommit:a.core.harnessCommit,packageHarnessBaseline:a.pkg.manifest.harnessCommit,coreHash:a.authority.coreHash,packageSha256:a.core.package.sha256,commandHash:canonicalHash(COMMAND_ARGS),discoveryCommandHash:canonicalHash([a.tools.node.path,a.tools.playwright.path,...discoveryArgs]),runCommandHash:canonicalHash([a.tools.node.path,a.tools.playwright.path,...runArgs]),sourceHash:canonicalHash(a.pkg.supervisedSourceHashes),commandSourceHash:canonicalHash(a.pkg.supervisedCommandSourceHashes),toolHash:canonicalHash(a.tools),attempt:1,retry:0};
 const reservation=write(dir,'reservation.json',{schema:'u1-supervised-reservation-v1',...binding,authorityValidatedAt:admittedAt,startedAt:new Date(admittedAt).toISOString()});
 let status='failed-closeout-required',failure=null,attempt=null,discovery=null,discoverySupervision=null,child=null,reconciliation=null;
 try{
  const list=await processOnce(a,discoveryArgs,environment(),'discovery',true);
  const {json:ignoredList,...listMetadata}=list;discoverySupervision=write(dir,'discovery-supervision.json',listMetadata);
  if(list.manualCleanupRequired)status='inconclusive';
  check(list.result.status==='process-completed'&&!list.parseFailed&&!list.manualCleanupRequired,'Discovery process failed');
  discovery=write(dir,'discovery.json',validateDiscoveryReport(list.json));
  const freshAt=Date.now(),fresh=await admission(options,freshAt);check(fresh.authority.coreHash===a.authority.coreHash,'Admission changed');
  attempt=write(dir,'attempt.json',{schema:'u1-supervised-attempt-v1',...binding,reservation,discovery,discoverySupervision,authorityValidatedAt:freshAt,startedAt:new Date(freshAt).toISOString()});
  const env={...environment(),...options.credentials,U1_PACKAGE_FILE:a.packageFile,U1_APPROVED_PACKAGE_SHA256:a.core.package.sha256,U1_STAGING_SSL_ROOT_CERT:a.tools.tls.path};
  const executed=await processOnce(a,runArgs,env,'run',false);const {json:ignoredExecution,...executionMetadata}=executed;child=executionMetadata;
  if(child.result.status!=='process-completed'||child.manualCleanupRequired){status=child.manualCleanupRequired?'inconclusive':'failed-closeout-required';throw new Error('Run incomplete');}
  await admission(options,freshAt); // Historical byte recheck, not a live-age waiver.
  const index=canonical(path.join(evidence,'supervised-index.json')),report=verifySupervisedEvidence(index,await digest(index));
  reconciliation=write(dir,'reconciliation.json',report);await admission(options,freshAt);
  status='pending-manual-closeout';
 }catch{failure='supervised-execution-or-evidence-rejected';}
 const result={schema:'u1-supervised-execution-v1',...binding,status,failure,reservation,attempt,discovery,discoverySupervision,child,reconciliation,productionAuthorized:false,manualCloseoutRequired:['read-only-data-postflight','outcome-reconciled-exact-owned-id-cleanup','qa-role-retirement','credential-removal','provider-restoration','served-assets-restoration','independent-review']};
 write(dir,'result.json',result);return Object.freeze(result);
}
