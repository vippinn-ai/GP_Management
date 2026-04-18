export function LoadingOverlay(props: { label: string }) {
  return (
    <div className="loading-overlay" role="status" aria-live="polite" aria-label={props.label}>
      <div className="loading-overlay-card">
        <div className="loading-spinner" />
        <strong>{props.label}</strong>
        <span className="muted">Please wait while the request is being completed.</span>
      </div>
    </div>
  );
}
