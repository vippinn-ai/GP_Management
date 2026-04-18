export function MetricCard(props: { label: string; value: string; sub?: string }) {
  return (
    <div className="metric-card">
      <span className="muted">{props.label}</span>
      <strong>{props.value}</strong>
      {props.sub && <span className="muted metric-sub">{props.sub}</span>}
    </div>
  );
}

export function TodayMetricCard(props: { value: string; timeLabel: string; dateLabel: string }) {
  return (
    <div className="metric-card today-metric-card">
      <div className="today-metric-top">
        <span className="muted">Today</span>
        <span className="muted">{props.timeLabel}</span>
        <span className="muted">{props.dateLabel}</span>
      </div>
      <strong>{props.value}</strong>
    </div>
  );
}
