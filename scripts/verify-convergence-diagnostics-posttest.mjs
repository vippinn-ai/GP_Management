import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertLifecycleSuiteDiscovery, assertCompleteLifecycleSummary } from './lifecycle-runner-guards.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const exactKeys = (value, keys) => value && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
export const PAIR_PHASES = ['prepare.reload.origin','prepare.reload.observer','prepare.synced.origin','prepare.synced.observer','overlap.reload.observer','overlap.rpc.origin','overlap.rpc.observer','converge.synced.observer','converge.reconcile.origin','converge.reconcile.observer','converge.absent.origin','converge.absent.observer'];
export function verifyPairTimingArtifact(value, runId) {
  if (value?.runId !== runId || value.samples !== 50 || value.cases?.length !== 50 || value.pairDiagnostics?.length !== 50
    || !isDeepStrictEqual(value.matrix, {sessionSession:4,sessionTab:3,tabTab:43})) throw new Error('Incomplete timing artifact.');
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  for (let index=0; index<50; index++) {
    const c=value.cases[index], d=value.pairDiagnostics[index], iteration=index+1;
    const matrix=iteration<=4?'session/session':iteration<=7?'session/tab':'tab/tab';
    if (c.iteration!==iteration || d.iteration!==iteration || c.matrixType!==matrix || d.matrixType!==matrix
      || d.completed!==true || d.budgetOutcome!=='passed' || !finite(d.pairStartedOffsetMs)
      || !isDeepStrictEqual(c.mutationIds,d.mutationIds) || !isDeepStrictEqual(c.targets?.map(t=>t.id),d.targetIds)
      || d.phases?.length!==PAIR_PHASES.length || !isDeepStrictEqual(d.phases.map(p=>p.phase).sort(),[...PAIR_PHASES].sort())) throw new Error('Pair identity, completion or phase mismatch.');
    for (const key of ['rpcPairMs','rpcAndReloadMs','browserCompletionMs']) if (!finite(d[key]) || c[key]!==d[key]) throw new Error('Pair timing mismatch.');
    if (d.browserCompletionMs>=7000 || d.rpcPairMs>d.rpcAndReloadMs || d.rpcAndReloadMs>d.browserCompletionMs) throw new Error('Pair timing budget/order failed.');
    for(const p of d.phases) if(p.outcome!=='passed' || !finite(p.startedMs) || !finite(p.endedMs) || !finite(p.durationMs) || p.endedMs<p.startedMs || Math.abs(p.endedMs-p.startedMs-p.durationMs)>0.03) throw new Error('Invalid phase span.');
  }
  return true;
}
function zeros(value, keys) {
  if (!exactKeys(value, keys) || keys.some(key => value[key] !== 0)) throw new Error('Missing, extra, coerced or nonzero reconciliation counts.');
}
export function verifyConvergenceDiagnosticsPosttest(manifest, observed, browser, summary, approved) {
  if (!/^[a-f0-9]{40}$/.test(approved?.commit ?? '') || !/^[a-f0-9]{64}$/.test(approved?.sourceSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(approved?.runtimeSha256 ?? '')) throw new Error('Explicit approved candidate/source/runtime bindings required.');
  if (browser.candidateCommit !== approved.commit || browser.sourceIdentity?.sha256 !== approved.sourceSha256
    || browser.runtimeIdentity?.sha256 !== approved.runtimeSha256
    || sha(JSON.stringify(browser.sourceIdentity?.files)) !== approved.sourceSha256
    || sha(JSON.stringify(browser.runtimeIdentity?.inputs)) !== approved.runtimeSha256) throw new Error('Candidate/source/runtime identity mismatch.');
  const inputs = browser.runtimeIdentity.inputs;
  if (inputs.E2E_LIFECYCLE_MODE !== 'convergence-diagnostics' || inputs.E2E_RUN_ID !== manifest.runId
    || !['https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev','https://gp-management-staging-pages.breakperfectgaminglounge.workers.dev/'].includes(inputs.E2E_BASE_URL)
    || inputs.E2E_V2_ORGANIZATION_ID !== 'org-primary') throw new Error('Runtime environment identity mismatch.');
  if (manifest.target?.projectRef !== 'tkbdyzxwwbhkpztgjjxh' || manifest.target?.organizationId !== 'org-primary'
    || manifest.target?.environment !== 'staging' || manifest.readOnly !== true
    || observed.project_ref !== 'tkbdyzxwwbhkpztgjjxh' || !/^normops-\d{8}-\d{4}-[a-z0-9-]+$/i.test(manifest.runId ?? '')
    || observed.run_id !== manifest.runId || browser.runId !== manifest.runId) throw new Error('Staging/run identity mismatch.');
  if (browser.mode !== 'convergence-diagnostics' || browser.suite !== 'operational-lifecycle-convergence-diagnostics'
    || browser.expectedTestCount !== 1 || browser.fullReleaseGate !== false || browser.exitCode !== 0 || browser.gateError
    || browser.actorPreflight?.status !== 'passed' || !browser.deployedArtifact
    || !isDeepStrictEqual(browser.deployedArtifact, browser.postRunArtifact)) throw new Error('Successful fixed diagnostic evidence required.');
  assertLifecycleSuiteDiscovery(browser.expectedTests, 'convergence-diagnostics');
  assertCompleteLifecycleSummary(summary, browser.expectedTests, manifest.runId);
  zeros(observed.global_floor, ['open_sessions', 'open_customer_tabs', 'recoverable_hopped_sessions', 'incomplete_operational_mutations', 'incomplete_financial_mutations']);
  zeros(observed.qa_live_residuals, ['sessions', 'customer_tabs', 'session_items', 'session_combos', 'tab_items', 'tab_combos']);
  zeros(observed.same_target_race_integrity, ['committed_close_mutations', 'all_close_mutations', 'close_audits', 'close_events', 'actor_mismatches']);
  if (!exactKeys(manifest.expectedAppState, ['md5', 'bytes', 'version', 'updated_at', 'updated_by'])
    || !exactKeys(manifest.expectedFunctionDefinitionMd5, ['get_operational_performance_dataset_identity', 'hop_session_v2', 'link_customer_tab_continuation', 'open_customer_tab', 'reject_customer_tab_v2', 'reject_session_v2', 'start_session'])
    || !isDeepStrictEqual(observed.app_state, manifest.expectedAppState)
    || !isDeepStrictEqual(observed.functions, manifest.expectedFunctionDefinitionMd5)) throw new Error('Baseline state or function drift.');
  return { runId: manifest.runId, status: 'convergence-diagnostics-passed', mode: 'convergence-diagnostics', fullReleaseGate: false,
    appStateUnchanged: true, globalFloorClean: true, qaLiveResidualsClean: true };
}

function main() {
  const paths = ['manifest', 'result', 'browser-manifest', 'summary'];
  const allowed = [...paths.flatMap(name => [name, `${name}-sha256`]), 'expected-commit', 'expected-source-sha256', 'expected-runtime-sha256'];
  const args = process.argv.slice(2);
  const names = args.map(arg => arg.match(/^--([^=]+)=.+$/)?.[1]);
  if (args.length !== allowed.length || !isDeepStrictEqual([...names].sort(), [...allowed].sort())) throw new Error('Exact bound paths and approved identities required.');
  const value = key => args.find(arg => arg.startsWith(`--${key}=`)).slice(key.length + 3);
  const entries = Object.fromEntries(paths.map(name => {
    const file = path.resolve(value(name)), bytes = fs.readFileSync(file), digest = value(`${name}-sha256`);
    if (!/^[a-f0-9]{64}$/.test(digest) || sha(bytes) !== digest) throw new Error(`Hash mismatch: ${name}`);
    return [name, { file, sha256: digest, value: JSON.parse(bytes.toString('utf8')) }];
  }));
  const browser = entries['browser-manifest'].value;
  if (browser.files?.filter(entry => path.resolve(entry.path) === entries.summary.file && entry.sha256 === entries.summary.sha256).length !== 1) throw new Error('Summary is not uniquely sealed by browser manifest.');
  const raw = entries.result.value;
  if (!Array.isArray(raw) || raw.length !== 1 || !raw[0].evidence) throw new Error('Exactly one raw SQL evidence row required.');
  const approved = { commit: value('expected-commit'), sourceSha256: value('expected-source-sha256'), runtimeSha256: value('expected-runtime-sha256') };
  const result = verifyConvergenceDiagnosticsPosttest(entries.manifest.value, raw[0].evidence, browser, entries.summary.value, approved);
  const artifactRoot=path.resolve('test-artifacts/playwright',`operational-v2-run-${browser.runId}`);
  const timingEntries=browser.files.filter(entry => path.basename(entry.path)==='operational-v2-50-unrelated-reload-races.json');
  if(timingEntries.length!==1) throw new Error('Exactly one canonical sealed timing artifact required.');
  const timingPath=path.resolve(timingEntries[0].path);
  if(!timingPath.startsWith(artifactRoot+path.sep)) throw new Error('Timing artifact outside run output.');
  const timingBytes=fs.readFileSync(timingPath);
  if(sha(timingBytes)!==timingEntries[0].sha256) throw new Error('Timing artifact hash mismatch.');
  verifyPairTimingArtifact(JSON.parse(timingBytes.toString('utf8')),browser.runId);
  const receipt = { ...result, approved, timingArtifact:timingEntries[0], verifiedAt: new Date().toISOString(), lineage: Object.fromEntries(paths.map(name => [name, entries[name].sha256])) };
  const output = path.join(path.dirname(entries.manifest.file), 'convergence-diagnostics-posttest-verification.json');
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, receipt }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
