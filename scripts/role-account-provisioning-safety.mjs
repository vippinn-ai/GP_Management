import fs from "node:fs";
import path from "node:path";

const RECEIPT_KEY_BLOCKLIST = /(?:password|authorization|api[_-]?key|token|secret|cookie|headers?|request|response)/i;

function assertRunId(runId) {
  if (!/^[A-Za-z0-9_-]{6,48}$/.test(runId ?? "")) {
    throw new Error("Role-account receipt run identity is invalid.");
  }
}

function assertPlainReceiptValue(value, trail = "receipt") {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPlainReceiptValue(entry, `${trail}[${index}]`));
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${trail} must contain only JSON-compatible values.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (RECEIPT_KEY_BLOCKLIST.test(key)) throw new Error(`${trail}.${key} is forbidden in provisioning receipts.`);
    assertPlainReceiptValue(entry, `${trail}.${key}`);
  }
}

export function assertExactUsernameAbsence(targetUsernames, rowsByUsername) {
  if (!Array.isArray(targetUsernames) || targetUsernames.length < 2) {
    throw new Error("At least two staging QA usernames must be checked before creation.");
  }
  const normalized = targetUsernames.map((value) => value?.trim()).filter(Boolean);
  if (normalized.length !== targetUsernames.length || new Set(normalized).size !== normalized.length) {
    throw new Error("Role-account target usernames must be nonempty and distinct.");
  }
  if (!rowsByUsername || Object.getPrototypeOf(rowsByUsername) !== Object.prototype) {
    throw new Error("Authoritative username absence evidence is missing.");
  }
  const observedKeys = Object.keys(rowsByUsername).sort();
  if (JSON.stringify(observedKeys) !== JSON.stringify([...normalized].sort())) {
    throw new Error("Authoritative username absence evidence does not cover both exact targets.");
  }
  for (const username of normalized) {
    const rows = rowsByUsername[username];
    if (!Array.isArray(rows)) throw new Error(`Authoritative username evidence is invalid for ${username}.`);
    if (rows.length !== 0) throw new Error(`The exact staging username ${username} already exists.`);
  }
  return true;
}

export function ownedCleanupTargets(accounts) {
  if (!Array.isArray(accounts)) throw new Error("Role-account ownership evidence must be an array.");
  return accounts
    .filter((account) => account?.profileId)
    .map((account) => ({
      username: account.username,
      role: account.role,
      profileId: account.profileId
    }));
}

export function assertOwnedDeactivationTargets(accounts) {
  const owned = ownedCleanupTargets(accounts);
  if (owned.length !== accounts.length) {
    throw new Error("Role-account recovery evidence is missing an authoritative owned profile identity; deactivation was refused.");
  }
  return owned;
}

export function assertSuccessfulCreateResponse(status, payload) {
  if (status !== 200 || !payload || Object.getPrototypeOf(payload) !== Object.prototype
    || payload.ok !== true || Object.keys(payload).length !== 1) {
    throw new Error("The staging admin-create-user response did not prove one successful creation.");
  }
  return true;
}

export async function settleCreateAction(responsePromise, clickPromise) {
  const [response] = await Promise.all([responsePromise, clickPromise]);
  return response;
}

export function roleOperationFailure({ operationFailed, terminalReceiptUnavailable, failureStage, cleanupStatuses }) {
  const cleanupFailed = cleanupStatuses.some((status) => status !== "fulfilled");
  if (operationFailed) {
    return new Error([
      terminalReceiptUnavailable
        ? "Staging role-account operation failed closed and its immutable terminal receipt is unavailable."
        : `Staging role-account operation failed closed at ${failureStage}; inspect the immutable terminal receipt.`,
      cleanupFailed ? "Browser cleanup also failed closed." : ""
    ].filter(Boolean).join(" "));
  }
  if (cleanupFailed) return new Error("Staging role-account browser cleanup failed closed after the operation completed.");
  return null;
}

export function createRoleReceiptStore({ root, runId, command, secrets = [], io = fs }) {
  assertRunId(runId);
  if (!new Set(["create", "deactivate"]).has(command)) throw new Error("Role-account receipt command is invalid.");
  const directory = path.resolve(root, "test-artifacts", "role-account-provisioning", runId);
  const expectedRoot = path.resolve(root, "test-artifacts", "role-account-provisioning");
  if (directory === expectedRoot || !directory.startsWith(`${expectedRoot}${path.sep}`)) {
    throw new Error("Role-account receipt path escaped the artifact directory.");
  }
  io.mkdirSync(directory, { recursive: true });

  const write = (phase, payload) => {
    if (!new Set(["reservation", "success", "failure", "closeout"]).has(phase)) {
      throw new Error("Role-account receipt phase is invalid.");
    }
    const receipt = {
      schemaVersion: 1,
      operation: command,
      runId,
      attempt: 1,
      retry: 0,
      phase,
      ...payload
    };
    assertPlainReceiptValue(receipt);
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    for (const secret of secrets) {
      if (typeof secret === "string" && secret.length && serialized.includes(secret)) {
        throw new Error("Provisioning receipt contains a credential value.");
      }
    }
    const receiptPath = path.join(directory,
      phase === "reservation" ? `${command}-reservation.json`
        : phase === "closeout" ? `${command}-closeout.json`
          : `${command}-terminal.json`);
    io.writeFileSync(receiptPath, serialized, { encoding: "utf8", flag: "wx" });
    return { path: receiptPath, receipt };
  };

  return { directory, write };
}
