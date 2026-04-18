import { useEffect, type MutableRefObject } from "react";
import {
  fetchCurrentProfile,
  loadRemoteAppDataSnapshot,
  saveRemoteAppData,
  subscribeToRemoteAppData
} from "../backend";
import { saveAppData } from "../storage";
import { normalizeAppDataCustomers } from "../utils";
import type { AppData, TabId } from "../types";

export function useAppSync(params: {
  backendConfigured: boolean;
  activeUserId: string | null;
  appData: AppData;
  remoteLoading: boolean;
  remoteVersion: number;
  skipRemotePersistRef: MutableRefObject<boolean>;
  remoteSaveTimerRef: MutableRefObject<number | null>;
  setAppData: (data: AppData) => void;
  setActiveUserId: (id: string | null) => void;
  setRemoteVersion: (v: number) => void;
  setRemoteLoading: (loading: boolean) => void;
  setRemoteError: (err: string) => void;
  setRemoteSaving: (saving: boolean) => void;
  setActiveTab: (tab: TabId) => void;
}): void {
  const {
    backendConfigured,
    activeUserId,
    appData,
    remoteLoading,
    remoteVersion,
    skipRemotePersistRef,
    remoteSaveTimerRef,
    setAppData,
    setActiveUserId,
    setRemoteVersion,
    setRemoteLoading,
    setRemoteError,
    setRemoteSaving,
    setActiveTab
  } = params;

  // Restore session on mount and load initial app data
  useEffect(() => {
    if (!backendConfigured) {
      return;
    }
    setRemoteLoading(true);
    fetchCurrentProfile()
      .then((profile) => {
        if (!profile || !profile.active) {
          setActiveUserId(null);
          return;
        }
        return loadRemoteAppDataSnapshot().then((snapshot) => {
          skipRemotePersistRef.current = true;
          setAppData(normalizeAppDataCustomers(snapshot.appData));
          setRemoteVersion(snapshot.version);
          setActiveUserId(profile.id);
          setActiveTab("dashboard");
        });
      })
      .catch(() => setActiveUserId(null))
      .finally(() => setRemoteLoading(false));
  }, [backendConfigured]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to realtime updates from other tabs/devices
  useEffect(() => {
    if (!backendConfigured || !activeUserId) {
      return;
    }
    return subscribeToRemoteAppData((snapshot) => {
      skipRemotePersistRef.current = true;
      setAppData(normalizeAppDataCustomers(snapshot.appData));
      setRemoteVersion(snapshot.version);
      setRemoteError("");
    });
  }, [activeUserId, backendConfigured]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced save — persists app state locally or remotely on every change
  useEffect(() => {
    if (!backendConfigured) {
      saveAppData(appData);
      return;
    }
    if (!activeUserId || remoteLoading) {
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
          // On conflict, fetch latest data before surfacing the error
          try {
            const snapshot = await loadRemoteAppDataSnapshot();
            skipRemotePersistRef.current = true;
            setAppData(normalizeAppDataCustomers(snapshot.appData));
            setRemoteVersion(snapshot.version);
          } catch {
            // ignore refresh failure — the error banner below is sufficient
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
  }, [activeUserId, appData, backendConfigured, remoteLoading]); // eslint-disable-line react-hooks/exhaustive-deps
}
