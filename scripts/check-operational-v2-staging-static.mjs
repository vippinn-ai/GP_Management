import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

run("Selected operational Playwright lint", path.join(projectRoot, "node_modules", "eslint", "bin", "eslint.js"), selectedSpecs);
run("Selected operational Playwright TypeScript", path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), [
  "--noEmit",
  "--target", "ES2023",
  "--lib", "ES2023,DOM,DOM.Iterable",
  "--module", "ESNext",
  "--moduleResolution", "Bundler",
  "--skipLibCheck",
  "--types", "node,@playwright/test,vite/client",
  ...selectedSpecs
]);

console.log(`Static operational Playwright gate passed for ${selectedSpecs.length} selected specs.`);
