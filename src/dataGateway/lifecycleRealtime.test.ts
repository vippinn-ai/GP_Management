import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppData } from "../types";
import type { RemoteAppDataSnapshot } from "../backend";
import type { OperationalEventRow, NormalizedRealtimeOverlay } from "./normalizedRealtime";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), overlay: vi.fn(), unsubscribe: vi.fn(), subscribe: vi.fn(),
  loadOverlay: vi.fn(), clearOrganization: vi.fn(), organization: vi.fn()
}));
vi.mock("../backend", () => ({
  getSupabaseClient: () => ({}), loadRemoteAppDataSnapshot: mocks.snapshot,
  saveRemoteAppData: vi.fn(), subscribeToRemoteAppData: vi.fn(),
  fetchProfiles: vi.fn(), loadRemoteAppStateMetadata: vi.fn()
}));
vi.mock("./normalizedOrganization", () => ({
  resolveNormalizedOrganizationId: mocks.organization,
  clearCachedNormalizedOrganizationId: mocks.clearOrganization
}));
vi.mock("./normalizedRealtime", () => ({
  loadNormalizedRealtimeOverlay: mocks.overlay,
  subscribeToOperationalEvents: mocks.subscribe,
  emitGenericAppStateSaveEvent: vi.fn()
}));
vi.mock("./normalizedReads", () => ({
  loadNormalizedAppDataOverlay: mocks.loadOverlay,
  loadNormalizedAuditLogs: vi.fn(), loadNormalizedExpenseAdminData: vi.fn(),
  loadNormalizedStockMovements: vi.fn(), loadNormalizedLiveDataByIds: vi.fn(),
  loadNormalizedAuditLogsByIds: vi.fn()
}));
import { createNormalizedRemoteDataGateway } from "./normalizedGateway";
import { DEFAULT_BACKEND_FEATURE_FLAGS, resolveBackendFeatureFlags } from "./featureFlags";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function snapshot(): RemoteAppDataSnapshot {
  return {
    version: 1,
    source: "app_state",
    appData: {
      users: [], businessProfile: { name: "Test", logoText: "", address: "", primaryPhone: "", receiptFooter: "" },
      inventoryCategories: [], stations: [], pricingRules: [], sessions: [], sessionPauseLogs: [],
      customers: [], customerTabs: [], inventoryItems: [], combos: [], stockMovements: [],
      bills: [], payments: [], auditLogs: [], expenses: [], expenseTemplates: [], expenseTemplateOverrides: []
    } satisfies AppData
  };
}
function event(id: string, organizationId = "org-primary"): OperationalEventRow {
  return { id, organization_id: organizationId, event_type: "hop_session", entity_type: "session",
    entity_id: "session-1", created_at: "2026-09-26T00:00:00Z", metadata: {} };
}
function overlay(): NormalizedRealtimeOverlay {
  return { appData: {}, refreshedSlices: [], removedCustomerIds: [], requiresFullRefresh: false };
}
let onEvent: (event: OperationalEventRow) => void | Promise<void>;
let onStatus: (status: string) => void;
function gateway() {
  return createNormalizedRemoteDataGateway({ ...DEFAULT_BACKEND_FEATURE_FLAGS, normalizedRealtime: true });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.snapshot.mockResolvedValue(snapshot());
  mocks.organization.mockResolvedValue("org-primary");
  mocks.loadOverlay.mockResolvedValue({ appData: {} });
  mocks.overlay.mockResolvedValue(overlay());
  mocks.subscribe.mockImplementation((_client, next, status) => {
    onEvent = next; onStatus = status; status("SUBSCRIBED");
    return mocks.unsubscribe;
  });
});

describe("isolated lifecycle realtime safety without atomic bootstrap", () => {
  it("shares overlapping snapshot loads and catches up their buffered event once", async () => {
    const data = deferred<RemoteAppDataSnapshot>();
    mocks.snapshot.mockReturnValue(data.promise);
    const g = gateway();
    const first = g.loadAppDataSnapshot();
    const second = g.loadAppDataSnapshot();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledOnce());
    await onEvent(event("during-load"));
    data.resolve(snapshot());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.sourceEventId).toBe("during-load");
    expect(mocks.overlay).toHaveBeenCalledOnce();
    g.subscribeToAppData(vi.fn())();
  });

  it("rejects pending readiness on dispose and ignores delayed old subscription status", async () => {
    mocks.subscribe.mockImplementation((_client, next, status) => {
      onEvent = next; onStatus = status; return mocks.unsubscribe;
    });
    const g = gateway(); const error = vi.fn();
    const dispose = g.subscribeToAppData(vi.fn(), error);
    const oldStatus = onStatus;
    const pending = g.loadAppDataSnapshot();
    const rejected = expect(pending).rejects.toThrow(/superseded/);
    dispose(); await rejected;
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    oldStatus("SUBSCRIBED");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    const next = g.loadAppDataSnapshot();
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    onStatus("SUBSCRIBED"); await next;
    expect(mocks.snapshot).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    g.subscribeToAppData(vi.fn())();
  });

  it("isolates a new organization and same-callback remount from old buffered events", async () => {
    const g = gateway(); await g.loadAppDataSnapshot();
    const listener = vi.fn(); const dispose = g.subscribeToAppData(listener);
    const oldEvent = onEvent; const oldStatus = onStatus;
    const patch = deferred<NormalizedRealtimeOverlay>();
    mocks.overlay.mockReturnValueOnce(patch.promise);
    const pending = oldEvent(event("old-org"));
    await vi.waitFor(() => expect(mocks.overlay).toHaveBeenCalledOnce());
    dispose();
    mocks.organization.mockResolvedValue("other-org");
    await g.loadAppDataSnapshot();
    const disposeNext = g.subscribeToAppData(listener);
    patch.resolve(overlay()); await pending;
    await oldEvent(event("late-old-event")); oldStatus("CLOSED");
    expect(listener).not.toHaveBeenCalled();
    await onEvent(event("new-org", "other-org"));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].sourceEventId).toBe("new-org");
    expect(mocks.clearOrganization).toHaveBeenCalled();
    disposeNext();
  });

  it("waits for subscription before reading the authoritative snapshot", async () => {
    mocks.subscribe.mockImplementation((_client, next, status) => {
      onEvent = next; onStatus = status; return mocks.unsubscribe;
    });
    const g = gateway();
    const pending = g.loadAppDataSnapshot();
    await Promise.resolve();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    onStatus("SUBSCRIBED");
    await pending;
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    g.subscribeToAppData(vi.fn())();
  });

  it("fails closed on overflow while the snapshot is loading", async () => {
    const data = deferred<RemoteAppDataSnapshot>();
    mocks.snapshot.mockReturnValue(data.promise);
    const g = gateway();
    const pending = g.loadAppDataSnapshot();
    const rejected = expect(pending).rejects.toThrow(/buffer exceeded/);
    await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledOnce());
    for (let i = 0; i < 1001; i++) await onEvent(event(`e-${i}`));
    data.resolve(snapshot());
    await rejected;
    expect(mocks.overlay).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it("also fails closed if the buffer overflows during catch-up", async () => {
    const data = deferred<RemoteAppDataSnapshot>();
    const patch = deferred<NormalizedRealtimeOverlay>();
    mocks.snapshot.mockReturnValue(data.promise);
    mocks.overlay.mockReturnValueOnce(patch.promise);
    const g = gateway();
    const pending = g.loadAppDataSnapshot();
    const rejected = expect(pending).rejects.toThrow(/buffer exceeded/);
    await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledOnce());
    await onEvent(event("first"));
    data.resolve(snapshot());
    await vi.waitFor(() => expect(mocks.overlay).toHaveBeenCalledOnce());
    for (let i = 0; i < 1001; i++) await onEvent(event(`queued-${i}`));
    patch.resolve(overlay());
    await rejected;
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it("serializes live hydration and ignores duplicate event IDs", async () => {
    const g = gateway(); await g.loadAppDataSnapshot();
    const listener = vi.fn(); const dispose = g.subscribeToAppData(listener);
    const firstPatch = deferred<NormalizedRealtimeOverlay>();
    mocks.overlay.mockReturnValueOnce(firstPatch.promise);
    const first = onEvent(event("one"));
    const second = onEvent(event("two"));
    await vi.waitFor(() => expect(mocks.overlay).toHaveBeenCalledOnce());
    firstPatch.resolve(overlay());
    await Promise.all([first, second]);
    await onEvent(event("two"));
    expect(mocks.overlay).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([row]) => row.sourceEventId)).toEqual(["one", "two"]);
    dispose();
  });

  it("does not publish old hydration into a remounted listener", async () => {
    const g = gateway(); await g.loadAppDataSnapshot();
    const oldListener = vi.fn(); const dispose = g.subscribeToAppData(oldListener);
    const patch = deferred<NormalizedRealtimeOverlay>();
    mocks.overlay.mockReturnValueOnce(patch.promise);
    const pending = onEvent(event("old"));
    await vi.waitFor(() => expect(mocks.overlay).toHaveBeenCalledOnce());
    dispose();
    await g.loadAppDataSnapshot();
    const nextListener = vi.fn(); const disposeNext = g.subscribeToAppData(nextListener);
    patch.resolve(overlay()); await pending;
    expect(oldListener).not.toHaveBeenCalled();
    expect(nextListener).not.toHaveBeenCalled();
    disposeNext();
  });

  it("rejects a snapshot superseded by disconnect and signals a read-only error", async () => {
    const g = gateway(); const error = vi.fn();
    const dispose = g.subscribeToAppData(vi.fn(), error);
    const data = deferred<RemoteAppDataSnapshot>(); mocks.snapshot.mockReturnValue(data.promise);
    const pending = g.loadAppDataSnapshot();
    const rejected = expect(pending).rejects.toThrow(/superseded/);
    await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledOnce());
    onStatus("CLOSED"); data.resolve(snapshot());
    await rejected;
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/disconnected/) }));
    dispose();
  });

  it("ignores events from another organization", async () => {
    const g = gateway(); await g.loadAppDataSnapshot();
    const listener = vi.fn(); const dispose = g.subscribeToAppData(listener);
    await onEvent(event("foreign", "other-org"));
    expect(mocks.overlay).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    dispose();
  });

  it("requires all existing normalized prerequisites without adding atomic bootstrap", () => {
    const enabled = { normalizedBootstrap: true, normalizedLiveReads: true, normalizedRealtime: true,
      rpcOperationalWrites: true, operationalRpcV2: true };
    expect(resolveBackendFeatureFlags(enabled, {}).operationalRpcV2).toBe(true);
    for (const key of ["normalizedBootstrap", "normalizedLiveReads", "normalizedRealtime", "rpcOperationalWrites"]) {
      expect(() => resolveBackendFeatureFlags({ ...enabled, [key]: false }, {})).toThrow(/requires normalized/);
    }
    expect(resolveBackendFeatureFlags({}, {}).operationalRpcV2).toBe(false);
  });
});
