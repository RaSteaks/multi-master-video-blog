export default function Loading() {
  return (
    <main className="shell page-stack" aria-busy="true" aria-label="Loading content">
      <section className="intro">
        <div className="skeleton" style={{ width: 180, height: 14, marginBottom: 24 }} />
        <div className="skeleton" style={{ width: "70%", height: 52, marginBottom: 20 }} />
        <div className="skeleton" style={{ width: "100%", maxWidth: 600, height: 18 }} />
      </section>

      <section className="section-band">
        <div className="skeleton" style={{ width: 120, height: 22 }} />
        <div className="content-grid">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              className="content-card"
              key={i}
              style={{ pointerEvents: "none" }}
              aria-hidden="true"
            >
              <div
                className="skeleton"
                style={{ width: "100%", aspectRatio: "16 / 9", borderRadius: 0 }}
              />
              <div style={{ padding: 20 }}>
                <div className="skeleton" style={{ width: 90, height: 12, marginBottom: 12 }} />
                <div className="skeleton" style={{ width: "80%", height: 18, marginBottom: 8 }} />
                <div className="skeleton" style={{ width: "100%", height: 14 }} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
