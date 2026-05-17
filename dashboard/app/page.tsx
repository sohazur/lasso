export default function Home() {
  return (
    <main style={{ padding: 32, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Lasso</h1>
      <p style={{ color: "#666", marginBottom: 32 }}>
        Recovered checkouts dashboard
      </p>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 32 }}>
        <Stat label="Recovered today" value="$0" />
        <Stat label="Calls placed" value="0" />
        <Stat label="Connect rate" value="—" />
      </section>

      <section>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Recent calls</h2>
        <p style={{ color: "#999" }}>No calls yet. Trigger one from the demo store.</p>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
