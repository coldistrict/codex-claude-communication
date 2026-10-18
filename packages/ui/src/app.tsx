import { PhaseTimeline, PlanningView } from "./planning-view.tsx";
import { Icon, PROVIDER_NAME, ProviderMark, StatusPill, formatClock, humanize, relativeTime, runStatus } from "./ui.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
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

type Theme = "system" | "light" | "dark";
const THEME_KEY = "collab.theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
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
        : "This browser's dashboard session is missing or expired. Open the full launch link shown when you start the app.",
    );
  }
  const body = await response.json();
  return body.csrf;
}

// HTTP replies and live events can arrive in either order. Accept same-sequence
// sidecar updates, but never let a delayed reply roll recorded progress back.
function mergeRun(runs: RunProjection[], incoming: RunProjection): RunProjection[] {
  if (!runs.some((run) => run.runId === incoming.runId)) return [incoming, ...runs];
  return runs.map((run) => run.runId === incoming.runId && incoming.seq >= run.seq ? incoming : run);
}

const ERROR_MESSAGES: Record<string, string> = {
  WORKSPACE_MUST_BE_ABSOLUTE: "Enter the full project path, choose a folder, or leave it blank.",
  WORKSPACE_NOT_DIRECTORY: "The project path must point to a folder. Choose a folder or leave it blank.",
  ENOENT: "A selected folder or file could not be found. Check the project path and selected files, or remove them to continue without that context.",
  ATTACHMENT_OUTSIDE_WORKSPACE: "Selected files must be inside the project folder. Check the paths under Context and limits.",
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

function billingLabel(status: BillingStatus | undefined): string {
  if (status?.simulated) return "Demo billing — not a proven route";
  if (!status) return "Preflight pending";
  return status.route === "subscription_allowance"
    ? "Subscription allowance"
    : status.route === "existing_credits"
      ? "Existing credits"
      : status.route === "blocked"
        ? "Billing blocked"
        : "Billing route unknown";
}

function BillingChip({ status }: { status: BillingStatus | undefined }) {
  const tone = status?.simulated
    ? "simulated"
    : status?.route === "subscription_allowance"
      ? "ok"
      : status?.route === "existing_credits"
        ? "warn"
        : status?.route === "blocked"
          ? "bad"
          : "muted";
  return (
    <span class={`chip chip-${tone}`} title={status?.proof.join("\n")}>
      {billingLabel(status)}
    </span>
  );
}

/* ---------- execution lanes ---------- */

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
  const working = worker.state === "working" && !run.completedAt;
  return (
    <section class={`card lane lane-${role}`} aria-labelledby={`${role}-heading`}>
      <header class="lane-head">
        <div class="provider-heading">
          <ProviderMark role={role} size="lg" />
          <div>
            <p class="eyebrow">{role}</p>
            <h2 id={`${role}-heading`}>{PROVIDER_NAME[role]}</h2>
          </div>
        </div>
        <BillingChip status={run.billing[role]} />
      </header>
      <p class="state-line">
        <span class={`state-dot${working ? " state-dot-live" : ""}`} aria-hidden="true" />
        <span>
          {humanize(worker.state)}
          {worker.activity ? ` — ${worker.activity}` : ""}
        </span>
      </p>
      <p class="model-line">
        Model: {identity?.model ? <code>{identity.model}</code> : "not yet reported"}
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
        <summary>
          Live activity <span class="count">{feed.length}</span>
        </summary>
        {feed.length ? (
          <ol class="activity-list" aria-label={`${role} live activity`}>
            {feed.map((entry) => (
              <li key={entry.seq} class={`activity-${entry.kind}`}>
                <span class="activity-kind" aria-hidden="true">
                  {entry.kind === "tool" ? "⚙" : entry.kind === "text" ? "❝" : "·"}
                </span>
                <span class="activity-summary">{entry.summary}</span>
                <time dateTime={entry.ts}>{formatClock(entry.ts)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p class="empty-copy">
            Nothing yet this session. Tool calls and messages appear here the moment the provider acts.
          </p>
        )}
      </details>
      <details class="packet-feed">
        <summary>
          Work packets <span class="count">{packets.length}</span>
        </summary>
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

/* ---------- action cards ---------- */

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
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, Record<string, string>>>({});
  const [armedCancel, setArmedCancel] = useState<string | null>(null);
  return (
    <aside class="card attention" aria-labelledby="actions-heading">
      <div class="attention-head">
        <span class="attention-icon" aria-hidden="true">
          {Icon.message({ size: 18 })}
        </span>
        <div>
          <p class="eyebrow">Paused for you</p>
          <h2 id="actions-heading">
            Your input is needed{actions.length > 1 ? ` (${actions.length})` : ""}
          </h2>
        </div>
      </div>
      {!actions.length ? <p>No user action is currently required.</p> : null}
      {actions.map((action) => (
        <article key={action.id} class="action-card">
          <div class="action-card-head">
            {action.agent ? <ProviderMark role={action.agent} size="sm" /> : null}
            <h3>{action.title}</h3>
          </div>
          <p class="action-body">{action.body}</p>
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
          {action.questions?.length ? (
            action.questions.map((question) => (
              <label key={question.id}>
                {question.question}
                <textarea
                  rows={2}
                  value={questionAnswers[action.id]?.[question.id] ?? ""}
                  onInput={(event) => {
                    const answers = {
                      ...questionAnswers[action.id],
                      [question.id]: event.currentTarget.value,
                    };
                    setQuestionAnswers((current) => ({ ...current, [action.id]: answers }));
                    setDetails((current) => ({
                      ...current,
                      [action.id]: action.questions!.every((q) => answers[q.id]?.trim())
                        ? JSON.stringify(answers)
                        : "",
                    }));
                  }}
                />
                {question.options?.length ? <small>Options: {question.options.join(" / ")}</small> : null}
              </label>
            ))
          ) : action.requiresDetailsFor?.length ? (
            <label class="action-details">
              {action.detailsLabel ?? "Details"}
              <textarea
                value={details[action.id] ?? ""}
                required
                rows={4}
                placeholder="Type your answer…"
                onInput={(event) =>
                  setDetails((current) => ({
                    ...current,
                    [action.id]: event.currentTarget.value,
                  }))
                }
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    const label = action.actions[0];
                    if (label && (details[action.id] ?? "").trim()) {
                      event.preventDefault();
                      onAction(action, label, details[action.id]);
                    }
                  }
                }}
              />
              <small>
                Required for: {action.requiresDetailsFor.join(", ")}. Press ⌘↵ to send.
              </small>
            </label>
          ) : null}
          <div class="button-row">
            {action.actions.map((label, index) => {
              const guardedCancel = label === "Cancel" && action.kind === "uncertain_effect";
              const armed = guardedCancel && armedCancel === action.id;
              const isCancel = label === "Cancel";
              return (
                <button
                  key={label}
                  type="button"
                  class={armed ? "btn btn-danger" : index === 0 && !isCancel ? "btn btn-primary" : "btn"}
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

/* ---------- composer ---------- */

function projectLabel(path: string): string { return path.split("/").filter(Boolean).at(-1) || "/"; }

interface ComposerProps {
  legacyDemo: boolean;
  csrf: string;
  workspace: string;
  recentProjects: string[];
  applyWorkspace: (path: string) => void;
  chooseWorkspace: () => void;
  workspacePickerOpen: boolean;
  workspacePickerError: string;
  readableRootsText: string;
  onReadableRoots: (value: string) => void;
  advisorSetupEnabled: boolean;
  setAdvisorSetupEnabled: (value: boolean) => void;
  onSubmit: (event: Event) => void;
  submitting: boolean;
  submitError: string;
}

function Composer(props: ComposerProps) {
  const {
    legacyDemo,
    csrf,
    workspace,
    recentProjects,
    applyWorkspace,
    chooseWorkspace,
    workspacePickerOpen,
    workspacePickerError,
    readableRootsText,
    onReadableRoots,
    advisorSetupEnabled,
    setAdvisorSetupEnabled,
    onSubmit,
    submitting,
    submitError,
  } = props;
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [goal, setGoal] = useState("");
  useLayoutEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);
  const workspaceField = (
      <div class="workspace-field">
        <div class="field-label-row">
          <label for="workspace">Project or workspace</label>
          <span class="field-hint">{legacyDemo ? "Workspace" : "Optional · session destination"}</span>
        </div>
        {!legacyDemo && recentProjects.length ? (
          <div>
            <label for="recent-project">Recent projects</label>
            <select id="recent-project" value={recentProjects.includes(workspace) ? workspace : ""} onChange={(event) => {
              if (event.currentTarget.value) applyWorkspace(event.currentTarget.value);
            }}>
              <option value="">Choose a recent project…</option>
              {recentProjects.map((path) => <option key={path} value={path}>{projectLabel(path)} — {path}</option>)}
            </select>
          </div>
        ) : null}
        <div class="workspace-picker-row">
          <input
            id="workspace"
            name="workspace"
            type="text"
            required={legacyDemo}
            placeholder={legacyDemo ? "/path/to/project" : "/path/to/project (optional)"}
            value={workspace}
            onInput={(event) => applyWorkspace(event.currentTarget.value)}
            aria-describedby={
              workspacePickerError ? "workspace-help workspace-picker-error" : "workspace-help"
            }
          />
          <button
            type="button"
            class="btn choose-folder"
            onClick={chooseWorkspace}
            disabled={!csrf || workspacePickerOpen}
          >
            {Icon.folder({ size: 15 })}
            {workspacePickerOpen ? "Choosing…" : "Choose folder…"}
          </button>
        </div>
        <small id="workspace-help">
          {legacyDemo
            ? "Choose a folder from this computer, or enter its absolute path."
            : "Use this folder for the collaboration and its provider sessions. Its README and selected text files are included as read-only evidence. This does not automatically place sessions in the Codex or Claude desktop project sidebar. Leave blank for a standalone collaboration."}
        </small>
        {workspacePickerError ? (
          <small id="workspace-picker-error" class="field-error">
            {workspacePickerError}
          </small>
        ) : null}
      </div>
  );
  return (
    <form class="composer" onSubmit={onSubmit} aria-busy={submitting}>
      {legacyDemo ? workspaceField : null}
      <label class="goal-field">
        {legacyDemo
          ? "What should Codex and Claude accomplish together?"
          : "What would you like help answering, deciding, or planning?"}
        <textarea
          ref={goalRef}
          name="goal"
          rows={5}
          required
          value={goal}
          onInput={(event) => setGoal(event.currentTarget.value)}
          placeholder={
            legacyDemo
              ? "Describe the outcome both providers should deliver in the workspace…"
              : "A question, a decision to make, a rough goal, or an existing proposal to pressure-test…"
          }
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
      </label>
      {!legacyDemo ? (
        <>
          {!goal ? (
            <div class="prompt-examples" role="group" aria-label="Ideas to get started">
              <span>Try a starting point</span>
              {[
                ["Make a plan", "Help me turn this goal into a practical plan: "],
                ["Compare options", "Help me compare these options and decide which fits best: "],
                ["Review an idea", "Review this idea, identify weak spots, and suggest improvements: "],
              ].map(([label, prompt]) => (
                <button type="button" class="btn btn-sm" onClick={() => {
                  setGoal(prompt!);
                  goalRef.current?.focus();
                }}>{label}</button>
              ))}
            </div>
          ) : null}
          {workspaceField}
        </>
      ) : null}
      {legacyDemo ? (
        <details class="advanced-settings">
          <summary>
            <span class="disclosure-chevron" aria-hidden="true">{Icon.chevron({ size: 14 })}</span>
            Advanced settings
          </summary>
          <p class="settings-intro">
            Default: workspace-write asks on first mutation, network off, automatic resource scheduling,
            4 challenge bursts, and 24 provider bursts.
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
                  Auto still asks before anything destructive, network-touching, installing, or outside
                  the workspace.
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
                <input name="maxDurationMinutes" type="number" min={1} max={1440} step={1} />
              </label>
            </div>
          </fieldset>
          <fieldset class="settings-group">
            <legend>Context and budgets</legend>
            <div class="settings-grid">
              <label class="settings-wide">
                Attachments (one workspace-contained path per line)
                <textarea name="attachmentPaths" rows={3} placeholder={"requirements.md\nreferences/example.png"} />
                <small>
                  Stored as path, size, media type, and SHA-256 references; file bytes are not copied into
                  the event store.
                </small>
              </label>
              <label class="settings-wide">
                Additional read-only folders (one absolute path per line, optional)
                <textarea
                  name="readableRoots"
                  rows={2}
                  placeholder={"/path/to/monorepo-root"}
                  value={readableRootsText}
                  onInput={(event) => onReadableRoots(event.currentTarget.value)}
                />
                <small>
                  Prefilled with the folder above the workspace so parent-repo reads need no approval. Reads
                  here proceed without a card; writing stays limited to the workspace.
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
            Starting a normal collaboration authorizes bounded provider turns only after both subscription
            billing routes are proven. The dashboard labels allowance versus existing-credit usage before the
            first turn.
          </p>
        </details>
      ) : (
        <details class="advanced-settings">
          <summary>
            <span class="disclosure-chevron" aria-hidden="true">{Icon.chevron({ size: 14 })}</span>
            Context and limits
          </summary>
          <p class="settings-intro">
            Read-only sources, no provider tools, adviser off. Both providers see the same saved context. One
            revision cycle, with one optional final cycle for a specific issue.
          </p>
          <div class="settings-grid">
            <label>
              Codex model
              <select name="codexModel">
                <option value="default">Provider default</option>
                <option value="gpt-5.6-luna">Luna</option>
                <option value="gpt-5.6-terra">Terra</option>
                <option value="gpt-5.6-sol">Sol</option>
                <option value="gpt-6-astra">Astra</option>
                <option value="gpt-5.5">GPT-5.5</option>
                <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
                <option value="gpt-5.3-codex-spark">Codex Spark</option>
              </select>
            </label>
            <label>
              Codex reasoning
              <select name="codexEffort">
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label>
              Claude model
              <select name="claudeModel">
                <option value="default">Provider default</option>
                <option value="opus[1m]">Opus (1M context)</option>
                <option value="claude-fable-5[1m]">Fable</option>
                <option value="sonnet">Sonnet</option>
              </select>
            </label>
            <label>
              Claude effort
              <select name="claudeEffort">
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <small class="settings-wide">Selections apply to this run and are checked against your providers’ available models before work starts. Unavailable selections stop with an explanation.</small>
            <label class="settings-wide">
              Selected text files (one path within the optional project per line)
              <textarea name="attachmentPaths" rows={3} placeholder="requirements.md" />
              <small>
                Text snapshots are redacted, bounded, and stored with this run. Binary files and oversized
                files are omitted with an explanation.
              </small>
            </label>
            <label class="settings-wide">
              Required conditions (optional, one per line)
              <textarea name="completionEvidence" rows={3} placeholder="Fit the plan into two hours per week." />
              <small>Each condition is checked explicitly by both reviewers before the answer counts as ready.</small>
            </label>
            <label>
              Provider calls per provider (default 9)
              <input name="perProvider" type="number" min={1} max={12} />
            </label>
            <label>
              Stop after provider work (minutes, default 12)
              <input name="maxDurationMinutes" type="number" min={1} max={30} />
            </label>
          </div>
        </details>
      )}
      {submitError ? (
        <p class="composer-error" ref={errorRef} role="alert" tabIndex={-1}>
          {Icon.alert({ size: 16 })}<span>{submitError}</span>
        </p>
      ) : null}
      <div class="composer-footer">
        <small class="composer-footnote">
          {Icon.lock({ size: 13 })}
          {legacyDemo
            ? "Both providers must prove a subscription billing route before any model turn starts."
            : "No model call starts until both providers prove a billing route. Sources stay read-only."}
        </small>
        <div class="composer-submit">
          <button class="btn btn-primary btn-lg" type="submit" disabled={!csrf || submitting}>
            {submitting ? <><span class="spinner" aria-hidden="true" /> Starting…</> : <>Start collaboration {Icon.arrow({ size: 16 })}</>}
          </button>
          <small class="shortcut-hint">⌘ / Ctrl + Enter to start</small>
        </div>
      </div>
    </form>
  );
}

function ComposerDialog({ open, onClose, onClosed, children }: { open: boolean; onClose: () => void; onClosed: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLTextAreaElement>('textarea[name="goal"]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      class="composer-dialog"
      aria-labelledby="new-run-heading"
      onClose={() => { onClose(); onClosed(); }}
      onClick={(event) => {
        // Click on the backdrop (outside the panel) closes the sheet.
        if (event.target === ref.current) onClose();
      }}
    >
      <div class="dialog-panel">
        <div class="dialog-head">
          <div>
            <p class="eyebrow">Start something new</p>
            <h2 id="new-run-heading">New collaboration</h2>
          </div>
          <button type="button" class="btn btn-icon" onClick={onClose} aria-label="Close">
            {Icon.x({ size: 16 })}
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/* ---------- sidebar ---------- */

function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const options: Array<{ value: Theme; label: string; icon: ComponentChildren }> = [
    { value: "system", label: "System", icon: Icon.monitor({ size: 14 }) },
    { value: "light", label: "Light", icon: Icon.sun({ size: 14 }) },
    { value: "dark", label: "Dark", icon: Icon.moon({ size: 14 }) },
  ];
  return (
    <div class="segmented" role="group" aria-label="Theme">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          class={theme === option.value ? "segmented-on" : undefined}
          aria-pressed={theme === option.value}
          onClick={() => onChange(option.value)}
          title={`${option.label} theme`}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function Sidebar({
  runs,
  selectedId,
  now,
  onSelect,
  onNew,
  hideNew,
  theme,
  onTheme,
}: {
  runs: RunProjection[];
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  hideNew: boolean;
  theme: Theme;
  onTheme: (theme: Theme) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <aside class="sidebar">
      <div class="sidebar-top">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">
            <span>C</span>
            <span>A</span>
          </span>
          <div class="brand-text">
            <h1>Codex + Claude</h1>
            <p>Two views, one reviewed answer</p>
          </div>
        </div>
        {hideNew ? null : (
          <button type="button" class="btn btn-primary new-run-button" onClick={onNew}>
            {Icon.plus({ size: 16 })} New collaboration
          </button>
        )}
      </div>
      <button type="button" class="history-toggle" aria-expanded={historyOpen} aria-controls="collaboration-history" onClick={() => setHistoryOpen(!historyOpen)}>
        <span>Collaborations <span class="count">{runs.length}</span></span>
        {Icon.chevron({ size: 16 })}
      </button>
      <nav id="collaboration-history" class={`run-list${historyOpen ? " run-list-open" : ""}`} aria-labelledby="run-list-heading">
        <h2 id="run-list-heading">
          Collaborations <span class="count">{runs.length}</span>
        </h2>
        {runs.length ? (
          <ol>
            {runs.map((run) => {
              const status = runStatus(run);
              const selected = run.runId === selectedId;
              return (
                <li key={run.runId}>
                  <button
                    type="button"
                    class={selected ? "run-item run-item-selected" : "run-item"}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => { onSelect(run.runId); setHistoryOpen(false); }}
                  >
                    <span class={`status-dot tone-${status.tone}`} aria-hidden="true" />
                    <span class="run-item-body">
                      <span class="run-item-goal">{run.goal?.goal ?? run.runId}</span>
                      {run.goal?.projectContext ? (
                        <span class="run-item-meta" title={run.goal.projectContext}>
                          {Icon.folder({ size: 12 })} {projectLabel(run.goal.projectContext)}
                        </span>
                      ) : null}
                      <span class="run-item-meta">
                        <span class={`run-item-status tone-${status.tone}`}>{status.label}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{relativeTime(run.goal?.createdAt, now) || humanize(run.state)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <p class="run-list-empty">Runs you start appear here and survive restarts.</p>
        )}
      </nav>
      <div class="sidebar-foot">
        <ThemeToggle theme={theme} onChange={onTheme} />
        <span class="local-badge" title="The service listens on 127.0.0.1 only and never writes to your sources.">
          <span class="local-dot" aria-hidden="true" /> Loopback only
        </span>
      </div>
    </aside>
  );
}

function HowItWorks() {
  const steps = [
    {
      title: "Independent proposals",
      copy: "Codex and Claude each answer from the same evidence packet without seeing the other.",
    },
    {
      title: "Cross-review",
      copy: "Each provider critiques the other’s answer with concrete, evidence-referenced objections.",
    },
    {
      title: "Synthesis and review",
      copy: "One document is written, then both review it. A material objection triggers a revision; dissent is preserved.",
    },
  ];
  return (
    <aside class="how" aria-labelledby="how-heading">
      <h2 id="how-heading">How a collaboration works</h2>
      <ol class="how-steps">
        {steps.map((step, index) => (
          <li key={step.title}>
            <span class="how-index" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.copy}</p>
            </div>
          </li>
        ))}
      </ol>
      <p class="how-foot">
        {Icon.lock({ size: 13 })} History is saved on this machine. The selected evidence is sent to Codex
        and Claude for review. Providers cannot browse or change your files.
      </p>
    </aside>
  );
}

/* ---------- legacy browser ---------- */

function LegacyBrowser({
  tasks,
  selected,
  onSelect,
}: {
  tasks: LegacyTaskSummary[];
  selected: LegacyTaskDetail | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section class="card legacy-browser" aria-labelledby="legacy-heading">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Configured root · zero writes</p>
          <h2 id="legacy-heading">Legacy task folders</h2>
        </div>
        <span class="chip chip-muted">{Icon.lock({ size: 12 })} Read-only</span>
      </div>
      {tasks.length ? (
        <div class="legacy-layout">
          <nav aria-label="Legacy tasks">
            <ol class="legacy-list">
              {tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    class={selected?.id === task.id ? "legacy-item legacy-item-selected" : "legacy-item"}
                    aria-current={selected?.id === task.id ? "true" : undefined}
                    onClick={() => onSelect(task.id)}
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
          {selected ? (
            <article class="legacy-detail" aria-labelledby="legacy-detail-heading">
              <p class="eyebrow">Historical task · read-only</p>
              <h3 id="legacy-detail-heading">{selected.name}</h3>
              <h4>Goal</h4>
              <p>{selected.goal}</p>
              <h4>State</h4>
              <pre>{JSON.stringify(selected.state, null, 2)}</pre>
              <h4>Notes</h4>
              {selected.notes.length ? (
                selected.notes.map((note) => (
                  <details key={note.name} class="diag">
                    <summary>{note.name}</summary>
                    <pre>{note.content}</pre>
                  </details>
                ))
              ) : (
                <p class="doc-empty">No legacy notes file was found.</p>
              )}
              <h4>Transcript</h4>
              <pre>{selected.transcript || "No transcript was found."}</pre>
              <h4>Final plan</h4>
              <pre>{selected.finalPlan || "No final plan was found."}</pre>
              <h4>Artifacts and files</h4>
              <ul class="legacy-files">
                {selected.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code> · {file.size} bytes · <code>{file.sha256}</code>
                  </li>
                ))}
              </ul>
            </article>
          ) : (
            <p class="legacy-placeholder">Select a historical task to inspect its immutable contents.</p>
          )}
        </div>
      ) : (
        <p class="doc-empty">No task folders were found under the configured legacy root.</p>
      )}
    </section>
  );
}

/* ---------- run header ---------- */

function RunHeader({
  run,
  now,
  exportOutcome,
  onCancel,
  onExport,
}: {
  run: RunProjection;
  now: number;
  exportOutcome: { runId: string; destination: string } | null;
  onCancel: () => void;
  onExport: () => void;
}) {
  const status = runStatus(run);
  const started = run.goal?.createdAt;
  // A long brief is clamped so the run's status and answer stay near the top;
  // the full text remains in the heading for assistive technology and tests.
  const goalText = run.goal?.goal ?? "";
  const longBrief = goalText.length > 240;
  const [briefExpanded, setBriefExpanded] = useState(false);
  useEffect(() => setBriefExpanded(false), [run.runId]);
  const calls = Object.values(run.budgets.provider).reduce((n, b) => n + b.consumed, 0);
  const limit = Object.values(run.budgets.provider).reduce((n, b) => n + b.limit, 0);
  const finishedPlan = Boolean(run.planning && run.completedAt);
  const providerSummary = (
    <div class="run-meta-line">
      {(["codex", "claude"] as const).map((role) => (
        <span key={role} class="run-meta-item">
          <ProviderMark role={role} size="sm" />
          <span>{PROVIDER_NAME[role]}: {billingLabel(run.billing[role])}</span>
        </span>
      ))}
      <span class="run-meta-item">
        {Icon.spark({ size: 13 })}
        <span>{calls} of {limit} provider calls used</span>
      </span>
    </div>
  );
  return (
    <section class="card run-header" aria-labelledby="run-goal-heading">
      <div class="run-title-row">
        <div class="run-title">
          <p class="eyebrow">
            {run.planning ? "Collaboration" : "Execution run"}
            {started ? (
              <>
                {" · "}
                <time dateTime={started} title={new Date(started).toLocaleString()}>
                  started {relativeTime(started, now)}
                </time>
              </>
            ) : null}
            {run.completedAt ? (
              <>
                {" · "}
                <time dateTime={run.completedAt}>finished {relativeTime(run.completedAt, now)}</time>
              </>
            ) : null}
          </p>
          <h2
            id="run-goal-heading"
            tabIndex={-1}
            class={longBrief && !briefExpanded ? "brief-clamped" : undefined}
          >
            {goalText}
          </h2>
          {longBrief ? (
            <button
              type="button"
              class="brief-toggle"
              aria-expanded={briefExpanded}
              aria-controls="run-goal-heading"
              onClick={() => setBriefExpanded((value) => !value)}
            >
              {briefExpanded ? "Show less of the brief" : "Show the full brief"}
            </button>
          ) : null}
        </div>
        <div class="run-primary-actions">
          <StatusPill tone={status.tone} class="state-chip">
            {status.label}
          </StatusPill>
          {!run.completedAt ? (
            <button type="button" class="btn" onClick={onCancel}>
              {Icon.stop({ size: 14 })} Cancel
            </button>
          ) : (
            <button type="button" class="btn" onClick={onExport}>
              {Icon.download({ size: 15 })} Export run
            </button>
          )}
        </div>
      </div>
      {run.planning && run.goal?.projectContext ? (
        <div class="run-meta-line" aria-label="Collaboration project">
          <span class="chip chip-muted chip-path" title={run.goal.projectContext}>
            {Icon.folder({ size: 13 })} Project: {projectLabel(run.goal.projectContext)}
          </span>
        </div>
      ) : null}
      {run.planning ? (
        <PhaseTimeline run={run} />
      ) : (
        <div class="run-snapshot" aria-label="Collaboration snapshot">
          <div>
            <span>Codex</span>
            <strong>{humanize(run.workers.codex.state)}</strong>
          </div>
          <div>
            <span>Claude</span>
            <strong>{humanize(run.workers.claude.state)}</strong>
          </div>
          <div>
            <span>Action queue</span>
            <strong>{run.actions.length ? `${run.actions.length} waiting` : "Clear"}</strong>
          </div>
          <div>
            <span>Shared outcome</span>
            <strong>
              {run.candidate ? "Candidate available" : run.completedAt ? "Completed" : "In progress"}
            </strong>
          </div>
        </div>
      )}
      {finishedPlan ? null : providerSummary}
      {exportOutcome && exportOutcome.runId === run.runId ? (
        <p class="export-note">
          {Icon.check({ size: 14 })}
          <span>
            Exported document (when available), events, and review history with checksums to{" "}
            <code>{exportOutcome.destination}</code>
          </span>
        </p>
      ) : null}
      <details class="run-details">
        <summary>
          <span class="disclosure-chevron" aria-hidden="true">{Icon.chevron({ size: 14 })}</span>
          <span>Run details</span>
          <small>{finishedPlan ? `${calls} of ${limit} calls used · provider and run diagnostics` : "Permissions, resources, limits, and diagnostics"}</small>
        </summary>
        <div class="run-details-body">
          {finishedPlan ? providerSummary : null}
          <div class="run-meta">
            {run.planning ? null : <span
              class={
                run.overhead == null
                  ? "chip chip-muted"
                  : run.overhead.passed
                    ? "chip chip-ok"
                    : run.overhead.provisional
                      ? "chip chip-warn chip-dashed"
                      : "chip chip-bad"
              }
              title={
                run.overhead
                  ? `${run.overhead.gateVersion ?? "overhead gate"}: ${
                      run.overhead.workerBurstCount ?? 0
                    } worker bursts; coordination tokens ${
                      run.overhead.coordinationTokenUpper ?? 0
                    }; mixed coordinator bytes ${
                      run.overhead.mixedCoordinatorBytes ?? 0
                    } of ${run.overhead.absoluteAllowanceBytes ?? 0} allowed`
                  : undefined
              }
            >
              Worker-loop overhead:{" "}
              {run.overhead?.ratio != null
                ? `${run.overhead.ratio.toFixed(4)}×`
                : run.overhead
                  ? "no positive useful-work bound yet"
                  : "no usage yet"}
              {run.overhead
                ? run.overhead.passed
                  ? run.overhead.passedBy === "absolute"
                    ? " · within the small-run byte allowance"
                    : " · within 1.05×"
                  : run.overhead.provisional
                    ? " · provisional — may still recover"
                    : " · gate failed"
                : ""}
            </span>}
            <span class="chip chip-muted">
              Sandbox:{" "}
              {run.goal?.authority.permissionPreset === "read_only"
                ? "read-only"
                : run.goal?.authority.permissionPreset === "auto"
                  ? "auto workspace-write"
                  : "workspace-write"}
            </span>
            <span class="chip chip-muted">Resources: {run.goal?.resourceMode ?? "automatic"}</span>
            {run.goal?.stopConditions?.maxDurationMinutes ? (
              <span class="chip chip-muted">Stop: {run.goal.stopConditions.maxDurationMinutes} min</span>
            ) : null}
            {run.goal?.workspace ? (
              <span class="chip chip-muted chip-path" title={run.goal.workspace}>
                {Icon.folder({ size: 12 })} {run.goal.workspace}
              </span>
            ) : null}
          </div>
          {run.overheadNotice ? (
            <p class="overhead-notice">
              Worker-loop overhead gate breached at a stable boundary ({humanize(run.overheadNotice.boundary)}
              ):{" "}
              {run.overheadNotice.ratio != null
                ? `${run.overheadNotice.ratio.toFixed(4)}× of the 1.05× ceiling`
                : "no positive useful-work lower bound"}
              , {run.overheadNotice.mixedCoordinatorBytes} coordinator bytes of{" "}
              {run.overheadNotice.absoluteAllowanceBytes} allowed across {run.overheadNotice.workerBurstCount}{" "}
              worker bursts. This notice is informational and required no action; the run was never
              interrupted by it.
            </p>
          ) : null}
          {run.goal?.attachments?.length ? (
            <details class="run-attachments diag">
              <summary>Attachments ({run.goal.attachments.length} immutable references)</summary>
              <ul>
                {run.goal.attachments.map((attachment) => (
                  <li key={`${attachment.path}:${attachment.sha256}`}>
                    <code>{attachment.path}</code> · {attachment.size} bytes · {attachment.mediaType} ·{" "}
                    <code>{attachment.sha256}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </details>
    </section>
  );
}

/* ---------- execution view ---------- */

function AdvisorLane({
  run,
  advisorView,
  reactiveWakesUsed,
  csrf,
  onAsk,
}: {
  run: RunProjection;
  advisorView: AdvisorView | null;
  reactiveWakesUsed: number;
  csrf: string;
  onAsk: () => void;
}) {
  const lastObservation = (advisorView?.ledger ?? []).filter((row) => row.kind === "observation").at(-1);
  const payload = lastObservation?.payload as { model?: string; effort?: string } | undefined;
  return (
    <section class="card lane advisor-lane" aria-labelledby="advisor-heading">
      <header class="lane-head">
        <div>
          <p class="eyebrow">advisory supervisor · zero authority</p>
          <h2 id="advisor-heading">Adviser</h2>
        </div>
        <span class="chip chip-advisor">
          {run.goal?.advisor?.provider === "codex" ? "Codex" : "Claude"}
          {" · "}
          {run.goal?.advisor?.effort === "medium" ? "medium effort" : "strong (high effort)"}
        </span>
      </header>
      <p class="model-line">
        Model:{" "}
        {payload?.model ? (
          <>
            <code>{payload.model}</code>
            {" · reasoning "}
            {payload.effort ?? run.goal?.advisor?.effort ?? "high"}
            {" (provider default row, resolved per wake)"}
          </>
        ) : (
          "resolved from the provider's default row at the first wake"
        )}
      </p>
      <p class="state-line">
        Wakes used: {reactiveWakesUsed} of{" "}
        {(run.goal?.advisor?.reactiveWakeUnits ?? 2) + (run.advisor?.extendedReactiveWakeUnits ?? 0)} reactive
        + {run.goal?.advisor?.retrospectiveWakeUnits ?? 1} reserved retrospective · Triggers recorded:{" "}
        {run.advisor?.triggerCount ?? 0}
      </p>
      <p class="state-line">
        Adviser usage: {advisorView?.accounting?.advisorUsage.totalTokens ?? 0} tokens (separate bucket; never
        part of the worker-loop overhead gate) · Combined informational ratio:{" "}
        {advisorView?.accounting?.combinedCoordinationRatio != null
          ? `${advisorView.accounting.combinedCoordinationRatio.toFixed(4)}×`
          : "n/a"}
      </p>
      <button type="button" class="btn" onClick={onAsk} disabled={!csrf || Boolean(run.completedAt)}>
        {Icon.message({ size: 15 })}
        <span>Ask the adviser</span>
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
                <strong class="packet-type">
                  wake {(row.wakeId ?? "").slice(0, 13)} · {String((row.payload as any)?.trigger?.kind ?? "observation")}
                </strong>
                {(output?.observations ?? []).map((observation, index) => (
                  <article key={`${row.seq}-${index}`} class="advisor-card">
                    <p>
                      [{observation.severity}] {observation.summary}
                    </p>
                    <small>
                      events: {observation.eventIds.join(", ") || "none"}
                      {observation.recommendationCode ? ` · suggestion code: ${observation.recommendationCode}` : ""}
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
              <strong class="packet-type">adviser failure</strong>
              <p>{String((row.payload as any)?.code ?? "failure")} — the worker run was not affected.</p>
            </li>
          ))}
      </ol>
      {advisorView?.files?.length ? (
        <details class="diag">
          <summary>Adviser note files (untrusted model output)</summary>
          <ul>
            {advisorView.files.map((file) => (
              <li key={file.name}>
                <code>{file.path}</code> · {file.size} bytes · <code>{file.sha256}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function ExecutionView({
  run,
  activity,
  identity,
  advisorEnabled,
  advisorView,
  reactiveWakesUsed,
  csrf,
  onAsk,
}: {
  run: RunProjection;
  activity: AgentActivityEntry[];
  identity: Record<string, AgentModelIdentity>;
  advisorEnabled: boolean;
  advisorView: AdvisorView | null;
  reactiveWakesUsed: number;
  csrf: string;
  onAsk: () => void;
}) {
  const verdictVerification = run.candidate?.manifest.verification ?? [];
  const verdictVerificationPassed = verdictVerification.filter((entry) => entry.outcome === "passed").length;
  const verdictSignedRoles = (["codex", "claude"] as const).filter((role) => run.signoffs?.[role]);
  return (
    <>
      {run.completedAt ? (
        <section class={`card verdict verdict-${run.state}`} aria-labelledby="verdict-heading">
          <p class="eyebrow">Conclusion</p>
          {run.state === "completed_consensus" ? (
            <>
              <h2 id="verdict-heading">Consensus reached — both models signed the same result</h2>
              <p>
                Both providers signed the same recorded outcome manifest. Review and recorded checks support
                assessment of the result; they do not establish that every claim is true.
              </p>
              {run.candidate ? (
                <ul class="verdict-facts">
                  <li>
                    <strong>{run.candidate.manifest.artifacts.length}</strong> files delivered in the workspace
                  </li>
                  <li>
                    <strong>
                      {verdictVerificationPassed}/{verdictVerification.length}
                    </strong>{" "}
                    verification checks passed
                  </li>
                  <li>
                    <strong>{run.candidate.manifest.evidenceLedger.length}</strong> evidence entries ·{" "}
                    <strong>{run.candidate.manifest.knownLimitations.length}</strong> known limitations recorded
                    honestly
                  </li>
                  <li>
                    Signed by <strong>{verdictSignedRoles.join(" and ") || "—"}</strong>
                  </li>
                </ul>
              ) : null}
              {run.candidate?.manifest.artifacts.length ? (
                <div class="verdict-artifacts">
                  <h3>What they delivered</h3>
                  <ul>
                    {run.candidate.manifest.artifacts.slice(0, 8).map((artifact) => (
                      <li key={`verdict-${artifact.path}`}>
                        <code>{artifact.path}</code>
                      </li>
                    ))}
                    {run.candidate.manifest.artifacts.length > 8 ? (
                      <li>…and {run.candidate.manifest.artifacts.length - 8} more in the shared outcome section below.</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
              {verdictSignedRoles.some((role) => run.signoffs?.[role]?.rationale) ? (
                <div class="verdict-rationales">
                  <h3>Why each model signed</h3>
                  {verdictSignedRoles.map((role) =>
                    run.signoffs?.[role]?.rationale ? (
                      <p key={`rationale-${role}`}>
                        <strong>{PROVIDER_NAME[role]}:</strong> {run.signoffs[role]!.rationale}
                      </p>
                    ) : null,
                  )}
                </div>
              ) : null}
              <p class="verdict-next">
                The delivered files are already live in your workspace — no further action is needed to apply
                them. Use “Export run” above for the complete audited record (events, transcript, checksums), or
                start a new collaboration for the next goal. Each model’s full analysis is in its lane’s work
                packets.
              </p>
            </>
          ) : run.state === "completed_disagreement" ? (
            <>
              <h2 id="verdict-heading">Ended with a recorded disagreement</h2>
              <p>
                The models could not converge on one result. No consensus was manufactured: both positions are
                preserved verbatim in the work packets and in the export.
              </p>
            </>
          ) : (
            <>
              <h2 id="verdict-heading">Collaboration cancelled</h2>
              <p>
                The run ended before a shared outcome. Any workspace changes made before cancellation remain on
                disk for inspection.
              </p>
            </>
          )}
        </section>
      ) : null}
      <div class="lanes">
        <AgentLane role="codex" run={run} activity={activity} identity={identity[`${run.runId}:codex`]} />
        <AgentLane role="claude" run={run} activity={activity} identity={identity[`${run.runId}:claude`]} />
      </div>
      {advisorEnabled ? (
        <AdvisorLane
          run={run}
          advisorView={advisorView}
          reactiveWakesUsed={reactiveWakesUsed}
          csrf={csrf}
          onAsk={onAsk}
        />
      ) : null}
      <section class="card outcome" aria-labelledby="outcome-heading">
        <p class="eyebrow">Shared outcome</p>
        <h2 id="outcome-heading">{run.candidate ? "Candidate manifest" : "Collaboration in progress"}</h2>
        <dl class="stats">
          <div>
            <dt>Opening barrier</dt>
            <dd>{run.barrierReleased ? "Released" : "Holding peer bytes"}</dd>
          </div>
          <div>
            <dt>Material challenges</dt>
            <dd>{Object.keys(run.materialChallenges).length}</dd>
          </div>
          <div>
            <dt>Codex budget</dt>
            <dd>
              {run.budgets.provider.codex.consumed}/{run.budgets.provider.codex.limit}
            </dd>
          </div>
          <div>
            <dt>Claude budget</dt>
            <dd>
              {run.budgets.provider.claude.consumed}/{run.budgets.provider.claude.limit}
            </dd>
          </div>
        </dl>
        {run.candidate ? (
          <details class="manifest-details diag">
            <summary>View candidate verification manifest</summary>
            <div class="manifest-body">
              <h3>Artifacts</h3>
              {run.candidate.manifest.artifacts.length ? (
                <ul>
                  {run.candidate.manifest.artifacts.map((artifact) => (
                    <li key={`${artifact.path}:${artifact.sha256}`}>
                      <code>{artifact.path}</code> — {artifact.mediaType} — <code>{artifact.sha256}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No artifact was declared.</p>
              )}
              <h3>Evidence ledger</h3>
              {run.candidate.manifest.evidenceLedger.length ? (
                <ul>
                  {run.candidate.manifest.evidenceLedger.map((entry, index) => (
                    <li key={`evidence-${index}`}>{entry}</li>
                  ))}
                </ul>
              ) : (
                <p>No evidence entries were recorded.</p>
              )}
              <h3>Verification ledger</h3>
              <ul>
                {run.candidate.manifest.verification.map((entry, index) => (
                  <li key={`${entry.command}:${index}`}>
                    <strong>{entry.outcome}</strong> — <code>{entry.command}</code>
                    <p>{entry.evidence}</p>
                  </li>
                ))}
              </ul>
              {run.candidate.manifest.knownLimitations.length ? (
                <>
                  <h3>Known limitations</h3>
                  <ul>
                    {run.candidate.manifest.knownLimitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p>
                <strong>Manifest digest:</strong> <code>{run.candidate.digest}</code>
              </p>
              <p>
                <strong>Verification digest:</strong> <code>{run.candidate.verificationDigest}</code>
              </p>
            </div>
          </details>
        ) : null}
      </section>
    </>
  );
}

/* ---------- app ---------- */

export function App() {
  const legacyDemo = new URLSearchParams(window.location.search).get("adapter") === "fake";
  const [csrf, setCsrf] = useState("");
  const [runs, setRuns] = useState<RunProjection[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // fatalError is reserved for a dead session (bootstrap failure): nothing
  // can render without it. Every later failure is a dismissible notice on
  // top of a still-working dashboard.
  const [fatalError, setFatalError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [composerVersion, setComposerVersion] = useState(0);
  const focusRun = useRef(false);
  const [workspace, setWorkspace] = useState("");
  const [workspacePickerError, setWorkspacePickerError] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [readableRootsText, setReadableRootsText] = useState("");
  const [readableRootsTouched, setReadableRootsTouched] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage may be unavailable; the choice simply does not persist.
    }
  }, [theme]);

  // Agents almost always need to at least read the folder enclosing the
  // workspace (monorepo root, sibling docs). Suggest it automatically so
  // the common case needs no typing; the user can clear or replace it.
  function applyWorkspace(path: string): void {
    setWorkspace(path);
    if (!legacyDemo || readableRootsTouched) return;
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
    () => runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  // With nothing selected the composer is the page itself; with a run in
  // focus it opens as a sheet above the run so the run stays visible.
  const heroComposer = !selected;
  const dialogComposer = Boolean(selected) && creatorOpen;
  function focusSelectedRun(): void {
    if (selected && focusRun.current) {
      focusRun.current = false;
      document.getElementById("run-goal-heading")?.focus();
    }
  }
  useLayoutEffect(() => {
    // A native dialog restores its opener when it closes. Focus the new run
    // after that restoration, or immediately when navigating without a dialog.
    if (!document.querySelector(".composer-dialog[open]")) focusSelectedRun();
  }, [selected?.runId, dialogComposer]);

  // Backfill the transient live feed whenever the selected run changes; SSE
  // keeps it current afterwards (entries dedupe by seq).
  useEffect(() => {
    const runId = selected?.runId;
    if (!runId || !csrf) return;
    let cancelled = false;
    fetch(`/api/runs/${encodeURIComponent(runId)}/activity`, {
      credentials: "same-origin",
    })
      .then(async (response) => (response.ok ? response.json() : { entries: [], identity: {} }))
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
              const merged = [...current, ...entries.filter((entry) => !seen.has(entry.seq))];
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
    const response = await fetch(`/api/runs/${encodeURIComponent(selected.runId)}/advisor/ask`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Collab-CSRF": csrf,
      },
      body: "{}",
    });
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
          // Keep history targets steady while background runs stream updates.
          setRuns((current) => mergeRun(current, projection));
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
      .catch((caught) => setFatalError(caught instanceof Error ? caught.message : String(caught)));
    return () => events?.close();
  }, []);

  async function createRun(event: Event): Promise<void> {
    event.preventDefault();
    if (submittingRef.current) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    if (!String(form.get("goal") ?? "").trim()) {
      setSubmitError("Describe a question or goal before starting.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      const perProvider = Number(form.get("perProvider"));
      const perMaterialChallenge = Number(form.get("perMaterialChallenge"));
      const budgets = {
        ...(Number.isInteger(perProvider) && perProvider > 0 ? { perProvider } : {}),
        ...(Number.isInteger(perMaterialChallenge) && perMaterialChallenge > 0 ? { perMaterialChallenge } : {}),
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
          workflow: legacyDemo ? "execution" : "planning",
          ...(!legacyDemo ? { planningModels: {
            codex: { model: form.get("codexModel"), effort: form.get("codexEffort") },
            claude: { model: form.get("claudeModel"), effort: form.get("claudeEffort") },
          } } : {}),
          completionEvidence: String(form.get("completionEvidence") ?? "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          workspace: form.get("workspace"),
          ...(Object.keys(budgets).length ? { budgets } : {}),
          attachmentPaths,
          readableRoots,
          permissionPreset: legacyDemo ? form.get("permissionPreset") : "read_only",
          stopConditions: {
            maxDurationMinutes:
              Number.isFinite(maxDurationMinutes) && maxDurationMinutes > 0 ? maxDurationMinutes : null,
          },
          resourceMode: legacyDemo ? form.get("resourceMode") : "serialized",
          ...(form.get("advisorEnabled") === "true"
            ? {
                advisor: {
                  enabled: true,
                  provider: form.get("advisorProvider"),
                  effort: form.get("advisorEffort"),
                },
              }
            : {}),
          mode: new URLSearchParams(window.location.search).get("adapter") === "fake" ? "fake" : "real",
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setSubmitError(describeError(body.error, "Unable to start collaboration."));
        return;
      }
      // Fake/demo execution can publish its projection over SSE before the
      // create response resolves. Upsert by runId so that race cannot duplicate
      // a run in the persistent history list.
      setRuns((current) => mergeRun(current, body));
      focusRun.current = true;
      setSelectedRunId(body.runId);
      setCreatorOpen(false);
      setComposerVersion((version) => version + 1);
      setExportOutcome(null);
    } catch {
      setSubmitError("The connection was interrupted. Your draft is preserved. Check collaboration history before retrying in case the run already started.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
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
          DIRECTORY_PICKER_FAILED: "The folder chooser could not be opened. Enter the absolute path instead.",
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
    const response = await fetch(`/api/legacy-tasks/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
    });
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

  async function decideAction(card: ActionCard, action: string, details?: string): Promise<void> {
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
    setRuns((current) => mergeRun(current, body));
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
    setRuns((current) => mergeRun(current, body));
  }

  if (fatalError) {
    return (
      <main class="fatal">
        <div class="card fatal-card">
          <span class="brand-mark" aria-hidden="true">
            <span>C</span>
            <span>A</span>
          </span>
          <h1>Collaboration dashboard</h1>
          <div role="alert" class="error">
            {fatalError}
          </div>
        </div>
      </main>
    );
  }

  const composerProps: ComposerProps = {
    legacyDemo,
    csrf,
    workspace,
    recentProjects: [...new Set(runs.map((run) => run.goal?.projectContext).filter((path): path is string => Boolean(path)))],
    applyWorkspace,
    chooseWorkspace,
    workspacePickerOpen,
    workspacePickerError,
    readableRootsText,
    onReadableRoots: (value) => {
      setReadableRootsTouched(true);
      setReadableRootsText(value);
    },
    advisorSetupEnabled,
    setAdvisorSetupEnabled,
    onSubmit: createRun,
    submitting,
    submitError,
  };
  const selectedStatus = selected ? runStatus(selected) : null;

  return (
    <div class="app">
      <button type="button" class="skip-link" onClick={() => document.getElementById("main-content")?.focus()}>Skip to content</button>
      <Sidebar
        runs={runs}
        selectedId={selected?.runId ?? null}
        now={now}
        onSelect={(id) => {
          focusRun.current = true;
          setSelectedRunId(id);
          setCreatorOpen(false);
          if (id === selected?.runId) {
            document.getElementById("run-goal-heading")?.focus();
            focusRun.current = false;
          }
        }}
        onNew={() => setCreatorOpen(true)}
        hideNew={heroComposer}
        theme={theme}
        onTheme={setTheme}
      />
      <main class="main" id="main-content" tabIndex={-1}>
        <div class="main-inner">
          {notice ? (
            <div role="alert" class="banner banner-error">
              <span class="banner-icon" aria-hidden="true">
                {Icon.alert({ size: 16 })}
              </span>
              <p>{notice}</p>
              <button type="button" class="btn btn-sm" onClick={() => setNotice("")}>
                Dismiss
              </button>
            </div>
          ) : null}
          {resourceState.degraded ? (
            <div class="banner banner-warn" role="status">
              <span class="banner-icon" aria-hidden="true">
                {Icon.alert({ size: 16 })}
              </span>
              <p>
                Degraded mode is active. New heavy work is paused and agents will serialize at the next safe
                boundary. {resourceState.reason}
              </p>
            </div>
          ) : null}

          {heroComposer ? (
            <div class="hero">
              <section class="card hero-composer" aria-labelledby="new-run-heading">
                <p class="eyebrow">Start something new</p>
                <h2 id="new-run-heading">New collaboration</h2>
                <p class="section-copy">
                  {legacyDemo
                    ? "Choose a local workspace and describe the outcome. The safe defaults handle the rest."
                    : "Describe what you want to answer, decide, or plan. Codex and Claude work it independently, review each other, and hand you one reviewed document."}
                </p>
                <Composer key={composerVersion} {...composerProps} />
              </section>
              <HowItWorks />
            </div>
          ) : null}

          {selected ? (
            <div class="run-workspace" key={selected.runId}>
              <RunHeader
                run={selected}
                now={now}
                exportOutcome={exportOutcome}
                onCancel={cancelRun}
                onExport={exportRun}
              />
              {selected.actions.length ? (
                <ActionDrawer actions={selected.actions} onRetry={retryPreflight} onAction={decideAction} />
              ) : null}
              {selected.planning ? (
                <PlanningView key={selected.runId} run={selected} onExport={exportRun} />
              ) : (
                <ExecutionView
                  run={selected}
                  activity={activity}
                  identity={identity}
                  advisorEnabled={advisorEnabled}
                  advisorView={advisorView}
                  reactiveWakesUsed={reactiveWakesUsed}
                  csrf={csrf}
                  onAsk={askAdvisor}
                />
              )}
              <div class="sr-only" role="status" aria-live="polite">
                Collaboration status: {selectedStatus?.label}. State {humanize(selected.state)}.
              </div>
            </div>
          ) : null}

          {resourceState.legacyTasksEnabled ? (
            <LegacyBrowser tasks={legacyTasks} selected={legacyTask} onSelect={selectLegacyTask} />
          ) : null}
        </div>
      </main>
      {selected ? (
        <ComposerDialog open={dialogComposer} onClose={() => setCreatorOpen(false)} onClosed={focusSelectedRun}>
          <Composer key={composerVersion} {...composerProps} />
        </ComposerDialog>
      ) : null}
    </div>
  );
}
