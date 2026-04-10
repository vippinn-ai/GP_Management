import type { PricingRule, Session, SessionChargeSummary, SessionPauseLog } from "./types";
import { sumBy } from "./utils";

interface Interval {
  start: number;
  end: number;
}

function getMinuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function isRuleActiveAt(rule: PricingRule, minuteOfDay: number): boolean {
  if (rule.startMinute === rule.endMinute) {
    return true;
  }

  if (rule.startMinute < rule.endMinute) {
    return minuteOfDay >= rule.startMinute && minuteOfDay < rule.endMinute;
  }

  return minuteOfDay >= rule.startMinute || minuteOfDay < rule.endMinute;
}

function getRuleAt(rules: PricingRule[], date: Date): PricingRule | undefined {
  const minuteOfDay = getMinuteOfDay(date);
  return rules.find((rule) => isRuleActiveAt(rule, minuteOfDay));
}

function nextBoundaryAfter(date: Date, rules: PricingRule[]): Date {
  const candidates: Date[] = [];

  for (const rule of rules) {
    for (const boundaryMinute of [rule.startMinute, rule.endMinute]) {
      for (const dayOffset of [0, 1]) {
        const candidate = new Date(date);
        candidate.setSeconds(0, 0);
        candidate.setDate(candidate.getDate() + dayOffset);
        candidate.setHours(Math.floor(boundaryMinute / 60), boundaryMinute % 60, 0, 0);
        if (candidate.getTime() > date.getTime()) {
          candidates.push(candidate);
        }
      }
    }
  }

  candidates.sort((left, right) => left.getTime() - right.getTime());
  return candidates[0] ?? new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

function buildPauseIntervals(
  session: Session,
  pauseLogs: SessionPauseLog[],
  endTime: Date
): Interval[] {
  return pauseLogs
    .filter((entry) => entry.sessionId === session.id)
    .map((entry) => ({
      start: new Date(entry.pausedAt).getTime(),
      end: new Date(entry.resumedAt ?? endTime.toISOString()).getTime()
    }))
    .filter((entry) => entry.end > entry.start)
    .sort((left, right) => left.start - right.start);
}

function subtractIntervals(base: Interval, excludes: Interval[]): Interval[] {
  let remaining: Interval[] = [base];

  for (const exclude of excludes) {
    const next: Interval[] = [];
    for (const current of remaining) {
      if (exclude.end <= current.start || exclude.start >= current.end) {
        next.push(current);
        continue;
      }

      if (exclude.start > current.start) {
        next.push({ start: current.start, end: exclude.start });
      }

      if (exclude.end < current.end) {
        next.push({ start: exclude.end, end: current.end });
      }
    }
    remaining = next;
  }

  return remaining.filter((entry) => entry.end > entry.start);
}

export function calculateSessionCharge(
  session: Session,
  pauseLogs: SessionPauseLog[],
  effectiveEndAt?: string
): SessionChargeSummary {
  const startTime = new Date(session.startedAt);
  const endTime = new Date(effectiveEndAt ?? session.endedAt ?? new Date().toISOString());
  const pauseIntervals = buildPauseIntervals(session, pauseLogs, endTime);
  const payableIntervals = subtractIntervals(
    { start: startTime.getTime(), end: endTime.getTime() },
    pauseIntervals
  );
  const rules = session.pricingSnapshot;
  const segments: SessionChargeSummary["segments"] = [];

  for (const interval of payableIntervals) {
    let cursor = interval.start;
    while (cursor < interval.end) {
      const currentDate = new Date(cursor);
      const rule = getRuleAt(rules, currentDate);
      const boundary = nextBoundaryAfter(currentDate, rules).getTime();
      const segmentEnd = Math.min(interval.end, boundary);
      const durationMinutes = (segmentEnd - cursor) / 60000;
      const hourlyRate = rule?.hourlyRate ?? 0;
      const subtotal = (durationMinutes / 60) * hourlyRate;

      segments.push({
        label: rule?.label ?? "No rate",
        hourlyRate,
        minutes: durationMinutes,
        subtotal
      });

      cursor = segmentEnd;
    }
  }

  const subtotal = sumBy(segments, (segment) => segment.subtotal);
  const billedMinutes = sumBy(segments, (segment) => segment.minutes);
  const pauseMinutes = sumBy(pauseIntervals, (interval) => (interval.end - interval.start) / 60000);

  return {
    subtotal,
    billedHours: billedMinutes / 60,
    billedMinutes,
    pauseMinutes,
    segments
  };
}
