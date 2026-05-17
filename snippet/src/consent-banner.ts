/**
 * Consent banner — slides down from the top of the viewport once
 * checkout is detected. Shadow DOM so merchant CSS can't break it.
 *
 * Dismissal persists 7 days in localStorage. Opt-in flips snapshot.consent_given.
 */

const DISMISS_KEY = "lasso:consent_dismissed_at";
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHOW_AFTER_MS = 2000;

export type ConsentHandle = {
  show: () => void;
  dismiss: () => void;
  destroy: () => void;
};

export function mountConsentBanner(
  storeName: string | undefined,
  onConsentChange: (consented: boolean) => void
): ConsentHandle {
  if (isDismissedRecently()) {
    return noopHandle();
  }

  const host = document.createElement("div");
  host.id = "lasso-consent-host";
  host.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    pointer-events: none;
  `;

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .banner {
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        background: #111;
        color: #fff;
        padding: 14px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        transform: translateY(-100%);
        transition: transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1);
        pointer-events: auto;
        font-size: 14px;
        line-height: 1.4;
        flex-wrap: wrap;
      }
      .banner.show { transform: translateY(0); }
      .copy { flex: 1; min-width: 240px; }
      .copy strong { color: #fff; }
      .copy .subtle { color: #aaa; font-size: 12px; margin-top: 2px; display: block; }
      .actions { display: flex; align-items: center; gap: 12px; }
      label {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        user-select: none;
      }
      input[type="checkbox"] {
        width: 18px;
        height: 18px;
        accent-color: #4ade80;
        cursor: pointer;
      }
      .dismiss {
        background: transparent;
        color: #888;
        border: 0;
        font-size: 13px;
        cursor: pointer;
        padding: 4px 8px;
      }
      .dismiss:hover { color: #fff; }
    </style>
    <div class="banner" role="region" aria-label="Lasso checkout callback consent">
      <div class="copy">
        <strong>If you need a hand, ${storeName ? escapeHtml(storeName) : "we"} can call you.</strong>
        <span class="subtle">Opt in below to let us reach out if you don't finish checking out.</span>
      </div>
      <div class="actions">
        <label>
          <input type="checkbox" id="lasso-consent-cb" />
          <span>Yes, you can call me</span>
        </label>
        <button class="dismiss" id="lasso-dismiss" aria-label="Dismiss">no thanks</button>
      </div>
    </div>
  `;

  document.body.appendChild(host);

  const banner = shadow.querySelector<HTMLDivElement>(".banner")!;
  const checkbox = shadow.querySelector<HTMLInputElement>("#lasso-consent-cb")!;
  const dismissBtn = shadow.querySelector<HTMLButtonElement>("#lasso-dismiss")!;

  let showTimer: ReturnType<typeof setTimeout> | undefined;

  function show(): void {
    showTimer = setTimeout(() => banner.classList.add("show"), 20);
  }

  function dismiss(): void {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    banner.classList.remove("show");
    onConsentChange(false);
    setTimeout(() => host.remove(), 320);
  }

  function destroy(): void {
    if (showTimer) clearTimeout(showTimer);
    host.remove();
  }

  checkbox.addEventListener("change", () => onConsentChange(checkbox.checked));
  dismissBtn.addEventListener("click", dismiss);

  setTimeout(show, SHOW_AFTER_MS);

  return { show, dismiss, destroy };
}

function isDismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (Number.isNaN(at)) return false;
    return Date.now() - at < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function noopHandle(): ConsentHandle {
  return { show: () => {}, dismiss: () => {}, destroy: () => {} };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
