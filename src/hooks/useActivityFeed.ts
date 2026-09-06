import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuditLog, User } from "../types";
import {
  buildLocalActivityEvents,
  loadActivityFeedPage,
  queryLocalActivityFeed,
  type ActivityEvent,
  type ActivityFeedCursor,
  type ActivityFeedFilters
} from "../dataGateway/activityFeed";

const EMPTY_ACTIVITY_FILTERS: ActivityFeedFilters = {};

export function useActivityFeed(params: {
  active: boolean;
  remoteEnabled: boolean;
  filters?: ActivityFeedFilters;
  pageSize: number;
  auditLogs: AuditLog[];
  users: User[];
  refreshKey?: string;
}) {
  const { active, remoteEnabled, pageSize, auditLogs, users, refreshKey = "" } = params;
  const filters = params.filters ?? EMPTY_ACTIVITY_FILTERS;
  const [items, setItems] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<ActivityFeedCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const localEvents = useMemo(() => buildLocalActivityEvents(auditLogs, users), [auditLogs, users]);

  const readPage = useCallback(async (nextCursor: ActivityFeedCursor | null) => {
    const query = { ...filters, limit: pageSize, cursor: nextCursor };
    return remoteEnabled ? loadActivityFeedPage(query) : queryLocalActivityFeed(localEvents, query);
  }, [filters, localEvents, pageSize, remoteEnabled]);

  const reload = useCallback(async () => {
    if (!active) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    setItems([]);
    setCursor(null);
    setHasMore(false);
    try {
      const page = await readPage(null);
      if (version !== requestVersion.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (readError) {
      if (version !== requestVersion.current) return;
      setError(readError instanceof Error ? readError.message : "Unable to load activity.");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [active, readPage]);

  const loadMore = useCallback(async () => {
    if (!active || !hasMore || !cursor || loadingMore) return;
    const version = requestVersion.current;
    setLoadingMore(true);
    setError("");
    try {
      const page = await readPage(cursor);
      if (version !== requestVersion.current) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (readError) {
      if (version !== requestVersion.current) return;
      setError(readError instanceof Error ? readError.message : "Unable to load more activity.");
    } finally {
      if (version === requestVersion.current) setLoadingMore(false);
    }
  }, [active, cursor, hasMore, loadingMore, readPage]);

  useEffect(() => {
    // The effect intentionally starts the server/local page read when its query becomes active.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    return () => {
      requestVersion.current += 1;
    };
  }, [reload, refreshKey]);

  return { items, hasMore, loading, loadingMore, error, reload, loadMore };
}
