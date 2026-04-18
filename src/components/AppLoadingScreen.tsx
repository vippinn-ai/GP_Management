export function AppLoadingScreen() {
  return (
    <div className="skeleton-shell" role="status" aria-label="Loading">
      <div className="skeleton-sidebar">
        <div className="skeleton-block skeleton-logo" />
        <div className="skeleton-nav">
          <div className="skeleton-block skeleton-nav-item" />
          <div className="skeleton-block skeleton-nav-item" />
          <div className="skeleton-block skeleton-nav-item" />
          <div className="skeleton-block skeleton-nav-item" />
          <div className="skeleton-block skeleton-nav-item" />
        </div>
        <div className="skeleton-block skeleton-user-card" />
      </div>
      <div className="skeleton-content">
        <div className="skeleton-header">
          <div className="skeleton-block skeleton-title" />
          <div className="skeleton-block skeleton-subtitle" />
        </div>
        <div className="skeleton-cards">
          <div className="skeleton-block skeleton-card" />
          <div className="skeleton-block skeleton-card" />
          <div className="skeleton-block skeleton-card" />
          <div className="skeleton-block skeleton-card skeleton-card-tall" />
          <div className="skeleton-block skeleton-card skeleton-card-tall" />
        </div>
      </div>
    </div>
  );
}
