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
import { loadNormalizedReportData } from "./normalizedReports";
import {
  emitGenericAppStateSaveEvent,
  loadNormalizedRealtimeOverlay,
  subscribeToOperationalEvents,
  type OperationalEventRow
} from "./normalizedRealtime";
import {
  buildOperationalBootstrapRpcResult,
  loadNormalizedAppDataOverlay,
  loadNormalizedAuditLogs,
  loadNormalizedExpenseAdminData,
  loadNormalizedStockMovements
} from "./normalizedReads";
import { invokeOperationalMutationRpc } from "./rpcClient";
import {
  clearCachedNormalizedOrganizationId,
  rememberNormalizedOrganizationId,
  resolveNormalizedOrganizationId
} from "./normalizedOrganization";
import type { RemoteDataGateway } from "./types";
import {
  fetchProfiles,
  getSupabaseClient,
  loadRemoteAppStateMetadata,
  type RemoteAppDataSnapshot
} from "../backend";
import { hydrateAppData } from "../storage";
import { recordCompactRealtimeTelemetry, recordStartupBootstrapTelemetry } from "../syncTelemetry";
import type { AppData, Bill, Customer, CustomerTab, Expense, Payment, Session, SessionPauseLog } from "../types";
import { addDays, toBusinessDayKey } from "../utils";

const NORMALIZED_BOOTSTRAP_RECENT_BUSINESS_DAYS = 1;
const NORMALIZED_BOOTSTRAP_STOCK_MOVEMENT_BUSINESS_DAYS = 30;
const NORMALIZED_BOOTSTRAP_PAGE_SIZE = 200;
const NORMALIZED_BOOTSTRAP_MAX_RECENT_BILLS = 5_000;
const NORMALIZED_BOOTSTRAP_MAX_STOCK_MOVEMENTS = 5_000;
const NORMALIZED_BOOTSTRAP_RECENT_AUDIT_LOGS = 20;
const MAX_PROCESSED_REALTIME_EVENT_IDS = 2_000;
const MAX_BUFFERED_BOOTSTRAP_EVENTS = 1_000;
const OPERATIONAL_BOOTSTRAP_CLIENT_TIMEOUT_MS = 7_000;

function markBootstrapPerformance(name: string) {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(name);
  }
}

function withOperationalBootstrapTimeout<T>(promise: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error("Operational bootstrap RPC did not finish within 7 seconds."));
    }, OPERATIONAL_BOOTSTRAP_CLIENT_TIMEOUT_MS);
    Promise.resolve(promise).then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function mergeLiveSessions(baseSessions: Session[], normalizedSessions: Session[]): Session[] {
  const baseSessionsById = new Map(baseSessions.map((session) => [session.id, session]));
  const effectiveNormalizedSessions = normalizedSessions.filter((session) => {
    const existing = baseSessionsById.get(session.id);
    return !(existing?.status === "closed" && session.status !== "closed");
  });
  const normalizedSessionIds = new Set(effectiveNormalizedSessions.map((session) => session.id));
  const normalizedOpenStationIds = new Set(
    effectiveNormalizedSessions
      .filter((session) => session.status !== "closed")
      .map((session) => session.stationId)
      .filter(Boolean)
  );
  const retainedBaseSessions = baseSessions.filter((session) => {
    if (normalizedSessionIds.has(session.id)) {
      return false;
    }
    if (session.status !== "closed" && normalizedOpenStationIds.has(session.stationId)) {
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
  refreshedSessions: Session[] | undefined,
  retainedSessions: Session[] | undefined
): SessionPauseLog[] {
  const normalizedPauseLogIds = new Set(normalizedPauseLogs.map((log) => log.id));
  const refreshedSessionIds = refreshedSessions ? new Set(refreshedSessions.map((session) => session.id)) : undefined;
  const retainedSessionIds = retainedSessions ? new Set(retainedSessions.map((session) => session.id)) : undefined;
  return [
    ...basePauseLogs.filter(
      (log) =>
        !normalizedPauseLogIds.has(log.id)
        && (!refreshedSessionIds || !refreshedSessionIds.has(log.sessionId))
        && (!retainedSessionIds || retainedSessionIds.has(log.sessionId))
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

export function mergeNormalizedAppDataOverlay(baseAppData: AppData, overlayAppData: Partial<AppData>): AppData {
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
  if (overlayAppData.customers) {
    merged.customers = mergeRecordsById(baseAppData.customers, overlayAppData.customers);
  }
  if (overlayAppData.stockMovements) {
    merged.stockMovements = mergeRecordsById(baseAppData.stockMovements, overlayAppData.stockMovements);
  }
  if (overlayAppData.auditLogs) {
    merged.auditLogs = mergeRecordsById(baseAppData.auditLogs, overlayAppData.auditLogs);
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
      overlayAppData.sessions,
      overlayAppData.sessions ? merged.sessions : undefined
    );
  }
  return merged;
}

export function buildRetainedNoncriticalDataOverlay(
  currentAppData: AppData,
  refreshedSlices: string[] = []
): Partial<AppData> {
  const refreshed = new Set(refreshedSlices);
  return {
    ...(!refreshed.has("bills")
      ? { bills: currentAppData.bills, payments: currentAppData.payments }
      : {}),
    ...(!refreshed.has("customers") ? { customers: currentAppData.customers } : {}),
    ...(!refreshed.has("stock_movements") ? { stockMovements: currentAppData.stockMovements } : {}),
    ...(!refreshed.has("audit_logs") ? { auditLogs: currentAppData.auditLogs } : {}),
    ...(!refreshed.has("expenses") ? { expenses: currentAppData.expenses } : {}),
    ...(!refreshed.has("expense_templates") ? { expenseTemplates: currentAppData.expenseTemplates } : {}),
    ...(!refreshed.has("expense_template_overrides")
      ? { expenseTemplateOverrides: currentAppData.expenseTemplateOverrides }
      : {})
  };
}

export async function loadNormalizedBillPages(
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
    if (!page.hasMore) {
      break;
    }
    if (!page.nextCursor || page.bills.length === 0) {
      throw new Error("Normalized bill history reported more rows without a usable cursor; refusing to return partial financial data.");
    }
    if (bills.length >= maxBills) {
      throw new Error(
        `Normalized bill history exceeded the safe bootstrap limit of ${maxBills}; refusing to return partial financial data.`
      );
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
): Promise<{ bills: Bill[]; payments: Payment[]; expenses: Expense[] }> {
  const { fromDate: recentFrom, toDate: currentBusinessDay } = getBusinessDayRangeForTrailingDays(
    NORMALIZED_BOOTSTRAP_RECENT_BUSINESS_DAYS
  );
  const [recent, paymentDateActivity, pendingBills] = await Promise.all([
    loadNormalizedBillPages(
      {
        organizationId,
        businessDateFrom: recentFrom,
        businessDateTo: currentBusinessDay
      },
      client,
      NORMALIZED_BOOTSTRAP_MAX_RECENT_BILLS
    ),
    loadNormalizedReportData(
      {
        organizationId,
        fromDate: recentFrom,
        toDate: currentBusinessDay
      },
      client
    ),
    loadNormalizedPendingBills({ organizationId }, client)
  ]);

  return {
    bills: mergeRecordsById(mergeRecordsById(recent.bills, paymentDateActivity.bills), pendingBills),
    payments: mergeRecordsById(recent.payments, paymentDateActivity.payments),
    expenses: paymentDateActivity.expenses
  };
}

export async function loadNormalizedBootstrapStockMovements(
  organizationId: string,
  client: ReturnType<typeof getSupabaseClient>
) {
  const stockMovementRange = getBusinessDayRangeForTrailingDays(NORMALIZED_BOOTSTRAP_STOCK_MOVEMENT_BUSINESS_DAYS);
  const dateRange = getBusinessDayIssuedAtRange(stockMovementRange.fromDate, stockMovementRange.toDate);
  const movements = await loadNormalizedStockMovements(
    organizationId,
    {
      fromIso: dateRange.fromIso,
      toIsoExclusive: dateRange.toIsoExclusive,
      limit: NORMALIZED_BOOTSTRAP_MAX_STOCK_MOVEMENTS
    },
    client
  );
  if (movements.length >= NORMALIZED_BOOTSTRAP_MAX_STOCK_MOVEMENTS) {
    throw new Error(
      `Normalized stock-movement history reached the safe bootstrap limit of ${NORMALIZED_BOOTSTRAP_MAX_STOCK_MOVEMENTS}; refusing to return partial inventory audit data.`
    );
  }
  return movements;
}

export async function loadDeferredNormalizedInventoryHistory() {
  const client = getSupabaseClient();
  const organizationId = await resolveNormalizedOrganizationId(client);
  return loadNormalizedBootstrapStockMovements(organizationId, client);
}

export async function loadDeferredNormalizedExpenseAdminData() {
  const client = getSupabaseClient();
  const organizationId = await resolveNormalizedOrganizationId(client);
  return loadNormalizedExpenseAdminData(organizationId, client);
}

export async function loadDeferredNormalizedDashboardHistory(explicitOrganizationId?: string) {
  const client = getSupabaseClient();
  const organizationId = explicitOrganizationId ?? await resolveNormalizedOrganizationId(client);
  return loadNormalizedBootstrapHistory(organizationId, client);
}

export async function loadDeferredNormalizedDashboardActivity(explicitOrganizationId?: string) {
  const client = getSupabaseClient();
  const organizationId = explicitOrganizationId ?? await resolveNormalizedOrganizationId(client);
  const auditLogs = await loadNormalizedAuditLogs(
    organizationId,
    { limit: NORMALIZED_BOOTSTRAP_RECENT_AUDIT_LOGS },
    client
  );
  return { auditLogs };
}

export async function loadDeferredNormalizedDashboardContext(explicitOrganizationId?: string) {
  const [history, activity] = await Promise.all([
    loadDeferredNormalizedDashboardHistory(explicitOrganizationId),
    loadDeferredNormalizedDashboardActivity(explicitOrganizationId)
  ]);
  return { ...history, ...activity };
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

async function loadNormalizedBootstrapSnapshot(options?: Parameters<RemoteDataGateway["loadAppDataSnapshot"]>[0]): Promise<RemoteAppDataSnapshot> {
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
        client,
        organization: options?.organization
      })
    ]);
    const startupAppData = {
      ...overlay.appData,
      bills: [],
      payments: [],
      expenses: [],
      stockMovements: [],
      auditLogs: []
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
  let realtimeEventPipeline: Promise<void> = Promise.resolve();
  let bootstrapInFlight = false;
  const bufferedBootstrapEvents: OperationalEventRow[] = [];
  let bootstrapBufferError: Error | null = null;
  const processedRealtimeEventIds = new Set<string>();
  let realtimeReadyPromise: Promise<void> | null = null;
  let realtimeReadyReject: ((error: Error) => void) | null = null;
  let realtimeUnsubscribe: (() => void) | null = null;
  let realtimeGeneration = 0;
  let selectedOrganizationId: string | null = null;
  let scheduledTeardownId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let realtimeSnapshotListener: ((snapshot: RemoteAppDataSnapshot) => void) | null = null;
  let realtimeErrorListener: ((error: Error) => void) | null = null;
  let realtimeListenerGeneration = 0;
  let preparedAtomicBootstrap: Promise<{ status: "no-session" } | { status: "session"; userId: string }> | null = null;
  let preparedAtomicBootstrapGeneration: number | null = null;
  let atomicBootstrapAttempt: ReturnType<NonNullable<RemoteDataGateway["loadAuthenticatedAppDataSnapshot"]>> | null = null;
  let atomicAttemptGeneration = 0;
  let atomicFailure: Error | null = null;

  const clearScheduledTeardown = () => {
    if (scheduledTeardownId !== null) {
      globalThis.clearTimeout(scheduledTeardownId);
      scheduledTeardownId = null;
    }
  };

  const resetRealtimeAttempt = () => {
    clearScheduledTeardown();
    const rejectPendingReady = realtimeReadyReject;
    realtimeReadyReject = null;
    realtimeGeneration += 1;
    const unsubscribe = realtimeUnsubscribe;
    realtimeUnsubscribe = null;
    realtimeReadyPromise = null;
    selectedOrganizationId = null;
    lastSnapshot = null;
    bootstrapInFlight = false;
    bootstrapBufferError = null;
    bufferedBootstrapEvents.length = 0;
    processedRealtimeEventIds.clear();
    clearCachedNormalizedOrganizationId();
    realtimeEventPipeline = Promise.resolve();
    unsubscribe?.();
    rejectPendingReady?.(new Error("Normalized realtime preparation was superseded."));
  };

  const assertAtomicAttemptCurrent = (generation: number) => {
    if (generation !== atomicAttemptGeneration) {
      throw new Error("Atomic bootstrap attempt was superseded by logout or account change.");
    }
  };

  const invalidateAtomicAttempt = () => {
    atomicAttemptGeneration += 1;
    atomicFailure = null;
    resetRealtimeAttempt();
    preparedAtomicBootstrap = null;
    preparedAtomicBootstrapGeneration = null;
    atomicBootstrapAttempt = null;
  };

  const failAtomicAttemptUntilManualReset = (error: Error) => {
    atomicAttemptGeneration += 1;
    resetRealtimeAttempt();
    atomicFailure = error;
    const failedPreparation = Promise.reject<{ status: "no-session" } | { status: "session"; userId: string }>(error);
    const failedAttempt = Promise.reject<Awaited<ReturnType<NonNullable<RemoteDataGateway["loadAuthenticatedAppDataSnapshot"]>>>>(error);
    void failedPreparation.catch(() => undefined);
    void failedAttempt.catch(() => undefined);
    preparedAtomicBootstrap = failedPreparation;
    preparedAtomicBootstrapGeneration = atomicAttemptGeneration;
    atomicBootstrapAttempt = failedAttempt;
  };

  const applyRealtimeEvent = async (
    event: OperationalEventRow,
    notify: boolean,
    validateAttempt?: () => void,
    listenerGeneration?: number
  ) => {
    validateAttempt?.();
    if (processedRealtimeEventIds.has(event.id)) return;
    if (selectedOrganizationId && event.organization_id !== selectedOrganizationId) return;
    const client = getSupabaseClient();
    const startedAt = Date.now();
    try {
      if (!lastSnapshot) throw new Error("Normalized realtime received an event without a base snapshot.");
      const overlay = await loadNormalizedRealtimeOverlay(event, _flags, client);
      validateAttempt?.();
      if (overlay.requiresFullRefresh) {
        throw new Error("A full-refresh event requires an explicit normalized restore.");
      }
      const removedCustomerIds = new Set(overlay.removedCustomerIds);
      const snapshotBeforeOverlay = removedCustomerIds.size > 0
        ? {
            ...lastSnapshot.appData,
            customers: lastSnapshot.appData.customers.filter((customer) => !removedCustomerIds.has(customer.id))
          }
        : lastSnapshot.appData;
      lastSnapshot = {
        ...lastSnapshot,
        appData: mergeNormalizedAppDataOverlay(snapshotBeforeOverlay, overlay.appData),
        version: overlay.appStateVersion ?? lastSnapshot.version,
        sourceMutationId: overlay.sourceMutationId,
        sourceEventId: event.id,
        refreshedSlices: overlay.refreshedSlices
      };
      processedRealtimeEventIds.add(event.id);
      while (processedRealtimeEventIds.size > MAX_PROCESSED_REALTIME_EVENT_IDS) {
        const oldestEventId = processedRealtimeEventIds.values().next().value;
        if (typeof oldestEventId !== "string") break;
        processedRealtimeEventIds.delete(oldestEventId);
      }
      recordCompactRealtimeTelemetry({
        eventPayload: event,
        eventType: event.event_type,
        entityType: event.entity_type,
        entityId: event.entity_id,
        refreshedSlices: overlay.refreshedSlices,
        startedAt,
        status: "success",
        skippedFullSnapshot: true
      });
      if (notify && (listenerGeneration === undefined || listenerGeneration === realtimeListenerGeneration)) {
        realtimeSnapshotListener?.(lastSnapshot);
      }
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
      throw error;
    }
  };

  const ensureRealtimeReady = () => {
    if (!_flags.normalizedRealtime) return Promise.resolve();
    if (_flags.atomicBootstrap && atomicFailure) return Promise.reject(atomicFailure);
    clearScheduledTeardown();
    if (realtimeReadyPromise) return realtimeReadyPromise;
    const client = getSupabaseClient();
    const generation = ++realtimeGeneration;
    markBootstrapPerformance("bp-realtime-requested");
    realtimeReadyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled || generation !== realtimeGeneration) return;
        settled = true;
        realtimeReadyReject = null;
        const error = new Error("Normalized realtime subscription did not become ready within 10 seconds.");
        if (_flags.atomicBootstrap) failAtomicAttemptUntilManualReset(error);
        reject(error);
      }, 10_000);
      realtimeReadyReject = (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        reject(error);
      };
      markBootstrapPerformance("bp-realtime-channel-subscribe-called");
      realtimeUnsubscribe = subscribeToOperationalEvents(
        client,
        (event) => {
          if (generation !== realtimeGeneration) return Promise.resolve();
          if (processedRealtimeEventIds.has(event.id)) return Promise.resolve();
          if (selectedOrganizationId && event.organization_id !== selectedOrganizationId) return Promise.resolve();
          if (bootstrapInFlight || !lastSnapshot) {
            if (!bufferedBootstrapEvents.some((entry) => entry.id === event.id)) {
              if (bufferedBootstrapEvents.length >= MAX_BUFFERED_BOOTSTRAP_EVENTS) {
                bootstrapBufferError = new Error("Normalized realtime bootstrap buffer exceeded its safe limit.");
                return Promise.resolve();
              }
              bufferedBootstrapEvents.push(event);
            }
            return Promise.resolve();
          }
          const eventListenerGeneration = realtimeListenerGeneration;
          const eventErrorListener = realtimeErrorListener;
          realtimeEventPipeline = realtimeEventPipeline
            .then(() => applyRealtimeEvent(event, true, () => {
              if (generation !== realtimeGeneration) {
                throw new Error("Realtime event belonged to a superseded subscription.");
              }
            }, eventListenerGeneration))
            .catch((error) => {
              if (
                generation !== realtimeGeneration
                || eventListenerGeneration !== realtimeListenerGeneration
              ) return;
              const normalizedError = error instanceof Error ? error : new Error("Unable to apply compact realtime event.");
              console.warn("Unable to apply compact realtime event.", normalizedError);
              eventErrorListener?.(normalizedError);
            });
          return realtimeEventPipeline;
        },
        (status) => {
          if (generation !== realtimeGeneration) return;
          const safeStatus = status.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          if (safeStatus) markBootstrapPerformance(`bp-realtime-status-${safeStatus}`);
          if (settled) {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
              const error = new Error(
                _flags.atomicBootstrap
                  ? `Normalized realtime disconnected (${status}); a manual retry is required.`
                  : `Normalized realtime disconnected (${status}); a fresh restore is required.`
              );
              if (_flags.atomicBootstrap) failAtomicAttemptUntilManualReset(error);
              else resetRealtimeAttempt();
              realtimeErrorListener?.(error);
            }
            return;
          }
          if (status === "SUBSCRIBED") {
            settled = true;
            realtimeReadyReject = null;
            globalThis.clearTimeout(timeoutId);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            settled = true;
            realtimeReadyReject = null;
            globalThis.clearTimeout(timeoutId);
            const error = new Error(`Normalized realtime subscription failed before bootstrap (${status}).`);
            if (_flags.atomicBootstrap) failAtomicAttemptUntilManualReset(error);
            reject(error);
          }
        }
      );
    });
    return realtimeReadyPromise;
  };

  const prepareAuthenticatedBootstrap = () => {
    clearScheduledTeardown();
    if (preparedAtomicBootstrap) return preparedAtomicBootstrap;
    const client = getSupabaseClient();
    const attemptGeneration = ++atomicAttemptGeneration;
    preparedAtomicBootstrapGeneration = attemptGeneration;
    markBootstrapPerformance("bp-session-requested");
    const preparation = (async () => {
      const sessionResponse = await client.auth.getSession();
      assertAtomicAttemptCurrent(attemptGeneration);
      if (sessionResponse.error) throw sessionResponse.error;
      const userId = sessionResponse.data.session?.user.id?.trim();
      markBootstrapPerformance("bp-session-ready");
      if (!userId) {
        resetRealtimeAttempt();
        return { status: "no-session" as const };
      }
      await ensureRealtimeReady();
      assertAtomicAttemptCurrent(attemptGeneration);
      markBootstrapPerformance("bp-realtime-ready");
      return { status: "session" as const, userId };
    })();
    preparedAtomicBootstrap = preparation.catch((error) => {
      if (attemptGeneration === atomicAttemptGeneration) {
        failAtomicAttemptUntilManualReset(
          error instanceof Error ? error : new Error("Unable to prepare atomic operational bootstrap.")
        );
      }
      throw error;
    });
    const currentPreparation = preparedAtomicBootstrap;
    void currentPreparation
      .then((result) => {
        if (result.status === "no-session" && preparedAtomicBootstrap === currentPreparation) {
          preparedAtomicBootstrap = null;
          preparedAtomicBootstrapGeneration = null;
          atomicBootstrapAttempt = null;
        }
      })
      .catch(() => undefined);
    return preparedAtomicBootstrap;
  };

  const loadAuthenticatedAppDataSnapshot = () => {
    clearScheduledTeardown();
    if (atomicBootstrapAttempt) return atomicBootstrapAttempt;
    const preparationPromise = prepareAuthenticatedBootstrap();
    const attemptGeneration = preparedAtomicBootstrapGeneration;
    if (attemptGeneration === null) throw new Error("Atomic bootstrap preparation generation is missing.");
    const attempt = (async () => {
      markBootstrapPerformance("bp-bootstrap-requested");
      const preparation = await preparationPromise;
      assertAtomicAttemptCurrent(attemptGeneration);
      if (preparation.status === "no-session") return preparation;
      bootstrapInFlight = true;
      const startedAt = Date.now();
      try {
        if (bootstrapBufferError) throw bootstrapBufferError;
        markBootstrapPerformance("bp-bootstrap-rpc-requested");
        const response = await withOperationalBootstrapTimeout(
          getSupabaseClient().rpc("load_operational_bootstrap_v2")
        );
        assertAtomicAttemptCurrent(attemptGeneration);
        markBootstrapPerformance("bp-bootstrap-rpc-response");
        if (response.error) throw response.error;
        const result = buildOperationalBootstrapRpcResult(response.data);
        assertAtomicAttemptCurrent(attemptGeneration);
        if (result.actorId !== preparation.userId) {
          throw new Error("Operational bootstrap actor did not match the authenticated session.");
        }
        if (result.status === "inactive-or-missing") {
          resetRealtimeAttempt();
          return { status: "inactive-or-missing" as const, userId: result.actorId };
        }
        rememberNormalizedOrganizationId(result.organization.id);
        selectedOrganizationId = result.organization.id;
        const startupAppData = {
          ...result.appData,
          bills: [],
          payments: [],
          expenses: [],
          stockMovements: [],
          auditLogs: []
        };
        lastSnapshot = {
          appData: hydrateAppData({
            ...startupAppData,
            customers: deriveStartupCustomers(startupAppData)
          }),
          version: result.version,
          source: "normalized_bootstrap"
        };
        markBootstrapPerformance("bp-bootstrap-mapped");
        if (bootstrapBufferError) throw bootstrapBufferError;
        while (lastSnapshot && bufferedBootstrapEvents.length > 0) {
          const event = bufferedBootstrapEvents.shift()!;
          if (event.organization_id !== selectedOrganizationId) continue;
          await applyRealtimeEvent(event, false, () => assertAtomicAttemptCurrent(attemptGeneration));
          assertAtomicAttemptCurrent(attemptGeneration);
          if (bootstrapBufferError) throw bootstrapBufferError;
        }
        assertAtomicAttemptCurrent(attemptGeneration);
        markBootstrapPerformance("bp-critical-snapshot-ready");
        markBootstrapPerformance("bp-critical-catchup-ready");
        recordStartupBootstrapTelemetry({
          appData: lastSnapshot.appData,
          source: "normalized_bootstrap",
          version: result.version,
          startedAt,
          status: "success",
          skippedFullAppStateData: true
        });
        return {
          status: "active" as const,
          profile: result.profile,
          organization: result.organization,
          snapshot: lastSnapshot
        };
      } catch (error) {
        if (attemptGeneration === atomicAttemptGeneration) {
          const normalizedError = error instanceof Error ? error : new Error("Unable to load atomic operational bootstrap.");
          recordStartupBootstrapTelemetry({
            appData: {},
            source: "normalized_bootstrap",
            startedAt,
            status: "error",
            errorMessage: normalizedError.message,
            skippedFullAppStateData: true
          });
          failAtomicAttemptUntilManualReset(normalizedError);
        }
        throw error;
      } finally {
        if (attemptGeneration === atomicAttemptGeneration) bootstrapInFlight = false;
      }
    })();
    atomicBootstrapAttempt = attempt;
    return attempt;
  };

  const scheduleAuthenticatedBootstrapCancellation = () => {
    clearScheduledTeardown();
    if (atomicFailure) return;
    scheduledTeardownId = globalThis.setTimeout(() => {
      scheduledTeardownId = null;
      invalidateAtomicAttempt();
    }, 0);
  };
  const resetAuthenticatedBootstrapAttempt = () => {
    invalidateAtomicAttempt();
  };
  const gateway: RemoteDataGateway = {
    async loadAppDataSnapshot(options) {
      markBootstrapPerformance("bp-bootstrap-requested");
      bootstrapInFlight = true;
      try {
        try {
          await ensureRealtimeReady();
          markBootstrapPerformance("bp-realtime-ready");
        } catch (error) {
          resetRealtimeAttempt();
          throw error;
        }
        if (_flags.normalizedBootstrap) {
          lastSnapshot = await loadNormalizedBootstrapSnapshot(options);
          markBootstrapPerformance("bp-critical-snapshot-ready");
        } else {
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
        }
        while (lastSnapshot && bufferedBootstrapEvents.length > 0) {
          await applyRealtimeEvent(bufferedBootstrapEvents.shift()!, false);
        }
        markBootstrapPerformance("bp-critical-catchup-ready");
        return lastSnapshot;
      } finally {
        bootstrapInFlight = false;
      }
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
    subscribeToAppData(onChange, onError) {
      if (_flags.normalizedRealtime) {
        const listenerGeneration = ++realtimeListenerGeneration;
        realtimeSnapshotListener = onChange;
        realtimeErrorListener = onError ?? null;
        const readiness = ensureRealtimeReady();
        const channelGeneration = realtimeGeneration;
        void readiness.catch((error) => {
          if (
            channelGeneration !== realtimeGeneration
            || listenerGeneration !== realtimeListenerGeneration
          ) return;
          const normalizedError = error instanceof Error ? error : new Error("Unable to prepare normalized realtime.");
          console.warn("Unable to prepare normalized realtime.", normalizedError);
          (onError ?? null)?.(normalizedError);
        });
        return () => {
          if (listenerGeneration !== realtimeListenerGeneration) return;
          realtimeListenerGeneration += 1;
          realtimeSnapshotListener = null;
          realtimeErrorListener = null;
          if (_flags.atomicBootstrap) scheduleAuthenticatedBootstrapCancellation();
          else resetRealtimeAttempt();
        };
      }
      return appStateRemoteDataGateway.subscribeToAppData(onChange, onError);
    }
  };
  if (_flags.atomicBootstrap) {
    gateway.prepareAuthenticatedBootstrap = prepareAuthenticatedBootstrap;
    gateway.loadAuthenticatedAppDataSnapshot = loadAuthenticatedAppDataSnapshot;
    gateway.resetAuthenticatedBootstrapAttempt = resetAuthenticatedBootstrapAttempt;
    gateway.scheduleAuthenticatedBootstrapCancellation = scheduleAuthenticatedBootstrapCancellation;
  }
  if (_flags.rpcOperationalWrites) {
    gateway.commitOperationalMutation = (mutation) => invokeOperationalMutationRpc(mutation, {
      useV2: _flags.operationalRpcV2
    });
  }
  if (_flags.rpcFinancialWrites || _flags.financialRpcV2) {
    gateway.commitFinancialCheckout = (patch) => invokeFinancialCheckoutRpc(patch, { useV2: _flags.financialRpcV2 });
    gateway.commitFinancialAdjustment = (patch) => invokeFinancialAdjustmentRpc(patch, { useV2: _flags.financialRpcV2 });
  }
  gateway.commitAdminDataChange = (patch) => invokeAdminDataChangeRpc(patch);
  return gateway;
}
