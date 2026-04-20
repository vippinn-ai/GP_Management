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
  // Rate is locked at session start time — no band-switching mid-session.
  const rules = session.pricingSnapshot;
  const startRule = getRuleAt(rules, startTime);
  const hourlyRate = startRule?.hourlyRate ?? 0;
  const rateLabel = startRule?.label ?? "No rate";

  const segments: SessionChargeSummary["segments"] = payableIntervals.map((interval) => {
    const durationMinutes = (interval.end - interval.start) / 60000;
    return {
      label: rateLabel,
      hourlyRate,
      minutes: durationMinutes,
      subtotal: (durationMinutes / 60) * hourlyRate
    };
  });

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
