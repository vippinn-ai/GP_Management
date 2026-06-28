import type { BackendFeatureFlags } from "./featureFlags";
import { invokeAdminDataChangeRpc } from "./adminDataRpcClient";
import { appStateRemoteDataGateway } from "./appStateGateway";
import { invokeFinancialAdjustmentRpc, invokeFinancialCheckoutRpc } from "./financialRpcClient";
import {
  getBusinessDayIssuedAtRange,
  loadNormalizedBillRegisterPage,
  loadNormalizedPendingBills,
  type NormalizedBillRegisterCursor,
  type NormalizedBillRegisterQuery
} from "./normalizedBillRegister";
import {
  emitGenericAppStateSaveEvent,
  loadNormalizedRealtimeOverlay,
  subscribeToOperationalEvents
} from "./normalizedRealtime";
import {
  loadNormalizedAppDataOverlay,
  loadNormalizedAuditLogs,
  loadNormalizedExpenseAdminData,
  loadNormalizedStockMovements
} from "./normalizedReads";
import { invokeOperationalMutationRpc } from "./rpcClient";
import type { RemoteDataGateway } from "./types";
import {
  fetchProfiles,
  getSupabaseClient,
  loadRemoteAppStateMetadata,
  type RemoteAppDataSnapshot
} from "../backend";
import { hydrateAppData } from "../storage";
import { recordCompactRealtimeTelemetry, recordStartupBootstrapTelemetry } from "../syncTelemetry";
import type { AppData, Bill, Customer, CustomerTab, Payment, Session, SessionPauseLog } from "../types";
import { addDays, toBusinessDayKey } from "../utils";

const NORMALIZED_BOOTSTRAP_RECENT_BUSINESS_DAYS = 1;
const NORMALIZED_BOOTSTRAP_STOCK_MOVEMENT_BUSINESS_DAYS = 30;
const NORMALIZED_BOOTSTRAP_PAGE_SIZE = 200;
const NORMALIZED_BOOTSTRAP_MAX_RECENT_BILLS = 200;
const NORMALIZED_BOOTSTRAP_MAX_STOCK_MOVEMENTS = 5_000;
const NORMALIZED_BOOTSTRAP_RECENT_AUDIT_LOGS = 20;

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

function appendUniqueRecordsById<T extends { id: string }>(baseRecords: T[], nextRecords: T[]): T[] {
  if (nextRecords.length === 0) {
    return baseRecords;
  }
  const existingIds = new Set(baseRecords.map((record) => record.id));
  return [...baseRecords, ...nextRecords.filter((record) => !existingIds.has(record.id))];
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

async function loadNormalizedBillPages(
  query: NormalizedBillRegisterQuery,
  client: ReturnType<typeof getSupabaseClient>,
  maxBills: number
): Promise<{ bills: Bill[]; payments: Payment[] }> {
  let cursor: NormalizedBillRegisterCursor | undefined;
  let bills: Bill[] = [];
  let payments: Payment[] = [];

  while (bills.length < maxBills) {
    const remaining = maxBills - bills.length;
    const page = await loadNormalizedBillRegisterPage(
      {
        ...query,
        limit: Math.min(NORMALIZED_BOOTSTRAP_PAGE_SIZE, remaining),
        cursor
      },
      client
    );
    bills = appendUniqueRecordsById(bills, page.bills);
    payments = appendUniqueRecordsById(payments, page.payments);
    if (!page.hasMore || !page.nextCursor || page.bills.length === 0) {
      break;
    }
    cursor = page.nextCursor;
  }

  return { bills, payments };
}

function getBusinessDayRangeForTrailingDays(days: number): { fromDate: string; toDate: string } {
  const currentBusinessDay = toBusinessDayKey(new Date());
  return {
    fromDate: toBusinessDayKey(addDays(new Date(`${currentBusinessDay}T12:00:00`), -(days - 1))),
    toDate: currentBusinessDay
  };
}

async function loadNormalizedBootstrapHistory(
  organizationId: string,
  client: ReturnType<typeof getSupabaseClient>
): Promise<{ bills: Bill[]; payments: Payment[] }> {
  const { fromDate: recentFrom, toDate: currentBusinessDay } = getBusinessDayRangeForTrailingDays(
    NORMALIZED_BOOTSTRAP_RECENT_BUSINESS_DAYS
  );
  const [recent, pendingBills] = await Promise.all([
    loadNormalizedBillPages(
      {
        organizationId,
        businessDateFrom: recentFrom,
        businessDateTo: currentBusinessDay
      },
      client,
      NORMALIZED_BOOTSTRAP_MAX_RECENT_BILLS
    ),
    loadNormalizedPendingBills({ organizationId }, client)
  ]);

  return {
    bills: mergeRecordsById(recent.bills, pendingBills),
    payments: recent.payments
  };
}

async function loadNormalizedBootstrapStockMovements(
  organizationId: string,
  client: ReturnType<typeof getSupabaseClient>
) {
  const stockMovementRange = getBusinessDayRangeForTrailingDays(NORMALIZED_BOOTSTRAP_STOCK_MOVEMENT_BUSINESS_DAYS);
  const dateRange = getBusinessDayIssuedAtRange(stockMovementRange.fromDate, stockMovementRange.toDate);
  return loadNormalizedStockMovements(
    organizationId,
    {
      fromIso: dateRange.fromIso,
      toIsoExclusive: dateRange.toIsoExclusive,
      limit: NORMALIZED_BOOTSTRAP_MAX_STOCK_MOVEMENTS
    },
    client
  );
}

function upsertStartupCustomer(
  customersById: Map<string, Customer>,
  source: {
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    visitAt?: string;
  }
) {
  const id = source.customerId?.trim();
  if (!id) {
    return;
  }
  const name = source.customerName?.trim() || source.customerPhone?.trim() || "Walk-in customer";
  const visitAt = source.visitAt || new Date().toISOString();
  const existing = customersById.get(id);
  if (!existing) {
    customersById.set(id, {
      id,
      name,
      phone: source.customerPhone?.trim() || undefined,
      createdAt: visitAt,
      lastVisitAt: visitAt
    });
    return;
  }
  if (source.customerPhone?.trim()) {
    existing.phone = source.customerPhone.trim();
  }
  if (source.customerName?.trim()) {
    existing.name = source.customerName.trim();
  }
  if (new Date(visitAt).getTime() > new Date(existing.lastVisitAt).getTime()) {
    existing.lastVisitAt = visitAt;
  }
  if (new Date(visitAt).getTime() < new Date(existing.createdAt).getTime()) {
    existing.createdAt = visitAt;
  }
}

function deriveStartupCustomers(appData: Partial<AppData>): Customer[] {
  const customersById = new Map<string, Customer>();
  (appData.customerTabs ?? []).forEach((tab) =>
    upsertStartupCustomer(customersById, {
      customerId: tab.customerId,
      customerName: tab.customerName,
      customerPhone: tab.customerPhone,
      visitAt: tab.createdAt
    })
  );
  (appData.sessions ?? []).forEach((session) =>
    upsertStartupCustomer(customersById, {
      customerId: session.customerId,
      customerName: session.customerName,
      customerPhone: session.customerPhone,
      visitAt: session.startedAt
    })
  );
  (appData.bills ?? []).forEach((bill) =>
    upsertStartupCustomer(customersById, {
      customerId: bill.customerId,
      customerName: bill.customerName,
      customerPhone: bill.customerPhone,
      visitAt: bill.issuedAt
    })
  );
  return Array.from(customersById.values()).sort((left, right) => right.lastVisitAt.localeCompare(left.lastVisitAt));
}

async function loadNormalizedBootstrapSnapshot(): Promise<RemoteAppDataSnapshot> {
  const startedAt = Date.now();
  try {
    const client = getSupabaseClient();
    const [users, metadata, overlay] = await Promise.all([
      fetchProfiles(),
      loadRemoteAppStateMetadata(),
      loadNormalizedAppDataOverlay({
        normalizedConfigReads: true,
        normalizedCatalogReads: true,
        normalizedComboReads: true,
        normalizedLiveReads: true,
        client
      })
    ]);
    const [history, expenses, stockMovements, auditLogs] = overlay.organizationId
      ? await Promise.all([
          loadNormalizedBootstrapHistory(overlay.organizationId, client),
          loadNormalizedExpenseAdminData(overlay.organizationId, client),
          loadNormalizedBootstrapStockMovements(overlay.organizationId, client),
          loadNormalizedAuditLogs(
            overlay.organizationId,
            { limit: NORMALIZED_BOOTSTRAP_RECENT_AUDIT_LOGS },
            client
          )
        ])
      : [
          { bills: [], payments: [] },
          { expenses: [], expenseTemplates: [], expenseTemplateOverrides: [] },
          [],
          []
        ];
    const startupAppData = {
      ...overlay.appData,
      ...history,
      ...expenses,
      stockMovements,
      auditLogs
    };
    const appData = hydrateAppData({
      ...startupAppData,
      customers: deriveStartupCustomers(startupAppData),
      users
    });
    recordStartupBootstrapTelemetry({
      appData,
      source: "normalized_bootstrap",
      version: metadata.version,
      startedAt,
      status: "success",
      skippedFullAppStateData: true
    });
    return {
      appData,
      version: metadata.version,
      source: "normalized_bootstrap"
    };
  } catch (error) {
    recordStartupBootstrapTelemetry({
      appData: {},
      source: "normalized_bootstrap",
      startedAt,
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unable to load normalized startup data.",
      skippedFullAppStateData: true
    });
    throw error;
  }
}

export function createNormalizedRemoteDataGateway(_flags: BackendFeatureFlags): RemoteDataGateway {
  let lastSnapshot: RemoteAppDataSnapshot | null = null;
  const gateway: RemoteDataGateway = {
    async loadAppDataSnapshot() {
      if (_flags.normalizedBootstrap) {
        lastSnapshot = await loadNormalizedBootstrapSnapshot();
        return lastSnapshot;
      }
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
      if (_flags.normalizedBootstrap) {
        throw new Error(
          "Full app-state saves are disabled while normalized startup bootstrap is enabled. Use RPC-backed actions or disable VITE_BACKEND_NORMALIZED_BOOTSTRAP."
        );
      }
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
  gateway.commitAdminDataChange = (patch) => invokeAdminDataChangeRpc(patch);
  return gateway;
}
