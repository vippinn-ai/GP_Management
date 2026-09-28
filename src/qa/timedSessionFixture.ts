import type { PricingRule } from "../types";

export interface FixturePricingRow {
  id: string;
  station_id: string;
  label: string;
  start_minute: number;
  end_minute: number;
  hourly_rate: number | string;
}

// Test-only pre-write guard; does not change application pricing.
export function timedFixturePricing(rows: FixturePricingRow[], stationId: string, startedAt: string, endedAt: string): PricingRule[] {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw Error("Invalid fixture time interval");
  if (!rows.length || new Set(rows.map(row => row.id)).size !== rows.length) throw Error("Missing or duplicate fixture pricing rules");
  const rules = rows.map(row => {
    const rate = Number(row.hourly_rate);
    if (!row.id || row.station_id !== stationId || !Number.isFinite(rate) || rate < 0
      || !Number.isInteger(row.start_minute) || row.start_minute < 0 || row.start_minute > 1439
      || !Number.isInteger(row.end_minute) || row.end_minute < 0 || row.end_minute > 1440) throw Error("Invalid fixture pricing rule");
    return { id: row.id, stationId, label: row.label, startMinute: row.start_minute, endMinute: row.end_minute, hourlyRate: rate };
  });
  const parts = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Calcutta", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(start);
  const minute = Number(parts.find(p => p.type === "hour")?.value) * 60 + Number(parts.find(p => p.type === "minute")?.value);
  const active = rules.filter(rule => rule.startMinute === rule.endMinute || (rule.startMinute < rule.endMinute
    ? minute >= rule.startMinute && minute < rule.endMinute
    : minute >= rule.startMinute || minute < rule.endMinute));
  if (active.length !== 1 || active[0].hourlyRate * (end.getTime() - start.getTime()) / 3_600_000 < 1) {
    throw Error("Fixture requires one positive billable start-time rate before any write");
  }
  return rules;
}
