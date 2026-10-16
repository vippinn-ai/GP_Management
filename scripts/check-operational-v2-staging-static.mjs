import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectedSpecs = [
  "operational-lifecycle-v2.e2e.ts",
  "operational-lifecycle-v2-concurrency.e2e.ts",
  "operational-lifecycle-v2-continuations.e2e.ts",
  "operational-lifecycle-v2-recovery-realtime.e2e.ts",
  "operational-lifecycle-v2-downstream-parity.e2e.ts",
  "operational-lifecycle-v2-hop-mutation-races.e2e.ts",
  "release-a-hop-pause.e2e.ts",
  "release-a-inventory-matrix.e2e.ts",
  "release-a-report-exports.e2e.ts",
  "release-b-checkout-reject-race-v2.e2e.ts",
  "release-b-checkout-hop-race-v2.e2e.ts",
  "release-b-hopped-concurrency-v2.e2e.ts",
  "release-b-multihop-concurrency-v2.e2e.ts",
  "release-b-role-checkout-hop-timing-v2.e2e.ts"
].map((name) => path.join("tests", "e2e", "staging", name));

function run(label, executable, args) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

run("Selected operational Playwright lint", path.join(path.dirname(require.resolve("eslint/package.json")), "bin", "eslint.js"), selectedSpecs);
const selectedTools = ["scripts/run-operational-v2-staging-e2e.mjs", "scripts/lifecycle-runner-guards.mjs",
  "scripts/verify-convergence-diagnostics-posttest.mjs", "scripts/convergence-diagnostics-contract.nodechecks.mjs",
  "scripts/lifecycle-actor-preflight.mjs", "scripts/lifecycle-actor-preflight.nodechecks.mjs",
  "scripts/role-account-provisioning-safety.mjs", "scripts/manage-financial-v2-role-accounts-staging.mjs",
  "scripts/role-account-browser-safety.mjs", "scripts/role-account-browser-safety.nodechecks.mjs",
  "scripts/run-financial-v2-role-matrix-staging-e2e.mjs",
  "scripts/lifecycle-runner-guards.nodechecks.mjs", "scripts/playwright-compact-reporter.mjs", "scripts/check-operational-v2-staging-static.mjs",
  "scripts/lifecycle-install-contract.mjs", "scripts/build-operational-lifecycle-v2-staging-install.mjs",
  "scripts/build-operational-lifecycle-v2-staging-reinstall.mjs", "scripts/verify-operational-lifecycle-v2-staging-postflight.mjs",
  "scripts/lifecycle-acl-convergence.mjs", "scripts/build-operational-lifecycle-v2-staging-acl-convergence.mjs",
  "scripts/verify-operational-lifecycle-v2-staging-acl-convergence.mjs", "scripts/lifecycle-database-lineage.mjs", "scripts/build-lifecycle-database-lineage.mjs",
  "scripts/build-operational-v2-transactional-proof.mjs", "scripts/build-operational-v2-proof-postrollback.mjs", "scripts/verify-operational-v2-proof-postrollback.mjs"];
run("Lifecycle runner lint", path.join(path.dirname(require.resolve("eslint/package.json")), "bin", "eslint.js"), [
  "--config", "scripts/lifecycle-eslint.config.mjs", "--max-warnings=0", ...selectedTools
]);
for (const file of selectedTools) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: projectRoot, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Syntax check failed: ${file}`);
}
run("Selected operational Playwright TypeScript", require.resolve("typescript/bin/tsc"), [
  "--noEmit",
  "--target", "ES2023",
  "--lib", "ES2023,DOM,DOM.Iterable",
  "--module", "ESNext",
  "--moduleResolution", "Bundler",
  "--skipLibCheck",
  "--types", "node,@playwright/test,vite/client",
  ...selectedSpecs,
  "playwright.operational-v2.staging.config.ts"
]);

console.log(`Static operational Playwright gate passed for ${selectedSpecs.length} selected specs.`);
