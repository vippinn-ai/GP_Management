import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONVERGENCE_DIAGNOSTIC_TESTS as cases, INVENTORY_CONTRACT_TESTS, parseLifecycleArguments, lifecycleSuiteContract, lifecycleSelectionArguments, assertLifecycleSuiteDiscovery } from './lifecycle-runner-guards.mjs';
import { verifyConvergenceDiagnosticsPosttest as check, verifyPairTimingArtifact, PAIR_PHASES } from './verify-convergence-diagnostics-posttest.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const structuredClone = value => JSON.parse(JSON.stringify(value));
function fixture(runId = 'normops-20261016-2000-convergence') {
  const app = { md5: 'a', bytes: 1000, version: 735, updated_at: 'time', updated_by: 'actor' };
  const functions = Object.fromEntries(['get_operational_performance_dataset_identity','hop_session_v2','link_customer_tab_continuation','open_customer_tab','reject_customer_tab_v2','reject_session_v2','start_session'].map(key => [key, 'md5']));
  const zeros = keys => Object.fromEntries(keys.map(key => [key, 0]));
  const files = [{ path: 'source.ts', sha256: 'a'.repeat(64) }];
  const inputs = { E2E_RUN_ID: runId, E2E_LIFECYCLE_MODE: 'convergence-diagnostics', E2E_BASE_URL: 'https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev', E2E_V2_ORGANIZATION_ID: 'org-primary' };
  return [
    { runId, target: { environment: 'staging', projectRef: 'tkbdyzxwwbhkpztgjjxh', organizationId: 'org-primary' }, readOnly: true, expectedAppState: app, expectedFunctionDefinitionMd5: functions },
    { run_id: runId, project_ref: 'tkbdyzxwwbhkpztgjjxh', app_state: structuredClone(app), functions: structuredClone(functions), global_floor: zeros(['open_sessions','open_customer_tabs','recoverable_hopped_sessions','incomplete_operational_mutations','incomplete_financial_mutations']), qa_live_residuals: zeros(['sessions','customer_tabs','session_items','session_combos','tab_items','tab_combos']), same_target_race_integrity: zeros(['committed_close_mutations','all_close_mutations','close_audits','close_events','actor_mismatches']) },
    { ...lifecycleSuiteContract('convergence-diagnostics'), runId, exitCode: 0, candidateCommit: 'a'.repeat(40), sourceIdentity: { files, sha256: hash(files) }, runtimeIdentity: { inputs, sha256: hash(inputs) }, expectedTests: structuredClone(cases), actorPreflight: { status: 'passed' }, deployedArtifact: { sha256: 'bundle' }, postRunArtifact: { sha256: 'bundle' } },
    { runId, status: 'passed', tests: cases.map(entry => ({ ...entry, status: 'passed', retry: 0 })) },
    { commit: 'a'.repeat(40), sourceSha256: hash(files), runtimeSha256: hash(inputs) }
  ];
}
test('fixed mode admits only exact invocation and one identity; previous contracts unchanged', () => {
  assert.equal(parseLifecycleArguments(['--convergence-diagnostics']).discoveryOnly, false);
  assert.equal(parseLifecycleArguments(['--convergence-diagnostics','--list']).discoveryOnly, true);
  for (const args of [['--list','--convergence-diagnostics'], ['--convergence-diagnostics','--grep=x'], ['--convergence-diagnostics','--retries=1'], ['--convergence-diagnostics','--inventory-contract']]) assert.throws(() => parseLifecycleArguments(args));
  assert.equal(assertLifecycleSuiteDiscovery(cases,'convergence-diagnostics').fullReleaseGate,false);
  for (const entries of [[], [...cases,...cases], INVENTORY_CONTRACT_TESTS, cases.map(x => ({...x,title:x.title+' extra'})), cases.map(x => ({...x,project:'other'})), cases.map(x => ({...x,file:'other'}))]) assert.throws(() => assertLifecycleSuiteDiscovery(entries,'convergence-diagnostics'));
  const pattern = new RegExp(lifecycleSelectionArguments('convergence-diagnostics')[1]);
  assert.ok(pattern.test(cases[0].title.replaceAll(' > ',' ')));
  assert.ok(!pattern.test(cases[0].title.replaceAll(' > ',' ')+' extra'));
  assert.equal(lifecycleSuiteContract('full').expectedTestCount,31);
  assert.equal(lifecycleSuiteContract('inventory-contract').expectedTestCount,2);
});
test('strict supplemental postflight accepts fresh exact evidence without release credit', () => {
  assert.deepEqual(check(...fixture()), {runId:'normops-20261016-2000-convergence',status:'convergence-diagnostics-passed',mode:'convergence-diagnostics',fullReleaseGate:false,appStateUnchanged:true,globalFloorClean:true,qaLiveResidualsClean:true});
});
test('rejects identity, source/runtime, suite, state, bundle, role and result drift', () => {
  for (const mutate of [
    x=>x[0].target.environment='production', x=>x[1].run_id='other', x=>x[0].readOnly=false,
    x=>x[2].mode='full', x=>x[2].mode='inventory-contract', x=>x[2].fullReleaseGate=true, x=>x[2].expectedTestCount=31,
    x=>x[2].candidateCommit='b'.repeat(40), x=>x[2].sourceIdentity.files[0].path='other', x=>x[2].runtimeIdentity.inputs.E2E_LIFECYCLE_MODE='full',
    x=>x[4].sourceSha256='b'.repeat(64), x=>x[4].runtimeSha256='b'.repeat(64),
    x=>x[1].app_state.version++, x=>delete x[0].expectedAppState.md5, x=>x[1].functions.start_session='other',
    x=>x[2].actorPreflight.status='failed', x=>x[2].postRunArtifact.sha256='other', x=>x[2].exitCode=1,
    x=>x[3].tests[0].retry=1, x=>x[3].tests[0].status='skipped', x=>x[3].tests=[], x=>x[3].tests.push(x[3].tests[0]), x=>x[2].expectedTests=[],
  ]) { const value=fixture(); mutate(value); assert.throws(()=>check(...value)); }
});
test('every floor, residual and same-target count is exact numeric zero', () => {
  for (const field of ['global_floor','qa_live_residuals','same_target_race_integrity']) {
    for (const key of Object.keys(fixture()[1][field])) for (const invalid of [1, '0', false, null]) {
      const value=fixture(); value[1][field][key]=invalid; assert.throws(()=>check(...value));
    }
    for(const mutate of [x=>delete x[1][field],x=>delete x[1][field][Object.keys(x[1][field])[0]],x=>x[1][field].extra=0]) { const value=fixture(); mutate(value); assert.throws(()=>check(...value)); }
  }
});

test('CLI binds hashes, raw shape and unique summary seal; receipt is exclusive', () => {
  const root=process.cwd(), temp=path.resolve(root,'test-artifacts/local-temp');
  fs.mkdirSync(temp,{recursive:true});
  const dir=fs.mkdtempSync(path.join(temp,'convergence-posttest-'));
  assert.ok(path.resolve(dir).startsWith(temp+path.sep));
  let sequence=0;
  const write=(name,value)=>{ const file=path.join(dir,`${sequence++}-${name}.json`),bytes=JSON.stringify(value); fs.writeFileSync(file,bytes,{flag:'wx'}); return {file,sha256:createHash('sha256').update(bytes).digest('hex')}; };
  const f=fixture(`normops-20261016-2000-local-${path.basename(dir).toLowerCase()}`), summary=write('summary',f[3]);
  const seal={path:summary.file,sha256:summary.sha256};
  const outputRoot=path.resolve(root,'test-artifacts/playwright',`operational-v2-run-${f[0].runId}`);
  assert.ok(outputRoot.startsWith(path.resolve(root,'test-artifacts/playwright')+path.sep));
  assert.equal(fs.existsSync(outputRoot),false,'Local fixture must not reuse an existing output directory');
  fs.mkdirSync(outputRoot, {recursive:true});
  const timingPath=path.join(outputRoot,'operational-v2-50-unrelated-reload-races.json'),timingBytes=JSON.stringify(timingFixture(f[0].runId));
  fs.writeFileSync(timingPath,timingBytes,{flag:'wx'});
  const timingSeal={path:timingPath,sha256:createHash('sha256').update(timingBytes).digest('hex')};
  f[2].files=[seal,timingSeal];
  const entries={manifest:write('manifest',f[0]),result:write('result',[{evidence:f[1]}]),'browser-manifest':write('browser',f[2]),summary};
  const args=(e=entries)=>[...Object.entries(e).flatMap(([name,item])=>[`--${name}=${item.file}`,`--${name}-sha256=${item.sha256}`]),`--expected-commit=${f[4].commit}`,`--expected-source-sha256=${f[4].sourceSha256}`,`--expected-runtime-sha256=${f[4].runtimeSha256}`];
  const run=a=>spawnSync(process.execPath,['scripts/verify-convergence-diagnostics-posttest.mjs',...a],{cwd:root,encoding:'utf8',windowsHide:true});
  try {
    assert.notEqual(run(args().slice(0,-1)).status,0);
    for(const name of Object.keys(entries)) assert.notEqual(run(args({...entries,[name]:{...entries[name],sha256:'0'.repeat(64)}})).status,0);
    for(const raw of [[],[{},{}],[{}]]) assert.notEqual(run(args({...entries,result:write('bad-raw',raw)})).status,0);
    for(const files of [[],[seal,seal],[{...seal,sha256:'0'.repeat(64)}],[{...seal,path:path.join(dir,'wrong.json')}]]) assert.notEqual(run(args({...entries,'browser-manifest':write('bad-seal',{...f[2],files})})).status,0);
    for(const files of [[seal],[seal,timingSeal,timingSeal],[seal,{...timingSeal,sha256:'0'.repeat(64)}],[seal,{...timingSeal,path:path.join(dir,path.basename(timingPath))}]]) assert.notEqual(run(args({...entries,'browser-manifest':write('bad-timing-seal',{...f[2],files})})).status,0);
    const first=run(args()); assert.equal(first.status,0,first.stderr);
    const receipt=path.join(dir,'convergence-diagnostics-posttest-verification.json'), bytes=fs.readFileSync(receipt);
    assert.notEqual(run(args()).status,0); assert.deepEqual(fs.readFileSync(receipt),bytes);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); fs.rmSync(outputRoot,{recursive:true,force:true}); }
});

function timingFixture(runId) {
  const cases=Array.from({length:50},(_,i)=>({iteration:i+1,matrixType:i<4?'session/session':i<7?'session/tab':'tab/tab',targets:[{id:`a${i}`},{id:`b${i}`}],mutationIds:[`m${i}`,`n${i}`],rpcPairMs:1,rpcAndReloadMs:2,browserCompletionMs:3}));
  return {runId,samples:50,matrix:{sessionSession:4,sessionTab:3,tabTab:43},cases,pairDiagnostics:cases.map(c=>({...c,targetIds:c.targets.map(t=>t.id),completed:true,budgetOutcome:'passed',pairStartedOffsetMs:0,phases:PAIR_PHASES.map(phase=>({phase,startedMs:0,endedMs:1,durationMs:1,outcome:'passed'}))}))};
}
test('sealed diagnostic content requires exact50 unique complete pairs and unchanged strict budget',()=>{
  assert.equal(verifyPairTimingArtifact(timingFixture('run'),'run'),true);
  for(const mutate of [x=>x.samples=49,x=>x.runId='other',x=>x.cases.pop(),x=>x.pairDiagnostics.pop(),x=>x.matrix.tabTab=42,
    x=>x.pairDiagnostics[0].iteration=2,x=>x.pairDiagnostics[0].matrixType='tab/tab',x=>x.pairDiagnostics[0].completed=false,
    x=>x.pairDiagnostics[0].budgetOutcome='failed',x=>x.pairDiagnostics[0].browserCompletionMs=7000,x=>x.cases[0].rpcPairMs=7,
    x=>x.pairDiagnostics[0].phases.pop(),x=>x.pairDiagnostics[0].phases[0].phase='other',x=>x.pairDiagnostics[0].phases[0].outcome='failed',
    x=>x.pairDiagnostics[0].phases[0].durationMs=-1,x=>x.pairDiagnostics[0].phases[0].endedMs=Infinity,x=>x.pairDiagnostics[0].phases[0].durationMs=2,
    x=>x.pairDiagnostics[0].mutationIds=['other'],x=>x.pairDiagnostics[0].targetIds=['other']]) {const value=timingFixture('run');mutate(value);assert.throws(()=>verifyPairTimingArtifact(value,'run'));}
});
