import { useEffect, type MutableRefObject } from "react";
import {
  loadRemoteAppDataSnapshot,
  resolveRemoteSessionProfile,
  saveRemoteAppData,
  subscribeToRemoteAppData,
  type RemoteAppDataSnapshot,
  type RemoteProfile
} from "../backend";
import { saveAppData } from "../storage";
import { normalizeAppDataCustomers } from "../utils";
import type { AppData, TabId, User } from "../types";

export type RemoteRestoreState = "checking" | "ready" | "stale-cache" | "retrying" | "blocked";

const DEFAULT_RESTORE_RETRY_DELAY_MS = 10_000;

function remoteProfileToUser(profile: RemoteProfile): User {
  return {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    role: profile.role,
    active: profile.active
  };
}

function ensureProfileInAppData(appData: AppData, profile: RemoteProfile): AppData {
  const user = remoteProfileToUser(profile);
  const existingUser = appData.users.find((entry) => entry.id === user.id);
  if (
    existingUser &&
    existingUser.active &&
    existingUser.name === user.name &&
    existingUser.username === user.username &&
    existingUser.role === user.role
  ) {
    return appData;
  }
  return {
    ...appData,
    users: existingUser
      ? appData.users.map((entry) => (entry.id === user.id ? { ...entry, ...user } : entry))
      : [user, ...appData.users]
  };
}

export function useAppSync(params: {
  backendConfigured: boolean;
  online: boolean;
  activeUserId: string | null;
  appData: AppData;
  remoteLoading: boolean;
  remoteReadOnly: boolean;
  remoteRestoreState: RemoteRestoreState;
  restoreRetrySignal: number;
  restoreRetryDelayMs?: number;
  hasCachedAppData: boolean;
  remoteVersion: number;
  skipRemotePersistRef: MutableRefObject<boolean>;
  remoteSaveTimerRef: MutableRefObject<number | null>;
  setAppData: (data: AppData) => void;
  setActiveUserId: (id: string | null) => void;
  setRemoteVersion: (v: number) => void;
  setRemoteLoading: (loading: boolean) => void;
  setRemoteError: (err: string) => void;
  setRemoteSaving: (saving: boolean) => void;
  setRemoteRestoreState: (state: RemoteRestoreState) => void;
  setRestoreRetrySignal: (value: number | ((previous: number) => number)) => void;
  setActiveTab: (tab: TabId) => void;
  applyRemoteSnapshot?: (snapshot: RemoteAppDataSnapshot) => void;
}): void {
  const {
    backendConfigured,
    online,
    activeUserId,
    appData,
    remoteLoading,
    remoteReadOnly,
    remoteRestoreState,
    restoreRetrySignal,
    restoreRetryDelayMs = DEFAULT_RESTORE_RETRY_DELAY_MS,
    hasCachedAppData,
    remoteVersion,
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
    setActiveTab,
    applyRemoteSnapshot
  } = params;

  useEffect(() => {
    if (!backendConfigured) {
      return;
    }
    let cancelled = false;
    setRemoteLoading(true);
    setRemoteRestoreState(restoreRetrySignal > 0 ? "retrying" : "checking");

    resolveRemoteSessionProfile()
      .then(async (sessionResult) => {
        if (cancelled) {
          return;
        }
        if (sessionResult.status === "no-session" || sessionResult.status === "inactive-or-missing") {
          setActiveUserId(null);
          setRemoteError("");
          setRemoteRestoreState("ready");
          return;
        }
        if (sessionResult.status === "profile-unreachable") {
          if (hasCachedAppData) {
            setActiveUserId(sessionResult.userId);
            setActiveTab("dashboard");
            setRemoteError(
              "Your session is still active, but the profile check is temporarily unavailable. Cached data is read-only until sync recovers."
            );
            setRemoteRestoreState("stale-cache");
          } else {
            setActiveUserId(null);
            setRemoteError(
              "Your session is still active, but the profile check is temporarily unavailable. Retry when the backend is reachable."
            );
            setRemoteRestoreState("blocked");
          }
          return;
        }

        try {
          const snapshot = await loadRemoteAppDataSnapshot();
          if (cancelled) {
            return;
          }
          if (applyRemoteSnapshot) {
            applyRemoteSnapshot(snapshot);
          } else {
            skipRemotePersistRef.current = true;
            setAppData(normalizeAppDataCustomers(snapshot.appData));
            setRemoteVersion(snapshot.version);
          }
          setActiveUserId(sessionResult.profile.id);
          setActiveTab("dashboard");
          setRemoteError("");
          setRemoteRestoreState("ready");
        } catch (error) {
          if (cancelled) {
            return;
          }
          if (hasCachedAppData) {
            skipRemotePersistRef.current = true;
            setAppData(normalizeAppDataCustomers(ensureProfileInAppData(appData, sessionResult.profile)));
            setActiveUserId(sessionResult.profile.id);
            setActiveTab("dashboard");
            setRemoteError(
              error instanceof Error
                ? `${error.message} Cached data is read-only until retry succeeds.`
                : "Latest remote data could not be loaded. Cached data is read-only until retry succeeds."
            );
            setRemoteRestoreState("stale-cache");
          } else {
            setActiveUserId(null);
            setRemoteError(
              error instanceof Error
                ? `${error.message} Retry when the backend is reachable.`
                : "Latest remote data could not be loaded. Retry when the backend is reachable."
            );
            setRemoteRestoreState("blocked");
          }
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setActiveUserId(null);
        setRemoteError(error instanceof Error ? error.message : "Unable to restore your session.");
        setRemoteRestoreState("blocked");
      })
      .finally(() => {
        if (!cancelled) {
          setRemoteLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [backendConfigured, restoreRetrySignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!backendConfigured || !online) {
      return;
    }
    if (remoteRestoreState !== "stale-cache" && remoteRestoreState !== "blocked") {
      return;
    }
    const retryTimer = window.setTimeout(() => {
      setRestoreRetrySignal((previous) => previous + 1);
    }, restoreRetryDelayMs);
    return () => window.clearTimeout(retryTimer);
  }, [backendConfigured, online, remoteRestoreState, restoreRetryDelayMs, setRestoreRetrySignal]);

  useEffect(() => {
    if (!backendConfigured || !activeUserId) {
      return;
    }
    return subscribeToRemoteAppData((snapshot) => {
      if (applyRemoteSnapshot) {
        applyRemoteSnapshot(snapshot);
      } else {
        skipRemotePersistRef.current = true;
        setAppData(normalizeAppDataCustomers(snapshot.appData));
        setRemoteVersion(snapshot.version);
      }
      setRemoteError("");
      setRemoteRestoreState("ready");
    });
  }, [activeUserId, backendConfigured]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!backendConfigured) {
      saveAppData(appData);
      return;
    }
    if (!activeUserId || remoteLoading || remoteReadOnly) {
      return;
    }
    if (skipRemotePersistRef.current) {
      skipRemotePersistRef.current = false;
      return;
    }
    if (remoteSaveTimerRef.current) {
      window.clearTimeout(remoteSaveTimerRef.current);
    }
    remoteSaveTimerRef.current = window.setTimeout(() => {
      if (!activeUserId) {
        return;
      }
      setRemoteSaving(true);
      saveRemoteAppData(appData, activeUserId, remoteVersion)
        .then((nextVersion) => {
          setRemoteVersion(nextVersion);
          setRemoteError("");
        })
        .catch(async (error: unknown) => {
          try {
            const snapshot = await loadRemoteAppDataSnapshot();
            skipRemotePersistRef.current = true;
            setAppData(normalizeAppDataCustomers(snapshot.appData));
            setRemoteVersion(snapshot.version);
          } catch {
            // The error banner below is sufficient while remote recovery is unavailable.
          }
          setRemoteError(
            error instanceof Error
              ? error.message
              : "Remote data changed in another browser. Please retry after the latest data loads."
          );
        })
        .finally(() => {
          setRemoteSaving(false);
        });
    }, 250);
    return () => {
      if (remoteSaveTimerRef.current) {
        window.clearTimeout(remoteSaveTimerRef.current);
      }
    };
  }, [activeUserId, appData, backendConfigured, remoteLoading, remoteReadOnly]); // eslint-disable-line react-hooks/exhaustive-deps
}
