import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertLifecycleSuiteDiscovery, assertCompleteLifecycleSummary } from './lifecycle-runner-guards.mjs';

const FLOOR = ['open_sessions', 'open_customer_tabs', 'recoverable_hopped_sessions', 'incomplete_operational_mutations', 'incomplete_financial_mutations'];
const RESIDUALS = ['sessions', 'customer_tabs', 'session_items', 'session_combos', 'tab_items', 'tab_combos'];
const RACES = ['committed_close_mutations', 'all_close_mutations', 'close_audits', 'close_events', 'actor_mismatches'];
function exactZeros(value, keys) {
  if (!value || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()) || keys.some(key => value[key] !== 0)) {
    throw new Error('Missing, extra, or nonzero reconciliation counts.');
  }
}

export function verifyInventoryContractPosttest(manifest, observed, browser, summary) {
  if (manifest.target?.projectRef !== 'tkbdyzxwwbhkpztgjjxh' || manifest.target?.organizationId !== 'org-primary'
    || manifest.readOnly !== true || observed.project_ref !== 'tkbdyzxwwbhkpztgjjxh'
    || !/^normops-\d{8}-\d{4}-[a-z0-9-]+$/i.test(manifest.runId ?? '')
    || observed.run_id !== manifest.runId || browser.runId !== manifest.runId) throw new Error('Staging/run identity mismatch.');
  if (browser.mode !== 'inventory-contract' || browser.suite !== 'operational-lifecycle-inventory-contract'
    || browser.expectedTestCount !== 2 || browser.fullReleaseGate !== false || browser.exitCode !== 0 || browser.gateError) {
    throw new Error('A successful supplemental inventory contract manifest is required.');
  }
  assertLifecycleSuiteDiscovery(browser.expectedTests, 'inventory-contract');
  assertCompleteLifecycleSummary(summary, browser.expectedTests, manifest.runId);
  exactZeros(observed.global_floor, FLOOR);
  exactZeros(observed.qa_live_residuals, RESIDUALS);
  exactZeros(observed.same_target_race_integrity, RACES);
  if (!manifest.expectedAppState || Object.keys(manifest.expectedAppState).length !== 5
    || !manifest.expectedFunctionDefinitionMd5 || Object.keys(manifest.expectedFunctionDefinitionMd5).length !== 7
    || !isDeepStrictEqual(observed.app_state, manifest.expectedAppState)
    || !isDeepStrictEqual(observed.functions, manifest.expectedFunctionDefinitionMd5)) throw new Error('Baseline state or function drift.');
  return { runId: manifest.runId, status: 'focused-passed', mode: 'inventory-contract', fullReleaseGate: false,
    appStateUnchanged: true, globalFloorClean: true, qaLiveResidualsClean: true };
}

function main() {
  const allowed = ['manifest', 'result', 'browser-manifest', 'summary'];
  const args = process.argv.slice(2);
  if (args.length !== 8 || new Set(args.map(arg => arg.split('=')[0])).size !== 8) throw new Error('Exactly four paths and their SHA-256 arguments are required.');
  const read = (name) => {
    const value = (key) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
    const file = value(name), sha = value(`${name}-sha256`);
    if (!file || !/^[a-f0-9]{64}$/.test(sha ?? '')) throw new Error(`Missing bound input: ${name}`);
    const bytes = fs.readFileSync(path.resolve(file));
    if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error(`Hash mismatch: ${name}`);
    return { file: path.resolve(file), sha256: sha, value: JSON.parse(bytes.toString('utf8')) };
  };
  const entries = Object.fromEntries(allowed.map(name => [name, read(name)]));
  const sealedSummary = entries['browser-manifest'].value.files?.filter(entry =>
    path.resolve(entry.path) === entries.summary.file && entry.sha256 === entries.summary.sha256);
  if (sealedSummary?.length !== 1) throw new Error('Summary is not sealed by the browser evidence manifest.');
  const raw = entries.result.value;
  if (!Array.isArray(raw) || raw.length !== 1 || !raw[0].evidence) throw new Error('Expected exactly one raw SQL evidence row.');
  const result = verifyInventoryContractPosttest(entries.manifest.value, raw[0].evidence, entries['browser-manifest'].value, entries.summary.value);
  const receipt = { ...result, verifiedAt: new Date().toISOString(), lineage: Object.fromEntries(allowed.map(name => [name, entries[name].sha256])) };
  const output = path.join(path.dirname(entries.manifest.file), 'inventory-contract-posttest-verification.json');
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, receipt }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
