import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile } from "./playwright-staging-env.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const unsupportedArgs = args.filter((argument) => argument !== "--list" && argument !== "--help");
if (unsupportedArgs.length) {
  throw new Error(`The role-matrix runner accepts only --list or --help; unsupported arguments: ${unsupportedArgs.join(", ")}`);
}
const discoveryOnly = args.includes("--list") || args.includes("--help");
const baseEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const roleEnv = parseEnvFile(path.join(root, ".env.e2e.roles.local"));
const env = { ...baseEnv, ...roleEnv, ...process.env };

if (!discoveryOnly) {
  const required = [
    "E2E_RECEPTIONIST_USER",
    "E2E_RECEPTIONIST_PASSWORD",
    "E2E_MANAGER_USER",
    "E2E_MANAGER_PASSWORD"
  ];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing role-matrix credentials: ${missing.join(", ")}. Copy .env.e2e.roles.example to .env.e2e.roles.local and fill staging-only values.`
    );
  }
  if (env.E2E_RECEPTIONIST_USER.trim().toLowerCase() === env.E2E_MANAGER_USER.trim().toLowerCase()) {
    throw new Error("The role matrix requires distinct receptionist and manager accounts.");
  }
  env.E2E_USER_A = env.E2E_RECEPTIONIST_USER;
  env.E2E_PASSWORD_A = env.E2E_RECEPTIONIST_PASSWORD;
  env.E2E_USER_B = env.E2E_MANAGER_USER;
  env.E2E_PASSWORD_B = env.E2E_MANAGER_PASSWORD;
  env.E2E_ROLE_MATRIX = "release-b-receptionist-manager";
}

const runner = path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs");
const scenario = "tests/e2e/staging/release-b-role-checkout-hop-timing-v2.e2e.ts";
const result = spawnSync(process.execPath, [runner, scenario, ...args], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: false
});
process.exit(result.status ?? 1);
