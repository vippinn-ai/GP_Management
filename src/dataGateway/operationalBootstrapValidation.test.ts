import { describe, expect, it } from "vitest";
import { validateOperationalBootstrapRow } from "./operationalBootstrapValidation";

const at = "2026-09-14T01:00:00.000Z";
const org = { organization_id: "org-primary" };
const raw = {};
const saleLine = {
  id: "line-1",
  inventory_item_id: "item-1",
  name: "Water",
  quantity: 1,
  unit_price: 20,
  added_at: at,
  sold_as_pack_of: null,
  sale_variant_id: null,
  stock_units_per_sale: null,
  combo_application_id: null,
  combo_id: null,
  raw_data: raw,
  created_at: at
};
const comboApplication = {
  id: "application-1",
  combo_id: "combo-1",
  combo_name: "Combo",
  price: 100,
  included_minutes: 60,
  applied_at: at,
  fixed_items: [],
  choices: [],
  raw_data: raw,
  created_at: at
};

const validRows: Record<string, Record<string, unknown>> = {
  profiles: {
    ...org, id: "user-1", name: "Admin", username: "admin", role: "admin", active: true, tabPermissions: []
  },
  inventory_categories: { ...org, name: "Drinks" },
  stations: {
    ...org, id: "station-1", name: "Pool", mode: "timed", active: true, ltp_enabled: false, notes: null, raw_data: raw
  },
  pricing_rules: {
    ...org, id: "rule-1", station_id: "station-1", label: "Standard", start_minute: 0,
    end_minute: 1440, hourly_rate: 100, raw_data: raw
  },
  inventory_items: {
    ...org, id: "item-1", name: "Water", category: "Drinks", price: 20, stock_qty: 10,
    low_stock_threshold: 2, unit: "bottle", is_reusable: false, barcode: null, active: true,
    archived_at: null, archived_by_user_id: null, archive_reason: null, sell_base_item: true,
    cigarette_pack: null, raw_data: raw
  },
  sale_variants: {
    ...org, inventory_item_id: "item-1", id: "variant-1", name: "Large", price: 30,
    stock_units_per_sale: 1, barcode: null, active: true, raw_data: raw
  },
  combos: {
    ...org, id: "combo-1", name: "Combo", type: "game", active: true, price: 100,
    included_minutes: 60, raw_data: raw, created_at: at, updated_at: at
  },
  combo_station_targets: { ...org, combo_id: "combo-1", station_id: "station-1" },
  combo_fixed_items: {
    ...org, combo_id: "combo-1", id: "fixed-1", sellable_option_id: "item-1",
    quantity: 1, raw_data: raw, created_at: at
  },
  combo_choice_groups: {
    ...org, combo_id: "combo-1", id: "group-1", label: "Drink", required_quantity: 1,
    raw_data: raw, created_at: at
  },
  combo_choice_options: {
    ...org, combo_id: "combo-1", choice_group_id: "group-1", option_id: "item-1"
  },
  sessions: {
    ...org, id: "session-1", station_id: "station-1", station_name_snapshot: "Pool", mode: "timed",
    started_at: at, ended_at: null, status: "active", customer_id: null, customer_name: null,
    customer_phone: null, play_mode: "group", ltp_eligible: false, ltp_outcome: null,
    ltp_discount_applied: null, pricing_snapshot: [], pause_log_ids: [], continued_from_session_ids: null,
    closed_bill_id: null, close_disposition: null, close_reason: null, raw_data: raw, created_at: at
  },
  session_pause_logs: {
    ...org, id: "pause-1", session_id: "session-1", paused_at: at, resumed_at: null, raw_data: raw, created_at: at
  },
  session_items: { ...org, session_id: "session-1", ...saleLine },
  session_combo_applications: { ...org, session_id: "session-1", ...comboApplication },
  customer_tabs: {
    ...org, id: "tab-1", customer_id: null, customer_name: "Walk-in", customer_phone: null,
    status: "open", opened_at: at, closed_at: null, continued_from_session_ids: null,
    closed_bill_id: null, close_disposition: null, close_reason: null, raw_data: raw, created_at: at
  },
  customer_tab_items: { ...org, customer_tab_id: "tab-1", ...saleLine },
  customer_tab_combo_applications: { ...org, customer_tab_id: "tab-1", ...comboApplication }
};

describe("operational bootstrap row value contracts", () => {
  it.each(Object.entries(validRows))("accepts the complete %s value contract", (key, row) => {
    expect(() => validateOperationalBootstrapRow(key, structuredClone(row), `${key}[0]`)).not.toThrow();
  });

  it.each([
    ["profiles", "active", "yes"],
    ["profiles", "tabPermissions", ["unknown-tab"]],
    ["inventory_categories", "name", 7],
    ["stations", "mode", "hourly"],
    ["pricing_rules", "hourly_rate", "100"],
    ["inventory_items", "stock_qty", "10"],
    ["sale_variants", "active", "true"],
    ["combos", "created_at", "not-a-time"],
    ["combo_station_targets", "station_id", null],
    ["combo_fixed_items", "quantity", 0],
    ["combo_choice_groups", "required_quantity", 1.5],
    ["combo_choice_options", "option_id", 12],
    ["sessions", "status", "unknown"],
    ["session_pause_logs", "resumed_at", "tomorrow-ish"],
    ["session_items", "quantity", "1"],
    ["session_combo_applications", "fixed_items", [{}]],
    ["customer_tabs", "status", "pending"],
    ["customer_tab_items", "unit_price", "20"],
    ["customer_tab_combo_applications", "choices", [{ groupId: "g", groupLabel: "G", selections: [{}] }]]
  ])("rejects malformed %s.%s values before mapping", (key, field, invalidValue) => {
    const row = structuredClone(validRows[key]);
    row[field] = invalidValue;
    expect(() => validateOperationalBootstrapRow(key, row, `${key}[0]`)).toThrow(
      new RegExp(`invalid ${key}\\[0\\]\\.${field}`, "i")
    );
  });

  it("rejects any non-empty compatibility data instead of accepting stale normalized overrides", () => {
    const row = structuredClone(validRows.sessions);
    row.raw_data = {
      status: "mystery",
      pricingSnapshot: [{
        id: "rule-1",
        stationId: "station-1",
        label: "Standard",
        startMinute: 0,
        endMinute: 1440,
        hourlyRate: 100
      }]
    };
    expect(() => validateOperationalBootstrapRow("sessions", row, "sessions[0]")).toThrow(
      /unexpected sessions\[0\]\.raw_data fields/i
    );
  });
});
