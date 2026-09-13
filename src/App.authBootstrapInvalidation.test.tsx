import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteProfile } from "./backend";
import { hydrateAppData } from "./storage";

const mocks = vi.hoisted(() => ({
  signInWithUsername: vi.fn(),
  signOutRemote: vi.fn(),
  prepareAuthenticatedBootstrap: vi.fn(),
  loadAuthenticatedAppDataSnapshot: vi.fn(),
  resetAuthenticatedBootstrapAttempt: vi.fn(),
  scheduleAuthenticatedBootstrapCancellation: vi.fn(),
  subscribeToAppData: vi.fn(),
  saveAppData: vi.fn()
}));

vi.mock("./backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backend")>();
  return {
    ...actual,
    isBackendConfigured: () => true,
    signInWithUsername: mocks.signInWithUsername,
    signOutRemote: mocks.signOutRemote
  };
});

vi.mock("./dataGateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dataGateway")>();
  return {
    ...actual,
    resolveBackendFeatureFlags: () => ({
      ...actual.DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    }),
    defaultRemoteDataGateway: {
      prepareAuthenticatedBootstrap: mocks.prepareAuthenticatedBootstrap,
      loadAuthenticatedAppDataSnapshot: mocks.loadAuthenticatedAppDataSnapshot,
      resetAuthenticatedBootstrapAttempt: mocks.resetAuthenticatedBootstrapAttempt,
      scheduleAuthenticatedBootstrapCancellation: mocks.scheduleAuthenticatedBootstrapCancellation,
      subscribeToAppData: mocks.subscribeToAppData,
      saveAppData: mocks.saveAppData
    }
  };
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

describe("App auth bootstrap invalidation ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.prepareAuthenticatedBootstrap.mockResolvedValue({ status: "no-session" });
    mocks.loadAuthenticatedAppDataSnapshot.mockResolvedValue({
      status: "active",
      profile: activeProfile,
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      snapshot: {
        version: 44,
        source: "normalized_bootstrap",
        appData: hydrateAppData({ users: [activeProfile] })
      }
    });
    mocks.subscribeToAppData.mockReturnValue(() => undefined);
    mocks.saveAppData.mockResolvedValue(45);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("invalidates the prior tenant before awaiting delayed sign-in and sign-out", async () => {
    const signIn = deferred<RemoteProfile>();
    const signOut = deferred<void>();
    mocks.signInWithUsername.mockReturnValue(signIn.promise);
    mocks.signOutRemote.mockReturnValue(signOut.promise);

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign In" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(mocks.signInWithUsername).toHaveBeenCalledTimes(1);
    expect(mocks.resetAuthenticatedBootstrapAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.resetAuthenticatedBootstrapAttempt.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.signInWithUsername.mock.invocationCallOrder[0]);
    expect(mocks.loadAuthenticatedAppDataSnapshot).not.toHaveBeenCalled();

    await act(async () => { signIn.resolve(activeProfile); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Log Out" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Log Out" }));
    expect(mocks.signOutRemote).toHaveBeenCalledTimes(1);
    expect(mocks.resetAuthenticatedBootstrapAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.resetAuthenticatedBootstrapAttempt.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.signOutRemote.mock.invocationCallOrder[0]);

    await act(async () => { signOut.resolve(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign In" })).toBeEnabled());
  });
});
