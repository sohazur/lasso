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
        const [c, s] = await Promise.all([listCalls(undefined, 50), getStats()]);
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
    <main className="lasso-shell dashboard">
      <header
        className="lasso-header"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}
      >
        <div style={{ flex: 1 }}>
          <span className="lasso-eyebrow">Recovered checkouts</span>
          <h1 className="lasso-h1">Live call log</h1>
          <p className="lasso-sub">
            One script tag, voice agent calls back within 60 seconds of an
            abandoned checkout.{" "}
            <span className="lasso-live">
              <span className="lasso-dot" />
              live · refreshing every 2 s
            </span>
          </p>
        </div>
        <a href="/onboarding" className="btn btn-primary">
          + Onboard a store
        </a>
      </header>

      {error && <div className="lasso-error">{error}</div>}

      <section className="lasso-stats">
        <Stat
          label="Recovered today"
          value={fmtMoney(stats?.recovered_cents_today)}
          sub={`${stats?.recovered_calls ?? 0} recovered all-time`}
        />
        <Stat
          label="Calls today"
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
          sub={`${stats?.connected_calls ?? 0} of ${stats?.total_calls ?? 0} connected`}
        />
      </section>

      <section className="lasso-card" style={{ padding: 28 }}>
        <h2 className="lasso-section-title">Recent calls</h2>
        {loading ? (
          <p className="lasso-empty">Loading…</p>
        ) : calls.length === 0 ? (
          <p className="lasso-empty">
            No calls yet.{" "}
            <a href="/onboarding">Onboard a store</a> to start recovering checkouts.
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
    <div className="lasso-table-wrap">
      <table className="lasso-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Merchant</th>
            <th>Caller</th>
            <th>Cart</th>
            <th>Status</th>
            <th>Outcome</th>
            <th>Trigger</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td>{fmtTime(c.created_at)}</td>
              <td>
                <code className="lasso-chip">{c.merchant_id}</code>
              </td>
              <td>
                {c.customer_name ? (
                  <>
                    <div className="lasso-caller-name">{c.customer_name}</div>
                    <div className="lasso-caller-phone">{c.phone}</div>
                  </>
                ) : (
                  <span className="lasso-caller-phone">{c.phone}</span>
                )}
              </td>
              <td>
                <CartCell call={c} />
              </td>
              <td>
                <StatusPill status={c.status} />
              </td>
              <td>
                {c.outcome ? (
                  <OutcomePill outcome={c.outcome} />
                ) : (
                  <span style={{ color: "var(--ink-faint)" }}>—</span>
                )}
              </td>
              <td>
                <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>
                  {c.trigger ?? "—"}
                </span>
              </td>
              <td>
                <a href={`/calls/${c.id}`} className="row-link">
                  view →
                </a>
              </td>
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
      <div className="lasso-cart-title">
        {item?.title ?? <span style={{ color: "var(--ink-faint)" }}>—</span>}
      </div>
      {typeof total === "number" && (
        <div className="lasso-cart-price">{fmtMoney(total)}</div>
      )}
    </>
  );
}

function StatusPill({ status }: { status: CallRow["status"] }) {
  return <span className={`lasso-pill ${status}`}>{status.replace("_", " ")}</span>;
}

function OutcomePill({ outcome }: { outcome: NonNullable<CallRow["outcome"]> }) {
  return <span className={`lasso-pill ${outcome}`}>{outcome}</span>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="lasso-stat">
      <div className="lasso-stat-label">{label}</div>
      <div className="lasso-stat-value">{value}</div>
      {sub && <div className="lasso-stat-sub">{sub}</div>}
    </div>
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
