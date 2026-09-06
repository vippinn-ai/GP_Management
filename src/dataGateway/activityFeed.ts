import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../backend";
import type { AuditLog, User } from "../types";
import { resolveNormalizedOrganizationId } from "./normalizedOrganization";

const ACTIVITY_FEED_RPC_NAME = "list_activity_events";
const ACTIVITY_FEED_TIMEOUT_MS = 15_000;
const ACTIVITY_CATEGORIES = new Set([
  "billing", "inventory", "session", "customer_tab", "customer",
  "catalog", "expense", "user", "settings", "other"
]);

export type ActivityCategory =
  | "billing"
  | "inventory"
  | "session"
  | "customer_tab"
  | "customer"
  | "catalog"
  | "expense"
  | "user"
  | "settings"
  | "other";

export interface ActivityEvent {
  id: string;
  occurredAt: string;
  actorUserId?: string;
  actorName: string;
  actorUsername?: string;
  actorRole?: string;
  action: string;
  category: ActivityCategory;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  summary: string;
  details: Record<string, unknown>;
  mutationId?: string;
  sourceKind: "audit_log" | "operational_event";
  legacy: boolean;
}

export interface ActivityActorOption {
  userId: string;
  name: string;
  username?: string;
  role?: string;
}

export interface ActivityFeedFilters {
  search?: string;
  actorUserId?: string;
  category?: ActivityCategory | "";
  entityType?: string;
  fromDate?: string;
  toDate?: string;
  timeFrom?: string;
  timeTo?: string;
}

export interface ActivityFeedCursor {
  occurredAt: string;
  id: string;
}

export interface ActivityFeedPage {
  items: ActivityEvent[];
  actors: ActivityActorOption[];
  hasMore: boolean;
  nextCursor: ActivityFeedCursor | null;
}

interface ActivityFeedQuery extends ActivityFeedFilters {
  organizationId?: string;
  limit?: number;
  cursor?: ActivityFeedCursor | null;
}

interface RpcResult<T> {
  data: T | null;
  error: Error | { message: string } | null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toOptionalString(value: unknown): string | undefined {
  const result = toStringValue(value).trim();
  return result || undefined;
}

function toBooleanValue(value: unknown): boolean {
  return value === true || value === "true";
}

export function inferActivityCategory(action: string, entityType?: string): ActivityCategory {
  const value = `${action} ${entityType ?? ""}`.toLowerCase();
  if (/(bill|payment|settle|discount|refund|void|checkout)/.test(value)) return "billing";
  if (/(inventory|stock|item|variant)/.test(value)) return "inventory";
  if (/(session|pause|resume|hop|game)/.test(value)) return "session";
  if (/(customer_tab|consumables_tab|tab_)/.test(value)) return "customer_tab";
  if (/customer/.test(value)) return "customer";
  if (/(combo|catalog|pricing|station)/.test(value)) return "catalog";
  if (/expense/.test(value)) return "expense";
  if (/(user|profile|password)/.test(value)) return "user";
  if (/(setting|business_profile)/.test(value)) return "settings";
  return "other";
}

export function mapActivityEvent(value: unknown): ActivityEvent {
  const row = toRecord(value);
  const sourceKind = row.source_kind === "operational_event" ? "operational_event" : "audit_log";
  const categoryValue = toStringValue(row.category, "other");
  const category = (ACTIVITY_CATEGORIES.has(categoryValue) ? categoryValue : "other") as ActivityCategory;
  return {
    id: toStringValue(row.id),
    occurredAt: toStringValue(row.occurred_at),
    actorUserId: toOptionalString(row.actor_user_id),
    actorName: toStringValue(row.actor_name, "Unknown user"),
    actorUsername: toOptionalString(row.actor_username),
    actorRole: toOptionalString(row.actor_role),
    action: toStringValue(row.action, "activity"),
    category,
    entityType: toOptionalString(row.entity_type),
    entityId: toOptionalString(row.entity_id),
    entityLabel: toOptionalString(row.entity_label),
    summary: toStringValue(row.summary, "Activity recorded"),
    details: toRecord(row.details),
    mutationId: toOptionalString(row.mutation_id),
    sourceKind,
    legacy: toBooleanValue(row.legacy)
  };
}

export function mapActivityFeedPage(value: unknown): ActivityFeedPage {
  const root = toRecord(value);
  const cursor = toRecord(root.next_cursor);
  const nextCursor = toOptionalString(cursor.occurred_at) && toOptionalString(cursor.id)
    ? { occurredAt: toStringValue(cursor.occurred_at), id: toStringValue(cursor.id) }
    : null;
  return {
    items: (Array.isArray(root.items) ? root.items : []).map(mapActivityEvent),
    actors: (Array.isArray(root.actors) ? root.actors : []).flatMap((value) => {
      const actor = toRecord(value);
      const userId = toOptionalString(actor.user_id);
      if (!userId) return [];
      return [{
        userId,
        name: toStringValue(actor.name, "Unknown user"),
        username: toOptionalString(actor.username),
        role: toOptionalString(actor.role)
      }];
    }),
    hasMore: toBooleanValue(root.has_more),
    nextCursor
  };
}

async function withActivityFeedTimeout<T>(request: PromiseLike<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Unable to reach the activity feed.")), ACTIVITY_FEED_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function loadActivityFeedPage(
  query: ActivityFeedQuery,
  client: SupabaseClient = getSupabaseClient()
): Promise<ActivityFeedPage> {
  const organizationId = query.organizationId ?? await resolveNormalizedOrganizationId(client);
  const payload = {
    organization_id: organizationId,
    limit: Math.min(Math.max(query.limit ?? 50, 1), 100),
    search: query.search?.trim() || null,
    actor_user_id: query.actorUserId || null,
    category: query.category || null,
    entity_type: query.entityType?.trim() || null,
    from_date: query.fromDate || null,
    to_date: query.toDate || null,
    time_from: query.timeFrom || null,
    time_to: query.timeTo || null,
    cursor_at: query.cursor?.occurredAt ?? null,
    cursor_id: query.cursor?.id ?? null
  };
  const result = await withActivityFeedTimeout(
    client.rpc(ACTIVITY_FEED_RPC_NAME, { payload }) as unknown as PromiseLike<RpcResult<unknown>>
  );
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error(result.error.message);
  }
  return mapActivityFeedPage(result.data);
}

export function buildLocalActivityEvents(auditLogs: AuditLog[], users: User[]): ActivityEvent[] {
  const usersById = new Map(users.map((user) => [user.id, user]));
  return auditLogs
    .map((entry): ActivityEvent => {
      const actor = usersById.get(entry.userId);
      return {
        id: entry.id,
        occurredAt: entry.createdAt,
        actorUserId: entry.userId,
        actorName: actor?.name ?? "Unknown user",
        actorUsername: actor?.username,
        actorRole: actor?.role,
        action: entry.action,
        category: inferActivityCategory(entry.action, entry.entityType),
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.message,
        details: { source: "local_audit_log", audit_id: entry.id },
        sourceKind: "audit_log",
        legacy: false
      };
    })
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
}

function isLocalTimeInRange(isoValue: string, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(isoValue));
  const time = `${parts.find((part) => part.type === "hour")?.value ?? "00"}:${parts.find((part) => part.type === "minute")?.value ?? "00"}`;
  if (from && to && from > to) {
    return time >= from || time <= to;
  }
  return (!from || time >= from) && (!to || time <= to);
}

export function queryLocalActivityFeed(
  activityEvents: ActivityEvent[],
  query: ActivityFeedQuery
): ActivityFeedPage {
  const search = query.search?.trim().toLowerCase();
  const filtered = activityEvents.filter((entry) => {
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(entry.occurredAt));
    const matchesSearch = !search || [
      entry.summary,
      entry.actorName,
      entry.actorUsername,
      entry.action,
      entry.entityLabel,
      entry.entityId
    ].some((value) => value?.toLowerCase().includes(search));
    return matchesSearch
      && (!query.actorUserId || entry.actorUserId === query.actorUserId)
      && (!query.category || entry.category === query.category)
      && (!query.entityType || entry.entityType === query.entityType)
      && (!query.fromDate || localDate >= query.fromDate)
      && (!query.toDate || localDate <= query.toDate)
      && isLocalTimeInRange(entry.occurredAt, query.timeFrom, query.timeTo);
  });
  const cursorIndex = query.cursor
    ? filtered.findIndex((entry) => entry.id === query.cursor?.id && entry.occurredAt === query.cursor.occurredAt)
    : -1;
  if (query.cursor && cursorIndex < 0) {
    return {
      items: [],
      actors: [],
      hasMore: false,
      nextCursor: null
    };
  }
  const start = cursorIndex + 1;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const items = filtered.slice(start, start + limit);
  const hasMore = start + limit < filtered.length;
  const tail = items.at(-1);
  const actors = Array.from(new Map(activityEvents.flatMap((entry) => entry.actorUserId ? [[entry.actorUserId, {
    userId: entry.actorUserId,
    name: entry.actorName,
    username: entry.actorUsername,
    role: entry.actorRole
  }] as const] : [])).values())
    .sort((left, right) => left.name.localeCompare(right.name) || left.userId.localeCompare(right.userId));
  return {
    items,
    actors,
    hasMore,
    nextCursor: hasMore && tail ? { occurredAt: tail.occurredAt, id: tail.id } : null
  };
}
