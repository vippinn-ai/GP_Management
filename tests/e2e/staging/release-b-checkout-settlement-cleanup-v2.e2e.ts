import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  assertAuthoritativeOrganizationIdentity,
  attachFailureScreenshot,
  attachJson,
  captureAuthenticatedRestRequests,
  captureRpcEvidence,
  credentials,
  readRestRows,
  rejectSessionIfOpen,
  signIn,
  type CapturedRpcRequest,
  type RpcEvidence
} from "./support/app";

const cleanupRunId = process.env.E2E_RUN_ID?.trim();
const sourceRunId = process.env.E2E_RACE_SOURCE_RUN_ID?.trim();
const sessionId = process.env.E2E_RACE_CLEANUP_SESSION_ID?.trim();
const expectedVersion = Number(process.env.E2E_RACE_CLEANUP_APP_STATE_VERSION);
const expectedHash = process.env.E2E_RACE_CLEANUP_APP_STATE_HASH?.trim();
const customerName = `QA Checkout Settlement Race ${sourceRunId}`;
const station = "8 Ball Pool";
const reason = `Playwright checkout-settlement adjustment-winner cleanup source ${sourceRunId} execution ${cleanupRunId}`;

if (!cleanupRunId || !sourceRunId || cleanupRunId === sourceRunId || !sessionId || !Number.isInteger(expectedVersion) || !expectedHash) {
  throw new Error("Exact checkout-settlement cleanup identity and app_state baseline are required.");
}

function appStateHash(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

test("rejects only the exact unbilled adjustment-winner session", async ({ page }, testInfo) => {
  const requests: CapturedRpcRequest[] = [];
  const rpcEvidence: RpcEvidence[] = [];
  captureAuthenticatedRestRequests(page, requests);
  captureRpcEvidence(page, "origin", rpcEvidence);
  let cleanupEvidence: Record<string, unknown> = {};

  try {
    await signIn(page, credentials("A"));
    const identity = await assertAuthoritativeOrganizationIdentity(page, requests, "admin", "org-primary");
    const [beforeSessions, beforeAppState] = await Promise.all([
      readRestRows<{
        id: string;
        status: string;
        close_disposition: string | null;
        closed_bill_id: string | null;
        customer_name: string;
        station_name_snapshot: string;
      }>(page, identity.restBase, identity.headers, "sessions", {
        organization_id: "eq.org-primary",
        id: `eq.${sessionId}`,
        select: "id,status,close_disposition,closed_bill_id,customer_name,station_name_snapshot"
      }),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary",
        select: "version,data"
      })
    ]);
    expect(beforeSessions).toEqual([{
      id: sessionId,
      status: "active",
      close_disposition: null,
      closed_bill_id: null,
      customer_name: customerName,
      station_name_snapshot: station
    }]);
    expect(beforeAppState).toHaveLength(1);
    expect(beforeAppState[0].version).toBe(expectedVersion);
    expect(appStateHash(beforeAppState[0].data)).toBe(expectedHash);

    const rejected = await rejectSessionIfOpen(page, station, customerName, reason);
    expect(rejected, "Guarded cleanup did not reject the exact active session.").toBe(true);
    const rejection = rpcEvidence.filter((entry) => entry.rpc === "reject_session" && entry.status < 300);
    expect(rejection).toHaveLength(1);
    expect(rejection[0].entityId).toBe(sessionId);
    expect(rejection[0].mutationId).toBeTruthy();
    expect(rejection[0].eventId).toBeTruthy();
    expect(rejection[0].changedRows?.sessions).toEqual([sessionId]);
    expect(rejection[0].changedRows?.audit_logs).toHaveLength(1);
    expect(rpcEvidence.filter((entry) => entry.rpc.startsWith("commit_financial") || entry.rpc === "commit_checkout_bill_v2")).toEqual([]);

    const [afterSessions, afterAppState] = await Promise.all([
      readRestRows<{ id: string; status: string; close_disposition: string | null; closed_bill_id: string | null }>(
        page,
        identity.restBase,
        identity.headers,
        "sessions",
        {
          organization_id: "eq.org-primary",
          id: `eq.${sessionId}`,
          select: "id,status,close_disposition,closed_bill_id"
        }
      ),
      readRestRows<{ version: number; data: unknown }>(page, identity.restBase, identity.headers, "app_state", {
        id: "eq.primary",
        select: "version,data"
      })
    ]);
    expect(afterSessions).toEqual([{
      id: sessionId,
      status: "closed",
      close_disposition: "rejected",
      closed_bill_id: null
    }]);
    expect(afterAppState).toHaveLength(1);
    expect(afterAppState[0].version).toBe(expectedVersion + 1);
    cleanupEvidence = {
      cleanupRunId,
      sourceRunId,
      sessionId,
      customerName,
      station,
      reason,
      actorId: identity.actorId,
      rejection: rejection[0],
      appStateBefore: { version: beforeAppState[0].version, hash: expectedHash },
      appStateAfter: {
        version: afterAppState[0].version,
        hash: appStateHash(afterAppState[0].data)
      }
    };
  } finally {
    await attachJson(testInfo, "checkout-settlement-adjustment-winner-cleanup", {
      ...cleanupEvidence,
      rpcEvidence
    });
    await attachFailureScreenshot(testInfo, page, "checkout-settlement-cleanup-failure");
  }
});
