export interface PauseInstant { paused_at: string; resumed_at: string | null }

function instant(value: unknown, label: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label} instant.`);
  return Date.parse(value);
}

export function capturedCompetingInstant(kind: "timing" | "pause" | "resume" | "add-item" | "remove-item", payload: Record<string, unknown>) {
  if (kind === "timing") return instant(payload.startedAt, "captured timing start");
  if (kind === "pause") {
    const pauseLog = payload.pauseLog as Record<string, unknown> | undefined;
    return instant(pauseLog?.pausedAt, "captured pause");
  }
  if (kind === "resume") return instant(payload.resumedAt, "captured resume");
  return null;
}

export function validateCapturedHopEnd(args: { capturedEnd: unknown; capturedAtMs: number; canonicalStartedAt: string; pauseLogs: PauseInstant[]; competingInstantMs: number | null }) {
  if (!Number.isInteger(args.capturedAtMs)) throw new Error("Invalid capture instant.");
  if (args.competingInstantMs !== null && !Number.isInteger(args.competingInstantMs)) throw new Error("Invalid competing instant.");
  const instants = [instant(args.canonicalStartedAt, "canonical start"), ...args.pauseLogs.flatMap((row) => [instant(row.paused_at, "pause start"), ...(row.resumed_at ? [instant(row.resumed_at, "pause resume")] : [])]), ...(args.competingInstantMs === null ? [] : [args.competingInstantMs])];
  const latest = Math.max(...instants);
  const endMs = instant(args.capturedEnd, "captured hop end");
  if (endMs < latest) throw new Error("Captured hop end precedes a canonical or competing instant.");
  if (endMs > args.capturedAtMs) throw new Error("Captured hop end is in the future.");
  return { endMs, latestRequiredMs: latest, capturedAtMs: args.capturedAtMs };
}

export function exactItemDelta(beforeIds: string[], afterIds: string[]) {
  if (new Set(beforeIds).size !== beforeIds.length || new Set(afterIds).size !== afterIds.length) throw new Error("Duplicate session item identity.");
  const before = new Set(beforeIds), after = new Set(afterIds);
  return { added: afterIds.filter((id) => !before.has(id)), removed: beforeIds.filter((id) => !after.has(id)) };
}

export function capturedItemId(kind: "add-item" | "remove-item", payload: Record<string, unknown>) {
  const value = kind === "add-item" ? (payload.item as Record<string, unknown> | undefined)?.id : payload.sessionItemId;
  if (typeof value !== "string" || !value) throw new Error(`Captured ${kind} item identity is missing.`);
  return value;
}
