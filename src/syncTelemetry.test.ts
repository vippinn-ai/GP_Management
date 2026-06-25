import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStoredSyncTelemetrySamples,
  estimateJsonBytes,
  getAppDataCollectionCounts,
  readStoredSyncTelemetrySamples,
  recordAppStateSaveTelemetry,
  recordCompactRealtimeTelemetry,
  recordRealtimeSnapshotTelemetry,
  recordStartupBootstrapTelemetry,
  SYNC_TELEMETRY_STORAGE_KEY
} from "./syncTelemetry";

describe("sync telemetry", () => {
  beforeEach(() => {
    clearStoredSyncTelemetrySamples();
  });

  it("initializes the debug API before the first sample is recorded", () => {
    expect(window.__GP_SYNC_TELEMETRY__?.storageKey).toBe(SYNC_TELEMETRY_STORAGE_KEY);
  });

  it("estimates utf-8 JSON byte size", () => {
    expect(estimateJsonBytes({ value: "₹" })).toBe(new TextEncoder().encode(JSON.stringify({ value: "₹" })).length);
  });

  it("counts AppData top-level collections", () => {
    const counts = getAppDataCollectionCounts({
      sessions: [{ id: "s1" }, { id: "s2" }],
      bills: [{ id: "b1" }],
      inventoryItems: undefined
    } as never);

    expect(counts.sessions).toBe(2);
    expect(counts.bills).toBe(1);
    expect(counts.inventoryItems).toBe(0);
    expect(counts.auditLogs).toBe(0);
  });

  it("stores app-state save samples without throwing", () => {
    recordAppStateSaveTelemetry({
      appData: { sessions: [{ id: "s1" }], bills: [{ id: "b1" }] } as never,
      actionLabel: "Adding item...",
      source: "operational_queue",
      expectedVersion: 4,
      nextVersion: 5,
      startedAt: 1_000,
      completedAt: 1_125,
      status: "success",
      pendingOperationCount: 2
    });

    const [sample] = readStoredSyncTelemetrySamples();
    expect(sample).toMatchObject({
      type: "app_state_save",
      source: "operational_queue",
      actionLabel: "Adding item...",
      expectedVersion: 4,
      nextVersion: 5,
      durationMs: 125,
      status: "success",
      pendingOperationCount: 2
    });
    expect(sample.payloadBytes).toBeGreaterThan(0);
    expect(sample.collectionCounts.sessions).toBe(1);
    expect(window.__GP_SYNC_TELEMETRY__?.storageKey).toBe(SYNC_TELEMETRY_STORAGE_KEY);
  });

  it("stores realtime snapshot samples", () => {
    recordRealtimeSnapshotTelemetry({
      appData: { customerTabs: [{ id: "tab-1" }], payments: [{ id: "pay-1" }] } as never,
      version: 9
    });

    const [sample] = readStoredSyncTelemetrySamples();
    expect(sample).toMatchObject({
      type: "app_state_realtime_snapshot",
      source: "realtime",
      nextVersion: 9,
      status: "success"
    });
    expect(sample.collectionCounts.customerTabs).toBe(1);
    expect(sample.collectionCounts.payments).toBe(1);
  });

  it("stores compact realtime event samples", () => {
    recordCompactRealtimeTelemetry({
      eventPayload: { event_type: "add_customer_tab_item", entity_id: "tab-1" },
      eventType: "add_customer_tab_item",
      entityType: "customer_tab",
      entityId: "tab-1",
      refreshedSlices: ["live"],
      startedAt: 2_000,
      completedAt: 2_060,
      status: "success",
      skippedFullSnapshot: true
    });

    const [sample] = readStoredSyncTelemetrySamples();
    expect(sample).toMatchObject({
      type: "compact_realtime_event",
      source: "realtime",
      eventType: "add_customer_tab_item",
      entityType: "customer_tab",
      entityId: "tab-1",
      refreshedSlices: ["live"],
      durationMs: 60,
      skippedFullSnapshot: true
    });
    expect(sample.payloadBytes).toBeGreaterThan(0);
  });

  it("stores normalized startup bootstrap samples", () => {
    recordStartupBootstrapTelemetry({
      appData: { users: [{ id: "user-1" }], inventoryItems: [{ id: "item-1" }] } as never,
      source: "normalized_bootstrap",
      version: 44,
      startedAt: 3_000,
      completedAt: 3_140,
      status: "success",
      skippedFullAppStateData: true
    });

    const [sample] = readStoredSyncTelemetrySamples();
    expect(sample).toMatchObject({
      type: "startup_bootstrap",
      source: "blocking",
      actionLabel: "Normalized startup bootstrap",
      bootstrapSource: "normalized_bootstrap",
      skippedFullAppStateData: true,
      skippedFullSnapshot: true,
      nextVersion: 44,
      durationMs: 140,
      status: "success"
    });
    expect(sample.collectionCounts.users).toBe(1);
    expect(sample.collectionCounts.inventoryItems).toBe(1);
  });

  it("keeps only the most recent telemetry samples", () => {
    for (let index = 0; index < 105; index += 1) {
      recordRealtimeSnapshotTelemetry({ appData: { bills: [{ id: `bill-${index}` }] } as never, version: index });
    }

    const samples = readStoredSyncTelemetrySamples();
    expect(samples).toHaveLength(100);
    expect(samples[0]?.nextVersion).toBe(104);
    expect(samples.at(-1)?.nextVersion).toBe(5);
  });
});
