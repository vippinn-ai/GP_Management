import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { useAppSync, type RemoteRestoreState } from "./useAppSync";
import type { AppData } from "../types";
import type { RemoteAppDataSnapshot, RemoteProfile, RemoteSessionProfileResult } from "../backend";

const backendMocks = vi.hoisted(() => ({
  loadRemoteAppDataSnapshot: vi.fn(),
  resolveRemoteSessionProfile: vi.fn(),
  saveRemoteAppData: vi.fn(),
  subscribeToRemoteAppData: vi.fn()
}));

vi.mock("../backend", () => backendMocks);

const activeProfile: RemoteProfile = {
  id: "user-1",
  name: "Admin User",
  username: "admin",
  role: "admin",
  active: true
};

function createAppData(name: string, users = [profileToUser(activeProfile)]): AppData {
  return {
    users,
    businessProfile: {
      name,
      logoText: "",
      address: "",
      primaryPhone: "",
      receiptFooter: ""
    },
    inventoryCategories: [],
    stations: [],
    pricingRules: [],
    sessions: [],
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

function profileToUser(profile: RemoteProfile) {
  return {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    role: profile.role,
    active: profile.active
  };
}

function snapshot(name: string, version = 1): RemoteAppDataSnapshot {
  return {
    appData: createAppData(name),
    version,
    source: "app_state"
  };
}

function activeSessionResult(profile = activeProfile): RemoteSessionProfileResult {
  return { status: "active", profile };
}

function Harness(props: {
  initialAppData?: AppData;
  initialActiveUserId?: string | null;
  initialRestoreState?: RemoteRestoreState;
  hasCachedAppData?: boolean;
  online?: boolean;
  retryDelayMs?: number;
  applyRemoteSnapshot?: (snapshot: RemoteAppDataSnapshot) => void;
  allowFullAppDataPersist?: boolean;
}) {
  const [appData, setAppData] = useState(() => props.initialAppData ?? createAppData("Cached"));
  const [activeUserId, setActiveUserId] = useState<string | null>(props.initialActiveUserId ?? null);
  const [remoteVersion, setRemoteVersion] = useState(0);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [, setRemoteSaving] = useState(false);
  const [remoteRestoreState, setRemoteRestoreState] = useState<RemoteRestoreState>(
    props.initialRestoreState ?? "checking"
  );
  const [restoreRetrySignal, setRestoreRetrySignal] = useState(0);
  const skipRemotePersistRef = useRef(false);
  const remoteSaveTimerRef = useRef<number | null>(null);
  const remoteReadOnly = remoteRestoreState === "stale-cache" || remoteRestoreState === "retrying";

  useAppSync({
    backendConfigured: true,
    online: props.online ?? true,
    activeUserId,
    appData,
    remoteLoading,
    remoteReadOnly,
    remoteRestoreState,
    restoreRetrySignal,
    restoreRetryDelayMs: props.retryDelayMs ?? 10_000,
    hasCachedAppData: props.hasCachedAppData ?? true,
    remoteVersion,
    allowFullAppDataPersist: props.allowFullAppDataPersist,
    skipRemotePersistRef,
    remoteSaveTimerRef,
    setAppData,
    setActiveUserId,
    setRemoteVersion,
    setRemoteLoading,
    setRemoteError,
    setRemoteSaving,
    setRemoteRestoreState,
    setRestoreRetrySignal,
    setActiveTab: vi.fn(),
    applyRemoteSnapshot: props.applyRemoteSnapshot
  });

  return (
    <div>
      <div data-testid="active-user">{activeUserId ?? "none"}</div>
      <div data-testid="restore-state">{remoteRestoreState}</div>
      <div data-testid="remote-loading">{remoteLoading ? "loading" : "idle"}</div>
      <div data-testid="remote-error">{remoteError}</div>
      <div data-testid="business-name">{appData.businessProfile.name}</div>
      <button type="button" onClick={() => setRestoreRetrySignal((previous) => previous + 1)}>
        manual retry
      </button>
      <button
        type="button"
        onClick={() =>
          setAppData((previous) => ({
            ...previous,
            businessProfile: { ...previous.businessProfile, name: "Local change" }
          }))
        }
      >
        mutate local data
      </button>
    </div>
  );
}

async function flushPromises(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("useAppSync session restore", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    window.localStorage.clear();
    backendMocks.subscribeToRemoteAppData.mockReturnValue(() => undefined);
    backendMocks.saveRemoteAppData.mockResolvedValue(2);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("restores a valid active profile when app data loads successfully", async () => {
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue(activeSessionResult());
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(snapshot("Remote latest", 4));

    render(<Harness hasCachedAppData={false} />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("ready"));
    expect(screen.getByTestId("active-user")).toHaveTextContent("user-1");
    expect(screen.getByTestId("business-name")).toHaveTextContent("Remote latest");
    expect(screen.getByTestId("remote-error")).toBeEmptyDOMElement();
  });

  it("keeps a valid session on cached read-only data when app data load times out", async () => {
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue(activeSessionResult());
    backendMocks.loadRemoteAppDataSnapshot.mockRejectedValue(new Error("App data timeout."));

    render(<Harness initialAppData={createAppData("Cached copy", [])} hasCachedAppData />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache"));
    expect(screen.getByTestId("active-user")).toHaveTextContent("user-1");
    expect(screen.getByTestId("business-name")).toHaveTextContent("Cached copy");
    expect(screen.getByTestId("remote-error")).toHaveTextContent("read-only");
  });

  it("clears cached read-only mode after a manual retry loads a fresh snapshot", async () => {
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue(activeSessionResult());
    backendMocks.loadRemoteAppDataSnapshot
      .mockRejectedValueOnce(new Error("App data timeout."))
      .mockResolvedValueOnce(snapshot("Remote after retry", 7));

    render(<Harness initialAppData={createAppData("Cached copy")} hasCachedAppData />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache"));
    fireEvent.click(screen.getByText("manual retry"));

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("ready"));
    expect(screen.getByTestId("business-name")).toHaveTextContent("Remote after retry");
    expect(backendMocks.resolveRemoteSessionProfile).toHaveBeenCalledTimes(2);
    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(2);
  });

  it("stays cached read-only when retry keeps failing", async () => {
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue(activeSessionResult());
    backendMocks.loadRemoteAppDataSnapshot.mockRejectedValue(new Error("App data timeout."));

    render(<Harness initialAppData={createAppData("Cached copy")} hasCachedAppData />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache"));
    fireEvent.click(screen.getByText("manual retry"));

    await waitFor(() => expect(backendMocks.resolveRemoteSessionProfile).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache");
    expect(screen.getByTestId("active-user")).toHaveTextContent("user-1");
  });

  it("preserves a local Supabase session when profile lookup is unreachable and cache exists", async () => {
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue({
      status: "profile-unreachable",
      userId: "user-1",
      error: new Error("Profile timeout.")
    } satisfies RemoteSessionProfileResult);

    render(<Harness initialAppData={createAppData("Cached copy")} hasCachedAppData />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache"));
    expect(screen.getByTestId("active-user")).toHaveTextContent("user-1");
    expect(screen.getByTestId("business-name")).toHaveTextContent("Cached copy");
    expect(screen.getByTestId("remote-error")).toHaveTextContent("profile check");
  });

  it("shows blocked recovery when profile lookup is unreachable and no cache exists", async () => {
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue({
      status: "profile-unreachable",
      userId: "user-1",
      error: new Error("Profile timeout.")
    } satisfies RemoteSessionProfileResult);

    render(<Harness hasCachedAppData={false} />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("blocked"));
    expect(screen.getByTestId("active-user")).toHaveTextContent("none");
    expect(screen.getByTestId("remote-error")).toHaveTextContent("session is still active");
  });

  it("returns to the login path when there is no Supabase session", async () => {
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue({ status: "no-session" } satisfies RemoteSessionProfileResult);

    render(<Harness initialActiveUserId="user-1" />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("ready"));
    expect(screen.getByTestId("active-user")).toHaveTextContent("none");
  });

  it("returns to the login path for inactive or missing profiles", async () => {
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue({
      status: "inactive-or-missing",
      userId: "user-1"
    } satisfies RemoteSessionProfileResult);

    render(<Harness initialActiveUserId="user-1" />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("ready"));
    expect(screen.getByTestId("active-user")).toHaveTextContent("none");
  });

  it("does not run debounced remote saves while cached data is read-only", async () => {
    vi.useFakeTimers();
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue({
      status: "profile-unreachable",
      userId: "user-1",
      error: new Error("Profile timeout.")
    } satisfies RemoteSessionProfileResult);

    render(
      <Harness
        initialAppData={createAppData("Cached copy")}
        initialActiveUserId="user-1"
        hasCachedAppData
        online={false}
      />
    );

    await flushPromises();
    expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache");

    act(() => {
      fireEvent.click(screen.getByText("mutate local data"));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await flushPromises();

    expect(backendMocks.saveRemoteAppData).not.toHaveBeenCalled();
  });

  it("does not run generic full-state saves when normalized bootstrap owns persistence", async () => {
    vi.useFakeTimers();
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue(activeSessionResult());
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(snapshot("Normalized", 4));

    render(<Harness allowFullAppDataPersist={false} />);
    await flushPromises();
    act(() => {
      fireEvent.click(screen.getByText("mutate local data"));
      vi.advanceTimersByTime(300);
    });
    await flushPromises();

    expect(backendMocks.saveRemoteAppData).not.toHaveBeenCalled();
  });

  it("auto retries every 10 seconds while online and stops after success", async () => {
    vi.useFakeTimers();
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue(activeSessionResult());
    backendMocks.loadRemoteAppDataSnapshot
      .mockRejectedValueOnce(new Error("App data timeout."))
      .mockResolvedValueOnce(snapshot("Recovered", 3));

    render(<Harness initialAppData={createAppData("Cached copy")} hasCachedAppData retryDelayMs={10_000} />);

    await flushPromises();
    expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache");
    expect(backendMocks.resolveRemoteSessionProfile).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    await flushPromises();

    expect(screen.getByTestId("restore-state")).toHaveTextContent("ready");
    expect(screen.getByTestId("business-name")).toHaveTextContent("Recovered");
    expect(backendMocks.resolveRemoteSessionProfile).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    await flushPromises();

    expect(backendMocks.resolveRemoteSessionProfile).toHaveBeenCalledTimes(2);
  });

  it("applies successful retry snapshots through the supplied rebase path", async () => {
    const applyRemoteSnapshot = vi.fn();
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue(activeSessionResult());
    backendMocks.loadRemoteAppDataSnapshot
      .mockRejectedValueOnce(new Error("App data timeout."))
      .mockResolvedValueOnce(snapshot("Fresh rebase source", 9));

    render(
      <Harness
        initialAppData={createAppData("Cached copy")}
        hasCachedAppData
        applyRemoteSnapshot={applyRemoteSnapshot}
      />
    );

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache"));
    fireEvent.click(screen.getByText("manual retry"));

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("ready"));
    expect(applyRemoteSnapshot).toHaveBeenCalledWith(snapshot("Fresh rebase source", 9));
  });

  it("uses realtime snapshots to leave cached read-only mode", async () => {
    let onRealtimeChange: ((snapshot: RemoteAppDataSnapshot) => void) | undefined;
    backendMocks.subscribeToRemoteAppData.mockImplementation((callback) => {
      onRealtimeChange = callback;
      return () => undefined;
    });
    backendMocks.resolveRemoteSessionProfile.mockResolvedValue(activeSessionResult());
    backendMocks.loadRemoteAppDataSnapshot.mockRejectedValue(new Error("App data timeout."));

    render(<Harness initialAppData={createAppData("Cached copy")} hasCachedAppData />);

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("stale-cache"));
    await waitFor(() => expect(onRealtimeChange).toBeDefined());

    act(() => {
      onRealtimeChange?.(snapshot("Realtime recovery", 5));
    });

    await waitFor(() => expect(screen.getByTestId("restore-state")).toHaveTextContent("ready"));
    expect(screen.getByTestId("business-name")).toHaveTextContent("Realtime recovery");
  });
});
