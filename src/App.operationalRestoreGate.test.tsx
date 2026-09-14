import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAppDataSnapshot, RemoteProfile } from "./backend";
import type { OperationalMutation } from "./operationalSync";
import { PENDING_OPERATION_STORAGE_KEY } from "./operationalSync";
import { hydrateAppData } from "./storage";

const mocks = vi.hoisted(() => ({
  resolveRemoteSessionProfile: vi.fn(),
  loadAppDataSnapshot: vi.fn(),
  saveAppData: vi.fn(),
  subscribeToAppData: vi.fn(),
  commitOperationalMutation: vi.fn(),
  loadDeferredNormalizedDashboardActivity: vi.fn(),
  loadDeferredNormalizedDashboardHistory: vi.fn(),
  loadActivityFeedPage: vi.fn()
}));

vi.mock("./backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backend")>();
  return {
    ...actual,
    isBackendConfigured: () => true,
    resolveRemoteSessionProfile: mocks.resolveRemoteSessionProfile
  };
});

vi.mock("./dataGateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dataGateway")>();
  return {
    ...actual,
    resolveBackendFeatureFlags: () => ({
      ...actual.DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedBootstrap: true,
      normalizedLiveReads: true,
      normalizedRealtime: true,
      rpcOperationalWrites: true,
      operationalRpcV2: true,
      activityFeed: true
    }),
    defaultRemoteDataGateway: {
      loadAppDataSnapshot: mocks.loadAppDataSnapshot,
      saveAppData: mocks.saveAppData,
      subscribeToAppData: mocks.subscribeToAppData,
      commitOperationalMutation: mocks.commitOperationalMutation
    },
    loadDeferredNormalizedDashboardActivity: mocks.loadDeferredNormalizedDashboardActivity,
    loadDeferredNormalizedDashboardHistory: mocks.loadDeferredNormalizedDashboardHistory
  };
});

vi.mock("./dataGateway/activityFeed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dataGateway/activityFeed")>();
  return { ...actual, loadActivityFeedPage: mocks.loadActivityFeedPage };
});

import App from "./App";

const activeProfile: RemoteProfile = {
  id: "user-1",
  name: "Admin User",
  username: "admin",
  role: "admin",
  active: true
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function createSnapshot(): RemoteAppDataSnapshot {
  return {
    version: 44,
    source: "normalized_bootstrap",
    appData: hydrateAppData({
      users: [{
        ...activeProfile,
        tabPermissions: activeProfile.tabPermissions ?? undefined
      }]
    })
  };
}

function createPendingMutation(): OperationalMutation {
  return {
    id: "op-seeded-before-restore",
    kind: "recordSessionAudit",
    label: "Seeded pending audit",
    userId: activeProfile.id,
    createdAt: "2026-09-13T10:00:00.000Z",
    baseVersion: 43,
    status: "pending",
    entityType: "session",
    entityId: "session-seeded",
    payload: {
      auditLog: {
        id: "audit-seeded",
        action: "session_updated",
        entityType: "session",
        entityId: "session-seeded",
        message: "Seeded pending audit.",
        createdAt: "2026-09-13T10:00:00.000Z",
        userId: activeProfile.id
      }
    }
  };
}

describe("App operational restore dispatch gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.subscribeToAppData.mockReturnValue(() => undefined);
    mocks.saveAppData.mockResolvedValue(45);
    mocks.resolveRemoteSessionProfile.mockResolvedValue({ status: "active", profile: activeProfile });
    mocks.commitOperationalMutation.mockResolvedValue({
      mutationId: "op-seeded-before-restore",
      rpcName: "record_session_audit",
      organizationId: "org-primary",
      entityType: "session",
      entityId: "session-seeded",
      canonicalHydrated: true
    });
    mocks.loadDeferredNormalizedDashboardActivity.mockResolvedValue({ auditLogs: [] });
    mocks.loadDeferredNormalizedDashboardHistory.mockResolvedValue({ bills: [], payments: [], expenses: [] });
    mocks.loadActivityFeedPage.mockResolvedValue({ items: [], actors: [], hasMore: false, nextCursor: null });
    window.localStorage.setItem(PENDING_OPERATION_STORAGE_KEY, JSON.stringify([createPendingMutation()]));
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("dispatches nothing before authoritative restore readiness and exactly once afterward", async () => {
    const restore = deferred<RemoteAppDataSnapshot>();
    mocks.loadAppDataSnapshot.mockReturnValue(restore.promise);

    render(<App />);

    await waitFor(() => expect(mocks.resolveRemoteSessionProfile).toHaveBeenCalledTimes(1));
    expect(mocks.loadAppDataSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.commitOperationalMutation).not.toHaveBeenCalled();

    restore.resolve(createSnapshot());

    await waitFor(() => expect(mocks.commitOperationalMutation).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(mocks.commitOperationalMutation).toHaveBeenCalledTimes(1);
  });

  it("renders recent activity while financial history is pending and preserves Show All navigation", async () => {
    const history = deferred<{ bills: []; payments: []; expenses: [] }>();
    let historySettled = false;
    void history.promise.finally(() => { historySettled = true; });
    mocks.loadAppDataSnapshot.mockResolvedValue(createSnapshot());
    mocks.loadDeferredNormalizedDashboardHistory.mockReturnValue(history.promise);
    mocks.loadActivityFeedPage.mockResolvedValue({
      items: [{
        id: "activity-fast",
        occurredAt: "2026-09-14T10:00:00.000Z",
        actorUserId: activeProfile.id,
        actorName: activeProfile.name,
        actorUsername: activeProfile.username,
        actorRole: activeProfile.role,
        action: "session_updated",
        category: "session",
        entityType: "session",
        entityId: "session-fast",
        summary: "Activity available before financial history",
        details: {},
        sourceKind: "audit_log",
        legacy: false
      }],
      actors: [],
      hasMore: false,
      nextCursor: null
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Activity available before financial history")).toBeVisible());
    expect(mocks.loadDeferredNormalizedDashboardActivity).not.toHaveBeenCalled();
    expect(mocks.loadActivityFeedPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadDeferredNormalizedDashboardHistory).toHaveBeenCalledTimes(1);
    expect(historySettled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Show All" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Detailed Activity" })).toBeVisible());
    await waitFor(() => expect(mocks.loadActivityFeedPage).toHaveBeenCalledTimes(2));
    expect(historySettled).toBe(false);

    await act(async () => { history.resolve({ bills: [], payments: [], expenses: [] }); });
  });
});
