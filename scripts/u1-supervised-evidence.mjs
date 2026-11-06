// Fixed U1 read-only numbered-record reconciliation; no CLI, network or writes.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadBrowserPackage,packagePhaseExpectation,packageFinalExpectation} from './u1-browser-database-adapter.mjs';
import {canonicalHash,planPhase,sealPhaseIntent,finalizePhaseIntent,reconcilePhase,reconcileProtectedRows,verifySamples,verifyPairIdentities} from './u1-data-reconciler.mjs';
import {bindGeneratedPhase,compareGeneratedProtected,canonicalProtectedRows} from './u1-generated-fields.mjs';
import {prepareInstalledPhase,compareInstalledPhase} from './u1-phase-expectations.mjs';
import {AUTHORITY_SOURCES} from './u1-launch-authority.mjs';
export const SUPERVISED_LIMITS=Object.freeze({recordBytes:32*1024*1024,indexBytes:1024*1024,workingBytes:128*1024*1024,totalRecordBytes:1024*1024*1024,maxRecords:1354,successRecords:1353,deadlineMs:1200000});
export const SUPERVISED_SOURCES=Object.freeze([...AUTHORITY_SOURCES,'scripts/u1-supervised-evidence.mjs','scripts/u1-supervised-evidence.nodechecks.mjs'].sort());
const check=(v,m)=>{if(!v)throw new Error(m);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b,m)=>check(canonicalHash(a)===canonicalHash(b),m);
const keys=(o,ks)=>check(o&&Object.keys(o).sort().join(',')===[...ks].sort().join(','),'Unexpected evidence fields');
const logicalBytes=o=>Buffer.byteLength(JSON.stringify(o));
export function verifySupervisedSourceHashes(pkg){
 keys(pkg.supervisedSourceHashes,SUPERVISED_SOURCES);same(pkg.supervisedLimits,SUPERVISED_LIMITS,'Supervised policy differs from fixed limits');
 const root=path.resolve(import.meta.dirname,'..');
 for(const name of SUPERVISED_SOURCES){const file=path.join(root,name),s=fs.lstatSync(file);check(s.isFile()&&!s.isSymbolicLink()&&fs.realpathSync(file)===file&&s.size<=32*1024*1024&&sha(fs.readFileSync(file))===pkg.supervisedSourceHashes[name],'Supervised source drift');}
}
export function verifySupervisedEvidence(indexFile,indexSha256){
 const start=performance.now(),deadline=()=>check(performance.now()-start<SUPERVISED_LIMITS.deadlineMs,'Supervised verification deadline');
 check(typeof indexFile==='string'&&path.isAbsolute(indexFile)&&/^[a-f0-9]{64}$/.test(indexSha256),'Canonical index and digest required');
 const directory=path.dirname(indexFile);
 check(path.basename(indexFile)==='supervised-index.json','Fixed supervised index required');
 for(let parent=directory;;parent=path.dirname(parent)){check(!fs.lstatSync(parent).isSymbolicLink(),'Symlink evidence ancestor');if(parent===path.dirname(parent))break;}
 const bounded=(file,max)=>{deadline();const s=fs.lstatSync(file);check(s.isFile()&&!s.isSymbolicLink()&&fs.realpathSync(file)===path.resolve(file)&&s.nlink===1&&s.size>0&&s.size<=max,'Noncanonical, aliased or oversized evidence');const b=fs.readFileSync(file);check(b.length===s.size,'Evidence size drift');deadline();return b;};
 const indexBytes=bounded(indexFile,SUPERVISED_LIMITS.indexBytes);check(sha(indexBytes)===indexSha256,'Index hash mismatch');
 const index=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(indexBytes));
 keys(index,['schema','evidenceMode','authority','sourceHashes','limits','runId','project','organization','attempt','retry','status','samples','records','terminalRecord','verifiedPhases','compatibilityCommits','initialAppStateHash','initialProtectedHash','finalAppStateHash','finalProtectedHash']);
 check(index.schema==='u1-supervised-index-v1'&&index.evidenceMode==='u1-supervised-numbered-v1'&&index.project==='tkbdyzxwwbhkpztgjjxh'&&index.organization==='org-primary'&&index.attempt===1&&index.retry===0,'Wrong supervised identity');
 check(index.status==='completed-unverified'&&index.verifiedPhases===250&&index.compatibilityCommits===100,'Failed or incomplete campaign');
 check(Array.isArray(index.records)&&index.records.length===SUPERVISED_LIMITS.successRecords,'Incomplete record count');
 const names=fs.readdirSync(directory).sort();same(names,[path.basename(indexFile),...index.records.map(r=>r.file)].sort(),'Extra or missing run evidence');
 let total=0;const paths=new Set();
 for(const [ordinal,ref]of index.records.entries()){
  keys(ref,['file','sha256','ordinal','phase','bytes']);
  check(ref.ordinal===ordinal&&ref.file===`${String(ordinal).padStart(5,'0')}-${ref.phase}.json`&&/^[a-z-]+$/.test(ref.phase)&&/^[a-f0-9]{64}$/.test(ref.sha256)&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=SUPERVISED_LIMITS.recordBytes&&!paths.has(ref.file),'Invalid record reference');
  paths.add(ref.file);total+=ref.bytes;check(total<=SUPERVISED_LIMITS.totalRecordBytes,'Numbered evidence total bound');
 }
 keys(index.authority,['packageFile','packageSha256','manifestHash','proofs']);
 check(typeof index.authority.packageFile==='string'&&path.isAbsolute(index.authority.packageFile)&&path.resolve(index.authority.packageFile)===index.authority.packageFile&&/^[A-Za-z0-9_-]+\.json$/.test(path.basename(index.authority.packageFile))&&!/credential|secret|backup/i.test(path.basename(index.authority.packageFile)),'Canonical non-secret package JSON required');
 check(sha(bounded(index.authority.packageFile,SUPERVISED_LIMITS.recordBytes))===index.authority.packageSha256,'Package hash mismatch');
 const pkg=loadBrowserPackage(index.authority.packageFile,index.authority.packageSha256);deadline();
 check(pkg.evidenceMode===index.evidenceMode&&pkg.manifest.runId===index.runId,'Package evidence mode mismatch');same(pkg.authority,index.authority,'Package authority mismatch');
 same(index.sourceHashes,pkg.supervisedSourceHashes,'Executed source inventory mismatch');same(index.limits,SUPERVISED_LIMITS,'Index policy mismatch');
 let ordinal=0,previous=null;
 const take=phase=>{
  deadline();const ref=index.records[ordinal++];check(ref?.phase===phase,'Unexpected numbered-record order');
  const bytes=bounded(path.join(directory,ref.file),SUPERVISED_LIMITS.recordBytes);check(bytes.length===ref.bytes&&sha(bytes)===ref.sha256,'Record hash/size mismatch');
  const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(record.phase===phase&&record.previousRecordHash===previous,'Broken record chronology');previous=ref.sha256;
  return {record,reference:{file:ref.file,sha256:ref.sha256}};
 };
 const pre=take('preflight').record;
 same(canonicalHash(pre.appState),pkg.manifest.initialAppStateHash,'Initial app state mismatch');same(canonicalHash(pre.protectedRows),pkg.initialProtectedHash,'Initial protected mismatch');
 same(index.initialAppStateHash,pkg.manifest.initialAppStateHash,'Initial index mismatch');same(index.initialProtectedHash,pkg.initialProtectedHash,'Initial protected index mismatch');
 let current=pre.appState,protectedRows=pre.protectedRows;const initialVersion=current.version,unownedHash=canonicalHash(protectedRows._unowned);
 // Release original container; retained states below replace it phase by phase.
 delete pre.appState;delete pre.protectedRows;
 const bindings=Object.create(null),generatedIds=new Set();let commits=0;
 const measured=[];
 const working=(...values)=>{check(values.reduce((sum,v)=>sum+logicalBytes(v),0)+logicalBytes(index)+logicalBytes(bindings)+logicalBytes(measured)+logicalBytes([...generatedIds])+logicalBytes(pkg)+logicalBytes(pre)<=SUPERVISED_LIMITS.workingBytes,'Logical retained-state bound');deadline();};
 working(current,protectedRows);
 for(let n=0;n<250;n++){
  const approved=packagePhaseExpectation(pkg,n),offset=n%5,pairIndex=Math.floor(n/5);
  if(offset===2){const pairPrepared=take('prepared').record;same({index:pairPrepared.index,aId:pairPrepared.aId,bId:pairPrepared.bId,intentHash:pairPrepared.intentHash},{index:pairIndex,aId:pkg.pairs[pairIndex].aId,bId:pkg.pairs[pairIndex].bId,intentHash:canonicalHash(pkg.manifest.intents[pairIndex])},'Pair intent mismatch');}
  const prepared=take('prepared-command'),p=prepared.record,phase=p.expectedPhase;
  same(p.command,approved.command,'Command differs from package');check(p.beforeHash===canonicalHash(current),'Broken expected preimage');
  for(const k of ['id','pairIndex','role','entityId','actorId','mutationId','auditId'])same(phase[k],approved[k],'Phase identity mismatch');
  same(phase.protectedRows,approved.protectedRows,'Prepared protected authority mismatch');same(phase.uiParity??null,approved.uiParity??null,'Prepared UI authority mismatch');
  const {earliestServerTime,latestServerTime,...generated}=phase.generated;same(generated,approved.generated,'Generated authority mismatch');
  same(phase.plan.patches,approved.plan.patches,'Patch authority mismatch');
  keys(phase.plan,offset>=3?['operation','outcome','actor','patches','earliestServerTime','latestServerTime']:['operation','outcome','actor','patches','serverTime']);
  check(offset>=3?phase.plan.earliestServerTime===earliestServerTime&&phase.plan.latestServerTime===latestServerTime:phase.plan.serverTime===earliestServerTime,'Prepared clock window mismatch');
  check(phase.plan.operation===approved.operation&&phase.plan.outcome==='committed'&&phase.plan.actor===approved.actorId,'Plan authority mismatch');
  const installed=prepareInstalledPhase(protectedRows,approved.operation,p.command);same(installed,p.installedIntent,'Installed intent mismatch');
  const attempt=take('submission-attempt').record,response=take('submission-response').record;
  for(const r of [attempt,response]){check(r.mutationId===phase.mutationId,'Submission identity mismatch');same(r.preparedArtifact,prepared.reference,'Submission preparation mismatch');}
  check(response.responseStatus===200&&/^[a-f0-9]{64}$/.test(response.responseHash)&&Number.isSafeInteger(response.responseLength)&&response.responseLength>0&&response.responseLength<=1048576,'Invalid canonical response evidence');
  const observed=take('observed-command'),o=observed.record;
  working(current,protectedRows,approved,p,attempt,response,o,installed);
  for(const k of ['id','pairIndex','role','entityId','actorId','mutationId','auditId'])same(o[k],approved[k],'Observation identity mismatch');
  same(o.preparedArtifact,prepared.reference,'Observation preparation mismatch');same(o.response,response.response,'Response disagreement');
  check(o.responseTime===o.response.server_time&&o.databaseTime===o.appState.updated_at,'Observed timestamp mismatch');
  const bound=bindGeneratedPhase(phase.generated,o.response,o.protectedRows,p.command);
  for(const k of ['eventId','auditActivityId','operationalActivityId']){check(!generatedIds.has(bound[k]),'Generated identity reused');generatedIds.add(bound[k]);}
  bindings[phase.id]=bound;
  const expectedProtected=compareInstalledPhase(phase.protectedRows,o.protectedRows,bindings,phase.id,installed);
  const plan=offset>=3?finalizePhaseIntent(sealPhaseIntent({...phase.plan,before:current}),{responseTime:o.responseTime,databaseTime:o.databaseTime}):planPhase({...phase.plan,before:current});
  reconcilePhase(plan,o.appState);same(canonicalHash(o.protectedRows._unowned),unownedHash,'Unowned projection drift');
  working(current,protectedRows,approved,p,attempt,response,o,installed,bound,expectedProtected,plan);
  const validation=take('phase-validation').record;
  const expectedValidation={phase:'phase-validation',schema:'u1-phase-validation-v1',index:n,id:phase.id,operation:approved.operation,actorId:phase.actorId,entityId:phase.entityId,mutationId:phase.mutationId,auditId:phase.auditId,preparedArtifact:prepared.reference,observedArtifact:observed.reference,beforeHash:plan.beforeHash,expectedAppStateHash:plan.expectedHash,actualAppStateHash:canonicalHash(o.appState),expectedProtectedHash:canonicalHash(canonicalProtectedRows(expectedProtected)),actualProtectedHash:canonicalHash(canonicalProtectedRows(o.protectedRows)),generatedBindingHash:canonicalHash(bound),compatibilityCommit:plan.compatibilityCommit};
  const {previousRecordHash:ignored,...savedValidation}=validation;same(savedValidation,expectedValidation,'Validation receipt mismatch');
  current=plan.expected;protectedRows=expectedProtected;commits+=Number(plan.compatibilityCommit);
  if(offset===2){
   same(o.uiParity,approved.uiParity,'UI parity mismatch');same(o.pendingQueues,{origin:[],observer:[]},'Pending queue mismatch');
   const sample=take('measured').record,{phase:ignoredPhase,previousRecordHash:ignoredHash,...clean}=sample;
   check(clean.outcome==='completed'&&clean.pendingQueuesEmpty===true&&clean.acknowledged===true&&clean.errorPriorityViolation===false&&clean.index===pairIndex&&clean.aId===pkg.pairs[pairIndex].aId&&clean.bId===pkg.pairs[pairIndex].bId&&clean.mutationId===phase.mutationId&&clean.entityId===phase.entityId&&clean.actorId===phase.actorId&&clean.intentHash===canonicalHash(pkg.manifest.intents[pairIndex])&&clean.parityHash===canonicalHash(o.uiParity),'Sample correlation mismatch');measured.push(clean);
  }
 }
 const post=take('postflight').record;check(post.failed===false,'Failed postflight');reconcileProtectedRows(current,post.appState);check(commits===100&&current.version===initialVersion+100,'Final compatibility fold mismatch');
 const finalTemplate=packageFinalExpectation(pkg);working(current,protectedRows,post,finalTemplate);
 compareGeneratedProtected(finalTemplate,post.protectedRows,bindings);same(canonicalHash(post.protectedRows._unowned),unownedHash,'Final unowned drift');
 same(index.finalAppStateHash,canonicalHash(post.appState),'Final app state summary mismatch');same(index.finalProtectedHash,canonicalHash(post.protectedRows),'Final protected summary mismatch');
 const terminal=take('terminal');check(terminal.record.status==='completed-unverified'&&ordinal===index.records.length,'Incomplete terminal');same(terminal.reference,index.terminalRecord,'Terminal reference mismatch');same(terminal.record.samples,measured,'Terminal samples mismatch');same(index.samples,measured,'Index samples mismatch');
 verifySamples(measured);verifyPairIdentities(measured,pkg.pairs);working(current,protectedRows,post);
 // Rehash exact files at end; do not retain or rebuild the250-phase arrays.
 for(const ref of index.records){const bytes=bounded(path.join(directory,ref.file),SUPERVISED_LIMITS.recordBytes);check(bytes.length===ref.bytes&&sha(bytes)===ref.sha256,'Record changed during reconciliation');}
 same(fs.readdirSync(directory).sort(),names,'Evidence directory changed');check(sha(bounded(indexFile,SUPERVISED_LIMITS.indexBytes))===indexSha256,'Index changed');
 check(sha(bounded(index.authority.packageFile,SUPERVISED_LIMITS.recordBytes))===index.authority.packageSha256,'Package changed during reconciliation');verifySupervisedSourceHashes(pkg);deadline();
 const result={schema:'u1-supervised-reconciliation-v1',status:'passed',runId:index.runId,evidenceMode:index.evidenceMode,packageSha256:pkg.authority.packageSha256,indexSha256,terminalRecord:index.terminalRecord,phases:250,compatibilityCommits:100,samples:50,numberedRecords:ordinal,totalRecordBytes:total,finalAppStateHash:index.finalAppStateHash,finalProtectedHash:index.finalProtectedHash,stagingAcceptance:false};
 check(indexBytes.length+logicalBytes(result)<=SUPERVISED_LIMITS.indexBytes,'Combined index/report byte bound');deadline();return Object.freeze(result);
}
