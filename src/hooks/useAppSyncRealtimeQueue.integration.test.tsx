import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import type { RemoteAppDataSnapshot, RemoteProfile } from "../backend";
import { DEFAULT_BACKEND_FEATURE_FLAGS } from "../dataGateway/featureFlags";
import { createNormalizedRemoteDataGateway } from "../dataGateway/normalizedGateway";
import type { RemoteDataGateway } from "../dataGateway/types";
import type { AppData } from "../types";
import { useAppSync, type RemoteRestoreState } from "./useAppSync";

const backendMocks = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  getSupabaseClient: vi.fn(),
  loadRemoteAppDataSnapshot: vi.fn(),
  loadRemoteAppStateMetadata: vi.fn(),
  resolveRemoteSessionProfile: vi.fn(),
  saveRemoteAppData: vi.fn(),
  subscribeToRemoteAppData: vi.fn()
}));

vi.mock("../backend", () => backendMocks);

const realtimeMocks = vi.hoisted(() => ({
  emitGenericAppStateSaveEvent: vi.fn(),
  loadNormalizedRealtimeOverlay: vi.fn(),
  subscribeToOperationalEvents: vi.fn()
}));

vi.mock("../dataGateway/normalizedRealtime", () => realtimeMocks);

const normalizedReadMocks = vi.hoisted(() => ({
  loadNormalizedAppDataOverlay: vi.fn(),
  loadNormalizedAuditLogs: vi.fn(),
  loadNormalizedExpenseAdminData: vi.fn(),
  loadNormalizedStockMovements: vi.fn()
}));

vi.mock("../dataGateway/normalizedReads", () => normalizedReadMocks);

const telemetryMocks = vi.hoisted(() => ({
  recordCompactRealtimeTelemetry: vi.fn(),
  recordStartupBootstrapTelemetry: vi.fn()
}));

vi.mock("../syncTelemetry", () => telemetryMocks);

const profile: RemoteProfile = {
  id: "user-queue",
  name: "Queue User",
  username: "queue-user",
  role: "admin",
  active: true
};

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

function appData(name: string): AppData {
  return {
    users: [{ id: profile.id, name: profile.name, username: profile.username, role: profile.role, active: profile.active }],
    businessProfile: { name, logoText: "", address: "", primaryPhone: "", receiptFooter: "" },
    inventoryCategories: [], stations: [], pricingRules: [], sessions: [], sessionPauseLogs: [], customers: [],
    customerTabs: [], inventoryItems: [], combos: [], stockMovements: [], bills: [], payments: [], auditLogs: [],
    expenses: [], expenseTemplates: [], expenseTemplateOverrides: []
  };
}

function snapshot(name: string, version: number): RemoteAppDataSnapshot {
  return { appData: appData(name), version, source: "app_state" };
}

function event(id: string, version: number): RealtimeEvent {
  return {
    organization_id: "org-primary",
    id,
    event_type: "save_live_session_details",
    entity_type: "session",
    entity_id: "session-shared",
    created_at: `2026-10-24T00:00:0${version}Z`,
    metadata: { app_state_version: version }
  };
}

function overlay(name: string, version: number) {
  return {
    appData: appData(name),
    appStateVersion: version,
    sourceMutationId: `mutation-${version}`,
    refreshedSlices: ["changed_live_rows"],
    requiresFullRefresh: false
  };
}

function Harness(props: {
  gateway: RemoteDataGateway;
  backendConfigured?: boolean;
  operationErrorOnSnapshotName?: string;
  onSetRemoteError?: (value: string) => void;
}) {
  const [data, setData] = useState(() => appData("Cached"));
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [remoteVersion, setRemoteVersion] = useState(0);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [remoteRestoreState, setRemoteRestoreState] = useState<RemoteRestoreState>("checking");
  const [restoreRetrySignal, setRestoreRetrySignal] = useState(0);
  const skipRemotePersistRef = useRef(false);
  const remoteSaveTimerRef = useRef<number | null>(null);
  const updateRemoteError = (value: string) => {
    props.onSetRemoteError?.(value);
    setRemoteError(value);
  };
  const applyRemoteSnapshot = props.operationErrorOnSnapshotName
    ? (value: RemoteAppDataSnapshot) => {
        setData(value.appData);
        setRemoteVersion(value.version);
        if (value.appData.businessProfile.name === props.operationErrorOnSnapshotName) {
          updateRemoteError("Financial command failed.");
        }
      }
    : undefined;

  useAppSync({
    backendConfigured: props.backendConfigured ?? true,
    online: true,
    activeUserId,
    appData: data,
    remoteLoading,
    remoteReadOnly: remoteRestoreState === "stale-cache" || remoteRestoreState === "retrying",
    remoteRestoreState,
    restoreRetrySignal,
    restoreRetryDelayMs: 60_000,
    hasCachedAppData: true,
    remoteVersion,
    allowFullAppDataPersist: false,
    skipRemotePersistRef,
    remoteSaveTimerRef,
    setAppData: setData,
    setActiveUserId,
    setRemoteVersion,
    setRemoteLoading,
    setRemoteError: updateRemoteError,
    setRemoteSaving: vi.fn(),
    setRemoteRestoreState,
    setRestoreRetrySignal,
    setActiveTab: vi.fn(),
    applyRemoteSnapshot,
    dataGateway: props.gateway
  });

  return (
    <div>
      <span data-testid="restore-state">{remoteRestoreState}</span>
      <span data-testid="business-name">{data.businessProfile.name}</span>
      <span data-testid="remote-error">{remoteError}</span>
      <span data-testid="active-user">{activeUserId ?? "none"}</span>
      <button type="button" onClick={() => setRemoteError("Financial command failed.")}>set operation error</button>
      <button type="button" onClick={() => setActiveUserId("user-changed")}>change user</button>
      <button type="button" onClick={() => setActiveUserId(null)}>log out</button>
    </div>
  );
}

function setupGateway() {
  const handlers: EventHandler[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  realtimeMocks.subscribeToOperationalEvents.mockImplementation((_client, handler: EventHandler) => {
    handlers.push(handler);
    const dispose = vi.fn();
    disposers.push(dispose);
    return dispose;
  });
  backendMocks.getSupabaseClient.mockReturnValue({ name: "integration-client" });
  normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValue({ appData: {}, organizationId: "org-primary" });
  const gateway = createNormalizedRemoteDataGateway({
    ...DEFAULT_BACKEND_FEATURE_FLAGS,
    normalizedRealtime: true
  });
  return { gateway, handlers, disposers };
}

describe("useAppSync and normalized realtime queue lifetime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue({ status: "active", profile });
  });

  afterEach(() => cleanup());

  it("keeps one subscription while stale-cache recovery publishes two queued events in FIFO order", async () => {
    const firstOverlay = deferred<ReturnType<typeof overlay>>();
    const secondOverlay = deferred<ReturnType<typeof overlay>>();
    backendMocks.loadRemoteAppDataSnapshot
      .mockRejectedValueOnce(new Error("initial restore unavailable"))
      .mockResolvedValueOnce(snapshot("Queue base", 3));
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockReturnValueOnce(firstOverlay.promise)
      .mockReturnValueOnce(secondOverlay.promise);
    const { gateway, handlers, disposers } = setupGateway();
    render(<Harness gateway={gateway} />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache"));
    await waitFor(() => expect(handlers).toHaveLength(1));
    const firstRun = handlers[0](event("event-first", 4));
    const secondRun = handlers[0](event("event-second", 5));
    await waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1));

    firstOverlay.resolve(overlay("First recovery", 4));
    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("ready"));
    expect(screen.getByTestId("remote-error")).toBeEmptyDOMElement();
    expect(realtimeMocks.subscribeToOperationalEvents).toHaveBeenCalledTimes(1);
    expect(disposers[0]).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("set operation error"));
    await waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(2));
    secondOverlay.resolve(overlay("Second recovery", 5));
    await act(async () => { await Promise.all([firstRun, secondRun]); });
    await waitFor(() => expect(screen.getByTestId("business-name")).toHaveTextContent("Second recovery"));
    expect(screen.getByTestId("remote-error")).toHaveTextContent("Financial command failed.");
    expect(realtimeMocks.subscribeToOperationalEvents).toHaveBeenCalledTimes(1);
    expect(disposers[0]).not.toHaveBeenCalled();
  });

  it("clears the restore error once but preserves a second-event operation error before React commits ready", async () => {
    const errorUpdates: string[] = [];
    backendMocks.loadRemoteAppDataSnapshot
      .mockRejectedValueOnce(new Error("initial restore unavailable"))
      .mockResolvedValueOnce(snapshot("Queue base", 3));
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockResolvedValueOnce(overlay("First same-batch recovery", 4))
      .mockResolvedValueOnce(overlay("Second same-batch conflict", 5));
    const { gateway, handlers, disposers } = setupGateway();
    render(
      <Harness
        gateway={gateway}
        operationErrorOnSnapshotName="Second same-batch conflict"
        onSetRemoteError={(value) => errorUpdates.push(value)}
      />
    );
    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache"));
    await waitFor(() => expect(handlers).toHaveLength(1));

    const firstRun = handlers[0](event("event-first-batch", 4));
    const secondRun = handlers[0](event("event-second-batch", 5));
    await act(async () => { await Promise.all([firstRun, secondRun]); });

    await waitFor(() => expect(screen.getByTestId("business-name")).toHaveTextContent("Second same-batch conflict"));
    expect(screen.getByTestId("restore-state")).toHaveTextContent("ready");
    expect(screen.getByTestId("remote-error")).toHaveTextContent("Financial command failed.");
    expect(errorUpdates.slice(-2)).toEqual(["", "Financial command failed."]);
    expect(realtimeMocks.subscribeToOperationalEvents).toHaveBeenCalledTimes(1);
    expect(disposers[0]).not.toHaveBeenCalled();
  });

  it("disposes delayed and queued old-user work when the active user changes", async () => {
    const delayed = deferred<ReturnType<typeof overlay>>();
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(snapshot("Ready", 1));
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(overlay("Must not publish", 3));
    const { gateway, handlers, disposers } = setupGateway();
    render(<Harness gateway={gateway} />);
    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("ready"));
    await waitFor(() => expect(handlers).toHaveLength(1));
    const firstRun = handlers[0](event("old-user-first", 2));
    const secondRun = handlers[0](event("old-user-second", 3));
    await waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("change user"));
    await waitFor(() => expect(handlers).toHaveLength(2));
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("active-user")).toHaveTextContent("user-changed");

    delayed.resolve(overlay("Old user result", 2));
    await act(async () => { await Promise.all([firstRun, secondRun]); });
    expect(screen.getByTestId("business-name")).toHaveTextContent("Ready");
    expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1);
  });

  it("disposes delayed and queued work on logout", async () => {
    const delayed = deferred<ReturnType<typeof overlay>>();
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(snapshot("Ready", 1));
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(overlay("Must not publish", 3));
    const { gateway, handlers, disposers } = setupGateway();
    render(<Harness gateway={gateway} />);
    await waitFor(() => expect(handlers).toHaveLength(1));
    const firstRun = handlers[0](event("logout-first", 2));
    const secondRun = handlers[0](event("logout-second", 3));
    await waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("log out"));
    await waitFor(() => expect(disposers[0]).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("active-user")).toHaveTextContent("none");
    delayed.resolve(overlay("Logged-out result", 2));
    await act(async () => { await Promise.all([firstRun, secondRun]); });
    expect(screen.getByTestId("business-name")).toHaveTextContent("Ready");
    expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1);
  });

  it("disposes delayed and queued work on unmount", async () => {
    const delayed = deferred<ReturnType<typeof overlay>>();
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(snapshot("Ready", 1));
    realtimeMocks.loadNormalizedRealtimeOverlay
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(overlay("Must not publish", 3));
    const { gateway, handlers, disposers } = setupGateway();
    const rendered = render(<Harness gateway={gateway} />);
    await waitFor(() => expect(handlers).toHaveLength(1));
    const firstRun = handlers[0](event("unmount-first", 2));
    const secondRun = handlers[0](event("unmount-second", 3));
    await waitFor(() => expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1));

    rendered.unmount();
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    delayed.resolve(overlay("Unmounted result", 2));
    await act(async () => { await Promise.all([firstRun, secondRun]); });
    expect(realtimeMocks.loadNormalizedRealtimeOverlay).toHaveBeenCalledTimes(1);
  });

  it("disposes on backend disable and replaces the subscription when the gateway identity changes", async () => {
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(snapshot("Ready", 1));
    const { gateway, handlers, disposers } = setupGateway();
    const rendered = render(<Harness gateway={gateway} />);
    await waitFor(() => expect(handlers).toHaveLength(1));

    const replacementGateway = createNormalizedRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedRealtime: true
    });
    rendered.rerender(<Harness gateway={replacementGateway} />);
    await waitFor(() => expect(handlers).toHaveLength(2));
    expect(disposers[0]).toHaveBeenCalledTimes(1);

    rendered.rerender(<Harness gateway={replacementGateway} backendConfigured={false} />);
    await waitFor(() => expect(disposers[1]).toHaveBeenCalledTimes(1));
    expect(handlers).toHaveLength(2);
  });
});
