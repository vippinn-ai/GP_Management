import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

if (process.argv.slice(2).length > 0) {
  throw new Error("The checkout-settlement cleanup runner accepts no arguments.");
}
for (const name of [
  "E2E_RUN_ID",
  "E2E_RACE_SOURCE_RUN_ID",
  "E2E_RACE_CLEANUP_SESSION_ID",
  "E2E_RACE_CLEANUP_APP_STATE_VERSION",
  "E2E_RACE_CLEANUP_APP_STATE_HASH"
]) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required for guarded cleanup.`);
}
const cleanupRunId = process.env.E2E_RUN_ID.trim();
if (cleanupRunId === process.env.E2E_RACE_SOURCE_RUN_ID.trim()) {
  throw new Error("Cleanup execution ID must differ from the source race ID.");
}

const root = process.cwd();
const artifactRoot = path.join(root, "test-artifacts");
const collisions = [];
function findCollisions(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name.includes(cleanupRunId)) collisions.push(path.relative(root, entryPath));
    if (entry.isDirectory()) findCollisions(entryPath);
  }
}
findCollisions(artifactRoot);
if (collisions.length) throw new Error(`Cleanup artifact identity already exists: ${collisions.join(", ")}`);
const genericRunner = path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs");
const spec = "tests/e2e/staging/release-b-checkout-settlement-cleanup-v2.e2e.ts";
const result = spawnSync(process.execPath, [genericRunner, spec], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: false
});
process.exit(result.status ?? 1);
