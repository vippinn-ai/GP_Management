import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  CALIBRATED_OVERLAP_TESTS as cases,
  INVENTORY_CONTRACT_TESTS,
  parseLifecycleArguments,
  lifecycleSuiteContract,
  lifecycleSelectionArguments,
  assertLifecycleSuiteDiscovery
} from './lifecycle-runner-guards.mjs';
import {verifyCalibrationTiming,verifyCalibrationPosttest} from './verify-calibrated-overlap-posttest.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const jsonHash=value=>digest(JSON.stringify(value));
const clone=value=>JSON.parse(JSON.stringify(value));
const zeros=keys=>Object.fromEntries(keys.map(key=>[key,0]));

function timingFixture(runId='normops-20261020-1900-calibrated-overlap') {
  const directRpcEvidence=[];
  const samples=[];
  for(let iteration=1;iteration<=10;iteration++) {
    const concurrentMutationIds=[0,1].map(n=>`${runId}-cal-${iteration}-con-${n}-reject`);
    const sequentialMutationIds=[0,1].map(n=>`${runId}-cal-${iteration}-seq-${n}-reject`);
    const base=Date.parse('2026-10-20T00:00:00Z')+iteration*10_000;
    for(const [arm,offset] of [['con',0],['seq',4_000]]) for(const [n,side] of ['a','b'].entries()) {
      const startAt=base+offset+n*(arm==='con'?10:1_000);
      const startDone=startAt+100;
      const closeAt=arm==='seq'?startDone+n*1_000:startDone+n*10;
      const closeDone=closeAt+100;
      directRpcEvidence.push({client:n===0?'origin':'observer',rpc:'start_session',mutationId:`${runId}-cal-${iteration}-${arm}-${side}-start`,startedAt:new Date(startAt).toISOString(),completedAt:new Date(startDone).toISOString(),elapsedMs:100,status:200,serverDurationMs:null});
      directRpcEvidence.push({client:n===0?'origin':'observer',rpc:'reject_session_v2',mutationId:`${runId}-cal-${iteration}-${arm}-${n}-reject`,startedAt:new Date(closeAt).toISOString(),completedAt:new Date(closeDone).toISOString(),elapsedMs:100,status:200,serverDurationMs:10});
    }
    samples.push({iteration,concurrentWallMs:80,sequentialWallMs:100,wallRatio:.8,submissionStartSkewMs:20,concurrentMutationIds,sequentialMutationIds});
  }
  return {runId,iteration:10,stage:'complete',completed:true,budgetOutcome:'passed',wallRatioP95:.8,samples,directRpcEvidence};
}

function fixture(runId='normops-20261020-1900-calibrated-overlap') {
  const app={md5:'a',bytes:1000,version:735,updated_at:'time',updated_by:'actor'};
  const functions=Object.fromEntries(['get_operational_performance_dataset_identity','hop_session_v2','link_customer_tab_continuation','open_customer_tab','reject_customer_tab_v2','reject_session_v2','start_session'].map(key=>[key,'md5']));
  const files=[{path:'source.ts',sha256:'a'.repeat(64)}];
  const inputs={E2E_RUN_ID:runId,E2E_LIFECYCLE_MODE:'calibrated-overlap-diagnostics',E2E_BASE_URL:'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/',E2E_V2_ORGANIZATION_ID:'org-primary'};
  return [
    {runId,target:{environment:'staging',projectRef:'tkbdyzxwwbhkpztgjjxh',organizationId:'org-primary'},readOnly:true,expectedAppState:app,expectedFunctionDefinitionMd5:functions},
    {run_id:runId,project_ref:'tkbdyzxwwbhkpztgjjxh',app_state:clone(app),functions:clone(functions),global_floor:zeros(['open_sessions','open_customer_tabs','recoverable_hopped_sessions','incomplete_operational_mutations','incomplete_financial_mutations']),qa_live_residuals:zeros(['sessions','customer_tabs','session_items','session_combos','tab_items','tab_combos']),same_target_race_integrity:zeros(['committed_close_mutations','all_close_mutations','close_audits','close_events','actor_mismatches']),qa_terminal_evidence:{bills:0,payments:0,sessions:20,customers:20,audit_logs:20,customer_tabs:0,operational_events:40,financial_mutations:0,operational_mutations:20}},
    {...lifecycleSuiteContract('calibrated-overlap-diagnostics'),runId,exitCode:0,candidateCommit:'a'.repeat(40),sourceIdentity:{files,sha256:jsonHash(files)},runtimeIdentity:{inputs,sha256:jsonHash(inputs)},expectedTests:clone(cases),actorPreflight:{status:'passed'},deployedArtifact:{sha256:'bundle'},postRunArtifact:{sha256:'bundle'}},
    {runId,status:'passed',tests:cases.map(entry=>({...entry,status:'passed',retry:0}))},
    {commit:'a'.repeat(40),sourceSha256:jsonHash(files),runtimeSha256:jsonHash(inputs)}
  ];
}

test('selector admits only the exact fixed one-case mode and preserves other suite sizes',()=>{
  assert.deepEqual(parseLifecycleArguments(['--calibrated-overlap-diagnostics']),{discoveryOnly:false,args:[],mode:'calibrated-overlap-diagnostics'});
  assert.deepEqual(parseLifecycleArguments(['--calibrated-overlap-diagnostics','--list']),{discoveryOnly:true,args:['--list'],mode:'calibrated-overlap-diagnostics'});
  for(const args of [['--list','--calibrated-overlap-diagnostics'],['--calibrated-overlap-diagnostics','--grep=x'],['--calibrated-overlap-diagnostics','--retries=1'],['--calibrated-overlap-diagnostics','--inventory-contract']]) assert.throws(()=>parseLifecycleArguments(args));
  assert.equal(assertLifecycleSuiteDiscovery(cases,'calibrated-overlap-diagnostics').fullReleaseGate,false);
  for(const invalid of [[],[...cases,...cases],INVENTORY_CONTRACT_TESTS,cases.map(x=>({...x,title:`${x.title} extra`})),cases.map(x=>({...x,file:'other'})),cases.map(x=>({...x,project:'other'}))]) assert.throws(()=>assertLifecycleSuiteDiscovery(invalid,'calibrated-overlap-diagnostics'));
  const pattern=new RegExp(lifecycleSelectionArguments('calibrated-overlap-diagnostics')[1]);
  assert.ok(pattern.test(cases[0].title.replaceAll(' > ',' ')));
  assert.ok(!pattern.test(`${cases[0].title.replaceAll(' > ',' ')} extra`));
  assert.equal(lifecycleSuiteContract('full').expectedTestCount,31);
  assert.equal(lifecycleSuiteContract('inventory-contract').expectedTestCount,2);
});

test('strict verifier accepts exact non-release evidence',()=>{
  assert.deepEqual(verifyCalibrationPosttest(...fixture()),{runId:'normops-20261020-1900-calibrated-overlap',status:'calibrated-overlap-diagnostics-passed',mode:'calibrated-overlap-diagnostics',fullReleaseGate:false});
  assert.equal(verifyCalibrationTiming(timingFixture(),'normops-20261020-1900-calibrated-overlap'),true);
});

test('timing evidence rejects partial, threshold, cardinality, identity, ordering and numeric drift',()=>{
  for(const mutate of [
    x=>x.runId='other',x=>x.iteration=9,x=>x.stage='budget',x=>x.completed=false,x=>x.budgetOutcome='failed',x=>x.wallRatioP95=.85,
    x=>x.samples.pop(),x=>x.directRpcEvidence.pop(),x=>x.samples[0].iteration=2,x=>x.samples[0].concurrentWallMs=Infinity,
    x=>x.samples[0].wallRatio=.7,x=>x.samples[0].submissionStartSkewMs=100,x=>x.samples[0].concurrentMutationIds[0]='other',
    x=>x.directRpcEvidence[0].status=400,x=>x.directRpcEvidence[0].elapsedMs=-1,x=>x.directRpcEvidence[0].serverDurationMs=-1,
    x=>x.directRpcEvidence[0].completedAt='bad',x=>x.directRpcEvidence[1].mutationId=x.directRpcEvidence[0].mutationId,
    x=>x.directRpcEvidence.find(e=>e.mutationId.includes('-seq-1-reject')).startedAt='2026-10-19T00:00:00Z'
  ]) {const value=timingFixture();mutate(value);assert.throws(()=>verifyCalibrationTiming(value,value.runId==='other'?'normops-20261020-1900-calibrated-overlap':value.runId));}
});

test('postflight rejects source, runtime, suite, result, floor, state and financial drift',()=>{
  for(const mutate of [
    x=>x[0].target.environment='production',x=>x[0].readOnly=false,x=>x[1].run_id='other',x=>x[2].mode='full',x=>x[2].fullReleaseGate=true,
    x=>x[2].candidateCommit='b'.repeat(40),x=>x[2].sourceIdentity.files[0].path='other',x=>x[2].runtimeIdentity.inputs.E2E_LIFECYCLE_MODE='full',
    x=>x[4].sourceSha256='b'.repeat(64),x=>x[4].runtimeSha256='b'.repeat(64),x=>x[2].actorPreflight.status='failed',
    x=>x[2].postRunArtifact.sha256='other',x=>x[2].exitCode=1,x=>x[3].tests[0].retry=1,x=>x[3].tests[0].status='failed',
    x=>x[3].tests=[],x=>x[3].tests.push(x[3].tests[0]),x=>x[1].global_floor.open_sessions=1,x=>x[1].qa_live_residuals.sessions=1,
    x=>x[1].same_target_race_integrity.close_events=1,x=>x[1].app_state.version++,x=>x[1].functions.start_session='other',
    x=>x[1].qa_terminal_evidence.bills=1,x=>x[1].qa_terminal_evidence.payments='0',x=>x[1].qa_terminal_evidence.financial_mutations=null,
    x=>delete x[1].qa_terminal_evidence.sessions,x=>x[1].qa_terminal_evidence.extra=0,x=>x[1].qa_terminal_evidence.customers=-1,
    x=>x[1].qa_terminal_evidence.audit_logs=1.5,x=>x[1].qa_terminal_evidence.customer_tabs=Number.MAX_SAFE_INTEGER+1,
    x=>x[1].qa_terminal_evidence.operational_events='40',x=>x[1].qa_terminal_evidence.operational_mutations=NaN
  ]) {const value=fixture();mutate(value);assert.throws(()=>verifyCalibrationPosttest(...value));}
});

test('CLI binds all hashes, exact raw shape, unique seals, timing containment and wx receipt',()=>{
  const root=process.cwd(),temp=path.resolve(root,'test-artifacts/local-temp');
  fs.mkdirSync(temp,{recursive:true});
  const dir=fs.mkdtempSync(path.join(temp,'calibrated-posttest-'));
  assert.ok(path.resolve(dir).startsWith(temp+path.sep));
  let sequence=0;
  const write=(name,value)=>{const file=path.join(dir,`${sequence++}-${name}.json`),bytes=JSON.stringify(value);fs.writeFileSync(file,bytes,{flag:'wx'});return{file,sha256:digest(bytes)};};
  const f=fixture(`normops-20261020-1900-local-${path.basename(dir).toLowerCase()}`),summary=write('summary',f[3]);
  const outputRoot=path.resolve(root,'test-artifacts/playwright',`operational-v2-run-${f[0].runId}`);
  assert.ok(outputRoot.startsWith(path.resolve(root,'test-artifacts/playwright')+path.sep));
  assert.equal(fs.existsSync(outputRoot),false);
  fs.mkdirSync(outputRoot,{recursive:true});
  const timingPath=path.join(outputRoot,'operational-v2-calibrated-overlap.json'),timingBytes=JSON.stringify(timingFixture(f[0].runId));
  fs.writeFileSync(timingPath,timingBytes,{flag:'wx'});
  const summarySeal={path:summary.file,sha256:summary.sha256},timingSeal={path:timingPath,sha256:digest(timingBytes)};
  f[2].files=[summarySeal,timingSeal];
  const entries={manifest:write('manifest',f[0]),result:write('result',[{evidence:f[1]}]),'browser-manifest':write('browser',f[2]),summary};
  const args=(e=entries)=>[...Object.entries(e).flatMap(([name,item])=>[`--${name}=${item.file}`,`--${name}-sha256=${item.sha256}`]),`--expected-commit=${f[4].commit}`,`--expected-source-sha256=${f[4].sourceSha256}`,`--expected-runtime-sha256=${f[4].runtimeSha256}`];
  const run=a=>spawnSync(process.execPath,['scripts/verify-calibrated-overlap-posttest.mjs',...a],{cwd:root,encoding:'utf8',windowsHide:true});
  try {
    assert.notEqual(run(args().slice(0,-1)).status,0);
    for(const name of Object.keys(entries)) assert.notEqual(run(args({...entries,[name]:{...entries[name],sha256:'0'.repeat(64)}})).status,0);
    for(const raw of [[],[{},{}],[{}],{evidence:f[1]}]) assert.notEqual(run(args({...entries,result:write('bad-raw',raw)})).status,0);
    for(const files of [[],[summarySeal,summarySeal,timingSeal],[{...summarySeal,sha256:'0'.repeat(64)},timingSeal],[{...summarySeal,path:path.join(dir,'wrong.json')},timingSeal]]) assert.notEqual(run(args({...entries,'browser-manifest':write('bad-summary-seal',{...f[2],files})})).status,0);
    for(const files of [[summarySeal],[summarySeal,timingSeal,timingSeal],[summarySeal,{...timingSeal,sha256:'0'.repeat(64)}],[summarySeal,{...timingSeal,path:path.join(dir,path.basename(timingPath))}]]) assert.notEqual(run(args({...entries,'browser-manifest':write('bad-timing-seal',{...f[2],files})})).status,0);
    const first=run(args());assert.equal(first.status,0,first.stderr);
    const receipt=path.join(dir,'calibrated-overlap-posttest-verification.json'),bytes=fs.readFileSync(receipt);
    assert.notEqual(run(args()).status,0);assert.deepEqual(fs.readFileSync(receipt),bytes);
  } finally {fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(outputRoot,{recursive:true,force:true});}
});
