import type { PlanningReview, ProviderRole, RunProjection } from "@collab/contracts";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Icon, PROVIDER_NAME, ProviderMark, formatClock, humanize } from "./ui.tsx";

/** Safe Markdown subset: all source text remains Preact text nodes, never innerHTML. */
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ComponentChildren[] = [];
  let i = 0;
  const row = (line: string) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(
        <pre>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push(heading[1]!.length >= 3 ? <h4>{inline(heading[2]!)}</h4> : <h3>{inline(heading[2]!)}</h3>);
      i++;
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const headers = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(row(lines[i++]!));
      blocks.push(
        <div class="document-table" role="region" aria-label="Plan table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {headers.map((h) => (
                  <th scope="col">{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells) => (
                <tr>
                  {headers.map((_, index) => (
                    <td>{inline(cells[index] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const entries: ComponentChildren[] = [];
      while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s/.test(lines[i]!)) {
        entries.push(<li>{inline(lines[i++]!.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>);
      }
      blocks.push(ordered ? <ol>{entries}</ol> : <ul>{entries}</ul>);
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(?:#|```|[-*] |\d+\. )/.test(lines[i]!)) {
      paragraph.push(lines[i++]!);
    }
    blocks.push(<p>{inline(paragraph.join("\n"))}</p>);
  }
  return <div class="document-markdown">{blocks}</div>;
}

/* ---------- workflow timeline ---------- */

type StageStatus = "done" | "active" | "pending" | "partial";
interface StageItem {
  role: ProviderRole;
  status: StageStatus;
}
export interface Stage {
  key: string;
  label: string;
  items: StageItem[];
  status: StageStatus;
}

const ROLES: ProviderRole[] = ["codex", "claude"];

/**
 * Derives the visible workflow from recorded planning steps. Steps are keyed
 * by context version; answering a clarification restarts the sequence, so
 * only the current version's steps count. At most one item is "active":
 * provider work is serialized, so the most recently claimed working worker is
 * the one actually running.
 */
export function planningStages(run: RunProjection): { stages: Stage[]; now: string | null } {
  const p = run.planning!;
  const prefix = `${p.answers.length}|`;
  const done = new Set(
    p.steps
      .filter((s) => s.key.startsWith(prefix) && !["usage", "provider_response"].includes(s.phase))
      .map((s) => s.key.slice(prefix.length)),
  );
  const paused = run.actions.length > 0 || Boolean(run.completedAt) ||
    ["paused", "cancelled", "failed", "preflight_blocked", "billing_integrity_unknown"].includes(run.state);
  const current = paused
    ? null
    : ROLES.filter((r) => run.workers[r].state === "working")
        .sort((a, b) =>
          String(run.workers[b].lastRuntimeActivity ?? "").localeCompare(
            String(run.workers[a].lastRuntimeActivity ?? ""),
          ),
        )[0] ?? null;
  let activeAssigned = false;
  let now: string | null = null;
  const item = (role: ProviderRole, key: string, phase: string, describe: string): StageItem => {
    if (done.has(key)) return { role, status: "done" };
    if (!activeAssigned && current === role && run.workers[role].activity === phase) {
      activeAssigned = true;
      now = `${PROVIDER_NAME[role]} ${describe}`;
      return { role, status: "active" };
    }
    return { role, status: "pending" };
  };
  const stages: Stage[] = [];
  const push = (key: string, label: string, items: StageItem[]) => {
    const status: StageStatus = items.every((i) => i.status === "done")
      ? "done"
      : items.some((i) => i.status === "active")
        ? "active"
        : items.some((i) => i.status === "done") ? "partial" : "pending";
    stages.push({ key, label, items, status });
  };
  push(
    "proposal",
    "Independent proposals",
    ROLES.map((r) => item(r, `proposal:${r}`, "proposal", "is writing an independent proposal")),
  );
  push(
    "cross",
    "Cross-review",
    ROLES.map((r) => item(r, `cross:${r}`, "cross_review", "is reviewing the peer proposal")),
  );
  const documents = p.documents;
  const author =
    documents[0]?.author ?? ROLES.find((r) => run.workers[r].activity === "synthesis") ?? "codex";
  push("synthesis", "Synthesis", [item(author, "document:1", "synthesis", "is synthesizing one document")]);
  const count = Math.max(documents.length, 1);
  for (let n = 1; n <= count; n++) {
    if (n > 1) {
      const revisor = documents[n - 1]?.author ?? author;
      push(`revision:${n}`, `Revision ${n}`, [
        item(revisor, `document:${n}`, "revision", `is revising the document (revision ${n})`),
      ]);
    }
    push(
      `review:${n}`,
      count > 1 ? `Review ${n}` : "Review",
      ROLES.map((r) => item(r, `review:${n}:${r}`, "review", `is reviewing revision ${n}`)),
    );
  }
  if (!activeAssigned && current && run.workers[current].activity === "revision" && documents.length) {
    const n = documents.length + 1;
    activeAssigned = true;
    now = `${PROVIDER_NAME[current]} is revising the document (revision ${n})`;
    push(`revision:${n}`, `Revision ${n}`, [{ role: current, status: "active" }]);
    push(`review:${n}`, `Review ${n}`, ROLES.map((r) => ({ role: r, status: "pending" as const })));
  }
  if (!now && !paused && current) {
    now = `${PROVIDER_NAME[current]} is ${humanize(run.workers[current].activity ?? "working")}`;
  }
  return { stages, now };
}

export function PhaseTimeline({ run }: { run: RunProjection }) {
  const { stages, now } = planningStages(run);
  const finished = Boolean(run.completedAt);
  const waiting = run.actions.length > 0 && !finished;
  const timeline = (
    <div class={`timeline-wrap${finished ? " timeline-finished" : ""}`}>
      <ol class="timeline" aria-label="Workflow progress">
        {stages.map((stage, index) => (
          <li key={stage.key} class={`stage stage-${stage.status}`}>
            <span class="stage-icon" aria-hidden="true">
              {stage.status === "done" ? Icon.check({ size: 12 }) : stage.status === "active" ? <span class="spinner" /> : index + 1}
            </span>
            <span class="stage-label">{stage.label}</span>
            <span class="stage-roles" aria-hidden="true">
              {stage.items.map((entry, i) => (
                <span key={i} class={`mini mini-${entry.role} mini-${entry.status}`}>
                  {entry.role === "codex" ? "C" : "A"}
                </span>
              ))}
            </span>
            <span class="sr-only">
              {stage.status === "done" ? "completed" : stage.status === "active" ? "in progress" : stage.status === "partial" ? "partially complete" : "pending"}
              {": "}
              {stage.items
                .map((entry) => `${PROVIDER_NAME[entry.role]} ${entry.status}`)
                .join(", ")}
            </span>
          </li>
        ))}
      </ol>
      {finished ? null : waiting ? (
        <p class="timeline-now timeline-now-waiting">
          {Icon.message({ size: 14 })} Waiting for your action below. No provider call is running.
        </p>
      ) : run.state === "paused" ? (
        <p class="timeline-now">Collaboration paused. No provider call is running.</p>
      ) : now ? (
        <p class="timeline-now">
          <span class="spinner spinner-inline" aria-hidden="true" /> {now}…
        </p>
      ) : (
        <p class="timeline-now">Waiting for both providers to pass preflight.</p>
      )}
    </div>
  );
  return finished ? (
    <details class="timeline-history">
      <summary>
        <span class="disclosure-chevron" aria-hidden="true">{Icon.chevron({ size: 14 })}</span>
        <span>Workflow history</span>
        <small>{stages.filter((stage) => stage.status === "done").length} of {stages.length} stages completed · {run.planning!.documents.length} document revisions</small>
      </summary>
      {timeline}
    </details>
  ) : timeline;
}

/* ---------- document ---------- */

function Section({ title, items, empty = "None recorded." }: { title: string; items: string[]; empty?: string }) {
  return (
    <section class="doc-section">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : (
        <p class="doc-empty">{empty}</p>
      )}
    </section>
  );
}

const VERDICT: Record<PlanningReview["verdict"], { label: string; tone: string }> = {
  approved: { label: "Approved", tone: "ok" },
  revision_requested: { label: "Revision requested", tone: "warn" },
  disagreement: { label: "Disagreement", tone: "bad" },
  needs_input: { label: "Needs input", tone: "accent" },
};

function ReviewCard({ role, review }: { role: ProviderRole; review: PlanningReview | undefined }) {
  const verdict = review ? VERDICT[review.verdict] : null;
  return (
    <article class={`review review-${role}`}>
      <header class="review-head">
        <ProviderMark role={role} size="sm" />
        <h4>{PROVIDER_NAME[role]}</h4>
        <span class={`badge badge-${verdict?.tone ?? "muted"}`}>{verdict?.label ?? "Pending"}</span>
      </header>
      {review ? (
        <>
          <p>{review.rationale}</p>
          {review.objections.length ? (
            <ul class="objections">
              {review.objections.map((objection) => (
                <li key={objection.id} class={`objection objection-${objection.severity}`}>
                  <span class={`badge badge-${objection.severity === "material" ? "warn" : "muted"}`}>
                    {objection.severity}
                  </span>
                  <div>
                    <p>{objection.issue}</p>
                    <p class="objection-fix">
                      <strong>Suggested correction:</strong> {objection.correction}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p class="doc-empty">No approval recorded for this revision yet.</p>
      )}
    </article>
  );
}

function Fact({ label, tone, children }: { label: string; tone: string; children: ComponentChildren }) {
  return (
    <span class={`fact fact-${tone}`}>
      <span class="fact-dot" aria-hidden="true" />
      <span class="fact-label">{label}</span>
      {children}
    </span>
  );
}

export function PlanningView({ run, onExport }: { run: RunProjection; onExport: () => void }) {
  const p = run.planning!;
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const current = p.documents.at(-1);
  const doc = p.documents.find((d) => d.number === revisionNumber) ?? current;
  const historical = Boolean(doc && current && doc.number !== current.number);
  const reviews = doc
    ? p.reviews.filter((r) => r.revision === doc.revision && (r.contextVersion ?? 0) === p.answers.length)
    : [];
  const usage = p.steps.filter((s) => s.phase === "usage");
  const rejected = p.steps.filter((s) => s.phase === "output_rejected");
  const attempts = Object.values(run.budgets.provider).reduce((n, b) => n + b.consumed, 0);
  const total = usage.reduce((n, s) => n + s.usage.input + s.usage.cachedInput + s.usage.output, 0);
  const seconds = Math.round(usage.reduce((n, s) => n + s.durationMs, 0) / 1000);
  const resultLabel =
    historical
      ? "Earlier revision"
      : p.status === "ready"
      ? "Ready for your consideration"
      : doc
        ? run.completedAt
          ? "Partial result"
          : "Draft under review"
        : run.completedAt ? "No document produced" : "Pending";
  const resultTone = historical ? "muted" : p.status === "ready" ? "ok" : doc ? (run.completedAt ? "warn" : "working") : "muted";
  const agreement = historical
    ? ROLES.every((role) => reviews.some((review) => review.reviewer === role && review.verdict === "approved"))
      ? "agreed" : reviews.some((review) => review.verdict !== "approved") ? "disagreed" : "pending"
    : p.agreement;
  const agreementLabel =
    agreement === "agreed"
      ? "Both approved"
      : agreement === "disagreed"
        ? reviews.some((r) => r.verdict === "revision_requested") && (historical || !run.completedAt)
          ? "Revision requested"
          : "Disagreement recorded"
        : run.completedAt ? (reviews.length ? "Not approved" : "Not reviewed") : "Pending";
  const agreementTone = agreement === "agreed" ? "ok" : agreement === "disagreed" ? "warn" : "muted";
  const conditions = run.goal?.completionEvidence ?? [];
  const fulfillment = historical
    ? conditions.some((condition) => doc?.conditions.some((entry) => entry.condition === condition && entry.status === "unmet") ||
      reviews.some((review) => review.conditions.some((entry) => entry.condition === condition && entry.status === "unmet")))
      ? "unmet"
      : conditions.every((condition) => doc?.conditions.some((entry) => entry.condition === condition && entry.status === "met") &&
        ROLES.every((role) => reviews.some((review) => review.reviewer === role && review.conditions.some((entry) => entry.condition === condition && entry.status === "met"))))
        ? "met" : "unknown"
    : p.fulfillment;
  const fulfillmentLabel = !conditions.length
    ? "None required"
    : fulfillment === "met"
      ? "All met"
      : fulfillment === "unmet"
        ? "Unmet"
        : run.completedAt ? "Not confirmed" : "Pending";
  const fulfillmentTone = !conditions.length
    ? "muted"
    : fulfillment === "met"
      ? "ok"
      : fulfillment === "unmet"
        ? "bad"
        : "muted";
  const list = (items: string[]) =>
    items.length ? (
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    ) : (
      <p class="doc-empty">None recorded.</p>
    );

  return (
    <>
      <section class="card document" aria-labelledby="document-heading">
        <header class="document-head">
          <p class="eyebrow">Your answer or plan</p>
          <h2 id="document-heading">
            {doc?.title ?? (run.completedAt ? "No completed document" : "Building the first answer")}
          </h2>
          <div class="planning-status" aria-label="Document status">
            <Fact label="Result" tone={resultTone}>
              <strong>{resultLabel}</strong>
            </Fact>
            <Fact label="Provider agreement" tone={agreementTone}>
              {agreementLabel}
            </Fact>
            <Fact label="Required conditions" tone={fulfillmentTone}>
              {fulfillmentLabel}
            </Fact>
          </div>
        </header>
        {doc ? (
          <>
            <div class="document-toolbar">
              <label class="select-field">
                Document revision{" "}
                <select value={doc.number} onChange={(e) => {
                  const number = Number(e.currentTarget.value);
                  setRevisionNumber(number === current?.number ? null : number);
                }}>
                  {p.documents.map((d) => (
                    <option value={d.number}>
                      Revision {d.number}
                      {d.number === current?.number ? " (current)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <span class="document-meta">
                Written by {PROVIDER_NAME[doc.author]} · {formatClock(doc.createdAt)}
                {p.documents.length > 1 ? ` · ${p.documents.length} revisions` : ""}
              </span>
              <button type="button" class="btn" onClick={onExport}>
                {Icon.download({ size: 15 })} {historical ? "Export latest Markdown" : "Export Markdown"}
              </button>
            </div>
            {historical ? (
              <div class="revision-notice">
                <p>Viewing revision {doc.number}. Feedback below applies to this version. Exports include the latest document and the full review history.</p>
                <button type="button" class="btn btn-sm" onClick={() => setRevisionNumber(null)}>Back to latest</button>
              </div>
            ) : null}
            <Markdown text={doc.body} />
            <div class="doc-sections">
              <Section title="Practical next steps" items={doc.nextSteps} />
              <Section title="Assumptions" items={doc.assumptions} />
              <Section title="Changes caused by review" items={doc.changes} empty="No review-driven changes in this revision." />
              <Section
                title="Remaining questions and disagreements"
                items={[...new Set([...doc.unresolved, ...(historical ? [] : p.issues)])]}
                empty="None recorded."
              />
              {conditions.length ? (
                <section class="doc-section">
                  <h3>Required conditions</h3>
                  <ul class="conditions">
                    {conditions.map((condition) => {
                      const c = doc.conditions.find((entry) => entry.condition === condition);
                      const status = c?.status ?? "unconfirmed";
                      return (
                        <li key={condition} class={`condition condition-${status}`}>
                          <span class={`badge badge-${status === "met" ? "ok" : status === "unmet" ? "bad" : "muted"}`}>
                            {status}
                          </span>
                          <div>
                            <p>{condition}</p>
                            <p class="condition-reason">{c?.reason ?? "No fulfillment assessment returned"}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
            </div>
            <section class="reviews-block" aria-labelledby="reviews-heading">
              <h3 id="reviews-heading">Review of this revision</h3>
              <div class="reviews">
                {ROLES.map((role) => (
                  <ReviewCard key={role} role={role} review={reviews.find((r) => r.reviewer === role)} />
                ))}
              </div>
            </section>
          </>
        ) : (
          <div class="document-pending">
            {run.completedAt ? (
              <p>This collaboration ended before a document was produced. Its messages and diagnostics are available below. Start a new collaboration to try again.</p>
            ) : run.actions.length || run.state === "paused" ? (
              <p>The document will appear here after collaboration resumes. {run.actions.length ? "Resolve the request above to continue." : "The collaboration is currently paused."}</p>
            ) : run.state === "preflight_blocked" ? (
              <p>
                Provider readiness must be resolved before collaboration can start. No second-provider
                approval has been inferred.
              </p>
            ) : (
              <>
                <p>
                  Each provider first answers on its own, then critiques the other. One document is then
                  synthesized and reviewed by both. It appears here the moment it exists.
                </p>
                <div class="skeleton" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </>
            )}
          </div>
        )}
        <p class="document-caveat">
          {Icon.info({ size: 14 })}
          <span>
            Review expresses the providers’ judgments against the available evidence. Agreement does not
            establish that every claim is true. Implementing this plan requires a separate request.
          </span>
        </p>
      </section>

      <details class="card disclosure">
        <summary>
          <span class="disclosure-title">Evidence and claim support</span>
          <span class="disclosure-hint">
            {p.context.length} source{p.context.length === 1 ? "" : "s"} ·{" "}
            {doc ? `${doc.claims.length} claim${doc.claims.length === 1 ? "" : "s"}` : "no document yet"}
          </span>
          <span class="disclosure-chevron" aria-hidden="true">{Icon.chevron({ size: 16 })}</span>
        </summary>
        <div class="disclosure-body">
          {doc ? (
            <>
              <h3>Claims in this revision</h3>
              {doc.claims.length ? (
                <ul class="claims">
                  {doc.claims.map((claim, i) => (
                    <li key={i}>
                      <span
                        class={`badge badge-${claim.status === "supported" ? "ok" : claim.status === "unsupported" ? "bad" : "muted"}`}
                      >
                        {claim.status}
                      </span>
                      <div>
                        <p>{claim.text}</p>
                        <p class="claim-refs">References: {claim.evidenceIds.join(", ") || "none"}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="doc-empty">No claims were recorded.</p>
              )}
            </>
          ) : null}
          <h3>Context notes</h3>
          {list(p.contextNotes)}
          <h3>Evidence packet</h3>
          {p.context.length ? (
            p.context.map((e) => (
              <details key={e.id} class="evidence">
                <summary>
                  <code>{e.id}</code> {e.source} <span class="badge badge-muted">{e.status}</span>
                </summary>
                <pre>{e.content}</pre>
                <small>Snapshot SHA-256: {e.sha256}</small>
              </details>
            ))
          ) : (
            <p class="doc-empty">No evidence packet was recorded.</p>
          )}
        </div>
      </details>

      <details class="card disclosure">
        <summary>
          <span class="disclosure-title">Messages, provider activity, usage, and diagnostics</span>
          <span class="disclosure-hint">
            {usage.length} call{usage.length === 1 ? "" : "s"} · {total.toLocaleString()} tokens · {seconds}s
          </span>
          <span class="disclosure-chevron" aria-hidden="true">{Icon.chevron({ size: 16 })}</span>
        </summary>
        <div class="disclosure-body">
          <p>
            {usage.length} provider calls returned; {total.toLocaleString()} input, cached input, and output
            tokens reported; {seconds} seconds in returned calls. Reasoning tokens, where reported, are a subset
            of output.
          </p>
          <p>
            Usage coverage:{" "}
            {usage.length === attempts && usage.every((s) => s.usageComplete)
              ? "Complete for returned calls"
              : attempts - usage.length === 1 && !run.completedAt && !run.actions.length
                ? "One call is in progress; its usage is reported when it returns"
                : "Incomplete; missing usage is not zero"}
            . Interrupted calls may have consumed unreported usage.
          </p>
          {rejected.length ? (
            <p>
              {rejected.length === 1 ? "One response was" : `${rejected.length} responses were`} rejected for structure and
              re-requested once with the reason: {rejected.map((s) => `${PROVIDER_NAME[s.role]} (${(s.output as { code?: string })?.code ?? "unknown"})`).join(", ")}.
              Re-requested calls count toward the call budget.
            </p>
          ) : null}
          <h3>Models for this run</h3>
          {ROLES.map((role) => {
            const selection = run.goal?.planningModels?.[role];
            const identity = p.steps.filter(s => s.role === role && s.phase === 'model_identity').at(-1)?.output as { model: string; effort: string } | undefined;
            return <p key={role}>
              <strong>{PROVIDER_NAME[role]}</strong>: {identity
                ? <><code>{identity.model}</code> · {identity.effort} effort · confirmed by completed call</>
                : <>{selection?.model ?? 'Provider default'} · {selection?.effort ?? 'medium'} effort · selected; no completed model call yet</>}
            </p>;
          })}
          <h3>Providers</h3>
          {ROLES.map((role) => (
            <details key={role} class="diag">
              <summary>
                <ProviderMark role={role} size="sm" /> {PROVIDER_NAME[role]}:{" "}
                {humanize(run.workers[role].activity ?? run.workers[role].state)} · billing{" "}
                {run.billing[role]?.simulated
                  ? "simulated fixture"
                  : run.billing[role]?.route
                    ? humanize(run.billing[role]!.route)
                    : "unchecked"}
              </summary>
              <pre>{JSON.stringify(run.billing[role], null, 2)}</pre>
            </details>
          ))}
          {p.answers.length ? (
            <>
              <h3>Your clarifications</h3>
              {p.answers.map((a, i) => (
                <article key={i} class="clarification">
                  <p class="clarification-q">{a.question}</p>
                  <p class="clarification-a">{a.answer}</p>
                </article>
              ))}
            </>
          ) : null}
          <h3>Validated steps</h3>
          {p.steps
            .filter((s) => !["usage", "provider_response", "model_identity", "output_rejected"].includes(s.phase))
            .map((s) => (
              <details key={s.key} class="diag">
                <summary>
                  <ProviderMark role={s.role} size="sm" /> {PROVIDER_NAME[s.role]}: {humanize(s.phase)}{" "}
                  <code>{s.key}</code>
                </summary>
                <pre>{JSON.stringify(s.output, null, 2)}</pre>
              </details>
            ))}
          <details class="diag">
            <summary>Original provider responses before validation</summary>
            {p.steps
              .filter((s) => s.phase === "provider_response")
              .map((s) => (
                <pre key={s.key}>{JSON.stringify(s.output, null, 2)}</pre>
              ))}
          </details>
          <h3>Reviews</h3>
          {p.reviews.map((r, i) => (
            <details key={i} class="diag">
              <summary>
                <ProviderMark role={r.reviewer} size="sm" /> {PROVIDER_NAME[r.reviewer]}: {humanize(r.verdict)} ·{" "}
                <code>{r.revision.slice(0, 12)}</code>
              </summary>
              <pre>{JSON.stringify(r, null, 2)}</pre>
            </details>
          ))}
        </div>
      </details>
    </>
  );
}
