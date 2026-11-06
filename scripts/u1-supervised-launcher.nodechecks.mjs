import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildCommandPlan} from './u1-command-plan.mjs';
import {prepareDraft,draftIdentityPlan,APPLICATION_COMMIT,HARNESS_BASE_COMMIT} from './u1-package-builder.mjs';
import {PROTECTED_TABLES} from './u1-protected-reader.mjs';
import {canonicalHash,patchArrayById} from './u1-data-reconciler.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(fn,large=false,setup={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u1-command-')));
 try{
 const save=(name,obj)=>{const file=path.join(dir,name),bytes=JSON.stringify(obj);fs.writeFileSync(file,bytes);return {file,sha256:sha(bytes)};};
 const runId='u1-launch-command-offline',actors={A:{id:'00000000-0000-4000-8000-000000000001',role:'admin',active:true,organization:'org-primary'},B:{id:'00000000-0000-4000-8000-000000000002',role:'manager',active:true,organization:'org-primary'}};
 const e={schema:'u1-package-preflight-v1',runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,project:'tkbdyzxwwbhkpztgjjxh',organization:'org-primary',systemIdentifier:'7623125441096521075',identityNonce:'f9bc0aed-b6c4-410f-ba2a-572522d03869',readOnly:true,capturedAt:'2026-11-04T12:00:00Z',scope:draftIdentityPlan(runId).scope,actors,stations:['station-a','station-b'].map(id=>({id,organization_id:'org-primary',active:true,mode:'timed'})),floor:{openSessions:0,openTabs:0,unbilledHops:0,incompleteOperationalMutations:0,incompleteFinancialMutations:0,customerNameCollisions:0},collisions:{sessionIds:0,customerIds:0,customerNames:0,mutationIds:0,auditIds:0},appState:{id:'primary',version:735,updated_by:null,updated_at:'2026-11-04T11:00:00Z',data:{sessions:[{id:'unrelated',nested:{preserve:true}}],auditLogs:[{id:'old-audit'}],unrelated:{blob:large?'x'.repeat(1024*1024):'retained'}}},protectedRows:{...Object.fromEntries(PROTECTED_TABLES.map(t=>[t,[]])),_unowned:Object.fromEntries(PROTECTED_TABLES.map(t=>[t,{count:0,md5:'d41d8cd98f00b204e9800998ecf8427e'}]))}};
 setup.preflight?.(e);
 const pre=save('pre.json',e),draft=prepareDraft({runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,baseURL:'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev',preflightFile:pre.file,preflightSha256:pre.sha256,now:Date.parse(e.capturedAt),actors,stationIds:['station-a','station-b']}),d=save('draft.json',draft);
 const authority={schema:'u1-approved-station-pricing-v1',runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,preflightSha256:pre.sha256,stations:e.stations.map(s=>({...s,name:`Name ${s.id}`,ltpEnabled:false,pricingSnapshot:[{id:`price-${s.id}`,stationId:s.id,label:'Standard',startMinute:0,endMinute:1440,hourlyRate:120}]}))},a=save('authority.json',authority);
 const input={schema:'u1-command-inputs-v1',runId,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,preflightSha256:pre.sha256,draftSha256:d.sha256,initialAppState:e.appState,initialProtectedRows:e.protectedRows,stationAuthority:{path:a.file,sha256:a.sha256},clock:{earliest:'2026-11-04T12:00:00Z',latest:'2026-11-04T12:15:00Z'},timings:Array.from({length:50},(_,index)=>({index,startA:'2026-11-04T12:00:00.000001Z',startB:'2026-11-04T12:00:00.000002Z',saveB:'2026-11-04T12:00:00.000003Z',endA:'2026-11-04T12:00:00.000004Z',endB:'2026-11-04T12:00:00.000005Z'})),closeReason:'U1 approved test'};
 setup.inputs?.(input);
 const build=()=>{const x=save('inputs.json',input);return buildCommandPlan({draftFile:d.file,draftSha256:d.sha256,inputsFile:x.file,inputsSha256:x.sha256});};
 await fn({dir,build,input,draft,authority,save,d,a});
 }finally{assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
}
import {fileURLToPath} from 'node:url';
import {buildResultExpectations,protectedTemplateAt,materializeResultAt,postgresUtcTimestamp} from './u1-result-expectations.mjs';
import {compareInstalledPhase,prepareInstalledPhase} from './u1-phase-expectations.mjs';
import {bindGeneratedPhase} from './u1-generated-fields.mjs';
const catalogFile=fileURLToPath(new URL('../../../evidence/u1-catalog-20261103-1615/catalog.csv',import.meta.url));
const helperCatalogFile=fileURLToPath(new URL('../../../evidence/u1-helper-catalog-20261103/catalog.csv',import.meta.url));
async function oracleFixture(fn,setup={}){return fixture(async f=>{
 const plan=f.build(),inp=f.save('inputs.json',f.input);
 const authority={schema:'u1-actor-display-authority-v1',runId:f.input.runId,applicationCommit:f.input.applicationCommit,harnessCommit:f.input.harnessCommit,preflightSha256:f.input.preflightSha256,planHash:plan.planHash,actors:Object.fromEntries(['A','B'].map(s=>[s,{id:f.draft.inputManifest.actors[s].id,name:s==='A'?'Actor A':'Actor B',username:s==='A'?'qa_a':'qa_b',profileRole:f.draft.inputManifest.actors[s].role,membershipRole:f.draft.inputManifest.actors[s].role,resolvedRole:f.draft.inputManifest.actors[s].role}]))};
 const a=f.save('actors.json',authority),options={commandInputs:{draftFile:f.d.file,draftSha256:f.d.sha256,inputsFile:inp.file,inputsSha256:inp.sha256},actorAuthorityFile:a.file,actorAuthoritySha256:a.sha256,catalogFile,helperCatalogFile};
 await fn({...f,plan,authority,options,oracle:buildResultExpectations(options)});
 },false,setup);}
import {prepareRuntimeExpectations,runtimePackageFields} from './u1-runtime-expectations.mjs';
import {U1BrowserDatabaseAdapter,REQUIRED_PROOF_CHECKS,loadBrowserPackage,packagePhaseExpectation,packageFinalExpectation,packagePairExpectations} from './u1-browser-database-adapter.mjs';
import {materializeProtected} from './u1-generated-fields.mjs';
import {analyticsBusinessDate} from './u1-installed-contract.mjs';
import {main as reconcileMain,verifyEvidenceFiles} from './reconcile-u1-evidence.mjs';
import {runBaselinePairs,U1_IDENTITY,U1_LIMITS} from './u1-playwright-runner.mjs';
import {verifyRunCloseout,CLOSEOUT_FLOORS,CLOSEOUT_RESIDUES} from './u1-closeout-verifier.mjs';
import {AUTHORITY_SOURCES,AUTHORITY_TARGET} from './u1-launch-authority.mjs';
import {LAUNCH_LIMITS} from './u1-guarded-launcher.mjs';
import {SUPERVISED_LIMITS,SUPERVISED_SOURCES,verifySupervisedEvidence} from './u1-supervised-evidence.mjs';
// ALL receipts/requests below are synthetic unit fixtures, never staging admission.
function admitted(f,mutate=()=>{}){
 const provider=prepareRuntimeExpectations(f.options),fields=runtimePackageFields(provider);
 const pkg={...structuredClone(fields),schema:'u1-browser-package-v1',generatedFieldPolicy:'u1-correlated-v1',protectedTables:PROTECTED_TABLES,proofs:{},proofFiles:{},assets:{'/assets/offline.js':'a'.repeat(64)},closeoutPolicy:{schema:'u1-closeout-policy-v1',credentialFiles:['credentials.json']}};
 mutate(pkg);
 for(const proof of ['catalog','rollback','source','build','reviewer','tester']){
  const receipt={runId:pkg.manifest.runId,project:pkg.manifest.project,manifestHash:canonicalHash(pkg.manifest),...(['reviewer','tester'].includes(proof)?{decision:'approved',scope:'u1-staging-run'}:{schema:'u1-'+proof+'-receipt-v1',status:'passed',applicationCommit:pkg.manifest.applicationCommit,organization:'org-primary',checks:REQUIRED_PROOF_CHECKS[proof].map((name,i)=>{const e=f.save(proof+'-'+i+'.json',{syntheticOffline:true,name});return{name,status:'passed',evidenceFile:path.basename(e.file),evidenceSha256:e.sha256};})})};
  const saved=f.save(proof+'.json',receipt);pkg.proofs[proof]=saved.sha256;pkg.proofFiles[proof]=path.basename(saved.file);
 }
 const saved=f.save('admitted.json',pkg);return {...saved,pkg,provider,fields};
}

import cp from 'node:child_process';
// Controlled builtin mocks below never execute the pinned binaries or staging.
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {runSupervisedOnce,COMMAND_SOURCES,COMMAND_ARGS} from './u1-supervised-launcher.mjs';
const ROOT=path.resolve(import.meta.dirname,'..');
const HASH_FILE=file=>sha(fs.readFileSync(file));
const NOW=Date.parse('2026-11-04T12:01:00Z');

test('actual entry preserves inconclusive taskkill failures and performs bounded exact-root fallback',async()=>oracleFixture(async f=>{
 const setup=launchAuthority(f),runRoot=path.join(ROOT,'test-artifacts/u1-supervised-run'),runDir=path.join(runRoot,f.input.runId);
 const original={spawn:cp.spawn,execFile:cp.execFile,now:Date.now,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
 assert.equal(fs.existsSync(runDir),false);fs.mkdirSync(runRoot,{recursive:true});
 try{
  Date.now=()=>NOW;
  globalThis.setTimeout=(fn,ms)=>{if([3000,5000,8000].includes(ms)){const h={fake:true,cancelled:false};queueMicrotask(()=>{if(!h.cancelled)fn();});return h;}return original.setTimeout(fn,ms);};
  globalThis.clearTimeout=h=>{if(h?.fake)h.cancelled=true;else original.clearTimeout(h);};
  cp.execFile=(file,args,opts,cb)=>queueMicrotask(()=>cb(null,args.includes('rev-parse')?'a'.repeat(40):''));
  for(const mode of ['kill-spawn','kill-error','kill-no-close']){
   let calls=0,rootKills=0,toolCalls=0;
   cp.spawn=(file,args,opts)=>{
    const tool=file===setup.paths.taskkill;
    if(tool){toolCalls++;assert.deepEqual(args,['/PID','42002','/T','/F']);assert.equal(opts.shell,false);if(mode==='kill-spawn')throw new Error('synthetic-private');}
    else {assert.equal(file,setup.paths.node);calls++;}
    const child=new EventEmitter();child.pid=tool?43000:42000+calls;child.exitCode=null;child.signalCode=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.destroy=()=>{};child.stderr.destroy=()=>{};child.unref=()=>{};
    child.kill=signal=>{assert.equal(signal,'SIGKILL');if(!tool){rootKills++;child.exitCode=1;child.emit('close',1);}else if(mode==='kill-error')queueMicrotask(()=>child.emit('close',1));return true;};
    queueMicrotask(()=>{if(tool){if(mode==='kill-error')child.emit('error',new Error('synthetic-private'));return;}if(args.includes('--list')){child.stdout.emit('data',Buffer.from(JSON.stringify({suites:[{specs:[{file:U1_IDENTITY.file,title:U1_IDENTITY.title,tests:[{projectName:U1_IDENTITY.project}]}]}],errors:[]})));child.exitCode=0;child.emit('close',0);}else child.emit('error',new Error('synthetic-private'));});
    return child;
   };
   syncBuiltinESMExports();
   const result=await runSupervisedOnce(setup.options());
   assert.equal(result.status,'inconclusive');assert.equal(result.child.rootCleanupConfirmed,true);assert.equal(result.child.cleanupFallbackUsed,true);assert.equal(result.child.manualCleanupRequired,true);assert.equal(rootKills,1);assert.equal(toolCalls,1);assert.equal(calls,2);assert.equal(JSON.stringify(result).includes('synthetic-private'),false);
   assert.ok(runDir.startsWith(runRoot+path.sep));fs.rmSync(runDir,{recursive:true,force:true});
  }
 }finally{cp.spawn=original.spawn;cp.execFile=original.execFile;Date.now=original.now;globalThis.setTimeout=original.setTimeout;globalThis.clearTimeout=original.clearTimeout;syncBuiltinESMExports();if(fs.existsSync(runDir)){assert.ok(runDir.startsWith(runRoot+path.sep));fs.rmSync(runDir,{recursive:true,force:true});}}
}));

function launchAuthority(f){
 const node=fs.realpathSync(process.execPath),git='C:\\Program Files\\Git\\cmd\\git.exe',taskkill='C:\\Windows\\System32\\taskkill.exe',playwright=fs.realpathSync(path.resolve(ROOT,'../../../node_modules/@playwright/test/cli.js'));
 fs.writeFileSync(path.join(f.dir,'psql.exe'),'SYNTHETIC NEVER EXECUTE');
 fs.writeFileSync(path.join(f.dir,'root.pem'),'SYNTHETIC CERTIFICATE');
 const paths={node,git,taskkill,playwright,psql:path.join(f.dir,'psql.exe'),tls:path.join(f.dir,'root.pem')};
 const prepared=admitted(f,p=>{
  p.evidenceMode='u1-supervised-numbered-v1';p.supervisedLimits=SUPERVISED_LIMITS;
  p.supervisedSourceHashes=Object.fromEntries(SUPERVISED_SOURCES.map(n=>[n,HASH_FILE(path.join(ROOT,n))]));
  p.supervisedCommandSourceHashes=Object.fromEntries(COMMAND_SOURCES.map(n=>[n,HASH_FILE(path.join(ROOT,n))]));
  p.readTool={path:paths.psql,sha256:HASH_FILE(paths.psql)};
  const chrome=fs.realpathSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  p.supervisedChrome={schema:'u1-supervised-chrome-v1',channel:'chrome',path:chrome,sha256:HASH_FILE(chrome),version:'1.2.3.4',resolverSha256:HASH_FILE(path.resolve(ROOT,'../../../node_modules/playwright-core/lib/server/registry/index.js'))};
 });
 const save=(name,value)=>{const p=f.save(name,value);return{file:path.basename(p.file),sha256:p.sha256};};
 const saveBytes=(name,bytes)=>{fs.writeFileSync(path.join(f.dir,name),bytes);return{file:name,sha256:sha(bytes)};};
 const packageRef=saveBytes('u1-supervised-package.json',fs.readFileSync(prepared.file));
 const pre=saveBytes('launch-preflight.json',fs.readFileSync(f.draft.inputManifest.preflight.path));
 const config=saveBytes('launch-config.txt',fs.readFileSync(path.join(ROOT,'playwright.u1.config.ts'))),spec=saveBytes('launch-spec.txt',fs.readFileSync(path.join(ROOT,'tests/e2e/u1/ui-read-speed-baseline-50-reload-pairs.e2e.ts')));
 const sources=Object.fromEntries(AUTHORITY_SOURCES.map((n,i)=>[n,saveBytes('source-'+i+'.txt',fs.readFileSync(path.join(ROOT,n)))]));
 const tools=Object.fromEntries(Object.entries(paths).map(([role,p])=>[role,save('tool-'+role+'.json',{schema:'u1-tool-descriptor-v1',role,path:p,sha256:HASH_FILE(p),version:'synthetic-bound-bytes',capturedAt:'2026-11-04T12:00:00.000Z'})]));
 const runId=f.input.runId,identity={runId,...AUTHORITY_TARGET},versionId='00000000-0000-4000-8000-000000000101',deploymentId='00000000-0000-4000-8000-000000000102',sourceCommit='0'.repeat(40);
 const flags=save('baseline-flags.json',{synthetic:true}),bc=save('baseline-config.json',{synthetic:true}),index=saveBytes('baseline-index.html',Buffer.from('<script src="/assets/offline.js"></script>')),asset=saveBytes('baseline-app.js',Buffer.from('synthetic-offline'));
 const baseline=save('baseline.json',{schema:'u1-baseline-descriptor-v1',...identity,capturedAt:'2026-11-04T12:00:00.000Z',sourceCommit,deploymentId,versionId,trafficPercent:100,flags,config:bc,index:{path:'/',status:200,redirects:[],body:index},assets:[{path:'/assets/offline.js',status:200,redirects:[],body:asset}],evidence:{
 provider:save('baseline-provider.json',{schema:'u1-baseline-provider-v1',...identity,deploymentId,versionId,trafficPercent:100,sourceCommit,indexSha256:index.sha256,configSha256:bc.sha256,flagsSha256:flags.sha256}),
 config:save('baseline-config-capture.json',{synthetic:true}),assets:save('baseline-assets.json',{schema:'u1-baseline-assets-v1',runId,versionId,indexSha256:index.sha256,assets:[{path:'/assets/offline.js',sha256:asset.sha256}]}),protectedParity:save('baseline-protected.json',{synthetic:true}),restoreProof:save('baseline-restore.json',{synthetic:true})}});
 const core={schema:'u1-launch-core-v1',...identity,applicationCommit:APPLICATION_COMMIT,harnessCommit:'a'.repeat(40),createdAt:'2026-11-04T12:00:00.000Z',limits:U1_LIMITS,processLimits:LAUNCH_LIMITS,discovery:U1_IDENTITY,sources,tools,package:packageRef,preflight:pre,baseline,config,spec};
 const options=()=>({artifactRoot:f.dir,core:save('launch-core.json',core),approvals:Object.fromEntries(['reviewer','tester'].map(role=>[role,save('launch-'+role+'.json',{schema:'u1-launch-approval-v1',role,reviewedBy:role+'-offline',scope:'u1-launch-core',decision:'approved',runId,coreHash:canonicalHash(core),approvedAt:'2026-11-04T12:00:00.000Z'})])),confirmation:'RUN U1 SUPERVISED ONCE '+runId,credentials:{U1_USER_A:'fake-a',U1_PASSWORD_A:'fake-secret-a',U1_USER_B:'fake-b',U1_PASSWORD_B:'fake-secret-b',U1_STAGING_DB_USER:'fake-db-user',U1_STAGING_DB_PASSWORD:'fake-db-secret'}});
 return{options,core,paths};
}
test('fixed entry rejects arbitrary API fields before any process',async()=>{
 await assert.rejects(runSupervisedOnce({command:'arbitrary'}),/Unexpected supervised/);
 assert.deepEqual(COMMAND_ARGS,['test','--config=playwright.u1.config.ts','--project=u1-baseline','--workers=1','--retries=0','--repeat-each=1','--max-failures=1']);
});
test('actual exported entry binds fixed subprocesses; Chrome drift, nonzero and code0 without evidence cannot pass',async()=>oracleFixture(async f=>{
 const setup=launchAuthority(f),calls=[],original={spawn:cp.spawn,execFile:cp.execFile,now:Date.now};
 const runRoot=path.join(ROOT,'test-artifacts/u1-supervised-run'),runDir=path.join(runRoot,f.input.runId);
 assert.equal(fs.existsSync(runDir),false,'prior test evidence must not be overwritten');
 fs.mkdirSync(runRoot,{recursive:true});
 let runCode=1;
 try{
 Date.now=()=>NOW;
 cp.execFile=(file,args,opts,callback)=>{assert.equal(file,setup.paths.git);assert.equal(opts.timeout,10000);assert.equal(opts.shell,false);queueMicrotask(()=>callback(null,args.includes('rev-parse')?'a'.repeat(40):''));};
 cp.spawn=(file,args,opts)=>{
  assert.equal(file,setup.paths.node,'Only mocked fixedNode may start');assert.equal(args[0],setup.paths.playwright);
  assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);assert.equal(opts.env.NODE_OPTIONS,undefined);assert.equal(opts.env.PGOPTIONS,undefined);
  calls.push({args,env:opts.env});const child=new EventEmitter();child.pid=41000+calls.length;child.exitCode=null;child.signalCode=null;child.unref=()=>{};child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.destroy=()=>{};child.stderr.destroy=()=>{};
  queueMicrotask(()=>{if(args.includes('--list')){assert.equal(opts.env.U1_PASSWORD_A,undefined);assert.ok(fs.existsSync(path.join(runDir,'reservation.json')));child.stdout.emit('data',Buffer.from(JSON.stringify({suites:[{specs:[{file:U1_IDENTITY.file,title:U1_IDENTITY.title,tests:[{projectName:U1_IDENTITY.project}]}]}],errors:[]})));child.exitCode=0;child.emit('close',0);}else{assert.ok(fs.existsSync(path.join(runDir,'attempt.json')));assert.equal(opts.env.U1_PASSWORD_A,'fake-secret-a');child.exitCode=runCode;child.emit('close',runCode);}});return child;
 };syncBuiltinESMExports();
 const packagePath=path.join(f.dir,setup.core.package.file),originalPackage=fs.readFileSync(packagePath),originalSha=setup.core.package.sha256;
 const drift=JSON.parse(originalPackage);drift.supervisedChrome.sha256='0'.repeat(64);fs.writeFileSync(packagePath,JSON.stringify(drift));setup.core.package.sha256=HASH_FILE(packagePath);
 await assert.rejects(runSupervisedOnce(setup.options()),/Chrome channel executable drift/);assert.equal(calls.length,0);assert.equal(fs.existsSync(runDir),false);
 fs.writeFileSync(packagePath,originalPackage);setup.core.package.sha256=originalSha;
 const opts=setup.options(),result=await runSupervisedOnce(opts);
 assert.equal(result.status,'failed-closeout-required');assert.equal(result.reconciliation,null);assert.equal(calls.length,2);assert.equal(JSON.stringify(result).includes('fake-secret'),false);
 assert.equal(result.executedHarnessCommit,setup.core.harnessCommit);assert.equal(result.packageHarnessBaseline,f.draft.inputManifest.harnessCommit);
 assert.equal(result.discoveryCommandHash,canonicalHash([setup.paths.node,...calls[0].args]));assert.equal(result.runCommandHash,canonicalHash([setup.paths.node,...calls[1].args]));
 assert.ok(result.discoverySupervision);const ds=JSON.parse(fs.readFileSync(path.join(runDir,result.discoverySupervision.file)));assert.equal(ds.result.status,'process-completed');assert.equal(ds.rootCleanupConfirmed,true);
 const bytes=fs.readFileSync(path.join(runDir,'attempt.json'));await assert.rejects(runSupervisedOnce(opts),/EEXIST/);assert.equal(calls.length,2);assert.deepEqual(fs.readFileSync(path.join(runDir,'attempt.json')),bytes);
 // Separate synthetic scenario, not a retry of a real run. No child is executed.
 assert.ok(runDir.startsWith(runRoot+path.sep));fs.rmSync(runDir,{recursive:true});runCode=0;
 const missing=await runSupervisedOnce(opts);assert.equal(missing.status,'failed-closeout-required');assert.equal(missing.reconciliation,null);assert.equal(missing.child.result.status,'process-completed');assert.equal(calls.length,4);
 }finally{cp.spawn=original.spawn;cp.execFile=original.execFile;Date.now=original.now;syncBuiltinESMExports();assert.ok(runDir.startsWith(runRoot+path.sep));if(fs.existsSync(runDir))fs.rmSync(runDir,{recursive:true,force:true});}
}));

