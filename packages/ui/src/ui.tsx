import type { ComponentChildren } from "preact";
import type { ProviderRole, RunProjection } from "@collab/contracts";

/** Shared presentational primitives. Nothing here talks to the network. */

export const PROVIDER_NAME: Record<ProviderRole, string> = {
  codex: "Codex",
  claude: "Claude",
};

export type Tone = "working" | "attention" | "ok" | "warn" | "bad" | "muted" | "accent";

const TERMINAL = new Set(["completed_consensus", "completed_disagreement", "cancelled", "failed"]);

/** One human status for a run, shared by the sidebar, the header, and the live region. */
export function runStatus(run: RunProjection): { label: string; tone: Tone } {
  if (run.actions.length) return { label: "Needs your input", tone: "attention" };
  if (run.completedAt || TERMINAL.has(run.state)) {
    if (run.state === "cancelled") return { label: "Cancelled", tone: "muted" };
    if (run.state === "failed") return { label: "Failed", tone: "bad" };
    if (run.planning) {
      return run.planning.status === "ready"
        ? { label: "Reviewed answer", tone: "ok" }
        : { label: "Partial result", tone: "warn" };
    }
    if (run.state === "completed_consensus") return { label: "Consensus reached", tone: "ok" };
    if (run.state === "completed_disagreement") return { label: "Disagreement recorded", tone: "warn" };
    return { label: "Completed", tone: "ok" };
  }
  if (run.state === "preflight_blocked") return { label: "Blocked at preflight", tone: "bad" };
  if (run.state === "billing_integrity_unknown") return { label: "Billing check needed", tone: "bad" };
  if (run.state === "paused") return { label: "Paused", tone: "muted" };
  if (run.state === "draft") return { label: "Not started", tone: "muted" };
  if (run.state === "waiting_user") return { label: "Waiting for you", tone: "attention" };
  return { label: "Working", tone: "working" };
}

export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

/* ---------- icons (16px stroke icons, decorative) ---------- */

type IconProps = { size?: number; class?: string };
function svg(path: ComponentChildren, { size = 16, class: klass }: IconProps = {}) {
  return (
    <svg
      class={klass ? `icon ${klass}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

export const Icon = {
  plus: (p?: IconProps) => svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>, p),
  folder: (p?: IconProps) =>
    svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, p),
  check: (p?: IconProps) => svg(<path d="M5 12.5l4.5 4.5L19 7" />, p),
  x: (p?: IconProps) => svg(<><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>, p),
  chevron: (p?: IconProps) => svg(<path d="M9 6l6 6-6 6" />, p),
  download: (p?: IconProps) =>
    svg(<><path d="M12 4v11" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" /></>, p),
  stop: (p?: IconProps) => svg(<rect x="6" y="6" width="12" height="12" rx="2" />, p),
  sun: (p?: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>,
      p,
    ),
  moon: (p?: IconProps) => svg(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />, p),
  monitor: (p?: IconProps) =>
    svg(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>, p),
  alert: (p?: IconProps) =>
    svg(<><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><path d="M12 18h.01" /></>, p),
  info: (p?: IconProps) =>
    svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>, p),
  lock: (p?: IconProps) =>
    svg(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, p),
  message: (p?: IconProps) =>
    svg(<path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z" />, p),
  spark: (p?: IconProps) =>
    svg(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />, p),
  arrow: (p?: IconProps) => svg(<><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>, p),
};

/* ---------- small building blocks ---------- */

export function ProviderMark({ role, size = "md" }: { role: ProviderRole; size?: "sm" | "md" | "lg" }) {
  return (
    <span class={`provider-mark provider-mark-${role} provider-mark-${size}`} aria-hidden="true">
      {role === "codex" ? "C" : "A"}
    </span>
  );
}

export function StatusPill({ tone, children, class: klass }: { tone: Tone; children: ComponentChildren; class?: string }) {
  return (
    <span class={`pill pill-${tone}${klass ? ` ${klass}` : ""}`}>
      <span class="pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Eyebrow({ children }: { children: ComponentChildren }) {
  return <p class="eyebrow">{children}</p>;
}

export function EmptyLine({ children }: { children: ComponentChildren }) {
  return <p class="empty-copy">{children}</p>;
}
