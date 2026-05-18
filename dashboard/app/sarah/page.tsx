"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getPrompt,
  savePrompt,
  getPlaybooks,
  savePlaybooks,
  getCallLog,
  getCallContext,
  getCallLive,
  type Playbooks,
  type Playbook,
  type CallRow,
  type PromptName,
  STRATEGY_URL,
} from "../lib/strategy-api";

type Tab = "strategy" | "behavior" | "brand" | "calls";

const TABS: Array<{ key: Tab; label: string; sub: string }> = [
  { key: "strategy", label: "Strategy", sub: "concern → playbook" },
  { key: "behavior", label: "Behavior", sub: "how Sarah talks" },
  { key: "brand", label: "Brand brief", sub: "merchant context" },
  { key: "calls", label: "Call log", sub: "recent activity" },
];

const EXIT_ORDER = ["cart", "address", "shipping_review", "payment", "order_review"];

export default function SarahPage() {
  const [tab, setTab] = useState<Tab>("strategy");
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "bad" } | null>(null);
  const flash = useCallback((msg: string, kind: "ok" | "bad" = "ok") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2200);
  }, []);

  return (
    <main className="lasso-shell dashboard" style={{ maxWidth: 1080 }}>
      <a href="/" className="lasso-back">
        ← back to call log
      </a>

      <header className="lasso-header" style={{ marginBottom: 24 }}>
        <span className="lasso-eyebrow">Recovery agent · brain</span>
        <h1 className="lasso-h1">Sarah</h1>
        <p className="lasso-sub">
          The strategy, behavior, and brand context driving every recovery call.
          Edits land on the next call instantly — no restart.{" "}
          <span className="mono" style={{ color: "var(--ink-faint)" }}>
            via {STRATEGY_URL}
          </span>
        </p>
      </header>

      <div className="sarah-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`sarah-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            <span className="sarah-tab-label">{t.label}</span>
            <span className="sarah-tab-sub">{t.sub}</span>
          </button>
        ))}
      </div>

      {tab === "strategy" && <StrategyEditor flash={flash} />}
      {tab === "behavior" && <PromptEditor name="behavior" flash={flash} />}
      {tab === "brand" && <PromptEditor name="brand_brief" flash={flash} />}
      {tab === "calls" && <CallLog />}

      {toast && <div className={`sarah-toast ${toast.kind}`}>{toast.msg}</div>}

      <style jsx>{`
        .sarah-tabs {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          margin-bottom: 24px;
        }
        .sarah-tab {
          padding: 14px 16px;
          border-radius: 16px;
          border: 1px solid var(--border);
          background: var(--surface);
          text-align: left;
          cursor: pointer;
          transition: border-color 0.15s, transform 0.05s;
        }
        .sarah-tab:hover {
          border-color: var(--border-strong);
        }
        .sarah-tab.active {
          border-color: var(--amber-deep);
          box-shadow: 0 0 0 2px var(--amber-tint);
        }
        .sarah-tab-label {
          display: block;
          font-size: 14px;
          font-weight: 600;
          color: var(--ink);
        }
        .sarah-tab-sub {
          display: block;
          font-size: 11px;
          color: var(--ink-muted);
          margin-top: 2px;
        }
        .sarah-toast {
          position: fixed;
          bottom: 24px;
          right: 24px;
          padding: 12px 18px;
          border-radius: 12px;
          font-size: 14px;
          color: white;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
          z-index: 10;
        }
        .sarah-toast.ok {
          background: #1f7a48;
        }
        .sarah-toast.bad {
          background: #a8281f;
        }
      `}</style>
    </main>
  );
}

/* ───────────────── Strategy (playbooks) editor ───────────────── */

function StrategyEditor({ flash }: { flash: (m: string, k?: "ok" | "bad") => void }) {
  const [data, setData] = useState<Playbooks | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<string>("");

  useEffect(() => {
    getPlaybooks()
      .then((d) => {
        setData(d);
        setInfo("loaded");
      })
      .catch((e) => setInfo("failed to load: " + e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading || !data) {
    return <section className="lasso-card">Loading playbooks…</section>;
  }

  function updatePlaybook(kind: "by_exit_point" | "overrides", key: string, field: keyof Playbook, value: string) {
    if (!data) return;
    const next: Playbooks = {
      ...data,
      [kind]: { ...data[kind], [key]: { ...data[kind][key], [field]: value } },
    };
    setData(next);
    setInfo("unsaved changes");
  }

  async function onSave() {
    if (!data) return;
    setSaving(true);
    try {
      await savePlaybooks(data);
      setInfo("saved · applies on next call");
      flash("Strategy saved");
    } catch (e: unknown) {
      setInfo("save failed");
      flash("Save failed: " + (e instanceof Error ? e.message : String(e)), "bad");
    } finally {
      setSaving(false);
    }
  }

  const exitKeys = [
    ...EXIT_ORDER.filter((k) => data.by_exit_point[k]),
    ...Object.keys(data.by_exit_point).filter((k) => !EXIT_ORDER.includes(k)),
  ];
  const overrideKeys = Object.keys(data.overrides);

  return (
    <>
      <section className="lasso-card">
        <div className="lasso-section-title">By exit point</div>
        <p className="lasso-hint" style={{ marginTop: 0, marginBottom: 14 }}>
          Where the customer dropped off in checkout determines Sarah&apos;s leading hypothesis. Each
          playbook is what she does once that hypothesis lands.
        </p>
        {exitKeys.map((k) => (
          <PlaybookCard
            key={k}
            label={k}
            badge="exit point"
            pb={data.by_exit_point[k]}
            onChange={(f, v) => updatePlaybook("by_exit_point", k, f, v)}
          />
        ))}
      </section>

      <section className="lasso-card">
        <div className="lasso-section-title">Overrides</div>
        <p className="lasso-hint" style={{ marginTop: 0, marginBottom: 14 }}>
          Signal flags that win over the exit-point lookup. e.g. if{" "}
          <code className="mono">discountCodeFailed</code> is true, that always wins.
        </p>
        {overrideKeys.length === 0 && <p className="lasso-hint">No overrides defined.</p>}
        {overrideKeys.map((k) => (
          <PlaybookCard
            key={k}
            label={k}
            badge="override"
            pb={data.overrides[k]}
            onChange={(f, v) => updatePlaybook("overrides", k, f, v)}
          />
        ))}
      </section>

      <div className="lasso-row" style={{ alignItems: "center" }}>
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save strategy"}
        </button>
        <span className="lasso-hint">{info}</span>
      </div>
    </>
  );
}

function PlaybookCard({
  label,
  badge,
  pb,
  onChange,
}: {
  label: string;
  badge: string;
  pb: Playbook;
  onChange: (field: keyof Playbook, value: string) => void;
}) {
  return (
    <div className="playbook-card">
      <div className="playbook-head">
        <span className="playbook-key">{label}</span>
        <span className="lasso-chip">{badge}</span>
      </div>

      <label className="lasso-label">Concern label</label>
      <input
        className="lasso-input"
        value={pb.concern}
        onChange={(e) => onChange("concern", e.target.value)}
      />

      <label className="lasso-label">Probe wording</label>
      <input
        className="lasso-input"
        value={pb.probe}
        onChange={(e) => onChange("probe", e.target.value)}
      />

      <label className="lasso-label">Suggested approach</label>
      <textarea
        className="lasso-input"
        rows={6}
        value={pb.approach}
        onChange={(e) => onChange("approach", e.target.value)}
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.55 }}
      />

      <style jsx>{`
        .playbook-card {
          padding: 14px 16px;
          border-radius: 16px;
          background: var(--cream);
          border: 1px solid var(--border);
          margin-bottom: 12px;
        }
        .playbook-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 10px;
        }
        .playbook-key {
          font-family: ui-monospace, monospace;
          font-size: 13px;
          font-weight: 600;
          color: var(--amber-deep);
        }
      `}</style>
    </div>
  );
}

/* ───────────────── Prompt (behavior / brand_brief) editor ───────────────── */

function PromptEditor({ name, flash }: { name: PromptName; flash: (m: string, k?: "ok" | "bad") => void }) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<string>("loading…");

  useEffect(() => {
    setLoading(true);
    getPrompt(name)
      .then((d) => {
        setContent(d.content);
        setOriginal(d.content);
        setInfo("loaded");
      })
      .catch((e) => setInfo("failed: " + e.message))
      .finally(() => setLoading(false));
  }, [name]);

  async function onSave() {
    setSaving(true);
    try {
      await savePrompt(name, content);
      setOriginal(content);
      setInfo("saved · applies on next call");
      flash(`Saved ${name}`);
    } catch (e: unknown) {
      setInfo("save failed");
      flash("Save failed: " + (e instanceof Error ? e.message : String(e)), "bad");
    } finally {
      setSaving(false);
    }
  }

  const dirty = content !== original;
  const labels: Record<PromptName, { title: string; sub: string }> = {
    behavior: {
      title: "Behavior",
      sub: "Sarah’s persona, voice, conversation flow, and hard rules. Read on every call.",
    },
    brand_brief: {
      title: "Brand brief",
      sub: "Industry, country, currency, category price norms, what the brand can flex on. Read by the strategy layer before every call.",
    },
  };
  const meta = labels[name];

  return (
    <section className="lasso-card">
      <div className="lasso-section-title">{meta.title}</div>
      <p className="lasso-hint" style={{ marginTop: 0, marginBottom: 14 }}>{meta.sub}</p>
      <textarea
        className="lasso-input"
        rows={26}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          if (e.target.value !== original) setInfo("unsaved changes");
        }}
        disabled={loading}
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.55 }}
      />
      <div className="lasso-row" style={{ alignItems: "center", marginTop: 12 }}>
        <button className="btn btn-primary" onClick={onSave} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setContent(original);
            setInfo("reverted");
          }}
          disabled={!dirty}
        >
          Revert
        </button>
        <span className="lasso-hint">{info}</span>
      </div>
    </section>
  );
}

/* ───────────────── Call log ───────────────── */

function CallLog() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, { briefing?: string; turns?: Array<{ user: string; agent: string }> }>>({});

  const load = useCallback(async () => {
    try {
      const r = await getCallLog(30);
      setCalls(r.calls || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  async function toggleRow(callId: string) {
    const next = new Set(expanded);
    if (next.has(callId)) {
      next.delete(callId);
    } else {
      next.add(callId);
      // Lazy-fetch detail
      try {
        const [ctx, live] = await Promise.all([
          getCallContext(callId).catch(() => ({ briefing: "" })),
          getCallLive(callId).catch(() => ({ turns: [] })),
        ]);
        setDetails((d) => ({ ...d, [callId]: { briefing: ctx.briefing, turns: live.turns } }));
      } catch {
        // silent
      }
    }
    setExpanded(next);
  }

  return (
    <section className="lasso-card">
      <div className="lasso-row" style={{ alignItems: "center", marginBottom: 14 }}>
        <button className="btn btn-ghost" onClick={load}>Refresh</button>
        <span className="lasso-hint">
          Auto-refresh every 4 s · run{" "}
          <code className="mono">./scripts/fire-abandonment.sh</code> to place a test call
        </span>
      </div>

      {loading && calls.length === 0 && <p className="lasso-hint">Loading…</p>}
      {!loading && calls.length === 0 && <p className="lasso-hint">No calls yet.</p>}

      <table className="sarah-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>To</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Call ID</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <CallRowView
              key={c.id}
              call={c}
              expanded={expanded.has(c.id)}
              detail={details[c.id]}
              onToggle={() => toggleRow(c.id)}
            />
          ))}
        </tbody>
      </table>

      <style jsx>{`
        .sarah-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          background: var(--surface);
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid var(--border);
        }
        .sarah-table th {
          text-align: left;
          padding: 10px 14px;
          background: var(--cream);
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--ink-muted);
        }
        .sarah-table td {
          padding: 10px 14px;
          border-top: 1px solid var(--border);
          font-family: ui-monospace, monospace;
          font-size: 12px;
        }
      `}</style>
    </section>
  );
}

function CallRowView({
  call,
  expanded,
  detail,
  onToggle,
}: {
  call: CallRow;
  expanded: boolean;
  detail?: { briefing?: string; turns?: Array<{ user: string; agent: string }> };
  onToggle: () => void;
}) {
  const status = (call.status || "unknown").toLowerCase();
  const dur = call.duration_seconds != null ? `${call.duration_seconds}s` : "—";
  const time = call.started_at ? new Date(call.started_at).toLocaleString() : "—";
  const shortId = (call.id || "").slice(-10);

  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }}>
        <td>{time}</td>
        <td>{call.to_number ?? "—"}</td>
        <td>
          <span className={`status-tag status-${status}`}>{status}</span>
        </td>
        <td>{dur}</td>
        <td>{shortId}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} style={{ background: "var(--cream)", padding: "14px 18px" }}>
            <div style={{ fontSize: 11, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Briefing Sarah received
            </div>
            <pre className="briefing-pre">{detail?.briefing || "(not stored — server may have restarted)"}</pre>

            <div style={{ fontSize: 11, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "12px 0 6px" }}>
              Transcript
            </div>
            <div className="transcript">
              {!detail?.turns || detail.turns.length === 0 ? (
                <em style={{ color: "var(--ink-muted)" }}>No transcript yet.</em>
              ) : (
                detail.turns.map((t, i) => (
                  <div key={i} className="turn">
                    {t.user && (
                      <div>
                        <span className="turn-lbl">user</span>
                        <span className="turn-user">{t.user}</span>
                      </div>
                    )}
                    {t.agent && (
                      <div>
                        <span className="turn-lbl">agent</span>
                        <span className="turn-agent">{t.agent}</span>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </td>
        </tr>
      )}

      <style jsx>{`
        .status-tag {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .status-completed {
          background: rgba(31, 122, 72, 0.18);
          color: #1f7a48;
        }
        .status-ringing,
        .status-in_progress {
          background: var(--amber-tint);
          color: var(--amber-deep);
        }
        .status-failed {
          background: rgba(168, 40, 31, 0.18);
          color: #a8281f;
        }
        .status-unknown,
        .status-none {
          background: rgba(0, 0, 0, 0.06);
          color: var(--ink-muted);
        }
        .briefing-pre {
          background: var(--surface);
          padding: 12px 14px;
          border-radius: 10px;
          border: 1px solid var(--border);
          font-family: ui-monospace, monospace;
          font-size: 12px;
          line-height: 1.55;
          max-height: 280px;
          overflow-y: auto;
          white-space: pre-wrap;
          margin: 0;
        }
        .transcript {
          background: #1b1b1b;
          color: #f1ece0;
          padding: 12px 14px;
          border-radius: 10px;
          font-family: ui-monospace, monospace;
          font-size: 12px;
          line-height: 1.6;
          max-height: 320px;
          overflow-y: auto;
        }
        .turn {
          padding: 4px 0;
        }
        .turn-lbl {
          color: #888;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-right: 8px;
        }
        .turn-user {
          color: #87c3ff;
        }
        .turn-agent {
          color: #ffd9b3;
        }
      `}</style>
    </>
  );
}
