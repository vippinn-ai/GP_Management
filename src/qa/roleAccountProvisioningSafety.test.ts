import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactUsernameAbsence,
  assertOwnedDeactivationTargets,
  assertSuccessfulCreateResponse,
  createRoleReceiptStore,
  ownedCleanupTargets,
  roleOperationFailure,
  settleCreateAction
} from "../../scripts/role-account-provisioning-safety.mjs";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const entry of cleanupPaths.splice(0)) {
    const target = resolve(entry);
    const root = resolve(tmpdir());
    if (target === root || !target.startsWith(`${root}\\`) || !target.split("\\").at(-1)?.startsWith("normops-role-")) {
      throw new Error(`Unsafe role-account test cleanup target: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
});

describe("staging role-account provisioning safety", () => {
  it("requires authoritative empty results for every exact receptionist, manager, and observer username", () => {
    const targets = ["qa_role_rec_run_1", "qa_role_mgr_run_1", "qa_role_admin_run_1"];
    expect(assertExactUsernameAbsence(targets, {
      qa_role_rec_run_1: [],
      qa_role_mgr_run_1: [],
      qa_role_admin_run_1: []
    })).toBe(true);
    expect(() => assertExactUsernameAbsence(targets, { qa_role_rec_run_1: [] })).toThrow(/both exact targets/i);
    expect(() => assertExactUsernameAbsence(targets, {
      qa_role_rec_run_1: [],
      qa_role_mgr_run_1: [{ username: "qa_role_mgr_run_1" }],
      qa_role_admin_run_1: []
    })).toThrow(/already exists/i);
    expect(() => assertExactUsernameAbsence([targets[0], targets[0]], {
      [targets[0]]: []
    })).toThrow(/distinct/i);
  });

  it("selects cleanup targets only after authoritative profile ownership is captured", () => {
    expect(ownedCleanupTargets([
      { username: "qa_role_rec_run_1", role: "receptionist", profileId: "profile-owned" },
      { username: "qa_role_mgr_run_1", role: "manager" }
    ])).toEqual([
      { username: "qa_role_rec_run_1", role: "receptionist", profileId: "profile-owned" }
    ]);
    const owned = [
      { username: "qa_role_rec_run_1", role: "receptionist", profileId: "profile-rec" },
      { username: "qa_role_mgr_run_1", role: "manager", profileId: "profile-mgr" },
      { username: "qa_role_admin_run_1", role: "admin", profileId: "profile-admin" }
    ];
    expect(assertOwnedDeactivationTargets(owned)).toEqual(owned);
    expect(() => assertOwnedDeactivationTargets(owned.map(({ username, role }) => ({ username, role }))))
      .toThrow(/deactivation was refused/i);
    expect(() => assertOwnedDeactivationTargets([{ ...owned[0] }, { username: "unowned", role: "manager" }]))
      .toThrow(/deactivation was refused/i);
  });

  it("accepts only the exact successful edge-function creation response", () => {
    expect(assertSuccessfulCreateResponse(200, { ok: true })).toBe(true);
    expect(() => assertSuccessfulCreateResponse(201, { ok: true })).toThrow(/did not prove/i);
    expect(() => assertSuccessfulCreateResponse(200, { ok: false })).toThrow(/did not prove/i);
    expect(() => assertSuccessfulCreateResponse(200, { ok: true, id: "unexpected" })).toThrow(/did not prove/i);
    expect(() => assertSuccessfulCreateResponse(200, null)).toThrow(/did not prove/i);
  });

  it("settles a create response waiter safely when the click fails before any response", async () => {
    const neverResponds = new Promise<never>(() => undefined);
    await expect(settleCreateAction(neverResponds, Promise.reject(new Error("click failed"))))
      .rejects.toThrow("click failed");
    await expect(settleCreateAction(Promise.resolve({ status: 200 }), Promise.resolve()))
      .resolves.toEqual({ status: 200 });
  });

  it("preserves the primary classification and reports browser cleanup independently", () => {
    const primaryAndCleanup = roleOperationFailure({
      operationFailed: true,
      terminalReceiptUnavailable: false,
      failureStage: "create-manager",
      cleanupStatuses: ["rejected", "fulfilled"]
    });
    expect(primaryAndCleanup?.message).toContain("failed closed at create-manager");
    expect(primaryAndCleanup?.message).toContain("Browser cleanup also failed closed");
    const cleanupOnly = roleOperationFailure({
      operationFailed: false,
      terminalReceiptUnavailable: false,
      failureStage: "complete",
      cleanupStatuses: ["fulfilled", "rejected"]
    });
    expect(cleanupOnly?.message).toBe("Staging role-account browser cleanup failed closed after the operation completed.");
    expect(roleOperationFailure({
      operationFailed: false,
      terminalReceiptUnavailable: false,
      failureStage: "complete",
      cleanupStatuses: ["fulfilled", "fulfilled"]
    })).toBeNull();
  });

  it("writes immutable zero-retry secret-free reservation and terminal receipts", () => {
    const root = mkdtempSync(join(tmpdir(), "normops-role-"));
    cleanupPaths.push(root);
    const secrets = ["admin-password", "generated-password"];
    const store = createRoleReceiptStore({ root, runId: "normops-role-20260927", command: "create", secrets });
    const reservation = store.write("reservation", {
      targets: [{ username: "qa_role_rec", role: "receptionist" }],
      credentialsPrinted: false
    });
    const success = store.write("success", {
      accounts: [{ username: "qa_role_rec", role: "receptionist", profileId: "profile-1", active: true }],
      cleanupOutcomes: []
    });
    expect(JSON.parse(readFileSync(reservation.path, "utf8"))).toMatchObject({ attempt: 1, retry: 0, phase: "reservation" });
    expect(JSON.parse(readFileSync(success.path, "utf8"))).toMatchObject({ attempt: 1, retry: 0, phase: "success" });
    expect(readFileSync(reservation.path, "utf8")).not.toContain(secrets[0]);
    expect(readFileSync(success.path, "utf8")).not.toContain(secrets[1]);
    expect(() => store.write("reservation", { targets: [] })).toThrow();
    expect(() => store.write("failure", { error: "late failure" })).toThrow();
    expect(() => store.write("failure", { password: "forbidden" })).toThrow(/forbidden/i);
    expect(() => store.write("failure", { error: secrets[1] })).toThrow(/credential/i);
    const closeout = store.write("closeout", { credentialFileRemoved: true });
    expect(JSON.parse(readFileSync(closeout.path, "utf8"))).toMatchObject({ phase: "closeout", retry: 0 });
  });

  it("requires the orchestration to preflight both names, preserve recovery, and clean only owned IDs", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "manage-financial-v2-role-accounts-staging.mjs"), "utf8");
    expect(source).toContain("assertExactUsernameAbsence");
    expect(source).toContain("authoritativeUsernameAbsence");
    expect(source).toContain("page.waitForResponse");
    expect(source).toContain("settleCreateAction");
    expect(source).toContain("assertSuccessfulCreateResponse(createResponse.status(), await createResponse.json())");
    expect(source).toContain("ownedCleanupTargets");
    expect(source).toContain("profileId");
    expect(source).toContain("provisioning_failed_reconciled");
    expect(source).toContain("E2E_OBSERVER_ADMIN_USER");
    expect(source).toContain("E2E_OBSERVER_ADMIN_PASSWORD");
    expect(source).toContain("E2E_OBSERVER_ADMIN_ACTOR_ID");
    expect(source).not.toContain("unlinkSync(rolePath);\n      const original");
    expect(source).toContain('write("reservation"');
    expect(source).toContain('write("failure"');
    expect(source).toContain('write("success"');
    expect(source).toContain('write("closeout"');
    expect(source.indexOf('receiptStore.write("success"')).toBeLessThan(source.indexOf("unlinkSync(rolePath)"));
    expect(source).toContain("assertOwnedDeactivationTargets(accounts)");
    expect(source).not.toContain('status: "not-owned"');
    expect(source).not.toContain("throw error");
    expect(source).not.toContain("AggregateError");
    expect(source).toContain("Promise.allSettled");
  });
});
