import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const allowed = new Set(["--list"]);
if (args.some((argument) => !allowed.has(argument)) || args.length > 1) {
  throw new Error("The checkout-settlement race runner accepts only the optional --list discovery flag.");
}

const root = process.cwd();
const genericRunner = path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs");
const spec = "tests/e2e/staging/release-b-checkout-settlement-race-v2.e2e.ts";
const result = spawnSync(process.execPath, [genericRunner, spec, ...args], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: false
});

process.exit(result.status ?? 1);
