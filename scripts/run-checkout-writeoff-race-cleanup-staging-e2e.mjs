import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

if (process.argv.slice(2).length) throw new Error("The checkout-writeoff cleanup runner accepts no arguments.");
const root = process.cwd();
const recoveryInput = process.env.E2E_CHECKOUT_WRITEOFF_RECOVERY_ARTIFACT?.trim();
const cleanupInput = process.env.E2E_RUN_ID?.trim();
if (!recoveryInput || !cleanupInput) throw new Error("Exact recovery artifact and fresh cleanup E2E_RUN_ID are required.");
const cleanupRunId = sanitizeRunId(cleanupInput);
const recoveryPath = path.resolve(root, recoveryInput);
const reconciliationDirectory = path.resolve(root, "test-artifacts", "reconciliation");
if (path.dirname(recoveryPath) !== reconciliationDirectory || !fs.existsSync(recoveryPath)) {
  throw new Error("Recovery must be an existing checkout-writeoff reconciliation artifact.");
}
const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
const recoverySha256 = createHash("sha256").update(fs.readFileSync(recoveryPath)).digest("hex");
const expectedName = `checkout-writeoff-race-reconciliation-${recovery.runId}.json`;
if (path.basename(recoveryPath) !== expectedName || recovery.projectRef !== STAGING_PROJECT_REF ||
    recovery.productionAllowed !== false || recovery.safeForAutomaticRetry !== false ||
    recovery.status !== "partial" || recovery.safeForIdentityBoundCleanup !== true ||
    !Array.isArray(recovery.failures) || recovery.failures.length !== 0 ||
    !Array.isArray(recovery.cleanupCandidates) || recovery.cleanupCandidates.length !== 1 ||
    !Array.isArray(recovery.openFloor?.sessions) || recovery.openFloor.sessions.length !== 1 ||
    !Array.isArray(recovery.openFloor?.tabs) || recovery.openFloor.tabs.length !== 0) {
  throw new Error("Recovery evidence does not authorize one identity-bound staging cleanup.");
}
const sourceRunId = sanitizeRunId(recovery.runId);
if (sourceRunId === cleanupRunId) throw new Error("Cleanup execution ID must differ from the source race ID.");
const candidate = recovery.cleanupCandidates[0];
const openSession = recovery.openFloor.sessions[0];
if (!candidate.sessionId || candidate.sessionId !== openSession.id || openSession.status !== "active" ||
    openSession.customer_name !== candidate.customerName || !candidate.station || !candidate.reason ||
    !Number.isInteger(recovery.appState?.version) || !recovery.appState?.hash) {
  throw new Error("Recovery cleanup identity or app_state baseline is incomplete.");
}

const collisions = [];
const artifactRoot = path.join(root, "test-artifacts");
function scan(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name.includes(cleanupRunId)) collisions.push(path.relative(root, entryPath));
    if (entry.isDirectory()) scan(entryPath);
  }
}
scan(artifactRoot);
if (collisions.length) throw new Error(`Cleanup artifact identity already exists: ${collisions.join(", ")}`);

const cleanupEnv = {
  ...process.env,
  E2E_RUN_ID: cleanupRunId,
  E2E_RACE_SOURCE_RUN_ID: sourceRunId,
  E2E_RACE_CLEANUP_SESSION_ID: candidate.sessionId,
  E2E_RACE_CLEANUP_CUSTOMER_NAME: candidate.customerName,
  E2E_RACE_CLEANUP_STATION: candidate.station,
  E2E_RACE_CLEANUP_REASON: candidate.reason,
  E2E_RACE_CLEANUP_APP_STATE_VERSION: String(recovery.appState.version),
  E2E_RACE_CLEANUP_APP_STATE_HASH: recovery.appState.hash,
  E2E_CHECKOUT_WRITEOFF_RECOVERY_ARTIFACT: recoveryPath,
  E2E_CHECKOUT_WRITEOFF_RECOVERY_SHA256: recoverySha256
};
const cleanup = spawnSync(process.execPath, [path.join(root, "scripts", "run-checkout-settlement-cleanup-staging-e2e.mjs")], {
  cwd: root,
  env: cleanupEnv,
  stdio: "inherit",
  shell: false
});
if ((cleanup.status ?? 1) !== 0) process.exit(cleanup.status ?? 1);

const summaryPath = path.join(root, "test-artifacts", "playwright", `summary-${cleanupRunId}.json`);
if (!fs.existsSync(summaryPath)) throw new Error("Identity-bound cleanup Playwright summary is missing.");
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const attachment = summary.tests?.[0]?.attachments?.find((entry) => entry.name === "checkout-settlement-adjustment-winner-cleanup");
if (summary.runId !== cleanupRunId || summary.status !== "passed" || summary.tests?.length !== 1 ||
    summary.tests[0].retry !== 0 || !attachment?.path) {
  throw new Error("Identity-bound cleanup Playwright evidence is incomplete or retried.");
}
const cleanupEvidencePath = path.resolve(root, attachment.path);
if (!fs.existsSync(cleanupEvidencePath)) throw new Error("Identity-bound cleanup JSON attachment is missing.");
const cleanupEvidenceBytes = fs.readFileSync(cleanupEvidencePath);
const cleanupEvidenceSha256 = createHash("sha256").update(cleanupEvidenceBytes).digest("hex");
const cleanupEvidence = JSON.parse(cleanupEvidenceBytes.toString("utf8"));
if (cleanupEvidence.cleanupRunId !== cleanupRunId || cleanupEvidence.sourceRunId !== sourceRunId ||
    cleanupEvidence.sessionId !== candidate.sessionId || cleanupEvidence.recoveryArtifact !== recoveryPath ||
    cleanupEvidence.recoverySha256 !== recoverySha256 || cleanupEvidence.rejection?.entityId !== candidate.sessionId) {
  throw new Error("Cleanup attachment is not bound to the authorized recovery artifact and session.");
}

const postflight = spawnSync(process.execPath, [path.join(root, "scripts", "reconcile-checkout-writeoff-race-staging.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    E2E_RUN_ID: sourceRunId,
    E2E_CHECKOUT_WRITEOFF_RECONCILIATION_ID: cleanupRunId,
    E2E_CHECKOUT_WRITEOFF_RECOVERY_ARTIFACT: recoveryPath,
    E2E_CHECKOUT_WRITEOFF_RECOVERY_SHA256: recoverySha256,
    E2E_CHECKOUT_WRITEOFF_CLEANUP_EVIDENCE: cleanupEvidencePath,
    E2E_CHECKOUT_WRITEOFF_CLEANUP_EVIDENCE_SHA256: cleanupEvidenceSha256
  },
  stdio: "inherit",
  shell: false
});
if (![0, 2].includes(postflight.status ?? 1)) process.exit(postflight.status ?? 1);
const postflightPath = path.join(reconciliationDirectory, `checkout-writeoff-race-reconciliation-${sourceRunId}-${cleanupRunId}.json`);
if (!fs.existsSync(postflightPath)) throw new Error("Identity-bound cleanup postflight artifact is missing.");
const postflightEvidence = JSON.parse(fs.readFileSync(postflightPath, "utf8"));
if (!Array.isArray(postflightEvidence.failures) || postflightEvidence.failures.length !== 0 ||
    !["partial", "passed"].includes(postflightEvidence.status) || postflightEvidence.productionAllowed !== false ||
    postflightEvidence.safeForAutomaticRetry !== false || postflightEvidence.safeForIdentityBoundCleanup !== false ||
    !Array.isArray(postflightEvidence.cleanupCandidates) || postflightEvidence.cleanupCandidates.length !== 0 ||
    !Array.isArray(postflightEvidence.openFloor?.sessions) || postflightEvidence.openFloor.sessions.length !== 0 ||
    !Array.isArray(postflightEvidence.openFloor?.tabs) || postflightEvidence.openFloor.tabs.length !== 0) {
  throw new Error("Identity-bound cleanup postflight did not prove an empty exact floor.");
}
