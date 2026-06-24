import type { AppData } from "./types";

export const SYNC_TELEMETRY_STORAGE_KEY = "game-parlour-management-system/sync-telemetry/v1";
const MAX_STORED_SYNC_TELEMETRY_SAMPLES = 100;

export type SyncTelemetryEventType = "app_state_save" | "app_state_realtime_snapshot" | "compact_realtime_event";
export type SyncTelemetrySource = "blocking" | "operational_queue" | "auto_persist" | "realtime";
export type SyncTelemetryStatus = "success" | "conflict" | "error";

export interface AppDataCollectionCounts {
  users: number;
  inventoryCategories: number;
  stations: number;
  pricingRules: number;
  sessions: number;
  sessionPauseLogs: number;
  customers: number;
  customerTabs: number;
  inventoryItems: number;
  combos: number;
  stockMovements: number;
  bills: number;
  payments: number;
  auditLogs: number;
  expenses: number;
  expenseTemplates: number;
  expenseTemplateOverrides: number;
}

export interface SyncTelemetrySample {
  id: string;
  type: SyncTelemetryEventType;
  source: SyncTelemetrySource;
  createdAt: string;
  actionLabel?: string;
  payloadBytes: number;
  collectionCounts: AppDataCollectionCounts;
  expectedVersion?: number;
  nextVersion?: number;
  durationMs?: number;
  status?: SyncTelemetryStatus;
  errorMessage?: string;
  pendingOperationCount?: number;
  eventType?: string;
  entityType?: string;
  entityId?: string;
  refreshedSlices?: string[];
  skippedFullSnapshot?: boolean;
}

type AppDataCollectionKey = keyof AppDataCollectionCounts;

const appDataCollectionKeys: AppDataCollectionKey[] = [
  "users",
  "inventoryCategories",
  "stations",
  "pricingRules",
  "sessions",
  "sessionPauseLogs",
  "customers",
  "customerTabs",
  "inventoryItems",
  "combos",
  "stockMovements",
  "bills",
  "payments",
  "auditLogs",
  "expenses",
  "expenseTemplates",
  "expenseTemplateOverrides"
];

declare global {
  interface Window {
    __GP_SYNC_TELEMETRY__?: {
      getSamples: () => SyncTelemetrySample[];
      clear: () => void;
      storageKey: string;
    };
  }
}

function createTelemetryId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `sync-${crypto.randomUUID()}`;
  }
  return `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

export function estimateJsonBytes(value: unknown) {
  const json = safeStringify(value);
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(json).length;
  }
  return unescape(encodeURIComponent(json)).length;
}

export function getAppDataCollectionCounts(appData: Partial<AppData> | null | undefined): AppDataCollectionCounts {
  const source = (appData ?? {}) as Record<AppDataCollectionKey, unknown>;
  return appDataCollectionKeys.reduce((counts, key) => {
    const value = source[key];
    counts[key] = Array.isArray(value) ? value.length : 0;
    return counts;
  }, {} as AppDataCollectionCounts);
}

export function readStoredSyncTelemetrySamples(): SyncTelemetrySample[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(SYNC_TELEMETRY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as SyncTelemetrySample[];
    return Array.isArray(parsed) ? parsed.filter((sample) => sample.id && sample.type) : [];
  } catch {
    return [];
  }
}

export function clearStoredSyncTelemetrySamples() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(SYNC_TELEMETRY_STORAGE_KEY);
  } catch {
    // Best-effort diagnostics only.
  }
}

function ensureDebugApi() {
  if (typeof window === "undefined" || window.__GP_SYNC_TELEMETRY__) {
    return;
  }
  window.__GP_SYNC_TELEMETRY__ = {
    getSamples: readStoredSyncTelemetrySamples,
    clear: clearStoredSyncTelemetrySamples,
    storageKey: SYNC_TELEMETRY_STORAGE_KEY
  };
}

export function ensureSyncTelemetryDebugApi() {
  ensureDebugApi();
}

export function recordSyncTelemetrySample(sample: SyncTelemetrySample) {
  if (typeof window === "undefined") {
    return;
  }
  ensureDebugApi();
  try {
    const nextSamples = [sample, ...readStoredSyncTelemetrySamples()].slice(0, MAX_STORED_SYNC_TELEMETRY_SAMPLES);
    window.localStorage.setItem(SYNC_TELEMETRY_STORAGE_KEY, JSON.stringify(nextSamples));
  } catch {
    // Telemetry must never interrupt operator workflows.
  }
}

export function recordAppStateSaveTelemetry(params: {
  appData: Partial<AppData>;
  actionLabel?: string;
  source: Exclude<SyncTelemetrySource, "realtime">;
  expectedVersion: number;
  nextVersion?: number;
  startedAt: number;
  completedAt?: number;
  status: SyncTelemetryStatus;
  errorMessage?: string;
  pendingOperationCount?: number;
}) {
  const completedAt = params.completedAt ?? Date.now();
  recordSyncTelemetrySample({
    id: createTelemetryId(),
    type: "app_state_save",
    source: params.source,
    createdAt: new Date(completedAt).toISOString(),
    actionLabel: params.actionLabel,
    payloadBytes: estimateJsonBytes(params.appData),
    collectionCounts: getAppDataCollectionCounts(params.appData),
    expectedVersion: params.expectedVersion,
    nextVersion: params.nextVersion,
    durationMs: Math.max(0, completedAt - params.startedAt),
    status: params.status,
    errorMessage: params.errorMessage,
    pendingOperationCount: params.pendingOperationCount
  });
}

export function recordRealtimeSnapshotTelemetry(params: {
  appData: Partial<AppData> | null | undefined;
  version?: number | null;
}) {
  recordSyncTelemetrySample({
    id: createTelemetryId(),
    type: "app_state_realtime_snapshot",
    source: "realtime",
    createdAt: new Date().toISOString(),
    payloadBytes: estimateJsonBytes(params.appData ?? {}),
    collectionCounts: getAppDataCollectionCounts(params.appData),
    nextVersion: params.version ?? undefined,
    status: "success"
  });
}

export function recordCompactRealtimeTelemetry(params: {
  eventPayload: unknown;
  eventType: string;
  entityType: string;
  entityId: string;
  refreshedSlices: string[];
  startedAt: number;
  completedAt?: number;
  status: SyncTelemetryStatus;
  errorMessage?: string;
  skippedFullSnapshot: boolean;
}) {
  const completedAt = params.completedAt ?? Date.now();
  recordSyncTelemetrySample({
    id: createTelemetryId(),
    type: "compact_realtime_event",
    source: "realtime",
    createdAt: new Date(completedAt).toISOString(),
    payloadBytes: estimateJsonBytes(params.eventPayload),
    collectionCounts: getAppDataCollectionCounts({}),
    durationMs: Math.max(0, completedAt - params.startedAt),
    status: params.status,
    errorMessage: params.errorMessage,
    eventType: params.eventType,
    entityType: params.entityType,
    entityId: params.entityId,
    refreshedSlices: params.refreshedSlices,
    skippedFullSnapshot: params.skippedFullSnapshot
  });
}

ensureDebugApi();
