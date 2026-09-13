import { describe, expect, it } from "vitest";
import { sameJsonValue } from "./json-value-equality.mjs";

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
    expect(sameJsonValue({ order: ["a", "b"] }, { order: ["b", "a"] })).toBe(false);
  });
});
