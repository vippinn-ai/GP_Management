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
 const runId='u1-command-offline',actors={A:{id:'00000000-0000-4000-8000-000000000001',role:'admin',active:true,organization:'org-primary'},B:{id:'00000000-0000-4000-8000-000000000002',role:'manager',active:true,organization:'org-primary'}};
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
test('compact registry admission rejects tampering, clones, getters and legacy overrides',async()=>oracleFixture(async f=>{
 const prepared=admitted(f),loaded=loadBrowserPackage(prepared.file,prepared.sha256);
 assert.equal(Object.isFrozen(loaded.phases[0].command.payload.session),true);
 assert.throws(()=>{loaded.manifest.runId='other';});assert.throws(()=>{loaded.phases[0].command.user_id='other';});
 assert.throws(()=>runtimePackageFields(structuredClone(prepared.provider)));
 assert.throws(()=>prepareRuntimeExpectations({get commandInputs(){throw Error('getter executed');}}),/Getter/);
 assert.throws(()=>packagePhaseExpectation(structuredClone(loaded),0));assert.throws(()=>packageFinalExpectation(structuredClone(loaded)));
 assert.equal(Object.isFrozen(packageFinalExpectation(loaded).sessions),true);
 const directory=path.resolve('test-artifacts','u1-evidence',loaded.manifest.runId);
 assert.equal(fs.existsSync(directory),false);
 assert.throws(()=>new U1BrowserDatabaseAdapter({package:structuredClone(loaded),evidenceDirectory:directory,protectedReader:async()=>{}}));
 assert.equal(fs.existsSync(directory),false);
 for(const mutate of [p=>delete p.expectationInputs,p=>p.manifest.expectationHash='0'.repeat(64),p=>p.manifest.initialAppStateHash='0'.repeat(64),p=>p.phases[0].command.label='tampered',p=>p.phases[0].protectedRows={},p=>p.phases[0].uiParity={},p=>p.finalProtectedRows={},p=>p.pairs[0].stationA='wrong',p=>p.initialProtectedHash='0'.repeat(64)]){
  const bad=admitted(f,mutate);assert.throws(()=>loadBrowserPackage(bad.file,bad.sha256));assert.equal(fs.existsSync(directory),false);
 }
 assert.ok(prepared.fields.phases.every(p=>!Object.hasOwn(p,'protectedRows')));
 assert.ok(Buffer.byteLength(JSON.stringify(prepared.fields))<2*1024*1024);
}));
function assertLegacyCloseoutOversize(f,a,pkg,directory,expectedPath,observedPath,reportPath){
 const put=(name,value)=>{const file=path.join(f.dir,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value));fs.writeFileSync(file,bytes,{flag:'wx'});return{file:name,sha256:sha(bytes)};},ref=x=>({file:path.basename(x.file),sha256:x.sha256});
 for(const name of fs.readdirSync(directory).filter(n=>/^\d{5}-[a-z-]+\.json$/.test(n)))fs.copyFileSync(path.join(directory,name),path.join(f.dir,name),fs.constants.COPYFILE_EXCL);
 const expected=put('closeout-expected.json',fs.readFileSync(expectedPath)),observed=put('closeout-observed.json',fs.readFileSync(observedPath)),report=put('closeout-report.json',fs.readFileSync(reportPath)),observedValue=JSON.parse(fs.readFileSync(observedPath));
 const blobs={};for(const n of ['core-config','baseline-config','flags','index','asset','provider-evidence','parity','restore','spec'])blobs[n]=put(n+'.json',{n});
 const deploymentId='00000000-0000-4000-8000-000000000101',versionId='00000000-0000-4000-8000-000000000102',sourceCommit='0'.repeat(40),runId=pkg.manifest.runId,provider=put('baseline-provider.json',{schema:'u1-baseline-provider-v1',runId,...AUTHORITY_TARGET,deploymentId,versionId,trafficPercent:100,sourceCommit,indexSha256:blobs.index.sha256,configSha256:blobs['baseline-config'].sha256,flagsSha256:blobs.flags.sha256}),inventory=put('baseline-inventory.json',{schema:'u1-baseline-assets-v1',runId,versionId,indexSha256:blobs.index.sha256,assets:[{path:'/assets/app.js',sha256:blobs.asset.sha256}]});
 const baselineValue={schema:'u1-baseline-descriptor-v1',runId,...AUTHORITY_TARGET,capturedAt:'2026-11-05T06:01:00.000Z',sourceCommit,deploymentId,versionId,trafficPercent:100,flags:blobs.flags,config:blobs['baseline-config'],index:{path:'/',status:200,redirects:[],body:blobs.index},assets:[{path:'/assets/app.js',status:200,redirects:[],body:blobs.asset}],evidence:{provider,config:blobs['provider-evidence'],assets:inventory,protectedParity:blobs.parity,restoreProof:blobs.restore}},baseline=put('baseline.json',baselineValue),sources=Object.fromEntries(AUTHORITY_SOURCES.map((n,i)=>[n,put(`src-${i}.txt`,n)])),tools=Object.fromEntries(['node','git','playwright','psql','taskkill','tls'].map(n=>[n,put(`tool-${n}.txt`,n)]));
 const coreValue={schema:'u1-launch-core-v1',runId,...AUTHORITY_TARGET,applicationCommit:APPLICATION_COMMIT,harnessCommit:HARNESS_BASE_COMMIT,createdAt:'2026-11-05T06:05:00.000Z',limits:U1_LIMITS,processLimits:LAUNCH_LIMITS,discovery:U1_IDENTITY,sources,tools,package:ref(a),preflight:ref({file:f.draft.inputManifest.preflight.path,sha256:f.draft.inputManifest.preflight.sha256}),baseline,config:blobs['core-config'],spec:blobs.spec},core=put('core.json',coreValue),coreHash=canonicalHash(coreValue),approvals={};
 for(const [role,reviewedBy]of [['reviewer','reviewer-one'],['tester','tester-two']])approvals[role]=put(`${role}-launch.json`,{schema:'u1-launch-approval-v1',role,reviewedBy,scope:'u1-launch-core',decision:'approved',runId,coreHash,approvedAt:'2026-11-05T06:06:00.000Z'});
 const attempt=put('attempt.json',{schema:'u1-launch-attempt-v1',runId,coreHash,packageSha256:a.sha256,authorityValidatedAt:'2026-11-05T06:06:30.000Z',startedAt:'2026-11-05T06:06:30.500Z',attempt:1,retry:0}),terminalValue={schema:'u1-launch-terminal-v1',runId,coreHash,attemptSha256:attempt.sha256,finishedAt:'2026-11-05T06:07:00.000Z',acceptance:'passed',child:{exitObserved:true,exitCode:0},browser:{status:'passed',identity:U1_IDENTITY,passed:1,failed:0,skipped:0,retries:0},reconciliation:{expected,observed,report}},terminal=put('terminal.json',terminalValue),common={runId,coreHash,attemptSha256:attempt.sha256,terminalSha256:terminal.sha256,capturedAt:'2026-11-05T06:08:00.000Z'},stateExpected=put('post-expected.json',{appState:observedValue.final,protectedRows:observedValue.finalProtectedRows}),stateObserved=put('post-observed.json',{appState:observedValue.final,protectedRows:observedValue.finalProtectedRows}),zeros=ns=>Object.fromEntries(ns.map(n=>[n,0]));
 const postflight=put('postflight.json',{schema:'u1-postflight-v1',...common,outcome:'reconciled-success',floors:zeros(CLOSEOUT_FLOORS),residues:zeros(CLOSEOUT_RESIDUES),initialAppStateHash:pkg.manifest.initialAppStateHash,initialProtectedHash:pkg.initialProtectedHash,expected:stateExpected,observed:stateObserved,historyPreserved:true,evidenceChainTailSha256:observedValue.terminalRecord.sha256,evidenceChainTail:observedValue.terminalRecord}),roleRetirement=put('roles.json',{schema:'u1-role-retirement-v1',...common,actors:['A','B'].map(k=>({id:pkg.actors[k].id,active:false})),credentialFiles:['credentials.json']}),providerRestoration=put('provider-restored.json',{schema:'u1-provider-restoration-v1',...common,...AUTHORITY_TARGET,versionId,trafficPercent:100,configSha256:baselineValue.config.sha256,flagsSha256:baselineValue.flags.sha256}),httpRestoration=put('http-restored.json',{schema:'u1-http-restoration-v1',...common,target:AUTHORITY_TARGET.target,index:{path:'/',status:200,redirects:[],body:blobs.index},assets:[{path:'/assets/app.js',status:200,redirects:[],body:blobs.asset}]}),closeout=put('closeout.json',{schema:'u1-run-closeout-v1',runId,coreHash,attempt,terminal,postflight,roleRetirement,providerRestoration,httpRestoration,failureApprovals:null});
 const sizes=Object.fromEntries([expected,observed,report].map(x=>[x.file,fs.statSync(path.join(f.dir,x.file)).size]));assert.equal(sizes['closeout-expected.json'],156799156);assert.equal(sizes['closeout-observed.json'],149862985);assert.equal(sizes['closeout-report.json'],614);assert.ok(sizes['closeout-expected.json']>64*1024*1024&&sizes['closeout-observed.json']>64*1024*1024,'Legacy closeout oversize regression must remain explicit');assert.throws(()=>verifyRunCloseout({artifactRoot:f.dir,core,approvals,closeout,now:Date.parse('2026-11-05T06:10:00.000Z')}),/oversized evidence/);
}
async function runAdapter(f,{phases=250,corrupt=false,submissionFailure=false,failureMode=null,recordFailure=null,supervised=false}={}){
 const a=admitted(f,p=>{if(supervised){p.evidenceMode='u1-supervised-numbered-v1';p.supervisedLimits=SUPERVISED_LIMITS;p.supervisedSourceHashes=Object.fromEntries(SUPERVISED_SOURCES.map(name=>[name,sha(fs.readFileSync(path.resolve(import.meta.dirname,'..',name)))]));}}),pkg=loadBrowserPackage(a.file,a.sha256),directory=path.resolve('test-artifacts','u1-evidence',pkg.manifest.runId);
 assert.equal(fs.existsSync(directory),false);let adapter,created=false;
 let state={appState:structuredClone(f.input.initialAppState),protectedRows:structuredClone(f.input.initialProtectedRows),floor:{openSessions:0,openTabs:0,unbilledHops:0,incompleteOperationalMutations:0,incompleteFinancialMutations:0,customerNameCollisions:0}},submitted=0,lastRecord=null;
  const bindings={},records=[];let latestPreparedArtifact=null;const page={reload:async()=>{},request:{post:async(url,opts)=>{
  const i=submitted++,phase=packagePhaseExpectation(pkg,i);
  assert.equal(lastRecord,'submission-attempt');assert.equal(opts.maxRetries,0);assert.equal(opts.timeout,15000);assert.equal(opts.maxRedirects,0);
  assert.deepEqual(opts.data,{payload:phase.command});assert.ok(url.endsWith('/'+phase.operation));
   const prepared=supervised?{preparedArtifact:latestPreparedArtifact,protectedRows:phase.protectedRows}:adapter.preparedPhases.at(-1),preparedBytes=fs.readFileSync(path.join(directory,prepared.preparedArtifact.file));assert.equal(sha(preparedBytes),prepared.preparedArtifact.sha256);const preparedRecord=JSON.parse(preparedBytes);assert.equal(preparedRecord.phase,'prepared-command');assert.deepEqual(preparedRecord.command,phase.command);assert.deepEqual(preparedRecord.expectedPhase.protectedRows,phase.protectedRows);assert.equal(Object.isFrozen(prepared.protectedRows),true);
  if(submissionFailure)throw new Error('synthetic private transport failure');
  const number=String(i+1).padStart(12,'0'),time=new Date().toISOString();
  const binding={eventId:'event-00000000-0000-4000-8000-'+number,auditActivityId:'activity-10000000-0000-4000-8000-'+number,operationalActivityId:'activity-20000000-0000-4000-8000-'+number,serverTime:time,operation:phase.operation,entityId:phase.entityId,auditId:phase.auditId,mutationId:phase.mutationId,customerId:phase.generated.customerId??null,customerWrite:phase.generated.customerWrite??null,analyticsDates:[...new Set(phase.protectedRows.analytics_dirty_dates.filter(r=>r.updated_at?.phase===phase.id).map(r=>r.business_date))],...(phase.operation==='reject_session'?{serverDurationMs:1.234}:{})};
  bindings[phase.id]=binding;state.protectedRows=materializeProtected(phase.protectedRows,bindings);
  const changed={sessions:[phase.entityId],audit_logs:[phase.auditId],operational_events:[binding.eventId]};
  if(phase.operation==='reject_session'){
   changed.session_pause_logs=[];const p=phase.command.payload;
   state.appState={...state.appState,version:state.appState.version+1,updated_by:phase.actorId,updated_at:postgresUtcTimestamp(time),data:{...state.appState.data,sessions:patchArrayById(state.appState.data.sessions,[p.session]),auditLogs:patchArrayById(state.appState.data.auditLogs,[p.auditLog])}};
  }else{changed.customers=[phase.generated.customerId];if(phase.operation==='start_session')Object.assign(changed,{session_items:[],session_combo_applications:[],stock_movements:[]});}
  if(corrupt)state.appState.data.unrelated.blob='malicious';
  const response={mutation_id:phase.mutationId,organization_id:'org-primary',entity_type:'session',entity_id:phase.entityId,event_id:binding.eventId,server_time:time,changed_rows:changed,...(phase.operation==='reject_session'?{app_state_version:state.appState.version,server_duration_ms:1.234}:{})};
  if(failureMode==='time'&&i===0)response.server_time=new Date(Date.parse(time)+16000).toISOString();if(failureMode==='version'&&i===3)response.app_state_version++;
  return{status:()=>failureMode==='status'?503:200,body:async()=>Buffer.from(JSON.stringify(response))};
 }}};
 try{
  adapter=new U1BrowserDatabaseAdapter({origin:page,observer:page,package:pkg,evidenceDirectory:directory,credentials:null,protectedReader:async()=>structuredClone(state)});created=true;
  adapter.current=structuredClone(state.appState);adapter.initialState=structuredClone(state.appState);adapter.expectedProtected=structuredClone(state.protectedRows);adapter.latestRows=structuredClone(state.protectedRows);adapter.nonOwned=canonicalHash(state.protectedRows._unowned);
   const originalRecord=adapter.record.bind(adapter);adapter.record=async value=>{lastRecord=value.phase;records.push(value.phase);if(value.phase===recordFailure||recordFailure&&value.phase==='submission-failure')throw new Error('private evidence I/O detail');const artifact=await originalRecord(value);if(value.phase==='prepared-command')latestPreparedArtifact=artifact;return artifact;};
  if(phases===250&&!corrupt&&!submissionFailure&&!failureMode&&!recordFailure){
   adapter.preflight=async()=>{await adapter.record({phase:'preflight',...state});return{pairs:pkg.pairs,appState:structuredClone(state.appState)};};
   adapter.assertPair=async pair=>Object.fromEntries(['A','B'].map(slot=>[slot,Object.fromEntries(['A','B'].map(suffix=>{const row=state.protectedRows.sessions.find(s=>s.id===pair[suffix==='A'?'aId':'bId']);return[suffix,{sessionId:row.id,customerName:row.customer_name,station:pair['station'+suffix]}];}))]));
   adapter.read=async(_slot,_table,filters)=>state.protectedRows.sessions.filter(s=>filters.id.slice(4,-1).split(',').includes(s.id));adapter.queues=async()=>({origin:[],observer:[]});
   let tick=0;const result=await runBaselinePairs(adapter,{manifest:pkg.manifest,manifestHash:canonicalHash(pkg.manifest),discovery:[U1_IDENTITY],limits:U1_LIMITS,clock:()=>tick++});
   assert.equal(result.status,'completed-unverified');assert.equal(submitted,250);assert.equal(adapter.current.version,835);
    if(supervised){
     const index=path.join(directory,'supervised-index.json'),originalIndex=fs.readFileSync(index),parsed=JSON.parse(originalIndex),result=verifySupervisedEvidence(index,sha(originalIndex));
     assert.equal(result.status,'passed');assert.equal(result.numberedRecords,1353);assert.equal(result.phases,250);assert.equal(result.compatibilityCommits,100);assert.equal(result.samples,50);
     const rejectIndex=(mutate,pattern)=>{const changed=structuredClone(parsed);mutate(changed);const bytes=Buffer.from(JSON.stringify(changed));fs.writeFileSync(index,bytes);try{assert.throws(()=>verifySupervisedEvidence(index,sha(bytes)),pattern);}finally{fs.writeFileSync(index,originalIndex);}};
     rejectIndex(value=>value.records.pop(),/Incomplete record count/);
     rejectIndex(value=>value.records.push(structuredClone(value.records.at(-1))),/Incomplete record count/);
     rejectIndex(value=>[value.records[0],value.records[1]]=[value.records[1],value.records[0]],/Invalid record reference/);
     rejectIndex(value=>value.records[1]=structuredClone(value.records[0]),/Extra or missing run evidence|Invalid record reference/);
     rejectIndex(value=>value.sourceHashes[Object.keys(value.sourceHashes)[0]]='0'.repeat(64),/Executed source inventory mismatch/);
     rejectIndex(value=>value.limits.maxRecords++,/Index policy mismatch/);
     rejectIndex(value=>value.authority.packageSha256='0'.repeat(64),/Package hash mismatch/);
     rejectIndex(value=>value.authority.packageFile=path.join(path.dirname(value.authority.packageFile),'credentials.json'),/Canonical non-secret package JSON/);
     const first=path.join(directory,parsed.records[0].file),originalFirst=fs.readFileSync(first);fs.writeFileSync(first,Buffer.concat([originalFirst,Buffer.from(' ')]));try{assert.throws(()=>verifySupervisedEvidence(index,sha(originalIndex)),/Record hash\/size mismatch/);}finally{fs.writeFileSync(first,originalFirst);}
     const second=path.join(directory,parsed.records[1].file),originalSecond=fs.readFileSync(second),replayed=JSON.parse(originalSecond);replayed.previousRecordHash='f'.repeat(64);const replayedBytes=Buffer.from(JSON.stringify(replayed));fs.writeFileSync(second,replayedBytes);try{rejectIndex(value=>{value.records[1].sha256=sha(replayedBytes);value.records[1].bytes=replayedBytes.length;},/Broken record chronology/);}finally{fs.writeFileSync(second,originalSecond);fs.writeFileSync(index,originalIndex);}
     assert.equal(sha(fs.readFileSync(index)),sha(originalIndex));assert.equal(sha(fs.readFileSync(first)),parsed.records[0].sha256);assert.equal(sha(fs.readFileSync(second)),parsed.records[1].sha256);return;
    }
   const expected=path.join(directory,'expected.json'),observed=path.join(directory,'observed.json'),report=path.join(directory,'offline-report.json'),expectedHash=sha(fs.readFileSync(expected));assert.equal(reconcileMain([expected,expectedHash,observed,report]),0);const cliReport=JSON.parse(fs.readFileSync(report));assert.equal(cliReport.ledger.compatibilityCommits,100);const before=fs.readdirSync(directory).sort(),readOnlyReport=verifyEvidenceFiles(expected,expectedHash,observed),after=fs.readdirSync(directory).sort();assert.deepEqual(after,before);assert.deepEqual(readOnlyReport,cliReport);const frozen=v=>!v||typeof v!=='object'||Object.isFrozen(v)&&Object.values(v).every(frozen);assert.equal(frozen(readOnlyReport),true);assertLegacyCloseoutOversize(f,a,pkg,directory,expected,observed,report);return;
  }
  await adapter.record({phase:'preflight',...state});
  if(recordFailure){await assert.rejects(adapter.executePhase(0),recordFailure==='prepared-command'?/Prepared evidence failed/:recordFailure==='observed-command'?/private evidence I\/O detail/:/Mutation failed or ambiguous/);await assert.rejects(adapter.executePhase(0),/Browser errors/);await assert.rejects(adapter.executePhase(1),/Browser errors/);assert.equal(submitted,['prepared-command','submission-attempt'].includes(recordFailure)?0:1);assert.equal(records.includes('terminal'),false);return;}
  if(corrupt||submissionFailure){const before=canonicalHash(adapter.current);await assert.rejects(adapter.executePhase(0),corrupt?/app_state mismatch/:/Mutation failed or ambiguous/);assert.equal(canonicalHash(adapter.current),before);await assert.rejects(adapter.executePhase(0),/Browser errors/);await assert.rejects(adapter.executePhase(1),/Browser errors/);assert.equal(submitted,1);return;}
  const samples=[];
  for(let i=0;i<phases;i++){
   if(failureMode&&i===(failureMode==='version'?3:0)){const before=canonicalHash(adapter.current);await assert.rejects(adapter.executePhase(i));assert.equal(canonicalHash(adapter.current),before);const count=submitted;await assert.rejects(adapter.executePhase(i+1),/Browser errors/);assert.equal(submitted,count);return;}
   if(i%5===2){const pair=packagePairExpectations(pkg)[Math.floor(i/5)],intent=await adapter.freezeIntent(pair,pair.index),pending=await adapter.saveObserver(pair,intent);
    const expectedParity=packagePhaseExpectation(pkg,i).uiParity;
    // Controlled UI/read test doubles; no browser is launched and no UI result is claimed.
    adapter.read=async()=>state.protectedRows.sessions.filter(s=>[pair.aId,pair.bId].includes(s.id));
    adapter.assertPair=async got=>{assert.equal(got.stationA,'Name station-a');assert.equal(got.stationB,'Name station-b');return expectedParity;};
    adapter.queues=async()=>({origin:[],observer:[]});
    const result=await adapter.convergeAndReconcile(pair,intent,[null,pending]);await adapter.finalizeMeasured();
    samples.push({...pair,index:pair.index,elapsedMs:1,outcome:'completed',...result,intentHash:canonicalHash(intent),parityHash:canonicalHash(expectedParity)});
   }else await adapter.executePhase(i);
  }
  assert.equal(submitted,phases);assert.equal(adapter.current.version,735+Math.floor(phases/5)*2);assert.notEqual(adapter.current,state.appState);assert.deepEqual(adapter.current,state.appState);
  await assert.rejects(adapter.executePhase(phases-1),/Out-of-order/);
  if(phases===250){
   await adapter.postflight({failed:false});await adapter.record({phase:'terminal',status:'completed-unverified',samples});
   const expected=path.join(directory,'expected.json'),observed=path.join(directory,'observed.json'),report=path.join(directory,'offline-report.json');
   const expectedHash=sha(fs.readFileSync(expected));assert.equal(reconcileMain([expected,expectedHash,observed,report]),0);const cliReport=JSON.parse(fs.readFileSync(report));assert.equal(cliReport.ledger.compatibilityCommits,100);const before=fs.readdirSync(directory).sort(),readOnlyReport=verifyEvidenceFiles(expected,expectedHash,observed),after=fs.readdirSync(directory).sort();assert.deepEqual(after,before);assert.deepEqual(readOnlyReport,cliReport);const frozen=v=>!v||typeof v!=='object'||Object.isFrozen(v)&&Object.values(v).every(frozen);assert.equal(frozen(readOnlyReport),true);
  }
  }catch(error){
   if(supervised)throw new AggregateError([error],`Synthetic supervised diagnostic: submitted=${submitted}, records=${records.length}, last=${lastRecord}, adapterErrors=${JSON.stringify(adapter?.errors??[])}`);
   throw error;
  }finally{if(created){assert.equal(directory,path.resolve('test-artifacts','u1-evidence',pkg.manifest.runId));fs.rmSync(directory,{recursive:true,force:true});}}
}
test('actual adapter 250 phases and unchanged v1 CLI evidence pipeline with fake IO',async()=>oracleFixture(async f=>{await runAdapter(f);}));
test('actual adapter 250 phases produce exact supervised numbered evidence and compact reconciliation',async()=>oracleFixture(async f=>{
 try{await runAdapter(f,{supervised:true});}
 catch(error){
  const flatten=item=>item instanceof AggregateError?[item.message,...item.errors.flatMap(flatten)]:[item instanceof Error?item.message:String(item)];
  const messages=flatten(error);
  assert.fail(`Supervised 250-phase run failed: ${JSON.stringify(messages)}`);
 }
}));
test('actual adapter rejects unrelated app_state corruption before advancing',async()=>oracleFixture(async f=>{await runAdapter(f,{phases:1,corrupt:true});}));
test('actual adapter poisons after ambiguous submission without next POST',async()=>oracleFixture(async f=>{await runAdapter(f,{phases:1,submissionFailure:true});}));
test('actual adapter rejects canonical time/version/status drift with no next POST',async()=>oracleFixture(async f=>{for(const failureMode of ['time','version','status'])await runAdapter(f,{phases:4,failureMode});}));
test('all four evidence I/O failure points poison without a next POST',async()=>oracleFixture(async f=>{for(const recordFailure of ['prepared-command','submission-attempt','submission-response','observed-command'])await runAdapter(f,{phases:1,recordFailure});}));

