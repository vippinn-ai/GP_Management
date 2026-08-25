import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnvFile } from "./playwright-staging-env.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const mode = args[0] ?? "--all";
const allowedModes = new Set([
  "--all", "--list", "--help", "--remaining", "--remaining-list", "--remaining-three", "--remaining-three-list"
]);
if (args.length > 1 || !allowedModes.has(mode)) {
  throw new Error("The role-matrix runner accepts no argument or exactly one documented mode.");
}
const discoveryOnly = mode === "--list" || mode === "--help" || mode.endsWith("-list");
const remainingOnly = mode === "--remaining" || mode === "--remaining-list";
const remainingThreeOnly = mode === "--remaining-three" || mode === "--remaining-three-list";
const baseEnv = parseEnvFile(path.join(root, ".env.e2e.local"));
const roleEnv = parseEnvFile(path.join(root, ".env.e2e.roles.local"));
const env = { ...baseEnv, ...process.env };
env.E2E_ROLE_MATRIX_PHASE = remainingThreeOnly ? "remaining-three" : remainingOnly ? "remaining" : "all";

if (!discoveryOnly) {
  const required = [
    "E2E_RECEPTIONIST_USER",
    "E2E_RECEPTIONIST_PASSWORD",
    "E2E_MANAGER_USER",
    "E2E_MANAGER_PASSWORD"
  ];
  const missing = required.filter((key) => !roleEnv[key]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing role-matrix credentials: ${missing.join(", ")}. Copy .env.e2e.roles.example to .env.e2e.roles.local and fill staging-only values.`
    );
  }
  if (roleEnv.E2E_ROLE_ACCOUNT_STATE?.trim() !== "active") {
    throw new Error("The role matrix requires an active, fully verified generated role-account file.");
  }
  if (roleEnv.E2E_RECEPTIONIST_USER.trim().toLowerCase() === roleEnv.E2E_MANAGER_USER.trim().toLowerCase()) {
    throw new Error("The role matrix requires distinct receptionist and manager accounts.");
  }
  env.E2E_USER_A = roleEnv.E2E_RECEPTIONIST_USER;
  env.E2E_PASSWORD_A = roleEnv.E2E_RECEPTIONIST_PASSWORD;
  env.E2E_USER_B = roleEnv.E2E_MANAGER_USER;
  env.E2E_PASSWORD_B = roleEnv.E2E_MANAGER_PASSWORD;
  env.E2E_RUN_ID = roleEnv.E2E_RUN_ID;
  env.E2E_ROLE_MATRIX = "release-b-receptionist-manager";
}

const runner = path.join(root, "scripts", "run-financial-v2-staging-e2e.mjs");
const scenario = "tests/e2e/staging/release-b-role-checkout-hop-timing-v2.e2e.ts";
const forwardedArgs = mode === "--list" || mode === "--help"
  ? [mode]
  : mode.endsWith("-list") ? ["--list"] : [];
const result = spawnSync(process.execPath, [runner, scenario, ...forwardedArgs], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: false
});
process.exit(result.status ?? 1);
