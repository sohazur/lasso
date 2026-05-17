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
    <main className="lasso-shell" style={{ maxWidth: 1100 }}>
      <header
        className="lasso-header"
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ flex: 1 }}>
          <span className="lasso-eyebrow">Lasso</span>
          <h1 className="lasso-h1">Recovered checkouts</h1>
          <p className="lasso-sub">
            One script tag. Every abandoned cart gets a callback in under 60
            seconds.{" "}
            <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>
              · live, refreshes every 2s
            </span>
          </p>
        </div>
        <a href="/onboarding" className="btn btn-primary">
          + Onboard a store
        </a>
      </header>

      {error && <div className="lasso-error" style={{ marginBottom: 24 }}>{error}</div>}

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 16,
          marginBottom: 24,
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

      <section className="lasso-card" style={{ padding: 24 }}>
        <h2
          style={{
            fontSize: 18,
            fontWeight: 600,
            margin: "0 0 16px",
            letterSpacing: "-0.01em",
          }}
        >
          Recent calls
        </h2>
        {loading ? (
          <p style={{ color: "var(--ink-faint)", fontSize: 14, margin: 0 }}>
            Loading…
          </p>
        ) : calls.length === 0 ? (
          <p style={{ color: "var(--ink-muted)", fontSize: 14, margin: 0 }}>
            No calls yet.{" "}
            <a
              href="/onboarding"
              style={{ color: "var(--amber-deep)", textDecoration: "underline" }}
            >
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
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 16,
        overflow: "hidden",
        background: "#fff",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "rgba(247,244,237,0.6)", textAlign: "left" }}>
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
            <tr key={c.id} style={{ borderTop: "1px solid var(--border)" }}>
              <Td>{fmtTime(c.created_at)}</Td>
              <Td>
                <code className="lasso-chip">{c.merchant_id}</code>
              </Td>
              <Td>
                {c.customer_name ? (
                  <>
                    <div style={{ fontWeight: 500 }}>{c.customer_name}</div>
                    <div style={{ color: "var(--ink-faint)", fontSize: 12 }}>
                      {c.phone}
                    </div>
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
              <Td>
                {c.outcome ? (
                  <OutcomePill outcome={c.outcome} />
                ) : (
                  <span style={{ color: "var(--ink-faint)" }}>—</span>
                )}
              </Td>
              <Td>
                <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>
                  {c.trigger ?? "—"}
                </span>
              </Td>
              <Td>
                <a
                  href={`/calls/${c.id}`}
                  style={{
                    color: "var(--amber-deep)",
                    textDecoration: "none",
                    fontWeight: 500,
                  }}
                >
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
      <div>
        {item?.title ?? <span style={{ color: "var(--ink-faint)" }}>—</span>}
      </div>
      {typeof total === "number" && (
        <div style={{ color: "var(--ink-muted)", fontSize: 12 }}>
          {fmtMoney(total)}
        </div>
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
  return <Pill bg={c.bg} fg={c.fg}>{status.replace("_", " ")}</Pill>;
}

function OutcomePill({ outcome }: { outcome: NonNullable<CallRow["outcome"]> }) {
  const colors: Record<
    NonNullable<CallRow["outcome"]>,
    { bg: string; fg: string }
  > = {
    recovered: { bg: "#d1fae5", fg: "#065f46" },
    declined: { bg: "#fee2e2", fg: "#991b1b" },
    unreachable: { bg: "#f3f4f6", fg: "#6b7280" },
    error: { bg: "#fef2f2", fg: "#991b1b" },
  };
  const c = colors[outcome];
  return <Pill bg={c.bg} fg={c.fg}>{outcome}</Pill>;
}

function Pill({
  bg,
  fg,
  children,
}: {
  bg: string;
  fg: string;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 9px",
        borderRadius: 999,
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        padding: 20,
        borderRadius: 24,
        border: "1px solid var(--border)",
        background: "rgba(255, 255, 255, 0.85)",
        boxShadow: "var(--shadow-soft)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--ink-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-faint)",
            marginTop: 6,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "12px 14px",
        fontWeight: 600,
        color: "var(--ink-muted)",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.6,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children?: React.ReactNode }) {
  return (
    <td style={{ padding: "12px 14px", verticalAlign: "top" }}>{children}</td>
  );
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
