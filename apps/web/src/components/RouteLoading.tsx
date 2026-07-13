type RouteLoadingVariant = "grid" | "article" | "player" | "form";

export function RouteLoading({ variant }: { variant: RouteLoadingVariant }) {
  return (
    <main
      className={`shell page-stack route-loading route-loading-${variant}`}
      aria-busy="true"
      aria-label="正在加载页面内容"
    >
      <header className="page-header route-loading-header">
        <span className="skeleton skeleton-line skeleton-line-short" />
        <span className="skeleton skeleton-title" />
        {variant !== "grid" ? (
          <span className="skeleton skeleton-line skeleton-line-wide" />
        ) : null}
      </header>

      {variant === "grid" ? <GridSkeleton /> : null}
      {variant === "article" ? <ArticleSkeleton /> : null}
      {variant === "player" ? <PlayerSkeleton /> : null}
      {variant === "form" ? <FormSkeleton /> : null}
    </main>
  );
}

function GridSkeleton() {
  return (
    <div className="content-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="content-card route-loading-card" key={index}>
          <span className="skeleton skeleton-media" />
          <div>
            <span className="skeleton skeleton-line skeleton-line-short" />
            <span className="skeleton skeleton-line skeleton-line-medium" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ArticleSkeleton() {
  return (
    <div className="content-glass route-loading-copy" aria-hidden="true">
      <span className="skeleton skeleton-media skeleton-hero" />
      {Array.from({ length: 5 }, (_, index) => (
        <span
          className={`skeleton skeleton-line ${index === 4 ? "skeleton-line-medium" : "skeleton-line-wide"}`}
          key={index}
        />
      ))}
    </div>
  );
}

function PlayerSkeleton() {
  return (
    <div className="route-loading-player" aria-hidden="true">
      <span className="skeleton skeleton-player" />
      <div className="route-loading-pills">
        <span className="skeleton" />
        <span className="skeleton" />
        <span className="skeleton" />
      </div>
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="content-glass route-loading-form" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index}>
          <span className="skeleton skeleton-line skeleton-line-short" />
          <span className="skeleton skeleton-field" />
        </div>
      ))}
    </div>
  );
}
