import { describe, it, expect } from "vitest";
import { toBusinessDayKey, isToday, BUSINESS_DAY_START_HOUR, getReportRange } from "./utils";

// ─── toBusinessDayKey ─────────────────────────────────────────────────────────

describe("toBusinessDayKey", () => {
  it("exposes BUSINESS_DAY_START_HOUR = 7", () => {
    expect(BUSINESS_DAY_START_HOUR).toBe(7);
  });

  it("returns same calendar day for times at or after 7:00 AM", () => {
    // 7:00 AM Apr 20 → Apr 20
    expect(toBusinessDayKey(new Date(2025, 3, 20, 7, 0, 0))).toBe("2025-04-20");
    // Noon → same day
    expect(toBusinessDayKey(new Date(2025, 3, 20, 12, 0, 0))).toBe("2025-04-20");
    // 11:59 PM → same day
    expect(toBusinessDayKey(new Date(2025, 3, 20, 23, 59, 59))).toBe("2025-04-20");
  });

  it("rolls back to previous calendar day for times before 7:00 AM", () => {
    // Midnight → previous day
    expect(toBusinessDayKey(new Date(2025, 3, 20, 0, 0, 0))).toBe("2025-04-19");
    // 3:00 AM → previous day
    expect(toBusinessDayKey(new Date(2025, 3, 20, 3, 0, 0))).toBe("2025-04-19");
    // 6:59 AM → previous day (one minute before cutoff)
    expect(toBusinessDayKey(new Date(2025, 3, 20, 6, 59, 59))).toBe("2025-04-19");
  });

  it("handles month boundaries correctly", () => {
    // 2:00 AM Apr 1 → Mar 31 (rollback across month boundary)
    expect(toBusinessDayKey(new Date(2025, 3, 1, 2, 0, 0))).toBe("2025-03-31");
  });

  it("handles year boundaries correctly", () => {
    // 3:00 AM Jan 1 → Dec 31 previous year
    expect(toBusinessDayKey(new Date(2025, 0, 1, 3, 0, 0))).toBe("2024-12-31");
  });

  it("accepts an ISO string as well as a Date object", () => {
    // 3:00 AM Apr 20 as ISO string
    const iso = new Date(2025, 3, 20, 3, 0, 0).toISOString();
    expect(toBusinessDayKey(iso)).toBe("2025-04-19");
  });
});

// ─── isToday (business-day aware) ────────────────────────────────────────────

describe("isToday — business-day aware", () => {
  it("returns true for a timestamp in the current business day", () => {
    // Use a time well within today's business hours
    const midday = new Date();
    midday.setHours(14, 0, 0, 0);
    expect(isToday(midday.toISOString())).toBe(true);
  });

  it("returns false for a timestamp clearly in a past business day", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(14, 0, 0, 0);
    expect(isToday(yesterday.toISOString())).toBe(false);
  });
});

// ─── getReportRange — business-day anchor ─────────────────────────────────────

describe("getReportRange — business-day anchor", () => {
  it("anchors 'today' on the current business day (7 AM normal hour)", () => {
    // 10:00 AM Apr 20 → business day = Apr 20
    const now = new Date(2025, 3, 20, 10, 0, 0).toISOString();
    const range = getReportRange({ preset: "today" }, now);
    expect(range.from).toBe("2025-04-20");
    expect(range.to).toBe("2025-04-20");
  });

  it("anchors 'today' on the previous calendar day when before 7 AM", () => {
    // 3:00 AM Apr 20 → business day = Apr 19
    const now = new Date(2025, 3, 20, 3, 0, 0).toISOString();
    const range = getReportRange({ preset: "today" }, now);
    expect(range.from).toBe("2025-04-19");
    expect(range.to).toBe("2025-04-19");
  });

  it("anchors 'yesterday' relative to business day", () => {
    // 3:00 AM Apr 20 → business today = Apr 19, yesterday = Apr 18
    const now = new Date(2025, 3, 20, 3, 0, 0).toISOString();
    const range = getReportRange({ preset: "yesterday" }, now);
    expect(range.from).toBe("2025-04-18");
    expect(range.to).toBe("2025-04-18");
  });

  it("anchors 'last_7_days' relative to business day", () => {
    // 3:00 AM Apr 20 → business today = Apr 19, 7-day window = Apr 13 to Apr 19
    const now = new Date(2025, 3, 20, 3, 0, 0).toISOString();
    const range = getReportRange({ preset: "last_7_days" }, now);
    expect(range.from).toBe("2025-04-13");
    expect(range.to).toBe("2025-04-19");
  });

  it("anchors 'this_month' relative to business day at month boundary", () => {
    // 3:00 AM Apr 1 → business day = Mar 31 → this_month = March
    const now = new Date(2025, 3, 1, 3, 0, 0).toISOString();
    const range = getReportRange({ preset: "this_month" }, now);
    expect(range.from).toBe("2025-03-01");
    expect(range.to).toBe("2025-03-31");
  });

  it("'this_year' anchors on business year", () => {
    // 3:00 AM Jan 1 2025 → business day = Dec 31 2024 → this_year = 2024
    const now = new Date(2025, 0, 1, 3, 0, 0).toISOString();
    const range = getReportRange({ preset: "this_year" }, now);
    expect(range.from).toBe("2024-01-01");
    expect(range.to).toBe("2024-12-31");
  });
});
