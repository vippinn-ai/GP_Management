import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeRunId, STAGING_PROJECT_REF } from "./playwright-staging-env.mjs";

if (process.argv.slice(2).length > 0) {
  throw new Error("The checkout-repeat-combo cleanup runner accepts no arguments.");
}

const root = process.cwd();
const cleanupRunId = sanitizeRunId(process.env.E2E_RUN_ID?.trim() || "");
const sourceRunId = sanitizeRunId(process.env.E2E_REPEAT_COMBO_RECOVERY_RUN_ID?.trim() || "");
if (!cleanupRunId || !sourceRunId || cleanupRunId === sourceRunId) {
  throw new Error("Distinct cleanup and source run IDs are required.");
}

const recoveryPath = path.join(
  root,
  "test-artifacts",
  "reconciliation",
  `checkout-repeat-combo-race-recovery-v2-${sourceRunId}.json`
);
if (!fs.existsSync(recoveryPath)) throw new Error("Exact passing combo-race recovery evidence is missing.");
const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
const scenarioPath = path.join(
  root,
  "test-artifacts",
  "reconciliation",
  `checkout-repeat-combo-race-${sourceRunId}-${recovery.scenario}.json`
);
if (!fs.existsSync(scenarioPath)) throw new Error("Exact combo-race scenario evidence is missing.");
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
if (
  recovery.runId !== sourceRunId ||
  recovery.projectRef !== STAGING_PROJECT_REF ||
  recovery.safeForIdentityBoundCleanup !== true ||
  recovery.session?.id !== recovery.openSessions?.[0]?.id ||
  recovery.openSessions?.length !== 1 ||
  recovery.openTabs?.length !== 0 ||
  !recovery.checkoutMutationId ||
  scenario.runId !== sourceRunId ||
  scenario.scenario !== recovery.scenario ||
  scenario.checkoutMutationId !== recovery.checkoutMutationId
) {
  throw new Error("Combo-race recovery evidence does not authorize identity-bound cleanup.");
}

const childEnv = {
  ...process.env,
  E2E_RACE_SOURCE_RUN_ID: sourceRunId,
  E2E_RACE_CLEANUP_SESSION_ID: recovery.session.id,
  E2E_RACE_CLEANUP_APP_STATE_VERSION: String(recovery.appState.version),
  E2E_RACE_CLEANUP_APP_STATE_HASH: recovery.appState.hash,
  E2E_RACE_CLEANUP_CUSTOMER_NAME: recovery.customerName,
  E2E_RACE_CLEANUP_STATION: recovery.session.station_name_snapshot,
  E2E_RACE_CLEANUP_REASON:
    process.env.E2E_RACE_CLEANUP_REASON?.trim() ||
    `Playwright combo-race cleanup source ${sourceRunId} scenario ${recovery.scenario} execution ${cleanupRunId}`,
  E2E_REPEAT_COMBO_RECOVERY_ARTIFACT: recoveryPath
};

const runner = path.join(root, "scripts", "run-checkout-settlement-cleanup-staging-e2e.mjs");
const result = spawnSync(process.execPath, [runner], {
  cwd: root,
  env: childEnv,
  stdio: "inherit",
  shell: false
});
process.exit(result.status ?? 1);
