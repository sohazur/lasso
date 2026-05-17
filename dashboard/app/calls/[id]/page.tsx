"use client";

import { useEffect, useState } from "react";
import { getCall, type CallRow } from "../../lib/api";

export default function CallDetail({ params }: { params: { id: string } }) {
  const [call, setCall] = useState<CallRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const c = await getCall(params.id);
        if (cancelled) return;
        setCall(c);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load");
      }
    }
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [params.id]);

  return (
    <main style={{ padding: 32, maxWidth: 800, margin: "0 auto", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <a href="/" style={{ color: "#666", textDecoration: "none", fontSize: 13 }}>
        ← Dashboard
      </a>

      {error && (
        <div
          style={{
            background: "#fef2f2",
            color: "#991b1b",
            border: "1px solid #fecaca",
            borderRadius: 8,
            padding: 12,
            fontSize: 13,
            margin: "16px 0",
          }}
        >
          {error}
        </div>
      )}

      {!call ? (
        <p style={{ color: "#999", marginTop: 24 }}>Loading…</p>
      ) : (
        <>
          <header style={{ marginTop: 12, marginBottom: 24 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: "8px 0 4px" }}>
              {call.customer_name ?? call.phone}
            </h1>
            <div style={{ color: "#666", fontSize: 13 }}>
              {call.merchant_id} · {call.trigger ?? "—"} · <code style={mono}>{call.id}</code>
            </div>
          </header>

          <section style={grid}>
            <Field label="Status" value={call.status} />
            <Field label="Outcome" value={call.outcome ?? "—"} />
            <Field
              label="Cart total"
              value={fmtMoney(call.cart_total_cents)}
            />
            <Field
              label="Recovered"
              value={fmtMoney(call.recovered_cents)}
            />
            <Field label="Phone" value={call.phone} />
            <Field label="Email" value={call.email ?? "—"} />
            <Field
              label="Duration"
              value={call.duration_secs ? `${call.duration_secs}s` : "—"}
            />
            <Field
              label="AgentPhone ID"
              value={<code style={mono}>{call.agentphone_call_id ?? "—"}</code>}
            />
            <Field label="Page URL" value={call.page_url ?? "—"} />
            <Field label="Started" value={call.created_at} />
            <Field label="Ended" value={call.ended_at ?? "—"} />
          </section>

          {call.cart_lines && call.cart_lines.length > 0 && (
            <section style={{ marginTop: 32 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Cart at abandonment</h2>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 14 }}>
                {call.cart_lines.map((line, i) => (
                  <li key={i} style={{ padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
                    {line.qty ?? 1}× {line.title ?? "(unknown)"}
                    {line.price_cents ? ` — ${fmtMoney(line.price_cents)}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section style={{ marginTop: 32 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Transcript</h2>
            {call.transcript ? (
              <pre style={transcript}>{call.transcript}</pre>
            ) : (
              <p style={{ color: "#999", fontSize: 13 }}>
                {call.status === "completed" || call.status === "failed"
                  ? "No transcript saved for this call."
                  : "Transcript will appear when the call ends."}
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: "#111", wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

function fmtMoney(cents: number | null | undefined): string {
  if (!cents || cents <= 0) return "$0";
  return `$${(cents / 100).toFixed(2)}`;
}

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 16,
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 16,
};

const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
  fontSize: 11,
  background: "#f3f4f6",
  padding: "1px 5px",
  borderRadius: 4,
};

const transcript: React.CSSProperties = {
  background: "#fafafa",
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 16,
  fontSize: 13,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
};
