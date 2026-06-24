import type { BackendFeatureFlags } from "./featureFlags";
import { appStateRemoteDataGateway } from "./appStateGateway";
import { invokeFinancialAdjustmentRpc, invokeFinancialCheckoutRpc } from "./financialRpcClient";
import {
  emitGenericAppStateSaveEvent,
  loadNormalizedRealtimeOverlay,
  subscribeToOperationalEvents
} from "./normalizedRealtime";
import { loadNormalizedAppDataOverlay } from "./normalizedReads";
import { invokeOperationalMutationRpc } from "./rpcClient";
import type { RemoteDataGateway } from "./types";
import { getSupabaseClient, type RemoteAppDataSnapshot } from "../backend";
import { recordCompactRealtimeTelemetry } from "../syncTelemetry";
import type { AppData, Bill, CustomerTab, Payment, Session, SessionPauseLog } from "../types";

function mergeLiveSessions(baseSessions: Session[], normalizedSessions: Session[]): Session[] {
  const closedBaseSessionIds = new Set(
    baseSessions.filter((session) => session.status === "closed").map((session) => session.id)
  );
  const effectiveNormalizedSessions = normalizedSessions.filter((session) => !closedBaseSessionIds.has(session.id));
  const normalizedSessionIds = new Set(effectiveNormalizedSessions.map((session) => session.id));
  const normalizedStationIds = new Set(effectiveNormalizedSessions.map((session) => session.stationId).filter(Boolean));
  const retainedBaseSessions = baseSessions.filter((session) => {
    if (normalizedSessionIds.has(session.id)) {
      return false;
    }
    if (session.status !== "closed" && normalizedStationIds.has(session.stationId)) {
      return false;
    }
    return true;
  });
  return [...retainedBaseSessions, ...effectiveNormalizedSessions];
}

function mergeLiveCustomerTabs(baseTabs: CustomerTab[], normalizedTabs: CustomerTab[]): CustomerTab[] {
  const closedBaseTabIds = new Set(baseTabs.filter((tab) => tab.status === "closed").map((tab) => tab.id));
  const effectiveNormalizedTabs = normalizedTabs.filter((tab) => !closedBaseTabIds.has(tab.id));
  const normalizedTabIds = new Set(effectiveNormalizedTabs.map((tab) => tab.id));
  return [...baseTabs.filter((tab) => !normalizedTabIds.has(tab.id)), ...effectiveNormalizedTabs];
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

function mergeRecordsById<T extends { id: string }>(baseRecords: T[], overlayRecords: T[]): T[] {
  if (overlayRecords.length === 0) {
    return baseRecords;
  }
  const overlayById = new Map(overlayRecords.map((record) => [record.id, record]));
  const merged = baseRecords.map((record) => overlayById.get(record.id) ?? record);
  const existingIds = new Set(baseRecords.map((record) => record.id));
  return [...overlayRecords.filter((record) => !existingIds.has(record.id)), ...merged];
}

function mergeNormalizedAppDataOverlay(baseAppData: AppData, overlayAppData: Partial<AppData>): AppData {
  const merged = {
    ...baseAppData,
    ...overlayAppData
  };
  if (overlayAppData.bills) {
    merged.bills = mergeRecordsById<Bill>(baseAppData.bills, overlayAppData.bills);
  }
  if (overlayAppData.payments) {
    merged.payments = mergeRecordsById<Payment>(baseAppData.payments, overlayAppData.payments);
  }
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
  let lastSnapshot: RemoteAppDataSnapshot | null = null;
  const gateway: RemoteDataGateway = {
    async loadAppDataSnapshot() {
      const snapshot = await appStateRemoteDataGateway.loadAppDataSnapshot();
      const overlay = await loadNormalizedAppDataOverlay({
        normalizedConfigReads: _flags.normalizedConfigReads,
        normalizedCatalogReads: _flags.normalizedCatalogReads,
        normalizedComboReads: _flags.normalizedComboReads,
        normalizedLiveReads: _flags.normalizedLiveReads
      });
      lastSnapshot = {
        ...snapshot,
        appData: mergeNormalizedAppDataOverlay(snapshot.appData, overlay.appData)
      };
      return lastSnapshot;
    },
    async saveAppData(appData, activeUserId, expectedVersion, telemetryOptions) {
      const nextVersion = await appStateRemoteDataGateway.saveAppData(appData, activeUserId, expectedVersion, telemetryOptions);
      if (_flags.normalizedRealtime) {
        try {
          await emitGenericAppStateSaveEvent({
            client: getSupabaseClient(),
            activeUserId,
            appStateVersion: nextVersion,
            actionLabel: telemetryOptions?.actionLabel
          });
        } catch (error) {
          console.warn("Unable to publish compact app-state save event.", error);
        }
      }
      return nextVersion;
    },
    subscribeToAppData(onChange) {
      if (_flags.normalizedRealtime) {
        const client = getSupabaseClient();
        return subscribeToOperationalEvents(client, async (event) => {
          const startedAt = Date.now();
          try {
            if (!lastSnapshot) {
              lastSnapshot = await gateway.loadAppDataSnapshot();
            }
            const overlay = await loadNormalizedRealtimeOverlay(event, _flags, client);
            if (overlay.requiresFullRefresh) {
              lastSnapshot = await gateway.loadAppDataSnapshot();
            } else {
              lastSnapshot = {
                ...lastSnapshot,
                appData: mergeNormalizedAppDataOverlay(lastSnapshot.appData, overlay.appData),
                version: overlay.appStateVersion ?? lastSnapshot.version,
                sourceMutationId: overlay.sourceMutationId
              };
            }
            recordCompactRealtimeTelemetry({
              eventPayload: event,
              eventType: event.event_type,
              entityType: event.entity_type,
              entityId: event.entity_id,
              refreshedSlices: overlay.refreshedSlices,
              startedAt,
              status: "success",
              skippedFullSnapshot: !overlay.requiresFullRefresh
            });
            onChange(lastSnapshot);
          } catch (error) {
            recordCompactRealtimeTelemetry({
              eventPayload: event,
              eventType: event.event_type,
              entityType: event.entity_type,
              entityId: event.entity_id,
              refreshedSlices: [],
              startedAt,
              status: "error",
              errorMessage: error instanceof Error ? error.message : "Unable to refresh compact realtime event.",
              skippedFullSnapshot: true
            });
            console.warn("Unable to apply compact realtime event.", error);
          }
        });
      }
      return appStateRemoteDataGateway.subscribeToAppData(onChange);
    }
  };
  if (_flags.rpcOperationalWrites) {
    gateway.commitOperationalMutation = (mutation) => invokeOperationalMutationRpc(mutation);
  }
  if (_flags.rpcFinancialWrites) {
    gateway.commitFinancialCheckout = (patch) => invokeFinancialCheckoutRpc(patch);
    gateway.commitFinancialAdjustment = (patch) => invokeFinancialAdjustmentRpc(patch);
  }
  return gateway;
}
