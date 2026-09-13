import { describe, expect, it } from "vitest";
import { sameAppStateIdentity, sameJsonValue } from "./json-value-equality.mjs";

describe("sameJsonValue", () => {
  it("ignores object key insertion order at every depth", () => {
    const dataset = {
      pending_bills: 36,
      active_inventory_items: 112,
      nested: { second: 2, first: 1 }
    };
    const fixturePlan = {
      active_inventory_items: 112,
      nested: { first: 1, second: 2 },
      pending_bills: 36
    };

    expect(sameJsonValue(dataset, fixturePlan)).toBe(true);
  });

  it("still rejects changed values, types, and array order", () => {
    expect(sameJsonValue({ count: 1 }, { count: 2 })).toBe(false);
    expect(sameJsonValue({ count: 1 }, { count: "1" })).toBe(false);
    expect(sameJsonValue({ count: 1 }, {})).toBe(false);
    expect(sameJsonValue({ count: 1 }, { count: 1, extra: true })).toBe(false);
    expect(sameJsonValue({ value: null }, {})).toBe(false);
    expect(sameJsonValue({ order: ["a", "b"] }, { order: ["b", "a"] })).toBe(false);
  });
});

describe("sameAppStateIdentity", () => {
  const utcIdentity = {
    version: 735,
    md5: "c2f8145558f9f85a6513caa71c19b54e",
    bytes: 1045421,
    updated_at: "2026-09-12T22:20:24.748007+00:00",
    updated_by: "61cc2f83-69d1-46ab-9d89-9df7f7b1e497"
  };

  it("accepts the same timestamp instant with a different timezone offset", () => {
    expect(sameAppStateIdentity(utcIdentity, {
      ...utcIdentity,
      updated_at: "2026-09-13T03:50:24.748007+05:30"
    })).toBe(true);
  });

  it("rejects a different instant or any non-timestamp identity drift", () => {
    expect(sameAppStateIdentity(utcIdentity, { ...utcIdentity, updated_at: "2026-09-12T22:20:24.748008+00:00" })).toBe(false);
    expect(sameAppStateIdentity(utcIdentity, { ...utcIdentity, version: 736 })).toBe(false);
    expect(sameAppStateIdentity(utcIdentity, { ...utcIdentity, updated_at: "not-a-timestamp" })).toBe(false);
    expect(sameAppStateIdentity(utcIdentity, { ...utcIdentity, extra: true })).toBe(false);
    const { updated_at: _updatedAt, ...missingTimestamp } = utcIdentity;
    expect(sameAppStateIdentity(utcIdentity, missingTimestamp)).toBe(false);
  });
});
