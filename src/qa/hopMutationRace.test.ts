import { describe, expect, it } from "vitest";
import { capturedCompetingInstant, capturedItemId, exactItemDelta, validateCapturedHopEnd } from "./hopMutationRace";

describe("hop mutation race contract", () => {
  it("accepts an unedited full-precision hop end bounded by canonical, captured, and current instants", () => {
    const result = validateCapturedHopEnd({ capturedEnd: "2026-10-11T10:01:21.125Z", capturedAtMs: Date.parse("2026-10-11T10:01:21.200Z"), canonicalStartedAt: "2026-10-11T09:45:00Z", pauseLogs: [{ paused_at: "2026-10-11T09:50:10Z", resumed_at: "2026-10-11T09:52:20Z" }], competingInstantMs: Date.parse("2026-10-11T10:01:20Z") });
    expect(result.endMs).toBe(Date.parse("2026-10-11T10:01:21.125Z"));
    expect(result.endMs).toBeGreaterThanOrEqual(result.latestRequiredMs);
    expect(result.endMs).toBeLessThanOrEqual(result.capturedAtMs);
  });
  it("rejects malformed, too-early, and future captured hop ends", () => {
    const base = { capturedAtMs: Date.parse("2026-10-11T10:01:22Z"), canonicalStartedAt: "2026-10-11T09:45:00Z", pauseLogs: [{ paused_at: "2026-10-11T10:01:20Z", resumed_at: null }], competingInstantMs: null };
    expect(() => validateCapturedHopEnd({ ...base, capturedEnd: "bad" })).toThrow(/captured hop end/);
    expect(() => validateCapturedHopEnd({ ...base, capturedEnd: "2026-10-11T10:01:19Z" })).toThrow(/precedes/);
    expect(() => validateCapturedHopEnd({ ...base, capturedEnd: "2026-10-11T10:01:23Z" })).toThrow(/future/);
    expect(() => validateCapturedHopEnd({ ...base, capturedEnd: "2026-10-11T10:01:21Z", competingInstantMs: 1.5 })).toThrow(/competing/);
  });
  it("extracts captured timing, pause, and resume instants", () => { expect(capturedCompetingInstant("timing", { startedAt: "2026-10-11T09:48:00Z" })).toBe(Date.parse("2026-10-11T09:48:00Z")); expect(capturedCompetingInstant("pause", { pauseLog: { pausedAt: "2026-10-11T10:00:03Z" } })).toBe(Date.parse("2026-10-11T10:00:03Z")); expect(capturedCompetingInstant("resume", { resumedAt: "2026-10-11T10:01:04Z" })).toBe(Date.parse("2026-10-11T10:01:04Z")); });
  it("derives exact added and removed identities and rejects duplicates", () => { expect(exactItemDelta(["a"],["a","b"])).toEqual({added:["b"],removed:[]}); expect(exactItemDelta(["a","b"],["a"])).toEqual({added:[],removed:["b"]}); expect(() => exactItemDelta(["a","a"],[])).toThrow(/Duplicate/); });
  it("binds add and remove commands to exact item IDs", () => { expect(capturedItemId("add-item", { item: { id: "new" } })).toBe("new"); expect(capturedItemId("remove-item", { sessionItemId: "old" })).toBe("old"); expect(() => capturedItemId("add-item", {})).toThrow(/missing/); });
});
