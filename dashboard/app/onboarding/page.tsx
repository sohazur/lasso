"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getOnboardStatus,
  snippetSrc,
  startOnboard,
  type MerchantStatus,
  type OnboardStatus,
} from "../lib/api";

type Step = "url" | "build" | "install";

const STEPS: Array<{ key: Step; label: string }> = [
  { key: "url", label: "Site" },
  { key: "build", label: "Build" },
  { key: "install", label: "Install" },
];

/** Derive everything from one URL: brand name, merchant slug, primary domain. */
function deriveFromUrl(raw: string): {
  url: string;
  brand: string;
  slug: string;
  host: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const root = host.split(".")[0] ?? "";
  const brand = root
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const slug = host.replace(/\./g, "-").toLowerCase().slice(0, 64);
  return { url: withScheme, brand: brand || host, slug, host };
}

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>("url");

  const [url, setUrl] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [merchantId, setMerchantId] = useState<string>("");
  const [merchantName, setMerchantName] = useState<string>("");
  const [status, setStatus] = useState<OnboardStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const derived = useMemo(() => deriveFromUrl(url), [url]);

  // Poll while in build phase
  useEffect(() => {
    if (step !== "build" || !merchantId) return;
    let cancelled = false;
    async function tick() {
      try {
        const s = await getOnboardStatus(merchantId);
        if (cancelled) return;
        setStatus(s);
        setPollError(null);
        if (s.status === "ready") setStep("install");
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : "Status check failed");
      }
    }
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [step, merchantId]);

  async function submit() {
    setSubmitError(null);
    if (!derived) {
      setSubmitError("Please enter a valid website URL.");
      return;
    }

    const privateContext: Record<string, unknown> = {};
    if (discountCode.trim()) privateContext.discount_code = discountCode.trim();
    if (notes.trim()) privateContext.notes = notes.trim();

    setSubmitting(true);
    try {
      await startOnboard({
        merchant_id: derived.slug,
        name: derived.brand,
        url: derived.url,
        private_context:
          Object.keys(privateContext).length > 0 ? privateContext : undefined,
      });
      setMerchantId(derived.slug);
      setMerchantName(derived.brand);
      setStep("build");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Onboarding failed.");
    } finally {
      setSubmitting(false);
    }
  }

  function startOver() {
    setStep("url");
    setStatus(null);
    setPollError(null);
    setSubmitError(null);
  }

  return (
    <main className="lasso-shell">
      <a href="/" className="lasso-back">
        ← Lasso
      </a>
      <header className="lasso-header">
        <span className="lasso-eyebrow">Onboard a store</span>
        <h1 className="lasso-h1">Drop one URL. We&apos;ll do the rest.</h1>
        <p className="lasso-sub">
          We&apos;ll crawl your site, build a knowledge base your voice agent
          can search in real time, and hand you a script tag to install.
          Usually 30-90 seconds.
        </p>
      </header>

      <Stepper step={step} />

      <section className="lasso-card">
        {step === "url" && (
          <UrlStep
            url={url}
            setUrl={setUrl}
            derived={derived}
            discountCode={discountCode}
            setDiscountCode={setDiscountCode}
            notes={notes}
            setNotes={setNotes}
            submitting={submitting}
            error={submitError}
            submit={submit}
          />
        )}

        {step === "build" && (
          <BuildStep
            status={status}
            pollError={pollError}
            merchantName={merchantName}
            onRetry={startOver}
          />
        )}

        {step === "install" && status && (
          <InstallStep merchantId={status.merchant_id} name={status.name} />
        )}
      </section>
    </main>
  );
}

/* ───────────── URL step ───────────── */

function UrlStep(props: {
  url: string;
  setUrl: (v: string) => void;
  derived: ReturnType<typeof deriveFromUrl>;
  discountCode: string;
  setDiscountCode: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  submitting: boolean;
  error: string | null;
  submit: () => void;
}) {
  const ready = !!props.derived && !props.submitting;
  return (
    <>
      <label className="lasso-label" htmlFor="lasso-url">
        Website URL
      </label>
      <input
        id="lasso-url"
        type="url"
        className="lasso-input lg"
        placeholder="https://yourstore.com"
        value={props.url}
        onChange={(e) => props.setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ready) props.submit();
        }}
        autoFocus
      />
      {props.derived ? (
        <p className="lasso-hint">
          We&apos;ll call it <strong>{props.derived.brand}</strong> and tag it as{" "}
          <code className="mono">{props.derived.slug}</code>. Edit later if needed.
        </p>
      ) : (
        <p className="lasso-hint">
          We&apos;ll crawl up to 30 pages and build your knowledge base.
        </p>
      )}

      <details className="lasso-details">
        <summary>Optional: tell the agent about deals or quirks</summary>
        <div>
          <div style={{ marginBottom: 14 }}>
            <label className="lasso-label" htmlFor="lasso-coupon">
              Discount code the agent can offer
            </label>
            <input
              id="lasso-coupon"
              className="lasso-input"
              placeholder="LASSO10"
              value={props.discountCode}
              onChange={(e) => props.setDiscountCode(e.target.value)}
            />
          </div>
          <label className="lasso-label" htmlFor="lasso-notes">
            Internal notes (anything not on your public site)
          </label>
          <textarea
            id="lasso-notes"
            className="lasso-input"
            rows={3}
            placeholder="We ship in 2 business days. Don't push the premium plan."
            value={props.notes}
            onChange={(e) => props.setNotes(e.target.value)}
          />
        </div>
      </details>

      {props.error && <div className="lasso-error">{props.error}</div>}

      <div className="lasso-row">
        <a href="/" className="btn btn-ghost">
          Cancel
        </a>
        <button
          type="button"
          className="btn btn-primary"
          onClick={props.submit}
          disabled={!ready}
        >
          {props.submitting ? "Starting…" : "Build my agent →"}
        </button>
      </div>
    </>
  );
}

/* ───────────── Build step ───────────── */

function BuildStep(props: {
  status: OnboardStatus | null;
  pollError: string | null;
  merchantName: string;
  onRetry: () => void;
}) {
  const phase: MerchantStatus = props.status?.status ?? "scraping";
  const failed = phase === "failed";

  const phases: Array<{ label: string; detail: string }> = [
    {
      label: "Reading your site",
      detail: "Firecrawl is fetching up to 30 pages.",
    },
    {
      label: "Indexing into Moss",
      detail: "Vector index ready for sub-200ms lookups during the call.",
    },
    {
      label: "Writing your brand briefing",
      detail: "An LLM is summarizing voice, products, and recovery tactics into Supermemory.",
    },
  ];

  const phaseIdx = (() => {
    switch (phase) {
      case "scraping":
        return 0;
      case "indexing":
        return 1;
      case "ready":
        return 2;
      default:
        return -1;
    }
  })();

  return (
    <>
      <h2 className="lasso-h1" style={{ fontSize: 22, marginBottom: 4 }}>
        Building {props.merchantName || "your agent"}
      </h2>
      <p className="lasso-sub" style={{ marginBottom: 20 }}>
        Hang tight. You can leave this page — we&apos;ll save progress.
      </p>

      <ul className="lasso-phases">
        {phases.map((p, i) => {
          const done = phaseIdx > i;
          const active = phaseIdx === i && !failed;
          return (
            <li key={p.label} className="lasso-phase">
              <span
                className={`lasso-phase-dot ${done ? "done" : active ? "active" : ""}`}
              >
                {done ? "✓" : active ? <span className="lasso-spinner" /> : i + 1}
              </span>
              <div>
                <div className="lasso-phase-title">{p.label}</div>
                <div className="lasso-phase-detail">{p.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>

      {failed && props.status && (
        <div className="lasso-error">
          <div>
            Hit a snag at{" "}
            <code className="mono">{props.status.failed_step ?? "unknown"}</code>.
          </div>
          {props.status.failed_reason && (
            <div
              style={{
                marginTop: 6,
                fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
                fontSize: 12,
                color: "#7f1d1d",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {props.status.failed_reason}
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{
                padding: "0 4px",
                color: "#1d4ed8",
                textDecoration: "underline",
              }}
              onClick={props.onRetry}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {props.pollError && !failed && (
        <div className="lasso-error">
          Couldn&apos;t check status: {props.pollError}
        </div>
      )}
    </>
  );
}

/* ───────────── Install step ───────────── */

function InstallStep(props: { merchantId: string; name: string }) {
  const tag = `<script src="${snippetSrc()}" data-merchant="${props.merchantId}" async></script>`;
  const [copied, setCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  function copy() {
    if (!taRef.current) return;
    taRef.current.select();
    void navigator.clipboard.writeText(tag);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <h2 className="lasso-h1" style={{ fontSize: 22, marginBottom: 4 }}>
        {props.name} is live
      </h2>
      <p className="lasso-sub" style={{ marginBottom: 20 }}>
        Paste this on your checkout page (or anywhere you want abandonment
        recovery). That&apos;s the entire integration.
      </p>

      <div className="lasso-snippet">
        <textarea ref={taRef} readOnly value={tag} rows={2} />
        <button type="button" className="btn btn-primary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <details
        style={{
          marginTop: 14,
          padding: "10px 14px",
          background: "rgba(245, 158, 11, 0.08)",
          border: "1px solid rgba(245, 158, 11, 0.25)",
          borderRadius: 10,
          fontSize: 13,
          color: "var(--ink-soft)",
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            fontWeight: 500,
            color: "var(--amber-deep)",
          }}
        >
          Tip: how to test it from your DevTools
        </summary>
        <div style={{ marginTop: 8, lineHeight: 1.6 }}>
          On a real checkout page, abandonment fires automatically (exit-intent,
          tab-hidden, close-tab). For an instant test, fill the phone + email,
          open DevTools console, and run:
          <pre
            style={{
              marginTop: 8,
              padding: "8px 10px",
              background: "#0f172a",
              color: "#e2e8f0",
              borderRadius: 8,
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
              fontSize: 12,
              overflowX: "auto",
            }}
          >
            window.Lasso.fire()
          </pre>
          The agent will call the phone number in the form within ~10s.
        </div>
      </details>

      <ul className="lasso-summary">
        <li>
          <span className="lasso-summary-key">Merchant ID</span>
          <code className="lasso-chip">{props.merchantId}</code>
        </li>
        <li>
          <span className="lasso-summary-key">Knowledge base</span>
          <span>
            Moss index <code className="lasso-chip">merchant_{props.merchantId}</code>
          </span>
        </li>
        <li>
          <span className="lasso-summary-key">Brand briefing</span>
          <span>
            Saved as <code className="lasso-chip">merchant:{props.merchantId}:context</code>
          </span>
        </li>
        <li>
          <span className="lasso-summary-key">Caller memory</span>
          <span>
            Will grow at{" "}
            <code className="lasso-chip">
              merchant:{props.merchantId}:phone:&lt;e164&gt;
            </code>
          </span>
        </li>
      </ul>

      <div className="lasso-row">
        <a href="/" className="btn btn-ghost">
          ← Dashboard
        </a>
        <a href="/" className="btn btn-dark">
          See live calls →
        </a>
      </div>
    </>
  );
}

/* ───────────── Stepper ───────────── */

function Stepper({ step }: { step: Step }) {
  const idx = STEPS.findIndex((s) => s.key === step);
  return (
    <div className="lasso-stepper" role="progressbar" aria-valuenow={idx + 1}>
      {STEPS.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <div key={s.key} className="lasso-stepper-item" style={{ flexShrink: 0 }}>
            <div
              className={`lasso-stepper-dot ${done ? "done" : active ? "active" : ""}`}
            >
              {done ? "✓" : i + 1}
            </div>
            <span className={`lasso-stepper-label ${done ? "done" : active ? "active" : ""}`}>
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className={`lasso-stepper-bar ${done ? "done" : ""}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
