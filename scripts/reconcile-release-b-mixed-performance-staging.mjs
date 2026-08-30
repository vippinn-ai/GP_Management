import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertStagingSupabaseEnvironment, parseEnvFile, sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

const root = process.cwd();
const stagingEnv = parseEnvFile(path.join(root, ".env.staging"));
assertStagingSupabaseEnvironment(stagingEnv, true);
if (!process.env.E2E_RUN_ID?.trim()) throw new Error("An explicit umbrella E2E_RUN_ID is required.");
const runId = sanitizeRunId(process.env.E2E_RUN_ID);
if (runId.length > 34) throw new Error("Mixed-performance E2E_RUN_ID must be at most 34 characters.");
const ids = { payment: `${runId}-dues`, replacement: `${runId}-replacement`, combo: `${runId}-combo` };

function readBound(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Required mixed-performance evidence is missing: ${relativePath}`);
  const raw = fs.readFileSync(absolutePath);
  return {
    path: relativePath.replaceAll("\\", "/"),
    sha256: createHash("sha256").update(raw).digest("hex"),
    value: JSON.parse(raw.toString("utf8"))
  };
}

const source = {
  paymentTerminal: readBound(`test-artifacts/evidence/checkout-payment-matrix-partial_previous_dues-final-${ids.payment}.json`),
  paymentReconciliation: readBound(`test-artifacts/reconciliation/checkout-payment-matrix-reconciliation-partial_previous_dues-${ids.payment}.json`),
  replacementTerminal: readBound(`test-artifacts/evidence/checkout-replacement-parity-terminal-${ids.replacement}.json`),
  replacementReconciliation: readBound(`test-artifacts/evidence/checkout-replacement-parity-reconciliation-${ids.replacement}.json`),
  comboTerminal: readBound(`test-artifacts/reconciliation/checkout-repeat-combo-race-${ids.combo}-simultaneous.json`),
  comboPostflight: readBound(`test-artifacts/reconciliation/checkout-repeat-combo-race-postflight-${ids.combo}.json`)
};

const payment = source.paymentTerminal.value;
const paymentReconciliation = source.paymentReconciliation.value;
const replacement = source.replacementTerminal.value;
const replacementReconciliation = source.replacementReconciliation.value;
const combo = source.comboTerminal.value;
const comboPostflight = source.comboPostflight.value;
const comboClassification = comboPostflight.classifications?.find((entry) => entry.scenario === "simultaneous");
const samePath = (left, right) => typeof left === "string" && typeof right === "string" && path.resolve(root, left) === path.resolve(root, right);
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameIds = (left, right) => sameJson([...new Set(left ?? [])].map(String).sort(), [...new Set(right ?? [])].map(String).sort());
const stagingIdentity = (value) => value?.projectRef === STAGING_PROJECT_REF && value?.productionAllowed === false && value?.safeForAutomaticRetry === false;

const sourceIdentityChecks = {
  paymentTerminal: payment.runId === ids.payment && payment.selectedCase === "partial_previous_dues" && payment.stage === "final" && payment.status === "browser-passed" && payment.productionAllowed === false && payment.safeForAutomaticRetry === false,
  paymentReconciliation: paymentReconciliation.runId === ids.payment && paymentReconciliation.selectedCase === "partial_previous_dues" && stagingIdentity(paymentReconciliation) && paymentReconciliation.status === "passed" && samePath(paymentReconciliation.browserEvidence, source.paymentTerminal.path) && paymentReconciliation.browserEvidenceSha256 === source.paymentTerminal.sha256,
  replacementTerminal: replacement.runId === ids.replacement && replacement.stage === "terminal" && replacement.status === "passed" && replacement.productionAllowed === false && replacement.safeForAutomaticRetry === false,
  replacementReconciliation: replacementReconciliation.runId === ids.replacement && stagingIdentity(replacementReconciliation) && replacementReconciliation.status === "passed" && samePath(replacementReconciliation.evidence?.terminal?.path, source.replacementTerminal.path) && replacementReconciliation.evidence?.terminal?.sha256 === source.replacementTerminal.sha256,
  comboTerminal: combo.runId === ids.combo && combo.scenario === "simultaneous" && stagingIdentity(combo),
  comboPostflight: comboPostflight.runId === ids.combo && stagingIdentity(comboPostflight) && comboPostflight.passed === true && comboClassification?.classification === "completed" && samePath(comboClassification?.artifactPath, source.comboTerminal.path) && comboClassification?.artifactSha256 === source.comboTerminal.sha256
};

const forbiddenErrorPattern = /\b57014\b|deadlock detected|statement timeout|client timeout|timed out|timeout.*exceeded/i;
const forbiddenMatches = Object.values(source).flatMap((entry) => forbiddenErrorPattern.test(JSON.stringify(entry.value)) ? [entry.path] : []);

function timing(label, value) {
  const submission = value?.submission;
  const response = value?.response;
  const uiTerminal = value?.uiTerminal;
  const failures = [];
  if (![submission, response, uiTerminal].every((point) => Number.isFinite(point?.monotonicMs) && Number.isFinite(Date.parse(point?.iso)))) failures.push("missing timestamp");
  if (submission && response && uiTerminal && !(submission.monotonicMs <= response.monotonicMs && response.monotonicMs <= uiTerminal.monotonicMs)) failures.push("non-monotonic timestamps");
  if (!Number.isFinite(value?.browserCompletionMs) || value.browserCompletionMs < 0 || value.browserCompletionMs >= 7_000) failures.push("browser completion outside 0-7000ms");
  if (!Number.isFinite(value?.responseMs) || value.responseMs < 0 || value.responseMs > value.browserCompletionMs) failures.push("response duration invalid");
  return { label, ...value, passed: failures.length === 0, failures };
}

const browserTimings = [
  timing("partial_previous_dues_current_checkout", payment.currentCommit?.timings),
  timing("replacement_quantity_decrease", replacement.operations?.replacement?.timings),
  timing("checkout_vs_repeat_combo_simultaneous", combo.timings)
];
const informationalTimings = [
  timing("partial_previous_dues_deferred_source", payment.sourceCommit?.timings),
  timing("replacement_original_checkout", replacement.operations?.original?.timings)
];

function paymentOperationIsExact(entry) {
  const mutationId = entry?.envelope?.payload?.mutation_id;
  return entry?.captureCount === 1 && entry?.submissionCount === 1 && entry?.responseStatus === 200 && entry?.result?.status === 200 &&
    Boolean(mutationId) && entry?.responseBody?.mutation_id === mutationId && entry?.result?.mutationId === mutationId &&
    Boolean(entry?.responseBody?.event_id) && entry?.responseBody?.event_id === entry?.result?.eventId;
}

function replacementOperationIsExact(entry) {
  const mutationId = entry?.request?.payload?.mutation_id;
  return entry?.captureCount === 1 && entry?.submissionCount === 1 && Boolean(mutationId) &&
    entry?.response?.mutation_id === mutationId && Boolean(entry?.response?.event_id);
}

const checkoutSucceeded = combo.responses?.checkout?.status === 200;
const comboSucceeded = combo.responses?.combo?.status === 200;
const comboSuccessfulResponse = checkoutSucceeded ? combo.responses.checkout.body : combo.responses?.combo?.body;
const comboSuccessfulMutationId = checkoutSucceeded ? combo.checkoutMutationId : combo.comboMutationId;
const comboExpectedLoserMessage = checkoutSucceeded
  ? "Repeating combo: The session is no longer open."
  : "Bill inventory rows do not match the locked session or tab items.";
const exactSubmissionChecks = {
  payment: [payment.sourceCommit, payment.currentCommit].every(paymentOperationIsExact),
  replacement: [replacement.operations?.original, replacement.operations?.replacement].every(replacementOperationIsExact),
  combo: combo.lifecycle?.checkoutSubmitted === true && combo.lifecycle?.comboSubmitted === true &&
    combo.lifecycle?.checkoutSubmissionCount === 1 && combo.lifecycle?.comboSubmissionCount === 1 &&
    combo.lifecycle?.checkoutCaptureCount === 1 && combo.lifecycle?.comboCaptureCount === 1 &&
    Number(checkoutSucceeded) + Number(comboSucceeded) === 1 &&
    combo.responses?.checkout?.status + combo.responses?.combo?.status === 600 &&
    combo.winner === (checkoutSucceeded ? "checkout" : "combo") && combo.loserUiMessage === comboExpectedLoserMessage &&
    Boolean(comboSuccessfulMutationId) && comboSuccessfulResponse?.mutation_id === comboSuccessfulMutationId && Boolean(comboSuccessfulResponse?.event_id)
};

const baseFinancialResponses = [
  ["payment_source", payment.sourceCommit?.responseBody],
  ["payment_current", payment.currentCommit?.responseBody],
  ["replacement_original", replacement.operations?.original?.response],
  ["replacement_quantity_decrease", replacement.operations?.replacement?.response]
];
const financialResponses = [
  ...baseFinancialResponses,
  ...(checkoutSucceeded ? [["combo_race_checkout_winner", combo.responses.checkout.body]] : [])
].map(([label, response]) => ({
  label,
  mutationId: response?.mutation_id,
  eventId: response?.event_id,
  serverDurationMs: Number(response?.server_duration_ms)
}));
const expectedDatabaseSampleCount = checkoutSucceeded ? 5 : 4;
const invalidDatabaseDurations = financialResponses.filter((entry) => !entry.mutationId || !entry.eventId || !Number.isFinite(entry.serverDurationMs) || entry.serverDurationMs < 0);
const uniqueDatabaseMutationIds = new Set(financialResponses.map((entry) => entry.mutationId)).size === financialResponses.length;
const sortedDurations = financialResponses.map((entry) => entry.serverDurationMs).filter(Number.isFinite).sort((a, b) => a - b);
const percentile = (values, value) => values.length ? values[Math.max(0, Math.ceil(values.length * value) - 1)] : null;
const databaseP95Ms = percentile(sortedDurations, 0.95);
const databaseMaxMs = sortedDurations.at(-1) ?? null;
const contentionWinner = {
  kind: checkoutSucceeded ? "financial_checkout" : "repeat_session_combo",
  mutationId: comboSuccessfulMutationId,
  eventId: comboSuccessfulResponse?.event_id,
  responseMs: combo.timings?.responseMs,
  serverDurationMs: checkoutSucceeded ? Number(comboSuccessfulResponse?.server_duration_ms) : null
};
const contentionWinnerCheck = Boolean(contentionWinner.mutationId) && Boolean(contentionWinner.eventId) &&
  Number.isFinite(contentionWinner.responseMs) && contentionWinner.responseMs >= 0 && contentionWinner.responseMs < 5_000 &&
  (checkoutSucceeded ? Number.isFinite(contentionWinner.serverDurationMs) && contentionWinner.serverDurationMs >= 0 : contentionWinner.serverDurationMs === null);

const paymentSnapshot = paymentReconciliation.snapshot;
const replacementSnapshot = replacementReconciliation.snapshot;
const comboSnapshot = comboPostflight.terminal;
const paymentLastFinancialState = payment.financialWindows?.at(-1)?.after;
const expectedComboFinalAppState = combo.appStateAfterCleanup ?? combo.afterRace?.appState;
const comboEvents = comboSnapshot?.events ?? [];
const comboEventMutationIds = comboEvents.map((entry) => entry.metadata?.mutation_id).filter(Boolean);
const checkoutStatus = comboSnapshot?.checkoutStatuses?.simultaneous ?? null;
const comboWinnerEffects = checkoutSucceeded
  ? comboSnapshot?.runBills?.length === 1 && comboSnapshot?.bills?.length === 1 && comboSnapshot?.payments?.length === 1 &&
    comboSnapshot?.sessions?.length === 1 && comboSnapshot.sessions[0]?.status === "closed" && comboSnapshot.sessions[0]?.close_disposition === "billed" &&
    comboSnapshot.sessions[0]?.closed_bill_id === combo.candidateBillId && comboSnapshot.bills[0]?.id === combo.candidateBillId &&
    sameJson(checkoutStatus, combo.checkoutMutationStatus) && checkoutStatus?.mutation_id === combo.checkoutMutationId && checkoutStatus?.event_id === combo.responses.checkout.body?.event_id &&
    sameIds(comboEventMutationIds, [combo.checkoutMutationId]) &&
    !(comboSnapshot?.combos ?? []).some((entry) => entry.id === combo.repeatedComboApplicationId) &&
    !(comboSnapshot?.items ?? []).some((entry) => combo.repeatedItemIds?.includes(entry.id))
  : comboSnapshot?.runBills?.length === 0 && comboSnapshot?.bills?.length === 0 && comboSnapshot?.payments?.length === 0 && checkoutStatus === null &&
    comboSnapshot?.sessions?.length === 1 && comboSnapshot.sessions[0]?.status === "closed" && comboSnapshot.sessions[0]?.close_disposition === "rejected" && comboSnapshot.sessions[0]?.closed_bill_id === null &&
    (comboSnapshot?.combos ?? []).some((entry) => entry.id === combo.repeatedComboApplicationId) &&
    sameIds((comboSnapshot?.items ?? []).filter((entry) => combo.repeatedItemIds?.includes(entry.id)).map((entry) => entry.id), combo.repeatedItemIds) &&
    sameIds(comboEventMutationIds, [combo.comboMutationId, combo.cleanup?.result?.mutationId]) && comboEvents.length === 2;

const reconciliationChecks = {
  payment: paymentReconciliation.status === "passed" && paymentReconciliation.integrityFailures?.length === 0 && paymentSnapshot?.openSessions?.length === 0 && paymentSnapshot?.openTabs?.length === 0 && paymentSnapshot?.mutationStatuses?.length === 2 && paymentSnapshot?.bills?.length === 2 && paymentSnapshot?.payments?.length === 3 && paymentSnapshot?.events?.length === 2,
  replacement: replacementReconciliation.status === "passed" && replacementReconciliation.integrityFailures?.length === 0 && replacementReconciliation.ambiguities?.length === 0 && replacementSnapshot?.openSessions?.length === 0 && replacementSnapshot?.openTabs?.length === 0 && replacementSnapshot?.mutationStatuses?.length === 2 && replacementSnapshot?.bills?.length === 2 && replacementSnapshot?.payments?.length === 2 && replacementSnapshot?.items?.length === 1 && replacementSnapshot.items[0]?.active === false && replacementSnapshot?.tabs?.length === 1 && replacementSnapshot.tabs[0]?.status === "closed" && replacementSnapshot.tabs[0]?.close_disposition === "billed" && replacementReconciliation.recovery?.rejectTab == null && replacementReconciliation.recovery?.archiveItem == null,
  combo: comboPostflight.passed === true && comboPostflight.failures?.length === 0 && comboPostflight.checks?.every((entry) => entry.passed === true) && comboSnapshot?.openSessions?.length === 0 && comboSnapshot?.openTabs?.length === 0 && comboWinnerEffects
};
const appStateChecks = {
  paymentFinancialWindowsUnchanged: payment.financialWindows?.length === 2 && payment.financialWindows.every((window) => sameJson(window.before, window.after)) && sameJson(paymentSnapshot?.appState && { version: paymentSnapshot.appState.version, hash: paymentSnapshot.appState.hash }, paymentLastFinancialState),
  replacementFinancialBaselinePreserved: replacement.finalState?.version === replacement.financialState?.version + 1 && sameJson(replacementSnapshot?.appState, replacement.finalState),
  comboRaceUnchanged: combo.appStateBefore?.version === combo.afterRace?.appState?.version && combo.appStateBefore?.hash === combo.afterRace?.appState?.hash,
  comboFinalStateBound: sameJson(comboSnapshot?.appState, expectedComboFinalAppState)
};

const failures = [];
if (Object.values(sourceIdentityChecks).some((value) => value !== true)) failures.push("Source identity, staging boundary, or cross-artifact SHA lineage failed.");
if (browserTimings.some((entry) => !entry.passed)) failures.push("One or more required browser-completion timings failed.");
if (informationalTimings.some((entry) => !entry.passed)) failures.push("One or more supporting checkout timings failed.");
if (financialResponses.length !== expectedDatabaseSampleCount || invalidDatabaseDurations.length || !uniqueDatabaseMutationIds) failures.push("Fresh financial database sample identity, count, or server duration failed.");
if (!(Number.isFinite(databaseP95Ms) && Number.isFinite(databaseMaxMs) && databaseP95Ms < 2_000 && databaseMaxMs < 5_000)) failures.push("Fresh database duration thresholds failed.");
if (!contentionWinnerCheck) failures.push("The contention winner identity or response duration failed.");
if (forbiddenMatches.length) failures.push("A selected passing artifact contains a forbidden timeout/deadlock signature.");
if (Object.values(exactSubmissionChecks).some((value) => value !== true)) failures.push("Exact capture, submission, mutation, event, response, or winner checks failed.");
if (Object.values(reconciliationChecks).some((value) => value !== true)) failures.push("A scenario reconciliation, empty-floor, or exact-effect check failed.");
if (Object.values(appStateChecks).some((value) => value !== true)) failures.push("A scenario app_state invariance or final-state binding failed.");

const report = {
  schemaVersion: 2,
  runId,
  scenarioRunIds: ids,
  generatedAt: new Date().toISOString(),
  projectRef: STAGING_PROJECT_REF,
  productionAllowed: false,
  safeForAutomaticRetry: false,
  status: failures.length ? "failed" : "passed",
  failures,
  acceptance: {
    requiredBrowserCompletionMs: "<7000",
    requiredContentionWinnerResponseMs: "<5000",
    requiredDatabaseP95Ms: "<2000",
    requiredDatabaseMaxMs: "<5000",
    sourceIdentityChecks,
    browserTimings,
    informationalTimings,
    expectedDatabaseSampleCount,
    financialResponses,
    databaseP95Ms,
    databaseMaxMs,
    contentionWinner,
    contentionWinnerCheck,
    forbiddenMatches,
    exactSubmissionChecks,
    reconciliationChecks,
    appStateChecks
  },
  sources: Object.fromEntries(Object.entries(source).map(([key, entry]) => [key, { path: entry.path, sha256: entry.sha256 }]))
};
const outputPath = path.join(root, "test-artifacts", "evidence", `release-b-mixed-performance-${runId}.json`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const sha256 = createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
console.log(JSON.stringify({ status: report.status, artifact: path.relative(root, outputPath), sha256, failures, databaseP95Ms, databaseMaxMs, contentionWinner, browserTimings }, null, 2));
if (failures.length) process.exitCode = 1;
