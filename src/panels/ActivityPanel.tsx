import { type FormEvent, useState } from "react";
import { ActivityEventRow } from "../components/ActivityEventRow";
import type { ActivityActorOption, ActivityCategory, ActivityEvent, ActivityFeedFilters } from "../dataGateway/activityFeed";

const CATEGORY_OPTIONS: Array<{ value: ActivityCategory; label: string }> = [
  { value: "billing", label: "Billing" },
  { value: "session", label: "Gaming sessions" },
  { value: "customer_tab", label: "Consumables tabs" },
  { value: "inventory", label: "Inventory" },
  { value: "customer", label: "Customers" },
  { value: "catalog", label: "Catalog and stations" },
  { value: "expense", label: "Expenses" },
  { value: "user", label: "Users" },
  { value: "settings", label: "Settings" },
  { value: "other", label: "Other" }
];

const ENTITY_OPTIONS = [
  ["bill", "Bill"],
  ["session", "Gaming session"],
  ["customer_tab", "Consumables tab"],
  ["inventory_item", "Inventory item"],
  ["stock_movement", "Stock movement"],
  ["customer", "Customer"],
  ["expense", "Expense"],
  ["station", "Station"],
  ["user", "User"]
] as const;

const EMPTY_FILTERS: ActivityFeedFilters = {};

export function ActivityPanel(props: {
  events: ActivityEvent[];
  actors: ActivityActorOption[];
  filters: ActivityFeedFilters;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  hasMore: boolean;
  remote: boolean;
  onApplyFilters: (filters: ActivityFeedFilters) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  const [draft, setDraft] = useState<ActivityFeedFilters>(props.filters);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onApplyFilters({
      search: draft.search?.trim() || undefined,
      actorUserId: draft.actorUserId || undefined,
      category: draft.category || undefined,
      entityType: draft.entityType || undefined,
      fromDate: draft.fromDate || undefined,
      toDate: draft.toDate || undefined,
      timeFrom: draft.timeFrom || undefined,
      timeTo: draft.timeTo || undefined
    });
  }

  return (
    <section className="panel activity-panel">
      <div className="panel-header activity-panel-header">
        <div>
          <span className="activity-eyebrow">Read-only operational ledger</span>
          <h2>Detailed Activity</h2>
          <p>
            {props.remote
              ? "New actions use the authenticated staff identity and server time. Imported history retains its source-recorded identity and time. All times are shown in IST."
              : "See the actions recorded in this browser and their local recorded time. All times are shown in IST."}
          </p>
        </div>
        <div className="activity-source-note">{props.remote ? "Server activity" : "Local activity"}</div>
      </div>

      <form className="activity-filter-grid" onSubmit={submit}>
        <label className="activity-search-field">
          <span>Search</span>
          <input
            type="search"
            value={draft.search ?? ""}
            placeholder="Customer, bill, action, session, item..."
            onChange={(event) => setDraft((current) => ({ ...current, search: event.target.value }))}
          />
        </label>
        <label>
          <span>Performed by</span>
          <select value={draft.actorUserId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, actorUserId: event.target.value }))}>
            <option value="">All users</option>
            {props.actors.map((actor) => (
              <option key={actor.userId} value={actor.userId}>
                {actor.name}{actor.role ? ` (${actor.role})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Category</span>
          <select value={draft.category ?? ""} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value as ActivityCategory | "" }))}>
            <option value="">All categories</option>
            {CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span>Record type</span>
          <select value={draft.entityType ?? ""} onChange={(event) => setDraft((current) => ({ ...current, entityType: event.target.value }))}>
            <option value="">All record types</option>
            {ENTITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>From date</span>
          <input type="date" value={draft.fromDate ?? ""} onChange={(event) => setDraft((current) => ({ ...current, fromDate: event.target.value }))} />
        </label>
        <label>
          <span>To date</span>
          <input type="date" value={draft.toDate ?? ""} onChange={(event) => setDraft((current) => ({ ...current, toDate: event.target.value }))} />
        </label>
        <label>
          <span>From time</span>
          <input type="time" value={draft.timeFrom ?? ""} onChange={(event) => setDraft((current) => ({ ...current, timeFrom: event.target.value }))} />
        </label>
        <label>
          <span>To time</span>
          <input type="time" value={draft.timeTo ?? ""} onChange={(event) => setDraft((current) => ({ ...current, timeTo: event.target.value }))} />
        </label>
        <div className="button-row activity-filter-actions">
          <button className="primary-button" type="submit">Apply filters</button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              props.onApplyFilters(EMPTY_FILTERS);
            }}
          >
            Clear
          </button>
          <button className="secondary-button" type="button" onClick={props.onRefresh} disabled={props.loading}>Refresh</button>
        </div>
      </form>

      {props.error && (
        <div className="activity-read-error" role="alert">
          <div><strong>Activity is temporarily unavailable.</strong><span>{props.error}</span></div>
          <button className="secondary-button" type="button" onClick={props.onRefresh}>Retry</button>
        </div>
      )}

      <div className="activity-results-header" aria-live="polite">
        <strong>{props.loading ? "Loading activity..." : `${props.events.length} activit${props.events.length === 1 ? "y" : "ies"} shown`}</strong>
        {!props.loading && props.hasMore && <span>More records are available</span>}
      </div>

      {!props.loading && !props.error && props.events.length === 0 && (
        <div className="empty-state">No recorded activity matches these filters.</div>
      )}

      {!props.error && (
        <div className="activity-timeline">
          {props.events.map((event) => <ActivityEventRow key={event.id} event={event} />)}
        </div>
      )}

      {props.hasMore && !props.error && (
        <div className="activity-load-more">
          <button className="secondary-button" type="button" onClick={props.onLoadMore} disabled={props.loadingMore}>
            {props.loadingMore ? "Loading..." : "Load more activity"}
          </button>
        </div>
      )}
    </section>
  );
}
