import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadBrowserPackage, packagePhaseExpectation, packageFinalExpectation } from './u1-browser-database-adapter.mjs';
import { bindGeneratedPhase, compareGeneratedProtected } from './u1-generated-fields.mjs';
import { prepareInstalledPhase, compareInstalledPhase } from './u1-phase-expectations.mjs';
import { canonicalHash, planPhase, sealPhaseIntent, finalizePhaseIntent, reconcilePhase, reconcileProtectedRows, reconcileRun, verifyPairIdentities, verifySamples } from './u1-data-reconciler.mjs';

// Offline only: expected evidence must be sealed before submission and separately
// approved. A caller-supplied hash is byte identity, not independent approval.
export function reconcileEvidence(expected, actual, preparedRecords = null, initialProtected = null) {
  if (expected.schema !== 'u1-expectations-v1' || actual.schema !== 'u1-observations-v1' ||
    expected.project !== 'tkbdyzxwwbhkpztgjjxh' || actual.project !== expected.project ||
    expected.organization !== 'org-primary' || actual.organization !== expected.organization ||
    !/^[a-zA-Z0-9_-]{6,80}$/.test(expected.runId) || expected.runId !== actual.runId)
    throw new Error('Evidence identity mismatch');
  if (actual.status !== 'completed-unverified' || actual.attempt !== 1 || actual.retry !== 0 ||
    !Array.isArray(expected.phases) || expected.phases.length !== 250 ||
    !Array.isArray(actual.phases) || actual.phases.length !== expected.phases.length)
    throw new Error('Failed, partial, retried, or missing phase evidence');
  // Fold only independent expectations, allowing correlated server timestamp slots.
  // Later phase preimages are the preceding EXPECTED state, never copied observations.
  let predicted = structuredClone(expected.initial);
  let predictedProtected = structuredClone(initialProtected);
  const correlated = expected.generatedFieldPolicy === 'u1-correlated-v1';
  const unownedHash = rows => {
    if (!rows?._unowned || Array.isArray(rows._unowned) || typeof rows._unowned !== 'object') throw new Error('Missing non-owned fingerprint projection');
    return canonicalHash(rows._unowned);
  };
  const initialUnownedHash = correlated ? unownedHash(initialProtected) : null;
  const generatedBindings = Object.create(null); const generatedIds = new Set();
  const ids = new Set(); const mutations = new Set(); const audits = new Set();
  const roles = ['start-a', 'start-b', 'save-b', 'reject-a', 'reject-b'];
  const operations = ['start_session', 'start_session', 'save_live_session_details', 'reject_session', 'reject_session'];
  const entries = expected.phases.map((phase, index) => {
    if (correlated && (unownedHash(phase.protectedRows) !== initialUnownedHash ||
      unownedHash(actual.phases[index].protectedRows) !== initialUnownedHash)) throw new Error('Non-owned data drift');
    if (expected.generatedFieldPolicy === 'u1-correlated-v1') {
      const record = preparedRecords?.[index];
      const { preparedArtifact, ...declaredPhase } = phase;
      if (!record || canonicalHash(record.expectedPhase) !== canonicalHash(declaredPhase) ||
        record.beforeHash !== canonicalHash(predicted) || canonicalHash(preparedArtifact) !== canonicalHash(actual.phases[index].preparedArtifact))
        throw new Error('Unbound pre-submit evidence');
    }
    const pairIndex = Math.floor(index / 5); const offset = index % 5;
    const pair = expected.pairs?.[pairIndex];
    const entityId = pair?.[offset === 0 || offset === 3 ? 'aId' : 'bId'];
    const planKeys = offset >= 3
      ? ['operation', 'outcome', 'patches', 'actor', 'earliestServerTime', 'latestServerTime']
      : ['operation', 'outcome', 'patches', 'actor', 'serverTime'];
    if (!phase.plan || Object.keys(phase.plan).some(key => !planKeys.includes(key)))
      throw new Error('Unexpected phase-plan constraint');
    if (!pair || phase.pairIndex !== pairIndex || phase.role !== roles[offset] || phase.entityId !== entityId ||
      phase.plan.operation !== operations[offset] || phase.plan.outcome !== 'committed' ||
      typeof phase.actorId !== 'string' || !phase.actorId.trim() || phase.actorId !== phase.plan.actor ||
      typeof phase.mutationId !== 'string' || !phase.mutationId.trim() || mutations.has(phase.mutationId) ||
      typeof phase.auditId !== 'string' || !phase.auditId.trim() || audits.has(phase.auditId))
      throw new Error('Incomplete or unbound 50-pair phase sequence');
    mutations.add(phase.mutationId); audits.add(phase.auditId);
    if (offset >= 3 && (phase.plan.patches?.sessions?.[0]?.id !== entityId ||
      phase.plan.patches?.auditLogs?.[0]?.id !== phase.auditId)) throw new Error('Cleanup patch identity mismatch');
    for (const key of ['pairIndex', 'role', 'entityId', 'actorId', 'mutationId', 'auditId']) {
      if (actual.phases[index][key] !== phase[key]) throw new Error('Observed phase identity mismatch');
    }
    if (Object.hasOwn(phase.plan, 'before')) throw new Error('Phase preimages must derive from the expected fold');
    let plan;
    if (offset >= 3) {
      if (Object.hasOwn(phase.plan, 'serverTime')) throw new Error('C timestamp must use a presealed window');
      const intent = sealPhaseIntent({ ...phase.plan, before: predicted });
      plan = finalizePhaseIntent(intent, {
        responseTime: actual.phases[index].responseTime, databaseTime: actual.phases[index].databaseTime,
      });
    } else plan = planPhase({ ...phase.plan, before: predicted });
    if (typeof phase.id !== 'string' || !phase.id || ids.has(phase.id) || phase.id !== actual.phases[index].id)
      throw new Error('Missing, duplicate, or reordered phase identity');
    ids.add(phase.id);
    const after = actual.phases[index].appState;
    reconcilePhase(plan, after);
    if (expected.generatedFieldPolicy === 'u1-correlated-v1') {
      if (!phase.generated || phase.generated.id !== phase.id || phase.generated.operation !== phase.plan.operation ||
        ['entityId', 'actorId', 'mutationId', 'auditId'].some(key => phase.generated[key] !== phase[key]))
        throw new Error('Missing or substituted generated-field contract');
      const command = preparedRecords[index].command;
      const installedIntent = prepareInstalledPhase(predictedProtected, phase.plan.operation, command);
      if (canonicalHash(installedIntent) !== canonicalHash(preparedRecords[index].installedIntent)) throw new Error('Installed pre-submit intent mismatch');
      const bound = bindGeneratedPhase(phase.generated, actual.phases[index].response, actual.phases[index].protectedRows, command);
      for (const key of ['eventId', 'auditActivityId', 'operationalActivityId']) {
        if (generatedIds.has(bound[key])) throw new Error('Reused generated ID'); generatedIds.add(bound[key]);
      }
      generatedBindings[phase.id] = bound;
      predictedProtected = compareInstalledPhase(phase.protectedRows, actual.phases[index].protectedRows, generatedBindings, phase.id, installedIntent);
    } else reconcileProtectedRows(phase.protectedRows, actual.phases[index].protectedRows);
    predicted = structuredClone(plan.expected);
    return { plan, after };
  });
  verifyPairIdentities(actual.samples, expected.pairs);
  for (let index = 0; index < actual.samples.length; index++) {
    const sample = actual.samples[index];
    const phaseIndex = index * 5 + 2;
    const measured = actual.phases[phaseIndex];
    reconcileProtectedRows(expected.phases[phaseIndex].uiParity, measured.uiParity);
    if (sample.outcome !== 'completed' || sample.pendingQueuesEmpty !== true ||
      sample.errorPriorityViolation !== false || sample.acknowledged !== true ||
      sample.mutationId !== measured.mutationId || sample.entityId !== measured.entityId ||
      sample.actorId !== measured.actorId ||
      !/^[a-f0-9]{64}$/.test(sample.intentHash) || sample.intentHash !== expected.pairs[index].intentHash ||
      sample.parityHash !== canonicalHash(measured.uiParity) ||
      canonicalHash(measured.pendingQueues) !== canonicalHash({ origin: [], observer: [] }))
      throw new Error('Incomplete sample convergence evidence');
  }
  const samples = verifySamples(actual.samples);
  const ledger = reconcileRun(expected.initial, entries, actual.final);
  if (correlated && (unownedHash(expected.finalProtectedRows) !== initialUnownedHash ||
    unownedHash(actual.finalProtectedRows) !== initialUnownedHash)) throw new Error('Final non-owned data drift');
  if (expected.generatedFieldPolicy === 'u1-correlated-v1')
    compareGeneratedProtected(expected.finalProtectedRows, actual.finalProtectedRows, generatedBindings);
  else reconcileProtectedRows(expected.finalProtectedRows, actual.finalProtectedRows);
  return { schema: 'u1-offline-reconciliation-v1', status: 'passed', runId: expected.runId,
    samples, ledger, scope: 'Offline supplied-evidence comparison only; not staging or release approval' };
}

export function main(args) {
  const historical = args.length === 5 && args[4] === '--historical-offline';
  if ((!historical && args.length !== 4) || !/^[0-9a-f]{64}$/.test(args[1]))
    throw new Error('Usage: node reconcile-u1-evidence.mjs EXPECTED.json EXPECTED_SHA256 OBSERVED.json NEW_REPORT.json');
  const [expectedPath, expectedHash, observedPath, reportPath] = args;
  if (new Set([expectedPath, observedPath, reportPath].map(value => path.resolve(value))).size !== 3)
    throw new Error('Expectation, observation and report must be separate files');
  if (fs.existsSync(reportPath)) throw new Error('Report already exists; evidence is immutable');
  const report = verifyEvidenceFiles(expectedPath, expectedHash, observedPath, {historical});
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report.status === 'passed' ? 0 : 1;
}

// Same evidence verification as the CLI, without creating or changing files.
export function verifyEvidenceFiles(expectedPath, expectedHash, observedPath, {historical = false} = {}) {
  if (typeof historical !== 'boolean' || !/^[0-9a-f]{64}$/.test(expectedHash) || path.resolve(expectedPath) === path.resolve(observedPath))
    throw new Error('Invalid read-only reconciliation inputs');
  const bytes = fs.readFileSync(expectedPath);
  const hash = data => createHash('sha256').update(data).digest('hex');
  if (hash(bytes) !== expectedHash) throw new Error('Approved expectation hash mismatch');
  const expected = JSON.parse(bytes.toString('utf8'));
  const observedBytes = fs.readFileSync(observedPath);
  let report;
  try {
    const actual = JSON.parse(observedBytes.toString('utf8'));
    if (!historical && expected.generatedFieldPolicy !== 'u1-correlated-v1') throw new Error('Correlated policy required');
    if (historical && expected.generatedFieldPolicy != null) throw new Error('Historical mode cannot admit correlated evidence');
    let preparedRecords = null, initialProtected = null;
    if (expected.generatedFieldPolicy === 'u1-correlated-v1') {
      const authority = expected.authority;
      if (!authority || canonicalHash(authority) !== canonicalHash(actual.authority) ||
        !/^[a-f0-9]{64}$/.test(authority.packageSha256 ?? '')) throw new Error('Missing package authority');
      const packageBytes = fs.readFileSync(authority.packageFile);
      if (hash(packageBytes) !== authority.packageSha256) throw new Error('Approved package bytes changed');
      const pkg = loadBrowserPackage(authority.packageFile, authority.packageSha256);
      if (pkg.generatedFieldPolicy !== 'u1-correlated-v1' || pkg.manifest.runId !== expected.runId ||
        canonicalHash(pkg.manifest) !== authority.manifestHash || canonicalHash(pkg.proofs) !== canonicalHash(authority.proofs) ||
        canonicalHash(expected.initial) !== pkg.manifest.initialAppStateHash ||
        canonicalHash(expected.finalProtectedRows) !== canonicalHash(packageFinalExpectation(pkg))) throw new Error('Package authority mismatch');
      if (canonicalHash(expected.pairs) !== canonicalHash(pkg.manifest.pairs.map((pair, index) =>
        ({ ...pair, intentHash: canonicalHash(pkg.manifest.intents[index]) })))) throw new Error('Pair authority mismatch');
      for (const [name, digest] of Object.entries(pkg.proofs)) {
        const relative = pkg.proofFiles[name];
        if (!/^[A-Za-z0-9_-]+\.json$/.test(relative ?? '') ||
          hash(fs.readFileSync(path.join(path.dirname(authority.packageFile), relative))) !== digest) throw new Error('Proof drift');
      }
      const directory = path.dirname(path.resolve(expectedPath));
      if (directory !== path.dirname(path.resolve(observedPath))) throw new Error('Evidence directories differ');
      const files = fs.readdirSync(directory).filter(file => /^\d{5}-[a-z-]+\.json$/.test(file)).sort();
      const records = new Map(); let previous = null;
      files.forEach((file, index) => {
        if (!file.startsWith(String(index).padStart(5, '0'))) throw new Error('Evidence sequence gap');
        const data = fs.readFileSync(path.join(directory, file)); const record = JSON.parse(data);
        if (record.previousRecordHash !== previous) throw new Error('Broken evidence hash chain');
        previous = hash(data); records.set(file, { record, sha256: previous, index });
      });
      const read = ref => {
        const found = records.get(ref?.file);
        if (!found || ref.sha256 !== found.sha256) throw new Error('Evidence reference mismatch'); return found;
      };
      const all = [...records.values()];
      const preflights = all.filter(item => item.record.phase === 'preflight');
      const postflights = all.filter(item => item.record.phase === 'postflight');
      if (preflights.length !== 1 || postflights.length !== 1 ||
        canonicalHash(preflights[0].record.appState) !== pkg.manifest.initialAppStateHash ||
        canonicalHash(preflights[0].record.protectedRows) !== pkg.initialProtectedHash ||
        canonicalHash(preflights[0].record.appState) !== canonicalHash(expected.initial) ||
        postflights[0].record.failed !== false || canonicalHash(postflights[0].record.appState) !== canonicalHash(actual.final) ||
        canonicalHash(postflights[0].record.protectedRows) !== canonicalHash(actual.finalProtectedRows)) throw new Error('Preflight/postflight authority mismatch');
      initialProtected = preflights[0].record.protectedRows;
      for (const kind of ['prepared-command', 'submission-attempt', 'submission-response', 'observed-command'])
        if (all.filter(item => item.record.phase === kind).length !== 250) throw new Error('Incomplete submission ledger');
      if (all.some(item => item.record.phase === 'submission-failure')) throw new Error('Failed submission ledger');
      preparedRecords = expected.phases.map((phase, index) => {
        const prepared = read(phase.preparedArtifact), observed = read(actual.phases[index].observedArtifact);
        const approved = packagePhaseExpectation(pkg,index);
        if (!approved || canonicalHash(prepared.record.command) !== canonicalHash(approved.command) ||
          ['id', 'pairIndex', 'role', 'entityId', 'actorId', 'mutationId', 'auditId'].some(key => phase[key] !== approved[key]) ||
          canonicalHash(phase.protectedRows) !== canonicalHash(approved.protectedRows) ||
          canonicalHash(phase.uiParity ?? null) !== canonicalHash(approved.uiParity ?? null)) throw new Error('Prepared command differs from approved package');
        const { earliestServerTime, latestServerTime, ...generated } = phase.generated;
        if (canonicalHash(generated) !== canonicalHash(approved.generated) ||
          canonicalHash(phase.plan.patches ?? {}) !== canonicalHash(approved.plan.patches ?? {})) throw new Error('Prepared contract differs from approved package');
        if (prepared.index >= observed.index || prepared.record.phase !== 'prepared-command' || observed.record.phase !== 'observed-command')
          throw new Error('Evidence chronology mismatch');
        const attempts = all.filter(item => item.record.phase === 'submission-attempt' && item.record.mutationId === phase.mutationId);
        const responses = all.filter(item => item.record.phase === 'submission-response' && item.record.mutationId === phase.mutationId);
        if (attempts.length !== 1 || responses.length !== 1 || !(prepared.index < attempts[0].index && attempts[0].index < responses[0].index && responses[0].index < observed.index) ||
          !(preflights[0].index < prepared.index && observed.index < postflights[0].index) ||
          !/^[a-f0-9]{64}$/.test(responses[0].record.responseHash ?? '') ||
          !Number.isInteger(responses[0].record.responseLength) || responses[0].record.responseLength < 0 || responses[0].record.responseLength > 1048576 ||
          responses[0].record.responseStatus !== 200 || canonicalHash(responses[0].record.response) !== canonicalHash(actual.phases[index].response) ||
          [attempts[0], responses[0]].some(item => canonicalHash(item.record.preparedArtifact) !== canonicalHash(phase.preparedArtifact)))
          throw new Error('Submission chronology or response mismatch');
        const { observedArtifact, ...payload } = actual.phases[index];
        const { phase: ignored, previousRecordHash: ignoredPrevious, ...saved } = observed.record;
        if (canonicalHash(payload) !== canonicalHash(saved)) throw new Error('Observation artifact mismatch');
        return prepared.record;
      });
      const terminal = read(actual.terminalRecord);
      if (terminal.record.phase !== 'terminal' || terminal.record.status !== 'completed-unverified' || terminal.index !== files.length - 1)
        throw new Error('Incomplete terminal evidence');
      if (postflights[0].index >= terminal.index) throw new Error('Postflight chronology mismatch');
      if (canonicalHash(terminal.record.samples) !== canonicalHash(actual.samples)) throw new Error('Terminal samples mismatch');
    }
    report = reconcileEvidence(expected, actual, preparedRecords, initialProtected);
  }
  catch { report = { schema: 'u1-offline-reconciliation-v1', status: 'failed',
    scope: 'Offline evidence rejected; preserve input files for independent diagnosis' }; }
  report.expectedSha256 = expectedHash; report.observedSha256 = hash(observedBytes);
  if (historical) report.scope = 'Historical synthetic offline comparison only; not live-run admission';
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  return freeze(report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { console.error('U1 offline reconciliation blocked; validate arguments, evidence hashes and new output path.'); process.exitCode = 1; }
}
