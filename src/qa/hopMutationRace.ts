export interface PauseInstant { paused_at: string; resumed_at: string | null }

export function validateRaceQueues(args: {
  origin: unknown; observer: unknown; status: number; rejectionCode: string | null;
  mutationId: string; mutationKind: string; sessionId: string;
}) {
  if (!Array.isArray(args.origin) || args.origin.length !== 0) throw new Error("Hop winner queue is not empty.");
  if (!Array.isArray(args.observer)) throw new Error("Observer queue is malformed.");
  if (args.status === 200) {
    if (args.observer.length !== 0) throw new Error("Successful competitor queue is not empty.");
    return [];
  }
  if (args.status !== 400 || args.rejectionCode !== "session_not_open") throw new Error("Unexpected competing outcome.");
  if (!args.mutationId || !args.mutationKind || !args.sessionId || args.observer.length !== 1) throw new Error("Expected exactly one identified losing-command conflict.");
  const entry = args.observer[0];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Malformed losing-command conflict.");
  const expected = { id: args.mutationId, kind: args.mutationKind, status: "conflict", entityType: "session", entityId: args.sessionId };
  for (const [key, value] of Object.entries(expected)) {
    if (entry[key] !== value) throw new Error(`Unexpected losing-command conflict ${key}.`);
  }
  return [expected];
}

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
