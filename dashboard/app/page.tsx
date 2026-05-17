"use client";

import { useEffect, useState } from "react";
import { listCalls, getStats, type CallRow, type Stats } from "./lib/api";

export default function Home() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [c, s] = await Promise.all([listCalls(undefined, 25), getStats()]);
        if (cancelled) return;
        setCalls(c);
        setStats(s);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load");
        setLoading(false);
      }
    }
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main style={{ padding: 32, maxWidth: 1200, margin: "0 auto" }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 32,
        }}
      >
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
            Lasso
          </h1>
          <p style={{ color: "#666", margin: 0 }}>
            Recovered checkouts dashboard{" "}
            <span style={{ fontSize: 12, color: "#999", marginLeft: 8 }}>
              live · refreshes every 2s
            </span>
          </p>
        </div>
        <a
          href="/onboarding"
          style={{
            background: "#111",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          + Onboard a store
        </a>
      </header>

      {error && (
        <div
          style={{
            background: "#fef2f2",
            color: "#991b1b",
            border: "1px solid #fecaca",
            borderRadius: 8,
            padding: 12,
            fontSize: 13,
            marginBottom: 24,
          }}
        >
          {error}
        </div>
      )}

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 16,
          marginBottom: 32,
        }}
      >
        <Stat
          label="Recovered today"
          value={fmtMoney(stats?.recovered_cents_today)}
          sub={`${stats?.recovered_calls ?? 0} recovered all-time`}
        />
        <Stat
          label="Calls placed"
          value={String(stats?.calls_today ?? 0)}
          sub={`${stats?.total_calls ?? 0} all-time`}
        />
        <Stat
          label="Connect rate"
          value={
            stats && stats.total_calls > 0
              ? `${Math.round(stats.connect_rate * 100)}%`
              : "—"
          }
          sub={`${stats?.connected_calls ?? 0} of ${stats?.total_calls ?? 0}`}
        />
      </section>

      <section>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
          Recent calls
        </h2>
        {loading ? (
          <p style={{ color: "#999" }}>Loading…</p>
        ) : calls.length === 0 ? (
          <p style={{ color: "#999" }}>
            No calls yet.{" "}
            <a href="/onboarding" style={{ color: "#1d4ed8" }}>
              Onboard a store
            </a>{" "}
            to drop in the script tag and start recovering checkouts.
          </p>
        ) : (
          <CallsTable calls={calls} />
        )}
      </section>
    </main>
  );
}

function CallsTable({ calls }: { calls: CallRow[] }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#fafafa", textAlign: "left" }}>
            <Th>When</Th>
            <Th>Merchant</Th>
            <Th>Caller</Th>
            <Th>Cart</Th>
            <Th>Status</Th>
            <Th>Outcome</Th>
            <Th>Trigger</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id} style={{ borderTop: "1px solid #eee" }}>
              <Td>{fmtTime(c.created_at)}</Td>
              <Td>{c.merchant_id}</Td>
              <Td>
                {c.customer_name ? (
                  <>
                    <div style={{ fontWeight: 500 }}>{c.customer_name}</div>
                    <div style={{ color: "#999", fontSize: 12 }}>{c.phone}</div>
                  </>
                ) : (
                  c.phone
                )}
              </Td>
              <Td>
                <CartCell call={c} />
              </Td>
              <Td>
                <StatusPill status={c.status} />
              </Td>
              <Td>{c.outcome ? <OutcomePill outcome={c.outcome} /> : <span style={{ color: "#aaa" }}>—</span>}</Td>
              <Td><span style={{ color: "#666", fontSize: 12 }}>{c.trigger ?? "—"}</span></Td>
              <Td>
                <a href={`/calls/${c.id}`} style={{ color: "#1d4ed8", textDecoration: "none" }}>
                  view →
                </a>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CartCell({ call }: { call: CallRow }) {
  const lines = call.cart_lines ?? [];
  const item = lines[0];
  const total = call.cart_total_cents;
  return (
    <>
      <div>{item?.title ?? <span style={{ color: "#aaa" }}>—</span>}</div>
      {typeof total === "number" && (
        <div style={{ color: "#666", fontSize: 12 }}>{fmtMoney(total)}</div>
      )}
    </>
  );
}

function StatusPill({ status }: { status: CallRow["status"] }) {
  const colors: Record<CallRow["status"], { bg: string; fg: string }> = {
    preparing: { bg: "#f3f4f6", fg: "#374151" },
    ringing: { bg: "#fef3c7", fg: "#92400e" },
    connected: { bg: "#dbeafe", fg: "#1e40af" },
    completed: { bg: "#d1fae5", fg: "#065f46" },
    failed: { bg: "#fee2e2", fg: "#991b1b" },
    no_answer: { bg: "#f3f4f6", fg: "#6b7280" },
  };
  const c = colors[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function OutcomePill({ outcome }: { outcome: NonNullable<CallRow["outcome"]> }) {
  const colors: Record<NonNullable<CallRow["outcome"]>, { bg: string; fg: string }> = {
    recovered: { bg: "#d1fae5", fg: "#065f46" },
    declined: { bg: "#fee2e2", fg: "#991b1b" },
    unreachable: { bg: "#f3f4f6", fg: "#6b7280" },
    error: { bg: "#fef2f2", fg: "#991b1b" },
  };
  const c = colors[outcome];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {outcome}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#999", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th style={{ padding: "10px 12px", fontWeight: 600, color: "#555", fontSize: 12 }}>
      {children}
    </th>
  );
}

function Td({ children }: { children?: React.ReactNode }) {
  return <td style={{ padding: "10px 12px", verticalAlign: "top" }}>{children}</td>;
}

function fmtMoney(cents: number | null | undefined): string {
  if (!cents || cents <= 0) return "$0";
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
