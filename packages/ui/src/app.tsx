import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  ActionCard,
  AgentActivityEntry,
  AgentModelIdentity,
  BillingStatus,
  ProviderRole,
  RunProjection,
} from "@collab/contracts";

interface AdvisorView {
  enabled: boolean;
  config?: {
    provider: ProviderRole;
    effort: "high" | "medium";
    reactiveWakeUnits: number;
    retrospectiveWakeUnits: number;
  };
  ledger?: Array<{
    seq: number;
    kind: string;
    wakeId: string | null;
    ts: string;
    payload: Record<string, unknown>;
  }>;
  accounting?: {
    workerOverhead: { ratio: number | null; passed: boolean } | null;
    advisorUsage: {
      wakeCount: number;
      totalTokens: number;
      usageCoverageComplete: boolean;
      uncausedWakes: number;
      byProvider: Record<
        string,
        { input: number; cachedInput: number; output: number; reasoning: number }
      >;
    };
    combinedModelUsage: {
      workerTokens: number;
      advisorTokens: number;
      totalTokens: number;
    };
    combinedCoordinationRatio: number | null;
  };
  files?: Array<{ name: string; path: string; sha256: string; size: number }>;
  projectionAdvisor?: {
    triggerCount: number;
    requestedCount: number;
    extendedReactiveWakeUnits: number;
  } | null;
}

interface LegacyTaskSummary {
  id: string;
  name: string;
  goal: string;
  status: string | null;
  fileCount: number;
  readOnly: true;
}

interface LegacyTaskDetail {
  id: string;
  name: string;
  state: Record<string, unknown> | null;
  goal: string;
  notes: Array<{ name: string; content: string }>;
  transcript: string;
  finalPlan: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  readOnly: true;
}

async function bootstrap(): Promise<string> {
  const capability = window.location.hash.slice(1);
  const response = await fetch(capability ? "/bootstrap" : "/session/restore", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(capability ? { capability } : {}),
  });
  if (capability) history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (!response.ok) {
    throw new Error(
      capability
        ? "The launch capability is invalid, expired, or already used."
        : "This dashboard session expired. Open the current launch URL printed by collab.",
    );
  }
  const body = await response.json();
  return body.csrf;
}

const ERROR_MESSAGES: Record<string, string> = {
  TASK_GRANT_OUTSIDE_WORKSPACE:
    "A task-wide grant cannot cover paths outside the workspace, so the decision was not applied. Choose “Allow once” instead.",
  ACTION_DETAILS_REQUIRED:
    "This action needs the details field filled in before it can be applied.",
  ACTION_CARD_NOT_FOUND: "This card is no longer active. It may already have been decided.",
  ACTION_RUN_MISMATCH: "This card belongs to a different collaboration run.",
  RUN_NOT_FOUND: "The collaboration run could not be found.",
  RUN_ALREADY_TERMINAL: "The collaboration has already ended.",
};

/**
 * Server errors arrive as terse machine codes (possibly with a `:detail`
 * suffix). Translate the known ones and keep the raw code visible for the
 * rest — an unexplained failure must never render as a bare code, and it
 * must never take down the whole dashboard.
 */
function describeError(code: unknown, fallback: string): string {
  const raw = typeof code === "string" ? code : "";
  const key = raw.split(":")[0] ?? "";
  if (key && ERROR_MESSAGES[key]) return ERROR_MESSAGES[key];
  if (key === "ACTION_NOT_SUPPORTED") {
    return `The service does not support this action on this card (${raw}).`;
  }
  if (key === "UNKNOWN_PERMISSION_REQUEST") {
    return "This permission card is no longer pending — the service may have restarted. Reload the page to fetch the current state.";
  }
  return raw ? `${fallback} The service reported: ${raw}` : fallback;
}

function BillingChip({ status }: { status: BillingStatus | undefined }) {
  if (status?.simulated) {
    return (
      <span class="chip chip-simulated" title={status.proof.join("\n")}>
        Demo billing — not a proven route
      </span>
    );
  }
  const label = status
    ? status.route === "subscription_allowance"
      ? "Subscription allowance"
      : status.route === "existing_credits"
        ? "Existing credits"
        : status.route === "blocked"
          ? "Billing blocked"
          : "Billing route unknown"
    : "Preflight pending";
  return (
    <span class={`chip chip-${status?.route ?? "unknown"}`} title={status?.proof.join("\n")}>
      {label}
    </span>
  );
}

function AgentLane({
  role,
  run,
  activity,
  identity,
}: {
  role: ProviderRole;
  run: RunProjection;
  activity: AgentActivityEntry[];
  identity: AgentModelIdentity | undefined;
}) {
  const worker = run.workers[role];
  const packets = run.packets.filter((packet) => packet.from === role);
  const feed = activity
    .filter((entry) => entry.runId === run.runId && entry.role === role)
    .slice(-80);
  return (
    <section class={`lane lane-${role}`} aria-labelledby={`${role}-heading`}>
      <header>
        <div class="provider-heading">
          <span class="provider-mark" aria-hidden="true">
            {role === "codex" ? "C" : "A"}
          </span>
          <div>
          <p class="eyebrow">{role}</p>
          <h2 id={`${role}-heading`}>{role === "codex" ? "Codex" : "Claude"}</h2>
          </div>
        </div>
        <BillingChip status={run.billing[role]} />
      </header>
      <p class="state-line">
        <span class="state-dot" aria-hidden="true" /> {worker.state.replaceAll("_", " ")}
        {worker.activity ? ` — ${worker.activity}` : ""}
      </p>
      <p class="model-line">
        Model:{" "}
        {identity?.model ? (
          <code>{identity.model}</code>
        ) : (
          "not yet reported"
        )}
        {" · reasoning "}
        {identity?.effort ?? "CLI default"}
      </p>
      {worker.waitingLease ? (
        <p class="notice">
          {worker.waitingLease.resources?.length
            ? `Waiting for exclusive ${worker.waitingLease.resources.join(", ")} held by `
            : "Waiting for lease held by "}
          {worker.waitingLease.holder}: {worker.waitingLease.reason}
        </p>
      ) : null}
      <details class="activity-feed" open>
        <summary>Live activity ({feed.length})</summary>
        {feed.length ? (
          <ol class="activity-list" aria-label={`${role} live activity`}>
            {feed.map((entry) => (
              <li key={entry.seq} class={`activity-${entry.kind}`}>
                <span class="activity-kind" aria-hidden="true">
                  {entry.kind === "tool" ? "⚙" : entry.kind === "text" ? "❝" : "·"}
                </span>
                <span class="activity-summary">{entry.summary}</span>
                <time dateTime={entry.ts}>
                  {new Date(entry.ts).toLocaleTimeString()}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p class="empty-copy">
            Nothing yet this session. Tool calls and messages appear here the
            moment the provider acts.
          </p>
        )}
      </details>
      <details class="packet-feed">
        <summary>Work packets ({packets.length})</summary>
        <ol class="packet-list" aria-label={`${role} public work packets`}>
          {packets.map((packet) => (
              <li key={packet.id}>
                <strong class="packet-type">{packet.type}</strong>
                <p>{packet.rationale}</p>
                <small>{packet.provenance.join(" · ")}</small>
              </li>
            ))}
        </ol>
        {!packets.length ? (
          <p class="empty-copy">Waiting for this provider’s first public work packet.</p>
        ) : null}
      </details>
    </section>
  );
}

function ActionDrawer({
  actions,
  onRetry,
  onAction,
}: {
  actions: ActionCard[];
  onRetry: (agent: ProviderRole) => void;
  onAction: (card: ActionCard, label: string, details?: string) => void;
}) {
  const [details, setDetails] = useState<Record<string, string>>({});
  // Cancelling from a reconciliation card ends the whole run; require a
  // second, explicitly labelled click so a cleanup-minded click cannot
  // kill a healthy collaboration.
  const [armedCancel, setArmedCancel] = useState<string | null>(null);
  return (
    <aside class="actions" aria-labelledby="actions-heading">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Blocking the selected run</p>
          <h2 id="actions-heading">Action needed ({actions.length})</h2>
        </div>
        <span class="action-count" aria-hidden="true">
          {actions.length}
        </span>
      </div>
      {!actions.length ? <p>No user action is currently required.</p> : null}
      {actions.map((action) => (
        <article key={action.id} class="action-card">
          <h3>{action.title}</h3>
          <p>{action.body}</p>
          {action.command ? (
            <p>
              <strong>Command/tool:</strong> <code>{action.command}</code>
            </p>
          ) : null}
          {action.paths?.length ? (
            <p>
              <strong>Paths:</strong> {action.paths.join(", ")}
            </p>
          ) : null}
          {action.requiresDetailsFor?.length ? (
            <label class="action-details">
              {action.detailsLabel ?? "Details"}
              <textarea
                value={details[action.id] ?? ""}
                required
                rows={4}
                onInput={(event) =>
                  setDetails((current) => ({
                    ...current,
                    [action.id]: event.currentTarget.value,
                  }))
                }
              />
              <small>
                Required for: {action.requiresDetailsFor.join(", ")}.
              </small>
            </label>
          ) : null}
          <div class="button-row">
            {action.actions.map((label) => {
              const guardedCancel =
                label === "Cancel" && action.kind === "uncertain_effect";
              const armed = guardedCancel && armedCancel === action.id;
              return (
                <button
                  key={label}
                  type="button"
                  class={armed ? "danger" : undefined}
                  onClick={() => {
                    if (label === "Retry preflight" && action.agent) {
                      onRetry(action.agent);
                      return;
                    }
                    if (guardedCancel && !armed) {
                      setArmedCancel(action.id);
                      return;
                    }
                    setArmedCancel(null);
                    onAction(action, label, details[action.id] ?? "");
                  }}
                  disabled={
                    action.requiresDetailsFor?.includes(label) === true &&
                    !(details[action.id] ?? "").trim()
                  }
                >
                  {armed ? "Click again to cancel the whole run" : label}
                </button>
              );
            })}
          </div>
        </article>
      ))}
    </aside>
  );
}

export function App() {
  const [csrf, setCsrf] = useState("");
  const [runs, setRuns] = useState<RunProjection[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // fatalError is reserved for a dead session (bootstrap failure): nothing
  // can render without it. Every later failure is a dismissible notice on
  // top of a still-working dashboard.
  const [fatalError, setFatalError] = useState("");
  const [notice, setNotice] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [workspacePickerError, setWorkspacePickerError] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [readableRootsText, setReadableRootsText] = useState("");
  const [readableRootsTouched, setReadableRootsTouched] = useState(false);

  // Agents almost always need to at least read the folder enclosing the
  // workspace (monorepo root, sibling docs). Suggest it automatically so
  // the common case needs no typing; the user can clear or replace it.
  function applyWorkspace(path: string): void {
    setWorkspace(path);
    if (readableRootsTouched) return;
    const trimmed = path.replace(/\/+$/, "");
    const parent = trimmed.split("/").slice(0, -1).join("/");
    setReadableRootsText(parent.includes("/") && parent !== "" ? parent : "");
  }
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [advisorSetupEnabled, setAdvisorSetupEnabled] = useState(false);
  const [exportOutcome, setExportOutcome] = useState<{
    runId: string;
    destination: string;
  } | null>(null);
  const [resourceState, setResourceState] = useState<{
    degraded: boolean;
    reason: string | null;
    legacyTasksEnabled: boolean;
  }>({ degraded: false, reason: null, legacyTasksEnabled: false });
  const [legacyTasks, setLegacyTasks] = useState<LegacyTaskSummary[]>([]);
  const [legacyTask, setLegacyTask] = useState<LegacyTaskDetail | null>(null);
  const [advisorView, setAdvisorView] = useState<AdvisorView | null>(null);
  const [activity, setActivity] = useState<AgentActivityEntry[]>([]);
  const [identity, setIdentity] = useState<Record<string, AgentModelIdentity>>({});
  const selected = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? runs.at(0) ?? null,
    [runs, selectedRunId],
  );
  const creatorVisible = creatorOpen || !selected;

  // Backfill the transient live feed whenever the selected run changes; SSE
  // keeps it current afterwards (entries dedupe by seq).
  useEffect(() => {
    const runId = selected?.runId;
    if (!runId || !csrf) return;
    let cancelled = false;
    fetch(`/api/runs/${encodeURIComponent(runId)}/activity`, {
      credentials: "same-origin",
    })
      .then(async (response) =>
        response.ok ? response.json() : { entries: [], identity: {} },
      )
      .then(
        (body: {
          entries: AgentActivityEntry[];
          identity: Partial<Record<ProviderRole, AgentModelIdentity>>;
        }) => {
          if (cancelled) return;
          const entries = body.entries ?? [];
          if (entries.length) {
            setActivity((current) => {
              const seen = new Set(current.map((entry) => entry.seq));
              const merged = [
                ...current,
                ...entries.filter((entry) => !seen.has(entry.seq)),
              ];
              merged.sort((left, right) => left.seq - right.seq);
              return merged.slice(-800);
            });
          }
          for (const item of Object.values(body.identity ?? {})) {
            if (!item) continue;
            setIdentity((current) => ({
              ...current,
              [`${item.runId}:${item.role}`]: item,
            }));
          }
        },
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected?.runId, csrf]);
  const advisorEnabled = selected?.goal?.advisor?.enabled === true;
  const advisorTriggerCount = selected?.advisor?.triggerCount ?? 0;
  const verdictVerification = selected?.candidate?.manifest.verification ?? [];
  const verdictVerificationPassed = verdictVerification.filter(
    (entry) => entry.outcome === "passed",
  ).length;
  const verdictSignedRoles = (["codex", "claude"] as const).filter(
    (role) => selected?.signoffs?.[role],
  );
  // Consumed reactive wake units, mirroring AdvisorService.consumedWakeUnits:
  // only wakes that reached a guarded model start, and never the reserved
  // retrospective. advisorUsage.wakeCount counts every claimed wake (including
  // the retrospective and wakes that consumed no unit), so rendering it
  // against the reactive budget overstates consumption.
  const reactiveWakesUsed = (advisorView?.ledger ?? []).filter((row) => {
    const payload = row.payload as { modelStarted?: boolean; purpose?: string };
    return (
      row.kind === "wake_outcome" &&
      payload.modelStarted === true &&
      payload.purpose === "advisor_observation"
    );
  }).length;

  useEffect(() => {
    if (!selected || !advisorEnabled || !csrf) {
      setAdvisorView(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/runs/${encodeURIComponent(selected.runId)}/advisor`, {
      credentials: "same-origin",
    })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body) setAdvisorView(body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  // Adviser ledger writes live in the sidecar, so their completion does not
  // advance the core projection sequence. The service still publishes a fresh
  // projection object after each wake; depending on that object ensures the
  // adviser view is refetched for same-sequence terminal outcomes.
  }, [selected, advisorEnabled, advisorTriggerCount, csrf]);

  async function askAdvisor(): Promise<void> {
    if (!selected) return;
    const response = await fetch(
      `/api/runs/${encodeURIComponent(selected.runId)}/advisor/ask`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Collab-CSRF": csrf,
        },
        body: "{}",
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setNotice(describeError(body.error, "The adviser request could not be recorded."));
    }
  }

  async function refresh(): Promise<void> {
    const [response, systemResponse] = await Promise.all([
      fetch("/api/runs", { credentials: "same-origin" }),
      fetch("/api/system", { credentials: "same-origin" }),
    ]);
    if (!response.ok || !systemResponse.ok) throw new Error("Unable to load collaboration history.");
    const [next, system] = await Promise.all([response.json(), systemResponse.json()]);
    setRuns(next);
    setResourceState(system);
    if (system.legacyTasksEnabled) {
      const legacyResponse = await fetch("/api/legacy-tasks", {
        credentials: "same-origin",
      });
      if (!legacyResponse.ok) {
        throw new Error("Unable to load the configured legacy task root.");
      }
      setLegacyTasks(await legacyResponse.json());
    } else {
      setLegacyTasks([]);
      setLegacyTask(null);
    }
    setSelectedRunId(
      (current) =>
        current ??
        (next as RunProjection[]).find((run) => run.actions.length > 0)?.runId ??
        (next as RunProjection[]).at(0)?.runId ??
        null,
    );
  }

  useEffect(() => {
    let events: EventSource | null = null;
    bootstrap()
      .then(async (token) => {
        setCsrf(token);
        await refresh();
        events = new EventSource("/api/events", { withCredentials: true });
        events.addEventListener("projection", (event) => {
          const projection = JSON.parse((event as MessageEvent).data) as RunProjection;
          setRuns((current) => [
            projection,
            ...current.filter((run) => run.runId !== projection.runId),
          ]);
        });
        events.addEventListener("activity", (event) => {
          const entry = JSON.parse((event as MessageEvent).data) as AgentActivityEntry;
          setActivity((current) => {
            if (current.some((existing) => existing.seq === entry.seq)) return current;
            return [...current.slice(-799), entry];
          });
        });
        events.addEventListener("identity", (event) => {
          const item = JSON.parse((event as MessageEvent).data) as AgentModelIdentity;
          setIdentity((current) => ({
            ...current,
            [`${item.runId}:${item.role}`]: item,
          }));
        });
      })
      .catch((caught) =>
        setFatalError(caught instanceof Error ? caught.message : String(caught)),
      );
    return () => events?.close();
  }, []);

  async function createRun(event: Event): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const perProvider = Number(form.get("perProvider"));
    const perMaterialChallenge = Number(form.get("perMaterialChallenge"));
    const budgets = {
      ...(Number.isInteger(perProvider) && perProvider > 0 ? { perProvider } : {}),
      ...(Number.isInteger(perMaterialChallenge) && perMaterialChallenge > 0
        ? { perMaterialChallenge }
        : {}),
    };
    const attachmentPaths = String(form.get("attachmentPaths") ?? "")
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    const readableRoots = String(form.get("readableRoots") ?? "")
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    const maxDurationMinutes = Number(form.get("maxDurationMinutes"));
    const response = await fetch("/api/runs", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Collab-CSRF": csrf,
      },
      body: JSON.stringify({
        goal: form.get("goal"),
        workspace: form.get("workspace"),
        ...(Object.keys(budgets).length ? { budgets } : {}),
        attachmentPaths,
        readableRoots,
        permissionPreset: form.get("permissionPreset"),
        stopConditions: {
          maxDurationMinutes:
            Number.isFinite(maxDurationMinutes) && maxDurationMinutes > 0
              ? maxDurationMinutes
              : null,
        },
        resourceMode: form.get("resourceMode"),
        ...(form.get("advisorEnabled") === "true"
          ? {
              advisor: {
                enabled: true,
                provider: form.get("advisorProvider"),
                effort: form.get("advisorEffort"),
              },
            }
          : {}),
        mode:
          new URLSearchParams(window.location.search).get("adapter") === "fake"
            ? "fake"
            : "real",
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setNotice(describeError(body.error, "Unable to start collaboration."));
      return;
    }
    // Fake/demo execution can publish its projection over SSE before the
    // create response resolves. Upsert by runId so that race cannot duplicate
    // a run in the persistent history list.
    setRuns((current) => [
      body,
      ...current.filter((run) => run.runId !== body.runId),
    ]);
    setSelectedRunId(body.runId);
    setCreatorOpen(false);
  }

  async function chooseWorkspace(): Promise<void> {
    setWorkspacePickerError("");
    setWorkspacePickerOpen(true);
    try {
      const response = await fetch("/api/workspace/pick", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Collab-CSRF": csrf,
        },
        body: "{}",
      });
      const body = await response.json();
      if (!response.ok) {
        const messages: Record<string, string> = {
          DIRECTORY_PICKER_BUSY: "A folder chooser is already open.",
          DIRECTORY_PICKER_FAILED:
            "The folder chooser could not be opened. Enter the absolute path instead.",
          DIRECTORY_PICKER_UNAVAILABLE:
            "No native folder chooser is available. Enter the absolute path instead.",
          DIRECTORY_PICKER_UNSUPPORTED_PLATFORM:
            "This system does not provide a supported folder chooser. Enter the absolute path instead.",
        };
        setWorkspacePickerError(
          messages[String(body.error)] ?? "Unable to choose a folder. Enter the absolute path instead.",
        );
        return;
      }
      if (!body.canceled && typeof body.path === "string") {
        applyWorkspace(body.path);
      }
    } catch {
      setWorkspacePickerError(
        "The local service could not open the folder chooser. Enter the absolute path instead.",
      );
    } finally {
      setWorkspacePickerOpen(false);
    }
  }

  async function selectLegacyTask(id: string): Promise<void> {
    const response = await fetch(
      `/api/legacy-tasks/${encodeURIComponent(id)}`,
      { credentials: "same-origin" },
    );
    const body = await response.json();
    if (!response.ok) {
      setNotice(describeError(body.error, "Unable to load the legacy task."));
      return;
    }
    setLegacyTask(body);
  }

  async function retryPreflight(provider: ProviderRole): Promise<void> {
    if (!selected) return;
    const response = await fetch(`/api/runs/${selected.runId}/retry-preflight`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Collab-CSRF": csrf,
      },
      body: JSON.stringify({ provider }),
    });
    if (!response.ok) setNotice("Preflight retry failed.");
  }

  async function decideAction(
    card: ActionCard,
    action: string,
    details?: string,
  ): Promise<void> {
    if (!selected) return;
    const response = await fetch(
      `/api/runs/${encodeURIComponent(selected.runId)}/actions/${encodeURIComponent(card.id)}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Collab-CSRF": csrf,
        },
        body: JSON.stringify({ action, details }),
      },
    );
    const body = await response.json();
    if (!response.ok) {
      setNotice(describeError(body.error, "The requested action could not be applied."));
      return;
    }
    setRuns((current) => [
      body,
      ...current.filter((run) => run.runId !== body.runId),
    ]);
  }

  async function exportRun(): Promise<void> {
    if (!selected) return;
    const response = await fetch(`/api/runs/${encodeURIComponent(selected.runId)}/export`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Collab-CSRF": csrf,
      },
      body: "{}",
    });
    const body = await response.json();
    if (!response.ok) {
      setNotice(describeError(body.error, "Unable to export the collaboration."));
      return;
    }
    setExportOutcome({ runId: selected.runId, destination: body.destination });
  }

  async function cancelRun(): Promise<void> {
    if (!selected) return;
    const response = await fetch(`/api/runs/${encodeURIComponent(selected.runId)}/cancel`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Collab-CSRF": csrf,
      },
      body: "{}",
    });
    const body = await response.json();
    if (!response.ok) {
      setNotice(describeError(body.error, "Unable to cancel the collaboration."));
      return;
    }
    setRuns((current) => [
      body,
      ...current.filter((run) => run.runId !== body.runId),
    ]);
  }

  if (fatalError) {
    return (
      <main class="shell">
        <h1>Collaboration dashboard</h1>
        <div role="alert" class="error">
          {fatalError}
        </div>
      </main>
    );
  }

  return (
    <main class="shell">
      <header class="masthead">
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true">
            <span>C</span>
            <span>A</span>
          </span>
          <div>
            <p class="eyebrow">Local-first · Two-provider collaboration</p>
            <h1>Codex + Claude</h1>
            <p class="masthead-copy">
              One workspace, two independent perspectives, one verified outcome.
            </p>
          </div>
        </div>
        <span class="local-badge">
          <span aria-hidden="true" /> Loopback only
        </span>
      </header>
      {notice ? (
        <div role="alert" class="notice-banner">
          <p>{notice}</p>
          <button type="button" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      {resourceState.degraded ? (
        <div class="resource-banner" role="status">
          Degraded mode is active. New heavy work is paused and agents will serialize at the next
          safe boundary. {resourceState.reason}
        </div>
      ) : null}

      <div class={selected ? "dashboard-layout" : "dashboard-layout dashboard-layout-empty"}>
      <section
        class={creatorVisible ? "new-run new-run-open" : "new-run new-run-collapsed"}
        aria-labelledby="new-run-heading"
      >
        <div class="section-heading new-run-heading">
          <div>
            <p class="eyebrow">Start something new</p>
            <h2 id="new-run-heading">New collaboration</h2>
          </div>
          {selected ? (
            <button
              type="button"
              class="composer-toggle"
              aria-expanded={creatorVisible}
              onClick={() => setCreatorOpen((open) => !open)}
            >
              {creatorVisible ? "Close" : "Create run"}
            </button>
          ) : null}
        </div>
        {creatorVisible ? (
          <>
            <p class="section-copy">
              Choose a local workspace and describe the outcome. The safe defaults handle the rest.
            </p>
            <form onSubmit={createRun}>
          <div class="workspace-field">
            <label for="workspace">Project or workspace</label>
            <div class="workspace-picker-row">
              <input
                id="workspace"
                name="workspace"
                type="text"
                required
                placeholder="/path/to/project"
                value={workspace}
                onInput={(event) => applyWorkspace(event.currentTarget.value)}
                aria-describedby={
                  workspacePickerError
                    ? "workspace-help workspace-picker-error"
                    : "workspace-help"
                }
              />
              <button
                type="button"
                class="choose-folder"
                onClick={chooseWorkspace}
                disabled={!csrf || workspacePickerOpen}
              >
                {workspacePickerOpen ? "Choosing…" : "Choose folder…"}
              </button>
            </div>
            <small id="workspace-help">
              Choose a folder from this computer, or enter its absolute path.
            </small>
            {workspacePickerError ? (
              <small id="workspace-picker-error" class="field-error">
                {workspacePickerError}
              </small>
            ) : null}
          </div>
          <label>
            What should Codex and Claude accomplish together?
            <textarea name="goal" rows={4} required />
          </label>
          <details class="advanced-settings">
            <summary>Advanced settings</summary>
            <p class="settings-intro">
              Default: workspace-write asks on first mutation, network off,
              automatic resource scheduling, 4 challenge bursts, and 24 provider bursts.
            </p>
            <fieldset class="settings-group">
              <legend>Execution boundaries</legend>
              <div class="settings-grid">
                <label>
                  Permission preset
                  <select name="permissionPreset">
                    <option value="auto" selected>
                      Auto — workspace commands run without asking (recommended)
                    </option>
                    <option value="default">Ask — approve each workspace mutation</option>
                    <option value="read_only">Read-only — mechanically deny mutations</option>
                  </select>
                  <small>
                    Auto still asks before anything destructive, network-touching,
                    installing, or outside the workspace.
                  </small>
                </label>
                <label>
                  Resource mode
                  <select name="resourceMode">
                    <option value="automatic">Automatic — parallel unless pressure requires serialization</option>
                    <option value="serialized">Serialized — run only one provider burst at a time</option>
                  </select>
                </label>
                <label>
                  Stop after provider work (minutes, optional)
                  <input
                    name="maxDurationMinutes"
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                  />
                </label>
              </div>
            </fieldset>
            <fieldset class="settings-group">
              <legend>Context and budgets</legend>
              <div class="settings-grid">
                <label class="settings-wide">
                  Attachments (one workspace-contained path per line)
                  <textarea
                    name="attachmentPaths"
                    rows={3}
                    placeholder={"requirements.md\nreferences/example.png"}
                  />
                  <small>
                    Stored as path, size, media type, and SHA-256 references; file bytes are not copied
                    into the event store.
                  </small>
                </label>
                <label class="settings-wide">
                  Additional read-only folders (one absolute path per line, optional)
                  <textarea
                    name="readableRoots"
                    rows={2}
                    placeholder={"/path/to/monorepo-root"}
                    value={readableRootsText}
                    onInput={(event) => {
                      setReadableRootsTouched(true);
                      setReadableRootsText(event.currentTarget.value);
                    }}
                  />
                  <small>
                    Prefilled with the folder above the workspace so parent-repo
                    reads need no approval. Reads here proceed without a card;
                    writing stays limited to the workspace.
                  </small>
                </label>
                <label>
                  Useful-work bursts per provider (default 24)
                  <input name="perProvider" type="number" min={1} max={200} step={1} />
                </label>
                <label>
                  Bursts per material challenge (default 4)
                  <input name="perMaterialChallenge" type="number" min={1} max={50} step={1} />
                </label>
              </div>
            </fieldset>
            <fieldset class="settings-group advisor-settings">
              <legend>Optional adviser</legend>
              <label class="toggle-row">
                <input
                  name="advisorEnabled"
                  type="checkbox"
                  value="true"
                  checked={advisorSetupEnabled}
                  onChange={(event) => setAdvisorSetupEnabled(event.currentTarget.checked)}
                />
                <span>
                  Enable the advisory supervisor
                  <small>
                    Off by default. It observes the run and writes event-linked notes with zero authority.
                  </small>
                </span>
              </label>
              {advisorSetupEnabled ? (
                <div class="settings-grid advisor-options">
                  <label>
                    Adviser provider
                    <select name="advisorProvider">
                      <option value="claude">Claude (default)</option>
                      <option value="codex">Codex</option>
                    </select>
                  </label>
                  <label>
                    Adviser effort
                    <select name="advisorEffort">
                      <option value="high">Strong (high effort, default)</option>
                      <option value="medium">Medium — economize</option>
                    </select>
                  </label>
                </div>
              ) : null}
            </fieldset>
            <p class="settings-footnote">
              Starting a normal collaboration authorizes bounded provider turns only after both
              subscription billing routes are proven. The dashboard labels allowance versus
              existing-credit usage before the first turn.
            </p>
          </details>
              <button class="primary" type="submit" disabled={!csrf}>
                Start collaboration
              </button>
            </form>
          </>
        ) : (
          <p class="creator-hint">The active run stays in focus. Open this panel when you need another.</p>
        )}
      </section>

      {resourceState.legacyTasksEnabled ? (
        <section class="legacy-browser" aria-labelledby="legacy-heading">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Configured root · zero writes</p>
              <h2 id="legacy-heading">Legacy task folders</h2>
            </div>
            <span class="chip">Read-only</span>
          </div>
          {legacyTasks.length ? (
            <div class="legacy-layout">
              <nav aria-label="Legacy tasks">
                <ol class="legacy-list">
                  {legacyTasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        class={
                          legacyTask?.id === task.id
                            ? "legacy-item legacy-item-selected"
                            : "legacy-item"
                        }
                        aria-current={
                          legacyTask?.id === task.id ? "true" : undefined
                        }
                        onClick={() => selectLegacyTask(task.id)}
                      >
                        <strong>{task.name}</strong>
                        <span>{task.goal}</span>
                        <small>
                          {task.status ?? "status unavailable"} · {task.fileCount} files
                        </small>
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
              {legacyTask ? (
                <article class="legacy-detail" aria-labelledby="legacy-detail-heading">
                  <p class="eyebrow">Historical task · read-only</p>
                  <h3 id="legacy-detail-heading">{legacyTask.name}</h3>
                  <h4>Goal</h4>
                  <p>{legacyTask.goal}</p>
                  <h4>State</h4>
                  <pre>{JSON.stringify(legacyTask.state, null, 2)}</pre>
                  <h4>Notes</h4>
                  {legacyTask.notes.length ? (
                    legacyTask.notes.map((note) => (
                      <details key={note.name}>
                        <summary>{note.name}</summary>
                        <pre>{note.content}</pre>
                      </details>
                    ))
                  ) : (
                    <p>No legacy notes file was found.</p>
                  )}
                  <h4>Transcript</h4>
                  <pre>{legacyTask.transcript || "No transcript was found."}</pre>
                  <h4>Final plan</h4>
                  <pre>{legacyTask.finalPlan || "No final plan was found."}</pre>
                  <h4>Artifacts and files</h4>
                  <ul class="legacy-files">
                    {legacyTask.files.map((file) => (
                      <li key={file.path}>
                        <code>{file.path}</code> · {file.size} bytes ·{" "}
                        <code>{file.sha256}</code>
                      </li>
                    ))}
                  </ul>
                </article>
              ) : (
                <p>Select a historical task to inspect its immutable contents.</p>
              )}
            </div>
          ) : (
            <p>No task folders were found under the configured legacy root.</p>
          )}
        </section>
      ) : null}

      {runs.length ? (
        <nav class="run-list" aria-labelledby="run-list-heading">
          <h2 id="run-list-heading">Collaboration runs</h2>
          <ol>
            {runs.map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  class={run.runId === selected?.runId ? "run-item run-item-selected" : "run-item"}
                  aria-current={run.runId === selected?.runId ? "true" : undefined}
                  onClick={() => setSelectedRunId(run.runId)}
                >
                  <span class="run-item-goal">{run.goal?.goal ?? run.runId}</span>
                  <span class="run-item-state">{run.state.replaceAll("_", " ")}</span>
                  <span class={run.actions.length ? "run-item-pending" : "run-item-quiet"}>
                    {run.actions.length
                      ? `Action needed (${run.actions.length})`
                      : "No action needed"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      {selected ? (
        <div class="run-workspace">
          <section class="run-header" aria-labelledby="run-goal-heading">
            <div class="run-title-row">
              <div>
                <p class="eyebrow">Active collaboration</p>
                <h2 id="run-goal-heading">{selected.goal?.goal}</h2>
              </div>
              <div class="run-primary-actions">
                <span class="chip state-chip">{selected.state.replaceAll("_", " ")}</span>
                {!selected.completedAt ? (
                  <button type="button" onClick={cancelRun}>
                    Cancel
                  </button>
                ) : (
                  <button type="button" onClick={exportRun}>
                    Export run
                  </button>
                )}
              </div>
            </div>
            <div class="run-snapshot" aria-label="Collaboration snapshot">
              <div>
                <span>Codex</span>
                <strong>{selected.workers.codex.state.replaceAll("_", " ")}</strong>
              </div>
              <div>
                <span>Claude</span>
                <strong>{selected.workers.claude.state.replaceAll("_", " ")}</strong>
              </div>
              <div>
                <span>Action queue</span>
                <strong>
                  {selected.actions.length
                    ? `${selected.actions.length} waiting`
                    : "Clear"}
                </strong>
              </div>
              <div>
                <span>Shared outcome</span>
                <strong>
                  {selected.candidate
                    ? "Candidate ready"
                    : selected.completedAt
                      ? "Completed"
                      : "In progress"}
                </strong>
              </div>
            </div>
            {exportOutcome && exportOutcome.runId === selected.runId ? (
              <p class="export-note">
                Exported events, transcript, and projection with checksums to{" "}
                <code>{exportOutcome.destination}</code>
              </p>
            ) : null}
            <details class="run-details">
              <summary>
                <span>Run details</span>
                <small>Permissions, resources, limits, and diagnostics</small>
              </summary>
              <div class="run-details-body">
                <div class="run-meta">
                  <span
                    class={
                      selected.overhead == null
                        ? "chip"
                        : selected.overhead.passed
                          ? "chip chip-overhead-pass"
                          : selected.overhead.provisional
                            ? "chip chip-overhead-provisional-fail"
                            : "chip chip-overhead-fail"
                    }
                    title={
                      selected.overhead
                        ? `${selected.overhead.gateVersion ?? "overhead gate"}: ${
                            selected.overhead.workerBurstCount ?? 0
                          } worker bursts; coordination tokens ${
                            selected.overhead.coordinationTokenUpper ?? 0
                          }; mixed coordinator bytes ${
                            selected.overhead.mixedCoordinatorBytes ?? 0
                          } of ${selected.overhead.absoluteAllowanceBytes ?? 0} allowed`
                        : undefined
                    }
                  >
                    Worker-loop overhead:{" "}
                    {selected.overhead?.ratio != null
                      ? `${selected.overhead.ratio.toFixed(4)}×`
                      : selected.overhead
                        ? "no positive useful-work bound yet"
                        : "no usage yet"}
                    {selected.overhead
                      ? selected.overhead.passed
                        ? selected.overhead.passedBy === "absolute"
                          ? " · within the small-run byte allowance"
                          : " · within 1.05×"
                        : selected.overhead.provisional
                          ? " · provisional — may still recover"
                          : " · gate failed"
                      : ""}
                  </span>
                  <span class="chip">
                    Sandbox:{" "}
                    {selected.goal?.authority.permissionPreset === "read_only"
                      ? "read-only"
                      : selected.goal?.authority.permissionPreset === "auto"
                        ? "auto workspace-write"
                        : "workspace-write"}
                  </span>
                  <span class="chip">
                    Resources: {selected.goal?.resourceMode ?? "automatic"}
                  </span>
                  {selected.goal?.stopConditions?.maxDurationMinutes ? (
                    <span class="chip">
                      Stop: {selected.goal.stopConditions.maxDurationMinutes} min
                    </span>
                  ) : null}
                </div>
                {selected.overheadNotice ? (
                  <p class="overhead-notice">
                    Worker-loop overhead gate breached at a stable boundary (
                    {selected.overheadNotice.boundary.replaceAll("_", " ")}):{" "}
                    {selected.overheadNotice.ratio != null
                      ? `${selected.overheadNotice.ratio.toFixed(4)}× of the 1.05× ceiling`
                      : "no positive useful-work lower bound"}
                    , {selected.overheadNotice.mixedCoordinatorBytes} coordinator
                    bytes of {selected.overheadNotice.absoluteAllowanceBytes}{" "}
                    allowed across {selected.overheadNotice.workerBurstCount} worker
                    bursts. This notice is informational and required no action;
                    the run was never interrupted by it.
                  </p>
                ) : null}
                {selected.goal?.attachments?.length ? (
                  <details class="run-attachments">
                    <summary>
                      Attachments ({selected.goal.attachments.length} immutable references)
                    </summary>
                    <ul>
                      {selected.goal.attachments.map((attachment) => (
                        <li key={`${attachment.path}:${attachment.sha256}`}>
                          <code>{attachment.path}</code> · {attachment.size} bytes ·{" "}
                          {attachment.mediaType} · <code>{attachment.sha256}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            </details>
          </section>
          {selected.actions.length ? (
            <ActionDrawer
              actions={selected.actions}
              onRetry={retryPreflight}
              onAction={decideAction}
            />
          ) : null}
          {selected.completedAt ? (
            <section
              class={`verdict verdict-${selected.state}`}
              aria-labelledby="verdict-heading"
            >
              <p class="eyebrow">Conclusion</p>
              {selected.state === "completed_consensus" ? (
                <>
                  <h2 id="verdict-heading">
                    Consensus reached — both models signed the same result
                  </h2>
                  <p>
                    Codex and Claude finished this goal together: one implemented,
                    the other independently reviewed and verified, and both signed
                    the identical outcome manifest. Nothing here required trust in
                    either model’s self-report — every claim below was checked by
                    the other side.
                  </p>
                  {selected.candidate ? (
                    <ul class="verdict-facts">
                      <li>
                        <strong>
                          {selected.candidate.manifest.artifacts.length}
                        </strong>{" "}
                        files delivered in the workspace
                      </li>
                      <li>
                        <strong>
                          {verdictVerificationPassed}/{verdictVerification.length}
                        </strong>{" "}
                        verification checks passed
                      </li>
                      <li>
                        <strong>
                          {selected.candidate.manifest.evidenceLedger.length}
                        </strong>{" "}
                        evidence entries ·{" "}
                        <strong>
                          {selected.candidate.manifest.knownLimitations.length}
                        </strong>{" "}
                        known limitations recorded honestly
                      </li>
                      <li>
                        Signed by{" "}
                        <strong>{verdictSignedRoles.join(" and ") || "—"}</strong>
                      </li>
                    </ul>
                  ) : null}
                  {selected.candidate?.manifest.artifacts.length ? (
                    <div class="verdict-artifacts">
                      <h3>What they delivered</h3>
                      <ul>
                        {selected.candidate.manifest.artifacts
                          .slice(0, 8)
                          .map((artifact) => (
                            <li key={`verdict-${artifact.path}`}>
                              <code>{artifact.path}</code>
                            </li>
                          ))}
                        {selected.candidate.manifest.artifacts.length > 8 ? (
                          <li>
                            …and{" "}
                            {selected.candidate.manifest.artifacts.length - 8} more
                            in the shared outcome section below.
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}
                  {verdictSignedRoles.some(
                    (role) => selected.signoffs?.[role]?.rationale,
                  ) ? (
                    <div class="verdict-rationales">
                      <h3>Why each model signed</h3>
                      {verdictSignedRoles.map((role) =>
                        selected.signoffs?.[role]?.rationale ? (
                          <p key={`rationale-${role}`}>
                            <strong>{role === "codex" ? "Codex" : "Claude"}:</strong>{" "}
                            {selected.signoffs[role]!.rationale}
                          </p>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                  <p class="verdict-next">
                    The delivered files are already live in your workspace — no
                    further action is needed to apply them. Use “Export run” above
                    for the complete audited record (events, transcript,
                    checksums), or start a new collaboration for the next goal.
                    Each model’s full analysis is in its lane’s work packets.
                  </p>
                </>
              ) : selected.state === "completed_disagreement" ? (
                <>
                  <h2 id="verdict-heading">
                    Ended with a recorded disagreement
                  </h2>
                  <p>
                    The models could not converge on one result. No consensus was
                    manufactured: both positions are preserved verbatim in the
                    work packets and in the export.
                  </p>
                </>
              ) : (
                <>
                  <h2 id="verdict-heading">Collaboration cancelled</h2>
                  <p>
                    The run ended before a shared outcome. Any workspace changes
                    made before cancellation remain on disk for inspection.
                  </p>
                </>
              )}
            </section>
          ) : null}
          <div class="lanes">
            <AgentLane
              role="codex"
              run={selected}
              activity={activity}
              identity={identity[`${selected.runId}:codex`]}
            />
            <AgentLane
              role="claude"
              run={selected}
              activity={activity}
              identity={identity[`${selected.runId}:claude`]}
            />
          </div>
          {advisorEnabled ? (
            <section class="lane advisor-lane" aria-labelledby="advisor-heading">
              <header>
                <div>
                  <p class="eyebrow">advisory supervisor · zero authority</p>
                  <h2 id="advisor-heading">Adviser</h2>
                </div>
                <span class="chip chip-advisor">
                  {selected.goal?.advisor?.provider === "codex" ? "Codex" : "Claude"}
                  {" · "}
                  {selected.goal?.advisor?.effort === "medium" ? "medium effort" : "strong (high effort)"}
                </span>
              </header>
              <p class="model-line">
                Model:{" "}
                {(() => {
                  const lastObservation = (advisorView?.ledger ?? [])
                    .filter((row) => row.kind === "observation")
                    .at(-1);
                  const payload = lastObservation?.payload as
                    | { model?: string; effort?: string }
                    | undefined;
                  return payload?.model ? (
                    <>
                      <code>{payload.model}</code>
                      {" · reasoning "}
                      {payload.effort ?? selected.goal?.advisor?.effort ?? "high"}
                      {" (provider default row, resolved per wake)"}
                    </>
                  ) : (
                    "resolved from the provider's default row at the first wake"
                  );
                })()}
              </p>
              <p class="state-line">
                Wakes used:{" "}
                {reactiveWakesUsed} of{" "}
                {(selected.goal?.advisor?.reactiveWakeUnits ?? 2) +
                  (selected.advisor?.extendedReactiveWakeUnits ?? 0)}{" "}
                reactive + {selected.goal?.advisor?.retrospectiveWakeUnits ?? 1}{" "}
                reserved retrospective · Triggers recorded:{" "}
                {selected.advisor?.triggerCount ?? 0}
              </p>
              <p class="state-line">
                Adviser usage: {advisorView?.accounting?.advisorUsage.totalTokens ?? 0}{" "}
                tokens (separate bucket; never part of the worker-loop overhead
                gate) · Combined informational ratio:{" "}
                {advisorView?.accounting?.combinedCoordinationRatio != null
                  ? `${advisorView.accounting.combinedCoordinationRatio.toFixed(4)}×`
                  : "n/a"}
              </p>
              <button
                type="button"
                onClick={askAdvisor}
                disabled={!csrf || Boolean(selected.completedAt)}
              >
                Ask the adviser
              </button>
              <ol class="packet-list" aria-label="Adviser observations">
                {(advisorView?.ledger ?? [])
                  .filter((row) => row.kind === "observation")
                  .map((row) => {
                    const output = (row.payload as any)?.output as
                      | {
                          observations?: Array<{
                            severity: string;
                            summary: string;
                            eventIds: string[];
                            recommendationCode?: string;
                          }>;
                        }
                      | undefined;
                    return (
                      <li key={`${row.seq}`}>
                        <strong>
                          wake {(row.wakeId ?? "").slice(0, 13)} ·{" "}
                          {String((row.payload as any)?.trigger?.kind ?? "observation")}
                        </strong>
                        {(output?.observations ?? []).map((observation, index) => (
                          <article
                            key={`${row.seq}-${index}`}
                            class="advisor-card"
                          >
                            <p>
                              [{observation.severity}] {observation.summary}
                            </p>
                            <small>
                              events: {observation.eventIds.join(", ") || "none"}
                              {observation.recommendationCode
                                ? ` · suggestion code: ${observation.recommendationCode}`
                                : ""}
                            </small>
                          </article>
                        ))}
                      </li>
                    );
                  })}
                {(advisorView?.ledger ?? [])
                  .filter((row) => row.kind === "failure")
                  .map((row) => (
                    <li key={`failure-${row.seq}`}>
                      <strong>adviser failure</strong>
                      <p>
                        {String((row.payload as any)?.code ?? "failure")} — the
                        worker run was not affected.
                      </p>
                    </li>
                  ))}
              </ol>
              {advisorView?.files?.length ? (
                <details>
                  <summary>Adviser note files (untrusted model output)</summary>
                  <ul>
                    {advisorView.files.map((file) => (
                      <li key={file.name}>
                        <code>{file.path}</code> · {file.size} bytes ·{" "}
                        <code>{file.sha256}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : null}
          <section class="outcome" aria-labelledby="outcome-heading">
            <p class="eyebrow">Shared outcome</p>
            <h2 id="outcome-heading">
              {selected.candidate ? "Candidate manifest" : "Collaboration in progress"}
            </h2>
            <dl>
              <div>
                <dt>Opening barrier</dt>
                <dd>{selected.barrierReleased ? "Released" : "Holding peer bytes"}</dd>
              </div>
              <div>
                <dt>Material challenges</dt>
                <dd>{Object.keys(selected.materialChallenges).length}</dd>
              </div>
              <div>
                <dt>Codex budget</dt>
                <dd>
                  {selected.budgets.provider.codex.consumed}/{selected.budgets.provider.codex.limit}
                </dd>
              </div>
              <div>
                <dt>Claude budget</dt>
                <dd>
                  {selected.budgets.provider.claude.consumed}/{selected.budgets.provider.claude.limit}
                </dd>
              </div>
            </dl>
            {selected.candidate ? (
              <details class="manifest-details">
                <summary>View candidate verification manifest</summary>
                <div class="manifest-body">
                  <h3>Artifacts</h3>
                  {selected.candidate.manifest.artifacts.length ? (
                    <ul>
                      {selected.candidate.manifest.artifacts.map((artifact) => (
                        <li key={`${artifact.path}:${artifact.sha256}`}>
                          <code>{artifact.path}</code> — {artifact.mediaType} —{" "}
                          <code>{artifact.sha256}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No artifact was declared.</p>
                  )}
                  <h3>Evidence ledger</h3>
                  {selected.candidate.manifest.evidenceLedger.length ? (
                    <ul>
                      {selected.candidate.manifest.evidenceLedger.map((entry, index) => (
                        <li key={`evidence-${index}`}>{entry}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>No evidence entries were recorded.</p>
                  )}
                  <h3>Verification ledger</h3>
                  <ul>
                    {selected.candidate.manifest.verification.map((entry, index) => (
                      <li key={`${entry.command}:${index}`}>
                        <strong>{entry.outcome}</strong> — <code>{entry.command}</code>
                        <p>{entry.evidence}</p>
                      </li>
                    ))}
                  </ul>
                  {selected.candidate.manifest.knownLimitations.length ? (
                    <>
                      <h3>Known limitations</h3>
                      <ul>
                        {selected.candidate.manifest.knownLimitations.map((limitation) => (
                          <li key={limitation}>{limitation}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <p>
                    <strong>Manifest digest:</strong>{" "}
                    <code>{selected.candidate.digest}</code>
                  </p>
                  <p>
                    <strong>Verification digest:</strong>{" "}
                    <code>{selected.candidate.verificationDigest}</code>
                  </p>
                </div>
              </details>
            ) : null}
          </section>
          <div class="sr-status" role="status" aria-live="polite">
            Collaboration state changed to {selected.state.replaceAll("_", " ")}.
          </div>
        </div>
      ) : (
        <section class="empty empty-start" aria-live="polite">
          <h2>No collaborations yet</h2>
          <p>
            Enter one goal above. Both providers must pass subscription and billing-route preflight
            before any model turn can start.
          </p>
        </section>
      )}
      </div>
    </main>
  );
}
