import type { BackendFeatureFlags } from "./featureFlags";
import { appStateRemoteDataGateway } from "./appStateGateway";
import { loadNormalizedAppDataOverlay } from "./normalizedReads";
import { invokeOperationalMutationRpc } from "./rpcClient";
import type { RemoteDataGateway } from "./types";
import type { AppData, CustomerTab, Session, SessionPauseLog } from "../types";

const NOT_IMPLEMENTED_MESSAGE =
  "Normalized RPC or realtime gateway is not implemented yet. Disable RPC/realtime backend feature flags until those adapters are available.";

function unsupportedGatewayCall(): never {
  throw new Error(NOT_IMPLEMENTED_MESSAGE);
}

function mergeLiveSessions(baseSessions: Session[], normalizedSessions: Session[]): Session[] {
  const normalizedSessionIds = new Set(normalizedSessions.map((session) => session.id));
  const normalizedStationIds = new Set(normalizedSessions.map((session) => session.stationId).filter(Boolean));
  const retainedBaseSessions = baseSessions.filter((session) => {
    if (normalizedSessionIds.has(session.id)) {
      return false;
    }
    if (session.status !== "closed" && normalizedStationIds.has(session.stationId)) {
      return false;
    }
    return true;
  });
  return [...retainedBaseSessions, ...normalizedSessions];
}

function mergeLiveCustomerTabs(baseTabs: CustomerTab[], normalizedTabs: CustomerTab[]): CustomerTab[] {
  const normalizedTabIds = new Set(normalizedTabs.map((tab) => tab.id));
  return [...baseTabs.filter((tab) => !normalizedTabIds.has(tab.id)), ...normalizedTabs];
}

function mergeLiveSessionPauseLogs(
  basePauseLogs: SessionPauseLog[],
  normalizedPauseLogs: SessionPauseLog[],
  retainedSessions: Session[] | undefined
): SessionPauseLog[] {
  const normalizedPauseLogIds = new Set(normalizedPauseLogs.map((log) => log.id));
  const retainedSessionIds = retainedSessions ? new Set(retainedSessions.map((session) => session.id)) : undefined;
  return [
    ...basePauseLogs.filter(
      (log) => !normalizedPauseLogIds.has(log.id) && (!retainedSessionIds || retainedSessionIds.has(log.sessionId))
    ),
    ...normalizedPauseLogs
  ];
}

function mergeNormalizedAppDataOverlay(baseAppData: AppData, overlayAppData: Partial<AppData>): AppData {
  const merged = {
    ...baseAppData,
    ...overlayAppData
  };
  if (overlayAppData.sessions) {
    merged.sessions = mergeLiveSessions(baseAppData.sessions, overlayAppData.sessions);
  }
  if (overlayAppData.customerTabs) {
    merged.customerTabs = mergeLiveCustomerTabs(baseAppData.customerTabs, overlayAppData.customerTabs);
  }
  if (overlayAppData.sessionPauseLogs) {
    merged.sessionPauseLogs = mergeLiveSessionPauseLogs(
      baseAppData.sessionPauseLogs,
      overlayAppData.sessionPauseLogs,
      overlayAppData.sessions ? merged.sessions : undefined
    );
  }
  return merged;
}

export function createNormalizedRemoteDataGateway(_flags: BackendFeatureFlags): RemoteDataGateway {
  const gateway: RemoteDataGateway = {
    async loadAppDataSnapshot() {
      const snapshot = await appStateRemoteDataGateway.loadAppDataSnapshot();
      const overlay = await loadNormalizedAppDataOverlay({
        normalizedConfigReads: _flags.normalizedConfigReads,
        normalizedCatalogReads: _flags.normalizedCatalogReads,
        normalizedComboReads: _flags.normalizedComboReads,
        normalizedLiveReads: _flags.normalizedLiveReads
      });
      return {
        ...snapshot,
        appData: mergeNormalizedAppDataOverlay(snapshot.appData, overlay.appData)
      };
    },
    saveAppData(appData, activeUserId, expectedVersion, telemetryOptions) {
      if (_flags.rpcFinancialWrites) {
        return Promise.reject(new Error(NOT_IMPLEMENTED_MESSAGE));
      }
      return appStateRemoteDataGateway.saveAppData(appData, activeUserId, expectedVersion, telemetryOptions);
    },
    subscribeToAppData(onChange) {
      if (_flags.normalizedRealtime) {
        return unsupportedGatewayCall();
      }
      return appStateRemoteDataGateway.subscribeToAppData(onChange);
    }
  };
  if (_flags.rpcOperationalWrites) {
    gateway.commitOperationalMutation = (mutation) => invokeOperationalMutationRpc(mutation);
  }
  return gateway;
}
