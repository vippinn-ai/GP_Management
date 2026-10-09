import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { INVENTORY_CONTRACT_TESTS } from './lifecycle-runner-guards.mjs';
import { verifyInventoryContractPosttest } from './verify-inventory-contract-posttest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifierPath = path.join(root, 'scripts', 'verify-inventory-contract-posttest.mjs');
const projectRef = 'tkbdyzxwwbhkpztgjjxh';
const floorKeys = ['open_sessions', 'open_customer_tabs', 'recoverable_hopped_sessions', 'incomplete_operational_mutations', 'incomplete_financial_mutations'];
const residualKeys = ['sessions', 'customer_tabs', 'session_items', 'session_combos', 'tab_items', 'tab_combos'];
const raceKeys = ['committed_close_mutations', 'all_close_mutations', 'close_audits', 'close_events', 'actor_mismatches'];
const zeros = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixtures(runId = 'normops-20261009-1700-inventory-contract') {
  const appState = { id: 'app-primary', version: 720, updated_at: '2026-10-09T12:00:00.000Z', byte_size: 1000, hash: 'app-hash' };
  const functions = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`function_${index + 1}`, `md5-${index + 1}`]));
  const expectedTests = clone(INVENTORY_CONTRACT_TESTS);
  return {
    manifest: {
      runId,
      target: { projectRef, organizationId: 'org-primary' },
      readOnly: true,
      expectedAppState: appState,
      expectedFunctionDefinitionMd5: functions,
    },
    observed: {
      project_ref: projectRef,
      run_id: runId,
      global_floor: zeros(floorKeys),
      qa_live_residuals: zeros(residualKeys),
      same_target_race_integrity: zeros(raceKeys),
      app_state: clone(appState),
      functions: clone(functions),
    },
    browser: {
      runId,
      mode: 'inventory-contract',
      suite: 'operational-lifecycle-inventory-contract',
      expectedTestCount: 2,
      fullReleaseGate: false,
      exitCode: 0,
      gateError: null,
      expectedTests,
      files: [],
    },
    summary: {
      runId,
      status: 'passed',
      tests: expectedTests.map((entry) => ({ ...entry, status: 'passed', retry: 0 })),
    },
  };
}

function verify(value) {
  return verifyInventoryContractPosttest(value.manifest, value.observed, value.browser, value.summary);
}

test('accepts exactly the two-test focused contract for two fresh valid identities', () => {
  for (const runId of ['normops-20261009-1700-inventory-contract', 'normops-20261009-1701-inventory-contract']) {
    assert.deepEqual(verify(fixtures(runId)), {
      runId,
      status: 'focused-passed',
      mode: 'inventory-contract',
      fullReleaseGate: false,
      appStateUnchanged: true,
      globalFloorClean: true,
      qaLiveResidualsClean: true,
    });
  }
});

test('rejects wrong suite mode, a full release gate, and failed browser evidence', () => {
  const mutations = [
    (value) => { value.browser.mode = 'full'; },
    (value) => { value.browser.suite = 'operational-lifecycle'; },
    (value) => { value.browser.expectedTestCount = '2'; },
    (value) => { value.browser.fullReleaseGate = true; },
    (value) => { value.browser.exitCode = 1; },
    (value) => { value.browser.gateError = 'failed'; },
  ];
  for (const mutate of mutations) {
    const value = fixtures();
    mutate(value);
    assert.throws(() => verify(value));
  }
});

test('rejects missing, extra, coerced, null, and nonzero reconciliation counts', () => {
  for (const [field, keys] of [['global_floor', floorKeys], ['qa_live_residuals', residualKeys], ['same_target_race_integrity', raceKeys]]) {
    const mutations = [
      (value) => { delete value.observed[field]; },
      (value) => { value.observed[field] = null; },
      (value) => { delete value.observed[field][keys[0]]; },
      (value) => { value.observed[field].unexpected = 0; },
      (value) => { value.observed[field][keys[0]] = 1; },
      (value) => { value.observed[field][keys[0]] = '0'; },
      (value) => { value.observed[field][keys[0]] = false; },
    ];
    for (const mutate of mutations) {
      const value = fixtures();
      mutate(value);
      assert.throws(() => verify(value), `must reject ${field} count mutation`);
    }
  }
});

test('rejects wrong run, project, organization, and read-only identity', () => {
  const mutations = [
    (value) => { value.manifest.runId = 'invalid'; value.observed.run_id = 'invalid'; value.browser.runId = 'invalid'; value.summary.runId = 'invalid'; },
    (value) => { value.observed.run_id = 'normops-20261009-1702-other'; },
    (value) => { value.browser.runId = 'normops-20261009-1702-other'; },
    (value) => { value.manifest.target.projectRef = 'wrong-project'; },
    (value) => { value.observed.project_ref = 'wrong-project'; },
    (value) => { value.manifest.target.organizationId = 'wrong-org'; },
    (value) => { value.manifest.readOnly = false; },
  ];
  for (const mutate of mutations) {
    const value = fixtures();
    mutate(value);
    assert.throws(() => verify(value));
  }
});

test('rejects app state and function drift and malformed baseline cardinality', () => {
  const mutations = [
    (value) => { value.observed.app_state.version += 1; },
    (value) => { value.observed.functions.function_1 = 'different'; },
    (value) => { delete value.manifest.expectedAppState.hash; },
    (value) => { value.manifest.expectedAppState.extra = true; },
    (value) => { delete value.manifest.expectedFunctionDefinitionMd5.function_7; },
    (value) => { value.manifest.expectedFunctionDefinitionMd5.function_8 = 'md5-8'; },
  ];
  for (const mutate of mutations) {
    const value = fixtures();
    mutate(value);
    assert.throws(() => verify(value));
  }
});

test('rejects missing, extra, skipped, duplicated, retried, or failed tests', () => {
  const mutations = [
    (value) => { value.summary.tests.pop(); },
    (value) => { value.summary.tests.push({ file: 'extra.e2e.ts', project: '', title: 'extra', status: 'passed', retry: 0 }); },
    (value) => { value.summary.tests[0].status = 'skipped'; },
    (value) => { value.summary.tests[1] = clone(value.summary.tests[0]); },
    (value) => { value.summary.tests[0].retry = 1; },
    (value) => { value.summary.tests[0].status = 'failed'; },
    (value) => { value.summary.tests[0].title = 'wrong title'; },
    (value) => { value.summary.status = 'failed'; },
    (value) => { value.browser.expectedTests.pop(); },
    (value) => { value.browser.expectedTests.push(clone(value.browser.expectedTests[0])); },
  ];
  for (const mutate of mutations) {
    const value = fixtures();
    mutate(value);
    assert.throws(() => verify(value));
  }
});

function writeJson(directory, name, value) {
  const file = path.join(directory, name);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { file, sha256: sha256(bytes) };
}

function cliArguments(entries) {
  return Object.entries(entries).flatMap(([name, entry]) => [`--${name}=${entry.file}`, `--${name}-sha256=${entry.sha256}`]);
}

test('CLI requires every hash, requires sealed summary lineage, and never overwrites a receipt', () => {
  const tempRoot = path.resolve(root, 'test-artifacts', 'local-temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, 'inventory-posttest-'));
  const resolvedDirectory = path.resolve(directory);
  const cleanupIsContained = resolvedDirectory.startsWith(`${tempRoot}${path.sep}`) && resolvedDirectory !== tempRoot;
  assert.equal(cleanupIsContained, true, 'temporary cleanup target must stay below the intended local-temp root');
  try {
    const value = fixtures();
    const summary = writeJson(directory, 'summary.json', value.summary);
    value.browser.files = [{ path: summary.file, sha256: summary.sha256 }];
    const entries = {
      manifest: writeJson(directory, 'manifest.json', value.manifest),
      result: writeJson(directory, 'result.json', [{ evidence: value.observed }]),
      'browser-manifest': writeJson(directory, 'browser.json', value.browser),
      summary,
    };
    const args = cliArguments(entries);
    const missingHash = spawnSync(process.execPath, [verifierPath, ...args.slice(0, -1)], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(missingHash.status, 0);

    for (const input of ['manifest', 'result', 'browser-manifest', 'summary']) {
      const tamperedEntries = clone(entries);
      tamperedEntries[input].sha256 = '0'.repeat(64);
      const tamperedResult = spawnSync(process.execPath, [verifierPath, ...cliArguments(tamperedEntries)], { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.notEqual(tamperedResult.status, 0, `must reject tampered ${input} hash`);
    }

    const unsealed = clone(value.browser);
    unsealed.files = [];
    const unsealedEntry = writeJson(directory, 'browser-unsealed.json', unsealed);
    const unsealedArgs = cliArguments({ ...entries, 'browser-manifest': unsealedEntry });
    const unsealedResult = spawnSync(process.execPath, [verifierPath, ...unsealedArgs], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(unsealedResult.status, 0);

    const wrongPath = clone(value.browser);
    wrongPath.files = [{ path: path.join(directory, 'different-summary.json'), sha256: summary.sha256 }];
    const wrongPathEntry = writeJson(directory, 'browser-wrong-path.json', wrongPath);
    const wrongPathResult = spawnSync(process.execPath, [verifierPath, ...cliArguments({ ...entries, 'browser-manifest': wrongPathEntry })], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(wrongPathResult.status, 0);

    const wrongSha = clone(value.browser);
    wrongSha.files = [{ path: summary.file, sha256: 'f'.repeat(64) }];
    const wrongShaEntry = writeJson(directory, 'browser-wrong-sha.json', wrongSha);
    const wrongShaResult = spawnSync(process.execPath, [verifierPath, ...cliArguments({ ...entries, 'browser-manifest': wrongShaEntry })], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(wrongShaResult.status, 0);

    const duplicateSeal = clone(value.browser);
    duplicateSeal.files = [
      { path: summary.file, sha256: summary.sha256 },
      { path: summary.file, sha256: summary.sha256 },
    ];
    const duplicateSealEntry = writeJson(directory, 'browser-duplicate-seal.json', duplicateSeal);
    const duplicateSealResult = spawnSync(process.execPath, [verifierPath, ...cliArguments({ ...entries, 'browser-manifest': duplicateSealEntry })], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(duplicateSealResult.status, 0);

    const first = spawnSync(process.execPath, [verifierPath, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(first.status, 0, first.stderr);
    const receipt = path.join(directory, 'inventory-contract-posttest-verification.json');
    const original = fs.readFileSync(receipt);

    const second = spawnSync(process.execPath, [verifierPath, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(second.status, 0);
    assert.deepEqual(fs.readFileSync(receipt), original);
  } finally {
    if (cleanupIsContained) fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  }
});
