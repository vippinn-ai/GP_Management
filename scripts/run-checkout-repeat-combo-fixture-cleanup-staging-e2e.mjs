import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile, sanitizeRunId } from "./playwright-staging-env.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((argument) => argument !== "--list")) throw new Error("Fixture cleanup accepts only the optional --list flag.");
const root = process.cwd();
const discoveryOnly = args[0] === "--list";
const childEnv = { ...process.env };
if (!discoveryOnly) {
  const localEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
  const runId = sanitizeRunId(childEnv.E2E_FIXTURE_RUN_ID || localEnv.E2E_FIXTURE_RUN_ID);
  const cleanupRunId = sanitizeRunId(childEnv.E2E_FIXTURE_CLEANUP_RUN_ID);
  if (cleanupRunId === runId) throw new Error("Fixture cleanup requires a fresh execution ID distinct from the setup ID.");
  if (childEnv.E2E_FIXTURE_CLEANUP_APPROVED !== `${runId}:${cleanupRunId}`) throw new Error("Fixture cleanup needs separate fixture-and-execution authorization in E2E_FIXTURE_CLEANUP_APPROVED.");
  const reportPath = path.join(root, "test-artifacts", "reconciliation", `checkout-repeat-combo-fixture-postflight-${runId}.json`);
  const preflightPath = path.join(root, "test-artifacts", "preflight", `checkout-repeat-combo-fixture-cleanup-preflight-${cleanupRunId}.json`);
  if (!fs.existsSync(reportPath)) throw new Error("The immutable fixture postflight is missing.");
  if (!fs.existsSync(preflightPath)) throw new Error("The immutable fixture cleanup preflight is missing.");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
  if (!report.reconciled || !["item_only", "complete"].includes(report.classification) || report.runId !== runId) throw new Error("Fixture cleanup refused an unreconciled or mismatched state.");
  if (!preflight.safeToRun || preflight.fixtureRunId !== runId || preflight.cleanupRunId !== cleanupRunId || preflight.effectCount !== report.effectCount) throw new Error("Fixture cleanup refused an unsafe or mismatched fresh preflight.");
  const artifactRoot = path.join(root, "test-artifacts");
  const collisions = [];
  function findCollisions(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name.includes(cleanupRunId) && path.resolve(entryPath) !== path.resolve(preflightPath)) {
        collisions.push(path.relative(root, entryPath));
      }
      if (entry.isDirectory()) findCollisions(entryPath);
    }
  }
  findCollisions(artifactRoot);
  if (collisions.length) throw new Error(`Fixture cleanup execution ID collides with existing artifacts: ${collisions.join(", ")}`);
  childEnv.E2E_RUN_ID = cleanupRunId;
  childEnv.E2E_FIXTURE_RUN_ID = runId;
  childEnv.E2E_FIXTURE_CLEANUP_RUN_ID = cleanupRunId;
  childEnv.E2E_FIXTURE_ITEM_NAME = report.fixture.item.name;
  childEnv.E2E_FIXTURE_COMBO_NAME = report.fixture.combo?.name ?? `QA Repeat Combo ${runId}`;
  childEnv.E2E_FIXTURE_CLEANUP_EFFECTS = String(report.effectCount);
  childEnv.E2E_FIXTURE_ITEM_ID = preflight.fixture.item.id;
  childEnv.E2E_FIXTURE_COMBO_ID = preflight.fixture.combo?.id ?? "";
  childEnv.E2E_FIXTURE_CLEANUP_STOCK_QTY = String(preflight.fixture.item.stock_qty);
  childEnv.E2E_FIXTURE_CLEANUP_BASELINE_VERSION = String(preflight.appState.version);
  childEnv.E2E_FIXTURE_CLEANUP_BASELINE_HASH = preflight.appState.hash;
}
const result = spawnSync(process.execPath, [
  path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs"),
  "tests/e2e/staging/release-b-checkout-repeat-combo-fixture-cleanup.e2e.ts",
  ...args
], { cwd: root, env: childEnv, stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
