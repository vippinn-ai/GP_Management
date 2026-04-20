import { describe, it, expect } from "vitest";
import { calculateSessionCharge } from "./pricing";
import type { Session, PricingRule } from "./types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    stationId: "station-1",
    stationNameSnapshot: "PS5 Station",
    mode: "timed",
    status: "active",
    playMode: "group",
    ltpEligible: false,
    startedAt: "2025-06-15T10:00:00.000Z",
    endedAt: undefined,
    items: [],
    pricingSnapshot: [],
    pauseLogIds: [],
    customerId: undefined,
    customerName: undefined,
    customerPhone: undefined,
    closedBillId: undefined,
    closeDisposition: undefined,
    closeReason: undefined,
    ...overrides
  };
}

const flatRate: PricingRule = {
  id: "rule-flat",
  stationId: "station-1",
  label: "Standard Rate",
  hourlyRate: 120,
  startMinute: 0,
  endMinute: 0
};

const peakRate: PricingRule = {
  id: "rule-peak",
  stationId: "station-1",
  label: "Peak Rate",
  hourlyRate: 180,
  startMinute: 720,
  endMinute: 1200
};

// ─── Basic charge calculation ────────────────────────────────────────────────

describe("calculateSessionCharge — basic", () => {
  it("charges zero for a 0-minute session", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const result = calculateSessionCharge(session, [], "2025-06-15T10:00:00.000Z");
    expect(result.subtotal).toBe(0);
    expect(result.billedMinutes).toBe(0);
  });

  it("charges correctly for a 60-minute session at flat rate", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const result = calculateSessionCharge(session, [], "2025-06-15T11:00:00.000Z");
    expect(result.subtotal).toBeCloseTo(120);
    expect(result.billedMinutes).toBeCloseTo(60);
    expect(result.billedHours).toBeCloseTo(1);
  });

  it("charges correctly for a 30-minute session", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const result = calculateSessionCharge(session, [], "2025-06-15T10:30:00.000Z");
    expect(result.subtotal).toBeCloseTo(60);
    expect(result.billedMinutes).toBeCloseTo(30);
  });

  it("charges zero when no pricing rules are configured", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: []
    });
    const result = calculateSessionCharge(session, [], "2025-06-15T11:00:00.000Z");
    expect(result.subtotal).toBe(0);
    expect(result.segments[0].hourlyRate).toBe(0);
  });

  it("uses effectiveEndAt over session.endedAt", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      endedAt: "2025-06-15T12:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const result = calculateSessionCharge(session, [], "2025-06-15T11:00:00.000Z");
    expect(result.billedMinutes).toBeCloseTo(60);
  });
});

// ─── Pause deductions ────────────────────────────────────────────────────────

describe("calculateSessionCharge — pauses", () => {
  it("deducts a full pause interval from billed time", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const pauseLogs = [
      {
        id: "p1",
        sessionId: "s1",
        pausedAt: "2025-06-15T10:15:00.000Z",
        resumedAt: "2025-06-15T10:30:00.000Z"
      }
    ];
    const result = calculateSessionCharge(session, pauseLogs, "2025-06-15T11:00:00.000Z");
    expect(result.pauseMinutes).toBeCloseTo(15);
    expect(result.billedMinutes).toBeCloseTo(45);
    expect(result.subtotal).toBeCloseTo(90);
  });

  it("handles multiple pauses correctly", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const pauseLogs = [
      { id: "p1", sessionId: "s1", pausedAt: "2025-06-15T10:10:00.000Z", resumedAt: "2025-06-15T10:20:00.000Z" },
      { id: "p2", sessionId: "s1", pausedAt: "2025-06-15T10:40:00.000Z", resumedAt: "2025-06-15T10:50:00.000Z" }
    ];
    const result = calculateSessionCharge(session, pauseLogs, "2025-06-15T11:00:00.000Z");
    expect(result.pauseMinutes).toBeCloseTo(20);
    expect(result.billedMinutes).toBeCloseTo(40);
    expect(result.subtotal).toBeCloseTo(80);
  });

  it("ignores pause logs from other sessions", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const pauseLogs = [
      { id: "p1", sessionId: "other-session", pausedAt: "2025-06-15T10:15:00.000Z", resumedAt: "2025-06-15T10:30:00.000Z" }
    ];
    const result = calculateSessionCharge(session, pauseLogs, "2025-06-15T11:00:00.000Z");
    expect(result.pauseMinutes).toBe(0);
    expect(result.billedMinutes).toBeCloseTo(60);
  });

  it("handles an unresolved pause (still paused at end time)", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const pauseLogs = [
      { id: "p1", sessionId: "s1", pausedAt: "2025-06-15T10:30:00.000Z", resumedAt: undefined }
    ];
    const result = calculateSessionCharge(session, pauseLogs, "2025-06-15T11:00:00.000Z");
    expect(result.pauseMinutes).toBeCloseTo(30);
    expect(result.billedMinutes).toBeCloseTo(30);
  });

  it("clamps a pause that started before the session (overlap at start)", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    // pause started before session — subtractIntervals only clips the payable interval
    const pauseLogs = [
      { id: "p1", sessionId: "s1", pausedAt: "2025-06-15T09:30:00.000Z", resumedAt: "2025-06-15T10:30:00.000Z" }
    ];
    const result = calculateSessionCharge(session, pauseLogs, "2025-06-15T11:00:00.000Z");
    // Only the overlap [10:00–10:30] is within the payable interval, so 30 min paused, 30 min billed
    expect(result.billedMinutes).toBeCloseTo(30);
    expect(result.subtotal).toBeCloseTo(60);
  });

  it("produces zero billed time when the entire session is paused", () => {
    const session = makeSession({
      startedAt: "2025-06-15T10:00:00.000Z",
      pricingSnapshot: [flatRate]
    });
    const pauseLogs = [
      { id: "p1", sessionId: "s1", pausedAt: "2025-06-15T10:00:00.000Z", resumedAt: "2025-06-15T11:00:00.000Z" }
    ];
    const result = calculateSessionCharge(session, pauseLogs, "2025-06-15T11:00:00.000Z");
    expect(result.billedMinutes).toBeCloseTo(0);
    expect(result.subtotal).toBeCloseTo(0);
  });
});

// ─── Pricing rule boundaries ─────────────────────────────────────────────────

describe("calculateSessionCharge — pricing rule boundaries", () => {
  it("bills entire session at the rate active at session start, ignoring later band transitions", () => {
    // peakRate: minute 720 (12:00) to 1200 (20:00). flatRate: always active (start===end===0).
    const start = new Date(2025, 5, 15, 11, 30, 0).toISOString(); // 11:30 local → flatRate active
    const end = new Date(2025, 5, 15, 12, 30, 0).toISOString();   // 12:30 local → peakRate would normally start at 12:00
    const session = makeSession({ startedAt: start, pricingSnapshot: [peakRate, flatRate] });
    // Session starts in flatRate band (11:30) → all 60 min billed at 120/hr = 120
    const result = calculateSessionCharge(session, [], end);
    expect(result.subtotal).toBeCloseTo(120);
    expect(result.billedMinutes).toBeCloseTo(60);
    expect(result.segments.every((s) => s.label === "Standard Rate")).toBe(true);
  });

  it("bills entire session at peak rate when started during peak hours, even after peak ends", () => {
    // Session starts at 14:00 (peakRate active), ends at 21:00 (after peakRate ends at 20:00)
    const start = new Date(2025, 5, 15, 14, 0, 0).toISOString();
    const end   = new Date(2025, 5, 15, 21, 0, 0).toISOString();
    const session = makeSession({ startedAt: start, pricingSnapshot: [peakRate, flatRate] });
    // 420 min at 180/hr = 1260
    const result = calculateSessionCharge(session, [], end);
    expect(result.subtotal).toBeCloseTo(1260);
    expect(result.billedMinutes).toBeCloseTo(420);
    expect(result.segments.every((s) => s.label === "Peak Rate")).toBe(true);
  });
});
