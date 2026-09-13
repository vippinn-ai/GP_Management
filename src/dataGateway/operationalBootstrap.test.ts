import { describe, expect, it } from "vitest";
import {
  buildOperationalBootstrapRpcResult,
  OPERATIONAL_BOOTSTRAP_CONTRACT_VERSION,
  OPERATIONAL_BOOTSTRAP_MAX_PAYLOAD_BYTES
} from "./normalizedReads";

const collectionKeys = [
  "inventory_categories",
  "stations",
  "pricing_rules",
  "inventory_items",
  "sale_variants",
  "combos",
  "combo_station_targets",
  "combo_fixed_items",
  "combo_choice_groups",
  "combo_choice_options",
  "sessions",
  "session_pause_logs",
  "session_items",
  "session_combo_applications",
  "customer_tabs",
  "customer_tab_items",
  "customer_tab_combo_applications"
] as const;

function activeEnvelope(): Record<string, unknown> {
  return {
    contract_version: OPERATIONAL_BOOTSTRAP_CONTRACT_VERSION,
    status: "active",
    actor_id: "user-1",
    organization_id: "org-primary",
    actor_profile: {
      id: "user-1",
      name: "Admin",
      username: "admin",
      role: "admin",
      active: true,
      tabPermissions: ["dashboard"]
    },
    organization: {
      id: "org-primary",
      name: "BreakPerfect",
      business_profile: { name: "BreakPerfect" }
    },
    app_state_metadata: {
      version: 42,
      updated_at: "2026-09-14T01:00:00.000Z"
    },
    profiles: [{
      organization_id: "org-primary",
      id: "user-1",
      name: "Admin",
      username: "admin",
      role: "admin",
      active: true,
      tabPermissions: ["dashboard"]
    }],
    ...Object.fromEntries(collectionKeys.map((key) => [key, []]))
  };
}

function cloneEnvelope(): Record<string, unknown> {
  return structuredClone(activeEnvelope());
}

describe("operational bootstrap RPC response mapping", () => {
  it("maps a complete active envelope through the existing normalized builders", () => {
    const result = buildOperationalBootstrapRpcResult(activeEnvelope());

    expect(result).toEqual({
      status: "active",
      actorId: "user-1",
      profile: {
        id: "user-1",
        name: "Admin",
        username: "admin",
        role: "admin",
        active: true,
        tabPermissions: ["dashboard"]
      },
      organization: {
        id: "org-primary",
        name: "BreakPerfect",
        businessProfile: { name: "BreakPerfect" }
      },
      version: 42,
      appData: expect.objectContaining({
        users: [expect.objectContaining({ id: "user-1", role: "admin" })],
        inventoryCategories: [],
        inventoryItems: [],
        combos: [],
        sessions: [],
        sessionPauseLogs: [],
        customerTabs: []
      })
    });
  });

  it("accepts only the minimal inactive response and never exposes application data", () => {
    expect(buildOperationalBootstrapRpcResult({
      contract_version: OPERATIONAL_BOOTSTRAP_CONTRACT_VERSION,
      status: "inactive-or-missing",
      actor_id: "user-1"
    })).toEqual({ status: "inactive-or-missing", actorId: "user-1" });

    expect(() => buildOperationalBootstrapRpcResult({
      contract_version: OPERATIONAL_BOOTSTRAP_CONTRACT_VERSION,
      status: "inactive-or-missing",
      actor_id: "user-1",
      sessions: []
    })).toThrow(/protected application data|unexpected/i);
  });

  it("rejects unsupported, partial, and extended envelopes", () => {
    const unsupported = cloneEnvelope();
    unsupported.contract_version = 2;
    expect(() => buildOperationalBootstrapRpcResult(unsupported)).toThrow(/unsupported contract version/i);

    const partial = cloneEnvelope();
    delete partial.sessions;
    expect(() => buildOperationalBootstrapRpcResult(partial)).toThrow(/sessions collection/i);

    const extended = cloneEnvelope();
    extended.bills = [];
    expect(() => buildOperationalBootstrapRpcResult(extended)).toThrow(/unexpected/i);
  });

  it("rejects actor divergence, duplicate identities, and cross-tenant rows", () => {
    const actorMismatch = cloneEnvelope();
    (actorMismatch.actor_profile as Record<string, unknown>).id = "user-2";
    expect(() => buildOperationalBootstrapRpcResult(actorMismatch)).toThrow(/actor identity/i);

    const duplicate = cloneEnvelope();
    duplicate.profiles = [
      ...(duplicate.profiles as unknown[]),
      structuredClone((duplicate.profiles as unknown[])[0])
    ];
    expect(() => buildOperationalBootstrapRpcResult(duplicate)).toThrow(/duplicate or missing profile identity/i);

    const actorCollectionMismatch = cloneEnvelope();
    ((actorCollectionMismatch.profiles as Array<Record<string, unknown>>)[0]).role = "manager";
    expect(() => buildOperationalBootstrapRpcResult(actorCollectionMismatch)).toThrow(/actor profile diverged/i);

    const crossTenant = cloneEnvelope();
    crossTenant.stations = [{
      organization_id: "org-other",
      id: "station-1",
      name: "Pool",
      mode: "timed",
      active: true,
      ltp_enabled: false,
      notes: null,
      raw_data: {}
    }];
    expect(() => buildOperationalBootstrapRpcResult(crossTenant)).toThrow(/cross-tenant stations/i);
  });

  it("rejects orphaned child rows", () => {
    const envelope = cloneEnvelope();
    envelope.combo_station_targets = [{
      organization_id: "org-primary",
      combo_id: "missing-combo",
      station_id: "station-1"
    }];
    expect(() => buildOperationalBootstrapRpcResult(envelope)).toThrow(/orphaned combo child/i);
  });

  it("rejects missing or extra fields inside normalized rows", () => {
    const missing = cloneEnvelope();
    missing.inventory_categories = [{ organization_id: "org-primary" }];
    expect(() => buildOperationalBootstrapRpcResult(missing)).toThrow(/malformed or unexpected inventory_categories/i);

    const extra = cloneEnvelope();
    extra.inventory_categories = [{ organization_id: "org-primary", name: "Snacks", secret: "unexpected" }];
    expect(() => buildOperationalBootstrapRpcResult(extra)).toThrow(/malformed or unexpected inventory_categories/i);
  });

  it("rejects payloads larger than the fixed decoded-byte budget", () => {
    const envelope = cloneEnvelope();
    (envelope.organization as Record<string, unknown>).business_profile = {
      oversized: "x".repeat(OPERATIONAL_BOOTSTRAP_MAX_PAYLOAD_BYTES)
    };
    expect(() => buildOperationalBootstrapRpcResult(envelope)).toThrow(/safe byte limit/i);
  });
});
