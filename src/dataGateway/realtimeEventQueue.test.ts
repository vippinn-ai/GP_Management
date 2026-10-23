import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAppDataSnapshot } from "../backend";
import type { AppData } from "../types";

const backendMocks = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  getSupabaseClient: vi.fn(),
  loadRemoteAppDataSnapshot: vi.fn(),
  loadRemoteAppStateMetadata: vi.fn(),
  saveRemoteAppData: vi.fn(),
  subscribeToRemoteAppData: vi.fn()
}));

vi.mock("../backend", () => backendMocks);

const realtimeMocks = vi.hoisted(() => ({
  emitGenericAppStateSaveEvent: vi.fn(),
  loadNormalizedRealtimeOverlay: vi.fn(),
  subscribeToOperationalEvents: vi.fn()
}));

vi.mock("./normalizedRealtime", () => realtimeMocks);

const normalizedReadMocks = vi.hoisted(() => ({
  loadNormalizedAppDataOverlay: vi.fn(),
  loadNormalizedAuditLogs: vi.fn(),
  loadNormalizedExpenseAdminData: vi.fn(),
  loadNormalizedStockMovements: vi.fn()
}));

vi.mock("./normalizedReads", () => normalizedReadMocks);

const telemetryMocks = vi.hoisted(() => ({
  recordCompactRealtimeTelemetry: vi.fn(),
  recordStartupBootstrapTelemetry: vi.fn()
}));

vi.mock("../syncTelemetry", () => telemetryMocks);

import { DEFAULT_BACKEND_FEATURE_FLAGS } from "./featureFlags";
import { createNormalizedRemoteDataGateway } from "./normalizedGateway";

type EventHandler = (event: RealtimeEvent) => Promise<void> | void;

interface RealtimeEvent {
  organization_id: string;
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function appData(status = "base"): AppData {
  return {
    users: [],
    businessProfile: { name: "Queue", logoText: "", address: "", primaryPhone: "", receiptFooter: "" },
    inventoryCategories: [],
    stations: [],
    pricingRules: [],
    sessions: [{ id: "session-shared", stationId: "station-1", status } as never],
    sessionPauseLogs: [],
    customers: [],
    customerTabs: [],
    inventoryItems: [],
    combos: [],
    stockMovements: [],
    bills: [],
    payments: [],
    auditLogs: [],
    expenses: [],
    expenseTemplates: [],
    expenseTemplateOverrides: []
  };
}

function snapshot(version = 20, status = "base"): RemoteAppDataSnapshot {
  return { appData: appData(status), version, source: "app_state" };
}

function event(id: string, entityId = "session-shared", version?: number): RealtimeEvent {
  return {
    organization_id: "org-primary",
    id,
    event_type: "save_live_session_details",
    entity_type: "session",
    entity_id: entityId,
    created_at: `2026-10-23T00:00:${id.slice(-2).padStart(2, "0")}Z`,
    metadata: version === undefined ? {} : { app_state_version: version }
  };
}

function overlay(status: string, version?: number, requiresFullRefresh = false) {
  return {
    appData: appData(status),
    appStateVersion: version,
    sourceMutationId: `mutation-${status}`,
    refreshedSlices: [requiresFullRefresh ? "full" : "changed_live_rows"],
    requiresFullRefresh
  };
}

function setupGateway() {
  const handlers: EventHandler[] = [];
  const unsubscribe = vi.fn();
  realtimeMocks.subscribeToOperationalEvents.mockImplementation((_client, handler: EventHandler) => {
    handlers.push(handler);
    return unsubscribe;
  });
  const client = { name: "queue-client" };
  backendMocks.getSupabaseClient.mockReturnValue(client);
  normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValue({ appData: {}, organizationId: "org-primary" });
  const gateway = createNormalizedRemoteDataGateway({
    ...DEFAULT_BACKEND_FEATURE_FLAGS,
    normalizedRealtime: true
  });
  return { gateway, handlers, unsubscribe };
}

beforeEach(() => {
  vi.resetAllMocks();
  backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(snapshot());
});

describe("normalized realtime event FIFO and lifecycle", () => {
  it("serializes same-entity events and publishes the newest state last", async () => {
    const first = deferred<ReturnType<typeof overlay>>();
    const second = deferred<ReturnType<typeof overlay>>();
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { gateway, handlers } = setupGateway();
    const onChange = vi.fn();
    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);

    const firstRun = handlers[0](event("01", "session-shared", 21));
    const secondRun = handlers[0](event("02", "session-shared", 22));
    await vi.waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1));
    first.resolve(overlay("paused", 21));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toMatchObject({ version: 21, sourceEventId: "01" });
    expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(2);
    second.resolve(overlay("active", 22));
    await Promise.all([firstRun, secondRun]);

    expect(onChange.mock.calls.map(([value]) => value.sourceEventId)).toEqual(["01", "02"]);
    expect(onChange.mock.calls[1][0]).toMatchObject({
      version: 22,
      appData: { sessions: [expect.objectContaining({ id: "session-shared", status: "active" })] }
    });
  });

  it("continues with the next event after a reader failure without publishing the failed event", async () => {
    const failure = new Error("first read failed");
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(overlay("active", 22));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { gateway, handlers } = setupGateway();
    const onChange = vi.fn();
    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    try {
      await Promise.all([handlers[0](event("01", "session-shared", 21)), handlers[0](event("02", "session-shared", 22))]);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0]).toMatchObject({ version: 22, sourceEventId: "02" });
      expect(warning).toHaveBeenCalledWith("Unable to apply compact realtime event.", failure);
    } finally {
      warning.mockRestore();
    }
  });

  it("uses one initial bootstrap for overlapping events and does not publish before it resolves", async () => {
    const bootstrap = deferred<RemoteAppDataSnapshot>();
    backendMocks.loadRemoteAppDataSnapshot.mockReturnValue(bootstrap.promise);
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockResolvedValueOnce(overlay("paused", 21))
      .mockResolvedValueOnce(overlay("active", 22));
    const { gateway, handlers } = setupGateway();
    const onChange = vi.fn();
    gateway.subscribeToAppData(onChange);

    const runs = [handlers[0](event("01", "session-shared", 21)), handlers[0](event("02", "session-shared", 22))];
    await Promise.resolve();
    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.loadNormalizedRealtimeOverlay).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    bootstrap.resolve(snapshot());
    await Promise.all(runs);

    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls.map(([value]) => value.sourceEventId)).toEqual(["01", "02"]);
  });

  it("recovers a queued event after the initial bootstrap fails", async () => {
    const bootstrapFailure = new Error("bootstrap unavailable");
    backendMocks.loadRemoteAppDataSnapshot
      .mockRejectedValueOnce(bootstrapFailure)
      .mockResolvedValueOnce(snapshot());
    realtimeMocks.loadNormalizedRealtimeOverlay.mockResolvedValueOnce(overlay("active", 22));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { gateway, handlers } = setupGateway();
    const onChange = vi.fn();
    gateway.subscribeToAppData(onChange);
    try {
      await Promise.all([handlers[0](event("01", "session-shared", 21)), handlers[0](event("02", "session-shared", 22))]);
      expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(2);
      expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith("Unable to apply compact realtime event.", bootstrapFailure);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0]).toMatchObject({ version: 22, sourceEventId: "02" });
    } finally {
      warning.mockRestore();
    }
  });

  it("does not seed shared cache when disposed during the initial bootstrap", async () => {
    const abandonedBootstrap = deferred<RemoteAppDataSnapshot>();
    const abandonedSnapshot = snapshot(90, "paused");
    abandonedSnapshot.appData.customers = [{
      id: "abandoned-bootstrap-customer",
      name: "Must Not Survive",
      createdAt: "2026-10-23T00:00:00.000Z",
      lastVisitAt: "2026-10-23T00:00:00.000Z"
    }];
    backendMocks.loadRemoteAppDataSnapshot
      .mockReturnValueOnce(abandonedBootstrap.promise)
      .mockResolvedValueOnce(snapshot(20, "base"));
    realtimeMocks.loadNormalizedRealtimeOverlay.mockResolvedValueOnce(overlay("active"));
    const { gateway, handlers } = setupGateway();
    const abandonedOnChange = vi.fn();
    const dispose = gateway.subscribeToAppData(abandonedOnChange);
    const abandonedRun = handlers[0](event("01"));
    await vi.waitFor(() => expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1));
    dispose();
    abandonedBootstrap.resolve(abandonedSnapshot);
    await abandonedRun;
    expect(abandonedOnChange).not.toHaveBeenCalled();
    expect(realtimeMocks.loadNormalizedRealtimeOverlay).not.toHaveBeenCalled();

    const remountedOnChange = vi.fn();
    gateway.subscribeToAppData(remountedOnChange);
    await handlers[1](event("02"));

    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(2);
    expect(remountedOnChange.mock.calls[0][0]).toMatchObject({
      version: 20,
      sourceEventId: "02",
      appData: {
        sessions: [expect.objectContaining({ status: "active" })],
        customers: []
      }
    });
  });

  it("drops queued and inflight work after disposal and a remount publishes no stale generation", async () => {
    const inflight = deferred<ReturnType<typeof overlay>>();
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockReturnValueOnce(inflight.promise)
      .mockResolvedValueOnce(overlay("active", 23));
    const { gateway, handlers, unsubscribe } = setupGateway();
    const firstOnChange = vi.fn();
    await gateway.loadAppDataSnapshot();
    const dispose = gateway.subscribeToAppData(firstOnChange);
    const inflightRun = handlers[0](event("01", "session-shared", 21));
    const queuedRun = handlers[0](event("02", "session-shared", 22));
    await vi.waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1));
    dispose();
    inflight.resolve(overlay("paused", 21));
    await Promise.all([inflightRun, queuedRun]);
    expect(firstOnChange).not.toHaveBeenCalled();
    // The second queued event was discarded before it performed any reader work.
    expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const remountedOnChange = vi.fn();
    gateway.subscribeToAppData(remountedOnChange);
    await handlers[1](event("03", "session-shared", 23));
    expect(remountedOnChange).toHaveBeenCalledTimes(1);
    expect(remountedOnChange.mock.calls[0][0]).toMatchObject({
      sourceEventId: "03",
      version: 23,
      appData: { sessions: [expect.objectContaining({ status: "active" })] }
    });
  });

  it("publishes a full refresh only after its replacement snapshot is complete", async () => {
    const refreshed = deferred<RemoteAppDataSnapshot>();
    backendMocks.loadRemoteAppDataSnapshot
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(refreshed.promise);
    realtimeMocks.loadNormalizedRealtimeOverlay.mockResolvedValueOnce(overlay("ignored", undefined, true));
    const { gateway, handlers } = setupGateway();
    const onChange = vi.fn();
    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    const run = handlers[0](event("01"));
    await vi.waitFor(() => expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(2));
    expect(onChange).not.toHaveBeenCalled();
    refreshed.resolve(snapshot(25, "active"));
    await run;

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      version: 25,
      sourceEventId: "01",
      refreshedSlices: ["full"]
    }));
  });

  it("merges a pending compact event onto a newer explicit refresh snapshot", async () => {
    const pendingOverlay = deferred<ReturnType<typeof overlay>>();
    const refreshedSnapshot = snapshot(25, "active");
    refreshedSnapshot.appData.customers = [{
      id: "customer-from-refresh",
      name: "Refreshed Customer",
      createdAt: "2026-10-23T00:00:00.000Z",
      lastVisitAt: "2026-10-23T00:00:00.000Z"
    }];
    backendMocks.loadRemoteAppDataSnapshot
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(refreshedSnapshot);
    realtimeMocks.loadNormalizedRealtimeOverlay.mockReturnValueOnce(pendingOverlay.promise);
    const { gateway, handlers } = setupGateway();
    const onChange = vi.fn();
    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    const eventRun = handlers[0](event("01", "session-shared", 26));
    await vi.waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1));

    await gateway.loadAppDataSnapshot();
    pendingOverlay.resolve(overlay("paused", 26));
    await eventRun;

    expect(onChange.mock.calls[0][0]).toMatchObject({
      version: 26,
      sourceEventId: "01",
      appData: {
        sessions: [expect.objectContaining({ status: "paused" })],
        customers: [expect.objectContaining({ id: "customer-from-refresh", name: "Refreshed Customer" })]
      }
    });
  });

  it("does not publish or retain a deferred full refresh after disposal", async () => {
    const refreshed = deferred<RemoteAppDataSnapshot>();
    backendMocks.loadRemoteAppDataSnapshot
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(refreshed.promise);
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockResolvedValueOnce(overlay("ignored", undefined, true))
      .mockResolvedValueOnce(overlay("active", 26));
    const { gateway, handlers } = setupGateway();
    const abandoned = vi.fn();
    await gateway.loadAppDataSnapshot();
    const dispose = gateway.subscribeToAppData(abandoned);
    const abandonedRun = handlers[0](event("01"));
    await vi.waitFor(() => expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(2));
    dispose();
    const abandonedRefresh = snapshot(25, "paused");
    abandonedRefresh.appData.customers = [{
      id: "abandoned-refresh-customer",
      name: "Must Not Survive",
      createdAt: "2026-10-23T00:00:00.000Z",
      lastVisitAt: "2026-10-23T00:00:00.000Z"
    }];
    refreshed.resolve(abandonedRefresh);
    await abandonedRun;
    expect(abandoned).not.toHaveBeenCalled();

    const remounted = vi.fn();
    gateway.subscribeToAppData(remounted);
    await handlers[1](event("02", "session-shared", 26));
    expect(remounted.mock.calls[0][0]).toMatchObject({
      version: 26,
      sourceEventId: "02",
      appData: {
        sessions: [expect.objectContaining({ status: "active" })],
        customers: []
      }
    });
  });

  it("preserves arrival order for different entities while readers are pending", async () => {
    const first = deferred<ReturnType<typeof overlay>>();
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(overlay("active", 22));
    const { gateway, handlers } = setupGateway();
    const onChange = vi.fn();
    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    const firstRun = handlers[0](event("01", "session-a", 21));
    const secondRun = handlers[0](event("02", "session-b", 22));

    await Promise.resolve();
    expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    first.resolve(overlay("paused", 21));
    await Promise.all([firstRun, secondRun]);
    expect(onChange.mock.calls.map(([value]) => value.sourceEventId)).toEqual(["01", "02"]);
  });

  it("keeps the existing version when queued events omit app_state versions", async () => {
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockResolvedValueOnce(overlay("paused"))
      .mockResolvedValueOnce(overlay("active"));
    const { gateway, handlers } = setupGateway();
    const onChange = vi.fn();
    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    await Promise.all([handlers[0](event("01")), handlers[0](event("02"))]);

    expect(onChange.mock.calls.map(([value]) => value.version)).toEqual([20, 20]);
    expect(onChange.mock.calls[1][0]).toMatchObject({ sourceEventId: "02" });
  });

  it("continues the queue when a listener throws after the first publication", async () => {
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockResolvedValueOnce(overlay("paused", 21))
      .mockResolvedValueOnce(overlay("active", 22));
    const listenerFailure = new Error("listener failed");
    const onChange = vi.fn()
      .mockImplementationOnce(() => { throw listenerFailure; })
      .mockImplementationOnce(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { gateway, handlers } = setupGateway();
    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    try {
      await Promise.all([handlers[0](event("01", "session-shared", 21)), handlers[0](event("02", "session-shared", 22))]);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange.mock.calls[1][0]).toMatchObject({ version: 22, sourceEventId: "02" });
      expect(warning).toHaveBeenCalledWith("Unable to apply compact realtime event.", listenerFailure);
    } finally {
      warning.mockRestore();
    }
  });

  it("starts telemetry at event receipt so queue wait remains included", async () => {
    const first = deferred<ReturnType<typeof overlay>>();
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(overlay("active", 22));
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110);
    const { gateway, handlers } = setupGateway();
    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(vi.fn());
    const firstRun = handlers[0](event("01", "session-shared", 21));
    const secondRun = handlers[0](event("02", "session-shared", 22));
    await vi.waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1));
    first.resolve(overlay("paused", 21));
    await Promise.all([firstRun, secondRun]);

    expect(telemetryMocks.recordCompactRealtimeTelemetry.mock.calls.map(([value]) => value.startedAt)).toEqual([100, 110]);
    now.mockRestore();
  });
});
