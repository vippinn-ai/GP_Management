import type { ActivityEvent } from "../dataGateway/activityFeed";

const CATEGORY_LABELS: Record<ActivityEvent["category"], string> = {
  billing: "Billing",
  inventory: "Inventory",
  session: "Session",
  customer_tab: "Consumables tab",
  customer: "Customer",
  catalog: "Catalog",
  expense: "Expense",
  user: "User",
  settings: "Settings",
  other: "Other"
};

function formatActivityTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "Time unavailable";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

export function ActivityEventRow({ event, compact = false }: { event: ActivityEvent; compact?: boolean }) {
  const actorMeta = [event.actorRole?.toUpperCase(), event.actorUsername ? `@${event.actorUsername}` : ""]
    .filter(Boolean)
    .join(" · ");
  const technicalDetails = {
    action: event.action,
    entity_type: event.entityType,
    entity_id: event.entityId,
    mutation_id: event.mutationId,
    ...event.details
  };

  return (
    <article className={`activity-event ${compact ? "is-compact" : ""}`} data-activity-id={event.id}>
      <div className="activity-event-marker" aria-hidden="true" />
      <div className="activity-event-content">
        <div className="activity-event-topline">
          <span className={`activity-category is-${event.category}`}>{CATEGORY_LABELS[event.category]}</span>
          <time dateTime={event.occurredAt}>{formatActivityTimestamp(event.occurredAt)} IST</time>
        </div>
        <strong className="activity-event-summary">{event.summary}</strong>
        <div className="activity-event-attribution">
          <span><b>{event.actorName}</b>{actorMeta ? ` · ${actorMeta}` : ""}</span>
          {(event.entityLabel || event.entityId) && (
            <span>{event.entityLabel || event.entityId}</span>
          )}
          {event.legacy && <span className="activity-legacy-badge" title="Imported from the historical audit record">Historical</span>}
        </div>
        {!compact && (
          <details className="activity-technical-details">
            <summary>View record details</summary>
            <pre>{JSON.stringify(technicalDetails, null, 2)}</pre>
          </details>
        )}
      </div>
    </article>
  );
}
