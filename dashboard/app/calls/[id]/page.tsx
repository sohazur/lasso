"use client";

import { useEffect, useMemo, useState } from "react";
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

  if (error) {
    return (
      <main className="lasso-shell call-detail">
        <a href="/" className="lasso-back">← Dashboard</a>
        <div className="lasso-error">{error}</div>
      </main>
    );
  }

  if (!call) {
    return (
      <main className="lasso-shell call-detail">
        <a href="/" className="lasso-back">← Dashboard</a>
        <p className="lasso-empty">Loading…</p>
      </main>
    );
  }

  return (
    <main className="lasso-shell call-detail">
      <a href="/" className="lasso-back">← Dashboard</a>

      <header className="lasso-header" style={{ marginBottom: 0 }}>
        <span className="lasso-eyebrow">Call · {call.merchant_id}</span>
        <h1 className="lasso-h1">
          {call.customer_name ?? "Unknown caller"}
        </h1>
        <p className="lasso-sub">
          <code className="mono">{call.phone}</code> · started{" "}
          {fmtFullDate(call.created_at)}{" "}
          <span style={{ marginLeft: 12 }}>
            <StatusPill status={call.status} />
            {call.outcome && (
              <span style={{ marginLeft: 8 }}>
                <OutcomePill outcome={call.outcome} />
              </span>
            )}
          </span>
        </p>
      </header>

      <div className="lasso-call-grid">
        <aside className="lasso-call-aside">
          <CustomerProfileCard call={call} />
          <CartCard call={call} />
          <CallMetaCard call={call} />
        </aside>

        <section className="lasso-call-main">
          <SummaryCard call={call} />
          <TranscriptCard call={call} />
        </section>
      </div>
    </main>
  );
}

/* ───────────── customer profile ───────────── */

function CustomerProfileCard({ call }: { call: CallRow }) {
  return (
    <div className="lasso-call-card">
      <h3>Customer</h3>
      <div className="lasso-profile-name">
        {call.customer_name ?? "—"}
      </div>
      <div className="lasso-profile-phone">{call.phone}</div>

      <ul className="lasso-profile-meta">
        <li>
          <span className="key">Email</span>
          <span className="value">{call.email ?? "—"}</span>
        </li>
        <li>
          <span className="key">Merchant</span>
          <span className="value">
            <code className="lasso-chip">{call.merchant_id}</code>
          </span>
        </li>
        <li>
          <span className="key">Triggered by</span>
          <span className="value">{call.trigger ?? "—"}</span>
        </li>
        <li>
          <span className="key">Source page</span>
          <span className="value" title={call.page_url ?? ""}>
            {call.page_url ? shortenUrl(call.page_url) : "—"}
          </span>
        </li>
      </ul>
    </div>
  );
}

/* ───────────── cart ───────────── */

function CartCard({ call }: { call: CallRow }) {
  const lines = (call.cart_lines ?? []) as Array<{ title?: string; qty?: number; price_cents?: number }>;
  if (lines.length === 0 && !call.cart_total_cents) {
    return null;
  }
  return (
    <div className="lasso-call-card">
      <h3>Cart at abandonment</h3>
      {lines.length > 0 ? (
        <ul className="lasso-cart-list">
          {lines.map((line, i) => (
            <li key={i}>
              <div>
                <span className="qty">{line.qty ?? 1}×</span>{" "}
                {line.title ?? "(item)"}
              </div>
              {line.price_cents != null && (
                <div>{fmtMoney(line.price_cents)}</div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="lasso-empty" style={{ padding: 0 }}>
          No line items captured.
        </p>
      )}
      {call.cart_total_cents != null && (
        <div className="lasso-cart-total">
          <span>Total</span>
          <span>{fmtMoney(call.cart_total_cents)}</span>
        </div>
      )}
    </div>
  );
}

/* ───────────── call meta ───────────── */

function CallMetaCard({ call }: { call: CallRow }) {
  return (
    <div className="lasso-call-card">
      <h3>Call details</h3>
      <ul className="lasso-profile-meta">
        <li>
          <span className="key">Status</span>
          <span className="value">
            <StatusPill status={call.status} />
          </span>
        </li>
        {call.outcome && (
          <li>
            <span className="key">Outcome</span>
            <span className="value">
              <OutcomePill outcome={call.outcome} />
            </span>
          </li>
        )}
        <li>
          <span className="key">Duration</span>
          <span className="value">
            {call.duration_secs ? `${call.duration_secs}s` : "—"}
          </span>
        </li>
        <li>
          <span className="key">Recovered</span>
          <span className="value">
            {call.recovered_cents
              ? fmtMoney(call.recovered_cents)
              : "—"}
          </span>
        </li>
        <li>
          <span className="key">Started</span>
          <span className="value">{fmtTime(call.created_at)}</span>
        </li>
        {call.ended_at && (
          <li>
            <span className="key">Ended</span>
            <span className="value">{fmtTime(call.ended_at)}</span>
          </li>
        )}
        <li>
          <span className="key">AgentPhone ID</span>
          <span className="value" style={{ fontSize: 11 }}>
            <code>{call.agentphone_call_id ?? "—"}</code>
          </span>
        </li>
      </ul>
    </div>
  );
}

/* ───────────── summary ───────────── */

function SummaryCard({ call }: { call: CallRow }) {
  const summary = useMemo(() => deriveSummary(call), [call]);
  return (
    <div className="lasso-call-card">
      <h2>Summary</h2>
      <p className="lasso-summary-line">{summary.line}</p>
      {call.failed_reason && (
        <pre
          style={{
            margin: "12px 0 0",
            padding: "10px 12px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 10,
            color: "#7f1d1d",
            fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {call.failed_reason}
        </pre>
      )}
      {summary.tags.length > 0 && (
        <div className="lasso-summary-meta">
          {summary.tags.map((t) => (
            <span key={t.label} className={`lasso-pill ${t.tone}`}>
              {t.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

type SummaryTag = { label: string; tone: string };
function deriveSummary(call: CallRow): { line: string; tags: SummaryTag[] } {
  const tags: SummaryTag[] = [];
  let line: string;

  if (call.status === "preparing") {
    line = "Call is being prepared — agent + cart context loading.";
  } else if (call.status === "ringing") {
    line = "Phone is ringing. Waiting for the customer to pick up.";
  } else if (call.status === "connected") {
    line = "Customer is on the line right now. Live transcript below.";
  } else if (call.status === "no_answer") {
    line = "Customer didn't pick up. Recommend SMS follow-up.";
  } else if (call.status === "failed") {
    line = call.failed_reason
      ? "Call failed before connecting. See error below."
      : "Call failed before connecting. Check AgentPhone logs.";
  } else if (call.status === "completed") {
    if (call.outcome === "recovered") {
      line = `Customer agreed to complete the purchase${
        call.recovered_cents ? `, recovered ${fmtMoney(call.recovered_cents)}` : ""
      }.`;
    } else if (call.outcome === "declined") {
      line = "Customer declined to continue. Cart not recovered.";
    } else if (call.outcome === "unreachable") {
      line = "Couldn't reach the customer — call connected but didn't resolve.";
    } else {
      line = "Call completed. Review the transcript below for context.";
    }
  } else {
    line = "Call in progress.";
  }

  tags.push({
    label: `Cart ${call.cart_total_cents ? fmtMoney(call.cart_total_cents) : "unknown"}`,
    tone: "ringing",
  });
  if (call.customer_name) {
    tags.push({ label: `Known: ${call.customer_name}`, tone: "completed" });
  }
  if (call.duration_secs) {
    tags.push({ label: `${call.duration_secs}s`, tone: "no_answer" });
  }
  if (call.outcome === "recovered" && call.recovered_cents) {
    tags.push({
      label: `Recovered ${fmtMoney(call.recovered_cents)}`,
      tone: "recovered",
    });
  }

  return { line, tags };
}

/* ───────────── transcript ───────────── */

type Turn = { speaker: "agent" | "caller"; text: string };

function TranscriptCard({ call }: { call: CallRow }) {
  const turns = useMemo(() => parseTranscript(call.transcript), [call.transcript]);
  return (
    <div className="lasso-call-card">
      <h2>Transcript</h2>
      {!call.transcript ? (
        <p className="lasso-empty" style={{ padding: 0 }}>
          {call.status === "completed" || call.status === "failed"
            ? "No transcript saved for this call."
            : "Transcript will appear once the call ends."}
        </p>
      ) : turns.length === 0 ? (
        <pre className="lasso-transcript-raw">{call.transcript}</pre>
      ) : (
        <div className="lasso-transcript">
          {turns.map((t, i) => (
            <div key={i} className={`lasso-bubble ${t.speaker}`}>
              <span className="lasso-bubble-label">
                {t.speaker === "agent" ? "Agent" : call.customer_name ?? "Caller"}
              </span>
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Best-effort transcript parser. AgentPhone webhook stores conversation as
 * a string; the format varies (sometimes "Agent: ...\nCaller: ...", sometimes
 * JSON, sometimes a raw text block). We try the obvious patterns and fall
 * back to raw text if nothing matches.
 */
function parseTranscript(raw: string | null): Turn[] {
  if (!raw) return [];

  // Try JSON first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const turns: Turn[] = [];
      for (const entry of parsed) {
        if (typeof entry !== "object" || !entry) continue;
        const text = entry.message ?? entry.text ?? entry.content ?? "";
        const role = entry.role ?? entry.direction ?? entry.speaker ?? "";
        if (!text) continue;
        const speaker: "agent" | "caller" =
          /agent|assistant|outbound|bot/i.test(String(role)) ? "agent" : "caller";
        turns.push({ speaker, text: String(text) });
      }
      if (turns.length > 0) return turns;
    }
  } catch {
    /* not JSON, continue */
  }

  // Line-based "Speaker: text" pattern
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const speakerRe = /^(agent|bot|assistant|caller|customer|user|visitor|you|me)\s*[:–—-]\s*(.+)$/i;

  for (const line of lines) {
    const m = speakerRe.exec(line);
    if (m) {
      if (current) turns.push(current);
      const isAgent = /agent|bot|assistant/i.test(m[1]!);
      current = { speaker: isAgent ? "agent" : "caller", text: m[2]! };
    } else if (current) {
      current.text += "\n" + line;
    }
  }
  if (current) turns.push(current);
  return turns;
}

/* ───────────── shared pills ───────────── */

function StatusPill({ status }: { status: CallRow["status"] }) {
  return <span className={`lasso-pill ${status}`}>{status.replace("_", " ")}</span>;
}

function OutcomePill({ outcome }: { outcome: NonNullable<CallRow["outcome"]> }) {
  return <span className={`lasso-pill ${outcome}`}>{outcome}</span>;
}

/* ───────────── formatters ───────────── */

function fmtMoney(cents: number | null | undefined): string {
  if (cents == null || cents <= 0) return "$0";
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function fmtFullDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function shortenUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.hostname}${parsed.pathname.length > 1 ? parsed.pathname : ""}`;
  } catch {
    return u.length > 30 ? u.slice(0, 28) + "…" : u;
  }
}
