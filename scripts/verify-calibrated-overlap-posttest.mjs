import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {assertLifecycleSuiteDiscovery,assertCompleteLifecycleSummary} from './lifecycle-runner-guards.mjs';

const mode='calibrated-overlap-diagnostics';
const sha=value=>createHash('sha256').update(value).digest('hex');
const keys=(v,k)=>v&&equal(Object.keys(v).sort(),[...k].sort());
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const zero=(v,k)=>{if(!keys(v,k)||k.some(key=>v[key]!==0))throw Error('Reconciliation counts missing, extra or nonzero');};
export function verifyCalibrationTiming(v,runId){
  if(!keys(v,['runId','iteration','stage','completed','budgetOutcome','wallRatioP95','samples','directRpcEvidence'])
    ||v.runId!==runId||v.iteration!==10||v.stage!=='complete'||v.completed!==true||v.budgetOutcome!=='passed'
    ||v.samples?.length!==10||v.directRpcEvidence?.length!==80)throw Error('Incomplete calibration evidence');
  const rpcById=new Map();
  for(const r of v.directRpcEvidence){
    if(!keys(r,['client','rpc','mutationId','startedAt','completedAt','elapsedMs','status','serverDurationMs'])
      ||!['origin','observer'].includes(r.client)||!['start_session','reject_session_v2'].includes(r.rpc)
      ||typeof r.mutationId!=='string'||!r.mutationId.startsWith(`${runId}-cal-`)||rpcById.has(r.mutationId)
      ||r.status!==200||!finite(r.elapsedMs)||!(r.serverDurationMs===null||finite(r.serverDurationMs))
      ||typeof r.startedAt!=='string'||typeof r.completedAt!=='string'
      ||!Number.isFinite(Date.parse(r.startedAt))||!Number.isFinite(Date.parse(r.completedAt))
      ||Date.parse(r.completedAt)<Date.parse(r.startedAt))throw Error('Invalid RPC projection');
    rpcById.set(r.mutationId,r);
  }
  const expectedIds=[];
  for(let i=1;i<=10;i++){
    const s=v.samples[i-1];
    const con=[0,1].map(n=>`${runId}-cal-${i}-con-${n}-reject`);
    const seq=[0,1].map(n=>`${runId}-cal-${i}-seq-${n}-reject`);
    if(!keys(s,['iteration','concurrentWallMs','sequentialWallMs','wallRatio','submissionStartSkewMs','concurrentMutationIds','sequentialMutationIds'])
      ||s.iteration!==i||!equal(s.concurrentMutationIds,con)||!equal(s.sequentialMutationIds,seq)
      ||!finite(s.concurrentWallMs)||!finite(s.sequentialWallMs)||s.sequentialWallMs<=0||!finite(s.wallRatio)
      ||s.wallRatio!==s.concurrentWallMs/s.sequentialWallMs||!finite(s.submissionStartSkewMs)||s.submissionStartSkewMs>=100)throw Error('Invalid calibration sample');
    for(const arm of ['con','seq'])for(const [n,side]of ['a','b'].entries()){
      const startId=`${runId}-cal-${i}-${arm}-${side}-start`;
      const closeId=`${runId}-cal-${i}-${arm}-${n}-reject`;
      expectedIds.push(startId,closeId);
      const start=rpcById.get(startId),close=rpcById.get(closeId),client=n===0?'origin':'observer';
      if(start?.rpc!=='start_session'||close?.rpc!=='reject_session_v2'||start.client!==client||close.client!==client)
        throw Error('Calibration RPC identity mismatch');
    }
    const a=rpcById.get(con[0]),b=rpcById.get(con[1]);
    if(s.submissionStartSkewMs!==Math.abs(Date.parse(a.startedAt)-Date.parse(b.startedAt)))throw Error('Submission skew mismatch');
    if(Date.parse(rpcById.get(seq[1]).startedAt)<Date.parse(rpcById.get(seq[0]).completedAt))throw Error('Sequential ordering mismatch');
  }
  if(!equal([...rpcById.keys()].sort(),expectedIds.sort()))throw Error('Unexpected RPC identities');
  const p95=v.samples.map(s=>s.wallRatio).sort((a,b)=>a-b)[Math.ceil(10*0.95)-1];
  if(v.wallRatioP95!==p95||!finite(p95)||p95>=0.85)throw Error('Calibration performance gate failed');
  return true;
}
export function verifyCalibrationPosttest(manifest,observed,browser,summary,approved){
  if(!/^[a-f0-9]{40}$/.test(approved?.commit??'')||!['sourceSha256','runtimeSha256'].every(k=>/^[a-f0-9]{64}$/.test(approved?.[k]??''))
    ||browser.candidateCommit!==approved.commit||browser.sourceIdentity?.sha256!==approved.sourceSha256
    ||browser.runtimeIdentity?.sha256!==approved.runtimeSha256||sha(JSON.stringify(browser.sourceIdentity?.files))!==approved.sourceSha256
    ||sha(JSON.stringify(browser.runtimeIdentity?.inputs))!==approved.runtimeSha256)throw Error('Approved source/runtime mismatch');
  const env=browser.runtimeIdentity.inputs;
  if(env.E2E_LIFECYCLE_MODE!==mode||env.E2E_RUN_ID!==manifest.runId||env.E2E_V2_ORGANIZATION_ID!=='org-primary'
    ||!['https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev','https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/'].includes(env.E2E_BASE_URL)
    ||manifest.target?.environment!=='staging'||manifest.target?.projectRef!=='tkbdyzxwwbhkpztgjjxh'||manifest.target?.organizationId!=='org-primary'
    ||manifest.readOnly!==true||observed.project_ref!=='tkbdyzxwwbhkpztgjjxh'||!/^normops-\d{8}-\d{4}-[a-z0-9-]+$/.test(manifest.runId??'')
    ||observed.run_id!==manifest.runId||browser.runId!==manifest.runId)throw Error('Staging/run identity mismatch');
  if(browser.mode!==mode||browser.suite!==`operational-lifecycle-${mode}`||browser.expectedTestCount!==1||browser.fullReleaseGate!==false
    ||browser.exitCode!==0||browser.gateError||browser.actorPreflight?.status!=='passed'||!browser.deployedArtifact
    ||!equal(browser.deployedArtifact,browser.postRunArtifact))throw Error('Successful single-case evidence required');
  assertLifecycleSuiteDiscovery(browser.expectedTests,mode);
  assertCompleteLifecycleSummary(summary,browser.expectedTests,manifest.runId);
  zero(observed.global_floor,['open_sessions','open_customer_tabs','recoverable_hopped_sessions','incomplete_operational_mutations','incomplete_financial_mutations']);
  zero(observed.qa_live_residuals,['sessions','customer_tabs','session_items','session_combos','tab_items','tab_combos']);
  zero(observed.same_target_race_integrity,['committed_close_mutations','all_close_mutations','close_audits','close_events','actor_mismatches']);
  if(!keys(manifest.expectedAppState,['md5','bytes','version','updated_at','updated_by'])
    ||!keys(manifest.expectedFunctionDefinitionMd5,['get_operational_performance_dataset_identity','hop_session_v2','link_customer_tab_continuation','open_customer_tab','reject_customer_tab_v2','reject_session_v2','start_session'])
    ||!equal(observed.app_state,manifest.expectedAppState)||!equal(observed.functions,manifest.expectedFunctionDefinitionMd5)
    ||!keys(observed.qa_terminal_evidence,['bills','payments','sessions','customers','audit_logs','customer_tabs','operational_events','financial_mutations','operational_mutations'])
    ||Object.values(observed.qa_terminal_evidence).some(v=>!Number.isSafeInteger(v)||v<0)
    ||['bills','payments','financial_mutations'].some(k=>observed.qa_terminal_evidence?.[k]!==0))throw Error('State/function/financial effects mismatch');
  return {runId:manifest.runId,status:'calibrated-overlap-diagnostics-passed',mode,fullReleaseGate:false};
}
function main(){
  const paths=['manifest','result','browser-manifest','summary'];
  const allowed=[...paths.flatMap(k=>[k,`${k}-sha256`]),'expected-commit','expected-source-sha256','expected-runtime-sha256'];
  const args=process.argv.slice(2),names=args.map(a=>a.match(/^--([^=]+)=.+$/)?.[1]);
  if(!equal([...names].sort(),[...allowed].sort()))throw Error('Exact bound arguments required');
  const value=k=>args.find(a=>a.startsWith(`--${k}=`)).slice(k.length+3);
  const entries=Object.fromEntries(paths.map(k=>{
    const file=path.resolve(value(k)),bytes=fs.readFileSync(file),hash=value(`${k}-sha256`);
    if(!/^[a-f0-9]{64}$/.test(hash)||sha(bytes)!==hash)throw Error('Input hash mismatch');
    return[k,{file,sha256:hash,value:JSON.parse(bytes.toString('utf8'))}];
  }));
  const browser=entries['browser-manifest'].value,raw=entries.result.value;
  if(browser.files?.filter(e=>path.resolve(e.path)===entries.summary.file&&e.sha256===entries.summary.sha256).length!==1)throw Error('Summary not uniquely sealed');
  if(!Array.isArray(raw)||raw.length!==1||!raw[0].evidence)throw Error('Single SQL row required');
  const approved={commit:value('expected-commit'),sourceSha256:value('expected-source-sha256'),runtimeSha256:value('expected-runtime-sha256')};
  const result=verifyCalibrationPosttest(entries.manifest.value,raw[0].evidence,browser,entries.summary.value,approved);
  const matches=browser.files.filter(e=>path.basename(e.path)==='operational-v2-calibrated-overlap.json');
  if(matches.length!==1)throw Error('Canonical timing artifact not uniquely sealed');
  const file=path.resolve(matches[0].path),root=path.resolve('test-artifacts/playwright',`operational-v2-run-${browser.runId}`);
  if(!file.startsWith(root+path.sep))throw Error('Timing path outside run');
  const bytes=fs.readFileSync(file);
  if(sha(bytes)!==matches[0].sha256)throw Error('Timing hash mismatch');
  verifyCalibrationTiming(JSON.parse(bytes.toString('utf8')),browser.runId);
  const receipt={...result,approved,verifiedAt:new Date().toISOString(),timingArtifact:matches[0],lineage:Object.fromEntries(paths.map(k=>[k,entries[k].sha256]))};
  const output=path.join(path.dirname(entries.manifest.file),'calibrated-overlap-posttest-verification.json');
  fs.writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,receipt}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main();
