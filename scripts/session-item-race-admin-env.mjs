import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  parseEnvFile,
  STAGING_APP_URL,
  STAGING_MUTATION_CONFIRMATION,
  STAGING_PROJECT_REF
} from "./playwright-staging-env.mjs";

export const SESSION_ITEM_RACE_ADMIN_FILE = ".env.e2e.session-item-admin.local";

export function loadSessionItemRaceAdmin(root, { required = false, allowedStates = ["active"] } = {}) {
  const filePath = path.join(root, SESSION_ITEM_RACE_ADMIN_FILE);
  if (!existsSync(filePath)) {
    if (required) throw new Error(`The ignored ${SESSION_ITEM_RACE_ADMIN_FILE} file is required.`);
    return null;
  }

  const values = parseEnvFile(filePath);
  const requiredKeys = [
    "E2E_SESSION_ITEM_ADMIN_STATE",
    "E2E_SESSION_ITEM_ADMIN_RUN_ID",
    "E2E_SESSION_ITEM_ADMIN_USER",
    "E2E_SESSION_ITEM_ADMIN_PASSWORD",
    "E2E_SESSION_ITEM_ADMIN_ACTOR_ID",
    "E2E_SESSION_ITEM_ADMIN_PROJECT_REF",
    "E2E_SESSION_ITEM_ADMIN_BASE_URL",
    "E2E_CONFIRM_STAGING_MUTATIONS"
  ];
  const missing = requiredKeys.filter((key) => !values[key]?.trim());
  if (missing.length) throw new Error(`The ignored session-item admin file is incomplete: ${missing.join(", ")}.`);
  if (!allowedStates.includes(values.E2E_SESSION_ITEM_ADMIN_STATE)) {
    throw new Error(`The session-item admin lifecycle state is ${values.E2E_SESSION_ITEM_ADMIN_STATE}, not ${allowedStates.join(" or ")}.`);
  }
  if (values.E2E_SESSION_ITEM_ADMIN_PROJECT_REF !== STAGING_PROJECT_REF) {
    throw new Error("The temporary session-item admin is not bound to the exact staging project.");
  }
  if (values.E2E_SESSION_ITEM_ADMIN_BASE_URL !== STAGING_APP_URL) {
    throw new Error("The temporary session-item admin is not bound to the exact staging application.");
  }
  if (values.E2E_CONFIRM_STAGING_MUTATIONS !== STAGING_MUTATION_CONFIRMATION) {
    throw new Error("The temporary session-item admin file lacks the exact staging mutation acknowledgement.");
  }

  const runId = values.E2E_SESSION_ITEM_ADMIN_RUN_ID;
  const createArtifactPath = path.join(
    root,
    "test-artifacts",
    "account-lifecycle",
    `session-item-race-admin-create-${runId}.json`
  );
  const deactivateArtifactPath = path.join(
    root,
    "test-artifacts",
    "account-lifecycle",
    `session-item-race-admin-deactivate-${runId}.json`
  );
  if (!existsSync(createArtifactPath)) {
    throw new Error("The immutable temporary-admin creation artifact is missing.");
  }
  if (existsSync(deactivateArtifactPath)) {
    throw new Error("The temporary session-item admin has immutable deactivation evidence and cannot be reused.");
  }
  const createArtifactText = readFileSync(createArtifactPath, "utf8");
  const createArtifact = JSON.parse(createArtifactText);
  if (
    createArtifact.command !== "create" ||
    createArtifact.runId !== runId ||
    createArtifact.projectRef !== STAGING_PROJECT_REF ||
    createArtifact.baseUrl !== STAGING_APP_URL ||
    createArtifact.productionAllowed !== false ||
    createArtifact.passwordsPrinted !== false ||
    createArtifact.credentialFile !== SESSION_ITEM_RACE_ADMIN_FILE ||
    createArtifact.account?.username !== values.E2E_SESSION_ITEM_ADMIN_USER ||
    createArtifact.account?.actorId !== values.E2E_SESSION_ITEM_ADMIN_ACTOR_ID ||
    createArtifact.account?.role !== "admin" ||
    createArtifact.account?.active !== true
  ) {
    throw new Error("The ignored temporary-admin credential does not match its immutable creation evidence.");
  }

  return {
    filePath,
    state: values.E2E_SESSION_ITEM_ADMIN_STATE,
    accountRunId: values.E2E_SESSION_ITEM_ADMIN_RUN_ID,
    username: values.E2E_SESSION_ITEM_ADMIN_USER,
    password: values.E2E_SESSION_ITEM_ADMIN_PASSWORD,
    actorId: values.E2E_SESSION_ITEM_ADMIN_ACTOR_ID,
    createArtifactPath,
    createArtifactSha256: createHash("sha256").update(createArtifactText).digest("hex"),
    overlay: {
      E2E_USER_B: values.E2E_SESSION_ITEM_ADMIN_USER,
      E2E_PASSWORD_B: values.E2E_SESSION_ITEM_ADMIN_PASSWORD,
      E2E_SESSION_ITEM_ADMIN_EXPECTED_ACTOR_ID: values.E2E_SESSION_ITEM_ADMIN_ACTOR_ID,
      E2E_SESSION_ITEM_ADMIN_ACCOUNT_RUN_ID: values.E2E_SESSION_ITEM_ADMIN_RUN_ID
    }
  };
}
