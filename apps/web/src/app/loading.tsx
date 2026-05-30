export default function Loading() {
  return (
    <main className="shell page-stack" aria-busy="true" aria-label="Loading content">
      <section className="intro">
        <div
          style={{
            width: 180,
            height: 14,
            borderRadius: 4,
            background: "var(--surface-overlay)",
            marginBottom: 24,
          }}
        />
        <div
          style={{
            width: "70%",
            height: 52,
            borderRadius: 6,
            background: "var(--surface-overlay)",
            marginBottom: 20,
          }}
        />
        <div
          style={{
            width: "100%",
            maxWidth: 600,
            height: 18,
            borderRadius: 4,
            background: "var(--surface-overlay)",
          }}
        />
      </section>

      <section className="section-band">
        <div style={{ width: 120, height: 22, borderRadius: 4, background: "var(--surface-overlay)" }} />
        <div className="content-grid">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              className="content-card"
              key={i}
              style={{ pointerEvents: "none" }}
              aria-hidden="true"
            >
              <div
                style={{
                  width: "100%",
                  aspectRatio: "16 / 9",
                  background: "var(--surface-overlay)",
                }}
              />
              <div style={{ padding: 20 }}>
                <div
                  style={{
                    width: 90,
                    height: 12,
                    borderRadius: 3,
                    background: "var(--surface-overlay)",
                    marginBottom: 12,
                  }}
                />
                <div
                  style={{
                    width: "80%",
                    height: 18,
                    borderRadius: 4,
                    background: "var(--surface-overlay)",
                    marginBottom: 8,
                  }}
                />
                <div
                  style={{
                    width: "100%",
                    height: 14,
                    borderRadius: 3,
                    background: "var(--surface-overlay)",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
