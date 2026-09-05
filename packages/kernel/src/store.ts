import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PROVIDER_ROLES,
  TERMINAL_RUN_STATES,
  type AppendCommand,
  type GoalPacket,
  type OutcomeManifest,
  type ProviderRole,
  type RunProjection,
  type StoredEvent,
} from "@collab/contracts";
import { canonicalJson, digest, newId, sha256 } from "./canonical.ts";
import { KernelError } from "./errors.ts";
import { replay } from "./projection.ts";
import { validateDocument, validateReview } from './documents.ts';
import type { UsageRecord } from "./overhead.ts";

const GENESIS_HASH = "0".repeat(64);
/**
 * v2 adds invocation-unique worker-usage causal bindings, ready-work
 * completion fields, and the kernel-owned adviser sidecar tables. v1
 * databases refuse to open until the operator migration runs.
 */
export const CURRENT_SCHEMA_VERSION = 2;

const PROVIDER_ONLY = new Set([
  'document_posted', 'document_reviewed', 'planning_step',
  "opening_committed",
  "packet_posted",
  "candidate_posted",
  "signoff",
]);
const USER_ONLY = new Set([
  'clarification_answered', 'planning_extension',
  "goal_set",
  "permission_decided",
  "human_override",
  "budget_extended",
  "advisor_requested",
  "advisor_budget_extended",
  "cancelled",
]);
const COORDINATOR_ONLY = new Set([
  'planning_context', 'planning_finished',
  "worker_started",
  "barrier_released",
  "work_claimed",
  "completed",
  "billing_integrity_unknown",
]);
const SYSTEM_ONLY = new Set([
  "preflight_passed",
  "preflight_blocked",
  "verification_run",
  "disagreement_declared",
  "needs_input",
  "permission_requested",
  "paused_limit",
  "resume_scheduled",
  "resumed",
  "retry_scheduled",
  "incarnation_replaced",
  "lease_acquired",
  "lease_released",
  "lease_waiting",
  "uncertain_effect",
  "billing_route_updated",
  "overhead_gate_breached",
  "runtime_activity",
  "advisor_trigger",
  "exported",
]);

export interface EventStoreOptions {
  crashAt?: "pre_txn" | "post_txn_pre_projection" | "post_projection";
}

export class EventStore {
  readonly db: DatabaseSync;
  /**
   * Optional post-append observer (used by the advisory supervisor's typed
   * triggers). It runs after the durable commit and projection rebuild, and
   * a listener failure can never fail or roll back the append.
   */
  appendListener?: (event: StoredEvent) => void;

  constructor(
    readonly file: string,
    private readonly options: EventStoreOptions = {},
  ) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    // Version compatibility is checked before any pragma or DDL executes:
    // refusing to open an old or newer database must leave its bytes
    // untouched so the quiesced-WAL, verified-backup migration path sees the
    // exact pre-open file.
    const existingMeta = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'",
      )
      .get();
    if (existingMeta) {
      const storedVersion = this.schemaVersion();
      if (storedVersion > CURRENT_SCHEMA_VERSION) {
        this.db.close();
        throw new KernelError(
          "INVALID_STATE",
          `SCHEMA_TOO_NEW:${storedVersion}>${CURRENT_SCHEMA_VERSION}`,
        );
      }
      if (storedVersion < CURRENT_SCHEMA_VERSION) {
        this.db.close();
        throw new KernelError(
          "INVALID_STATE",
          `SCHEMA_MIGRATION_REQUIRED:${storedVersion}<${CURRENT_SCHEMA_VERSION}`,
        );
      }
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        UNIQUE (run_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS projections (
        run_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        projection_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        sha256 TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        producer TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_records (
        run_id TEXT NOT NULL,
        burst_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        classification TEXT NOT NULL,
        coordinator_owned_json TEXT,
        attribution_complete INTEGER NOT NULL,
        uncaused INTEGER NOT NULL,
        nested_usage_complete INTEGER NOT NULL,
        ready_work_id TEXT,
        claim_event_id TEXT,
        trigger_event_id TEXT,
        PRIMARY KEY (run_id, burst_key)
      );
      CREATE TABLE IF NOT EXISTS advisor_ledger (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        wake_id TEXT,
        ts TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS advisor_usage (
        run_id TEXT NOT NULL,
        wake_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        PRIMARY KEY (run_id, wake_id)
      );
      CREATE TABLE IF NOT EXISTS advisor_epochs (
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        epoch_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        fired_at TEXT,
        PRIMARY KEY (run_id, kind, epoch_key)
      );
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', ?)")
      .run(String(CURRENT_SCHEMA_VERSION));
    this.rebuildAllProjections();
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return Number(
      (this.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string })
        .value,
    );
  }

  listRunIds(): string[] {
    return (
      this.db
        .prepare(
          `SELECT run_id AS runId, MAX(ts) AS lastTs
           FROM events GROUP BY run_id ORDER BY lastTs DESC, run_id`,
        )
        .all() as Array<{ runId: string }>
    ).map((row) => row.runId);
  }

  events(runId: string): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, seq, id, idempotency_key, actor, type, ts, payload_json,
                payload_hash, prev_hash, hash
         FROM events WHERE run_id=? ORDER BY seq`,
      )
      .all(runId) as Array<Record<string, any>>;
    return rows.map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      id: row.id,
      idempotencyKey: row.idempotency_key,
      actor: row.actor,
      type: row.type,
      ts: row.ts,
      payload: JSON.parse(row.payload_json),
      payloadHash: row.payload_hash,
      prevHash: row.prev_hash,
      hash: row.hash,
    }));
  }

  projection(runId: string): RunProjection {
    const row = this.db
      .prepare("SELECT projection_json FROM projections WHERE run_id=?")
      .get(runId) as { projection_json: string } | undefined;
    return row ? JSON.parse(row.projection_json) : replay(runId, []);
  }

  append<T>(command: AppendCommand<T>): StoredEvent<T> {
    const payloadJson = canonicalJson(command.payload);
    const existing = this.db
      .prepare(
        "SELECT payload_json, type, actor FROM events WHERE run_id=? AND idempotency_key=?",
      )
      .get(command.runId, command.idempotencyKey) as
      | { payload_json: string; type: string; actor: string }
      | undefined;
    if (existing) {
      if (
        existing.payload_json !== payloadJson ||
        existing.type !== command.type ||
        existing.actor !== command.actor
      ) {
        throw new KernelError(
          "DUPLICATE_CONFLICT",
          `Idempotency key ${command.idempotencyKey} was reused with a different command`,
        );
      }
      return this.events(command.runId).find(
        (event) => event.idempotencyKey === command.idempotencyKey,
      ) as StoredEvent<T>;
    }

    const current = this.projection(command.runId);
    this.validate(command, current);
    if (this.options.crashAt === "pre_txn") throw new Error("CRASH_INJECTED:pre_txn");

    const previous = this.events(command.runId).at(-1);
    const seq = (previous?.seq ?? 0) + 1;
    if (command.expectedSeq !== undefined && command.expectedSeq !== (previous?.seq ?? 0)) {
      throw new KernelError("STALE_SEQUENCE", "Expected sequence does not match the event log", {
        expected: command.expectedSeq,
        actual: previous?.seq ?? 0,
      });
    }
    const payloadHash = sha256(payloadJson);
    const eventBase = {
      seq,
      id: newId("evt"),
      idempotencyKey: command.idempotencyKey,
      actor: command.actor,
      type: command.type,
      runId: command.runId,
      ts: command.ts ?? new Date().toISOString(),
      payload: command.payload,
      payloadHash,
      prevHash: previous?.hash ?? GENESIS_HASH,
    };
    const event: StoredEvent<T> = {
      ...eventBase,
      hash: digest(eventBase),
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO events(
            run_id, seq, id, idempotency_key, actor, type, ts, payload_json,
            payload_hash, prev_hash, hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.runId,
          event.seq,
          event.id,
          event.idempotencyKey,
          event.actor,
          event.type,
          event.ts,
          payloadJson,
          event.payloadHash,
          event.prevHash,
          event.hash,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (this.options.crashAt === "post_txn_pre_projection") {
      throw new Error("CRASH_INJECTED:post_txn_pre_projection");
    }
    this.rebuildProjection(command.runId);
    if (this.options.crashAt === "post_projection") {
      throw new Error("CRASH_INJECTED:post_projection");
    }
    if (this.appendListener) {
      try {
        this.appendListener(event);
      } catch {
        // Observers are advisory: their failures never affect the append.
      }
    }
    return event;
  }

  verifyHashChain(runId: string): { ok: true; count: number } {
    let previousHash = GENESIS_HASH;
    const events = this.events(runId);
    for (const event of events) {
      const { hash, ...base } = event;
      if (event.prevHash !== previousHash || digest(base) !== hash) {
        throw new KernelError("INVALID_EVENT", `Hash-chain verification failed at seq ${event.seq}`);
      }
      previousHash = hash;
    }
    return { ok: true, count: events.length };
  }

  /**
   * Records one invocation-unique worker usage row. The burst key must be
   * unique per guarded worker invocation: recording the identical record
   * under the same key is an idempotent duplicate delivery, but a different
   * record under an existing key is rejected — a retry or recovery call must
   * use a new invocation key and never overwrite an earlier invocation.
   */
  recordUsage(runId: string, burstKey: string, record: UsageRecord): void {
    const counts = [record.input, record.cachedInput, record.output, record.reasoning];
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new KernelError("INVALID_EVENT", "Usage counters must be non-negative integers");
    }
    const result = this.db
      .prepare(
        `INSERT INTO usage_records(
          run_id, burst_key, provider, input_tokens, cached_input_tokens,
          output_tokens, reasoning_tokens, classification, coordinator_owned_json,
          attribution_complete, uncaused, nested_usage_complete,
          ready_work_id, claim_event_id, trigger_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, burst_key) DO NOTHING`,
      )
      .run(
        runId,
        burstKey,
        record.provider,
        record.input,
        record.cachedInput,
        record.output,
        record.reasoning,
        record.classification,
        record.coordinatorOwnedContent === undefined
          ? null
          : canonicalJson(record.coordinatorOwnedContent),
        record.attributionComplete ? 1 : 0,
        record.uncaused ? 1 : 0,
        record.nestedUsageComplete ? 1 : 0,
        record.readyWorkId ?? null,
        record.claimEventId ?? null,
        record.triggerEventId ?? null,
      );
    if (result.changes === 1) return;
    const existing = this.usageRecord(runId, burstKey);
    if (!existing || canonicalJson(existing) !== canonicalJson(this.normalizeUsage(record))) {
      throw new KernelError(
        "DUPLICATE_CONFLICT",
        `USAGE_INVOCATION_KEY_REUSED:${burstKey}: an earlier invocation's row is never overwritten`,
      );
    }
  }

  private normalizeUsage(record: UsageRecord): UsageRecord {
    return {
      provider: record.provider,
      input: record.input,
      cachedInput: record.cachedInput,
      output: record.output,
      reasoning: record.reasoning,
      classification: record.classification,
      ...(record.coordinatorOwnedContent !== undefined
        ? { coordinatorOwnedContent: record.coordinatorOwnedContent }
        : {}),
      attributionComplete: record.attributionComplete,
      uncaused: record.uncaused,
      nestedUsageComplete: record.nestedUsageComplete,
      ...(record.readyWorkId ? { readyWorkId: record.readyWorkId } : {}),
      ...(record.claimEventId ? { claimEventId: record.claimEventId } : {}),
      ...(record.triggerEventId ? { triggerEventId: record.triggerEventId } : {}),
    };
  }

  private usageRecord(runId: string, burstKey: string): UsageRecord | null {
    const row = this.db
      .prepare(
        `SELECT provider, input_tokens, cached_input_tokens, output_tokens,
                reasoning_tokens, classification, coordinator_owned_json,
                attribution_complete, uncaused, nested_usage_complete,
                ready_work_id, claim_event_id, trigger_event_id
         FROM usage_records WHERE run_id=? AND burst_key=?`,
      )
      .get(runId, burstKey) as Record<string, any> | undefined;
    return row ? this.usageRowToRecord(row) : null;
  }

  private usageRowToRecord(row: Record<string, any>): UsageRecord {
    return {
      provider: row.provider,
      input: row.input_tokens,
      cachedInput: row.cached_input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
      classification: row.classification,
      ...(row.coordinator_owned_json
        ? { coordinatorOwnedContent: JSON.parse(row.coordinator_owned_json) }
        : {}),
      attributionComplete: Boolean(row.attribution_complete),
      uncaused: Boolean(row.uncaused),
      nestedUsageComplete: Boolean(row.nested_usage_complete),
      ...(row.ready_work_id ? { readyWorkId: String(row.ready_work_id) } : {}),
      ...(row.claim_event_id ? { claimEventId: String(row.claim_event_id) } : {}),
      ...(row.trigger_event_id
        ? { triggerEventId: String(row.trigger_event_id) }
        : {}),
    };
  }

  usageRecords(runId: string): UsageRecord[] {
    return (
      this.db
        .prepare(
          `SELECT provider, input_tokens, cached_input_tokens, output_tokens,
                  reasoning_tokens, classification, coordinator_owned_json,
                  attribution_complete, uncaused, nested_usage_complete,
                  ready_work_id, claim_event_id, trigger_event_id
           FROM usage_records WHERE run_id=? ORDER BY rowid`,
        )
        .all(runId) as Array<Record<string, any>>
    ).map((row) => this.usageRowToRecord(row));
  }

  rebuildProjection(runId: string): RunProjection {
    const projected = replay(runId, this.events(runId));
    this.db
      .prepare(
        `INSERT INTO projections(run_id, seq, projection_json)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET seq=excluded.seq, projection_json=excluded.projection_json`,
      )
      .run(runId, projected.seq, canonicalJson(projected));
    return projected;
  }

  rebuildAllProjections(): void {
    for (const runId of this.listRunIds()) this.rebuildProjection(runId);
  }

  private validate<T>(command: AppendCommand<T>, projection: RunProjection): void {
    if (TERMINAL_RUN_STATES.has(projection.state)) {
      throw new KernelError("TERMINAL_RUN", `Run ${command.runId} is terminal`);
    }
    if (PROVIDER_ONLY.has(command.type) && !PROVIDER_ROLES.includes(command.actor as ProviderRole)) {
      throw new KernelError("ACTOR_FORBIDDEN", `${command.type} requires a provider actor`);
    }
    if (USER_ONLY.has(command.type) && command.actor !== "user") {
      throw new KernelError("ACTOR_FORBIDDEN", `${command.type} requires the user actor`);
    }
    if (COORDINATOR_ONLY.has(command.type) && command.actor !== "coordinator") {
      throw new KernelError("ACTOR_FORBIDDEN", `${command.type} requires the coordinator actor`);
    }
    if (SYSTEM_ONLY.has(command.type) && command.actor !== "system") {
      throw new KernelError("ACTOR_FORBIDDEN", `${command.type} requires the system actor`);
    }
    if (command.type !== "goal_set" && !projection.goal) {
      throw new KernelError("INVALID_STATE", `${command.type} requires an immutable Goal Packet`);
    }
    if (command.type === "goal_set") {
      if (projection.goal) throw new KernelError("INVALID_STATE", "Goal Packet is immutable");
      const goal = (command.payload as { goal?: GoalPacket }).goal;
      if (!goal || goal.runId !== command.runId || goal.digest !== digest({
        goal: goal.goal,
        ...(goal.workflow ? { workflow: goal.workflow, projectContext: goal.projectContext ?? null } : {}),
        workspace: goal.workspace,
        constraints: goal.constraints,
        ...(goal.attachments ? { attachments: goal.attachments } : {}),
        authority: goal.authority,
        ...(goal.stopConditions
          ? { stopConditions: goal.stopConditions }
          : {}),
        ...(goal.resourceMode ? { resourceMode: goal.resourceMode } : {}),
        ...(goal.advisor ? { advisor: goal.advisor } : {}),
        completionEvidence: goal.completionEvidence,
        usefulWorkBudget: goal.usefulWorkBudget,
      })) {
        throw new KernelError("INVALID_EVENT", "Goal Packet digest is invalid");
      }
    }
    if (command.type === "barrier_released") {
      if (!projection.openings.codex || !projection.openings.claude) {
        throw new KernelError("BARRIER_CLOSED", "Both opening packets must commit first");
      }
    }
    if (command.type === "packet_posted") {
      const packet = (command.payload as any).packet;
      if (
        packet?.from !== command.actor ||
        (!projection.barrierReleased &&
          packet?.to !== "user" &&
          packet?.type !== "blocker" &&
          projection.openings[command.actor as ProviderRole] !== packet?.id)
      ) {
        throw new KernelError("BARRIER_CLOSED", "Peer bytes cannot cross the opening barrier");
      }
    }
    if (command.type === "work_claimed") {
      const payload = command.payload as any;
      if (payload.chargeBudget) {
        const providerBudget = projection.budgets.provider[payload.role as ProviderRole];
        const issueBudget = payload.issueId ? projection.budgets.issues[payload.issueId] : undefined;
        if (
          providerBudget.consumed >= providerBudget.limit ||
          (issueBudget && issueBudget.consumed >= issueBudget.limit)
        ) {
          throw new KernelError("BUDGET_EXHAUSTED", "Useful-work burst budget is exhausted", {
            provider: providerBudget,
            issue: issueBudget,
          });
        }
      }
    }
    if (command.type === "candidate_posted") {
      const payload = command.payload as any;
      if (
        !projection.barrierReleased ||
        payload.manifest?.runId !== command.runId ||
        payload.manifest?.goalDigest !== projection.goal?.digest ||
        payload.digest !== digest(payload.manifest as OutcomeManifest)
      ) {
        throw new KernelError("MANIFEST_MISMATCH", "Candidate manifest digest is invalid");
      }
    }
    if (command.type === "signoff") {
      const payload = command.payload as any;
      if (!projection.candidate) throw new KernelError("INVALID_STATE", "No candidate to sign");
      if (
        payload.role !== command.actor ||
        payload.manifestDigest !== projection.candidate.digest ||
        payload.verificationDigest !== projection.candidate.verificationDigest
      ) {
        throw new KernelError("MANIFEST_MISMATCH", "Signoff does not match the current candidate");
      }
      if (
        Object.values(projection.materialChallenges).some((challenge) => challenge.status === "open")
      ) {
        throw new KernelError(
          "UNRESOLVED_CHALLENGE",
          "Material challenges must be resolved or carried to disagreement",
        );
      }
    }
    if (command.type === "completed") {
      if (projection.goal?.workflow === 'planning') throw new Error('PLANNING_REQUIRES_DOCUMENT_COMPLETION');
      const payload = command.payload as any;
      if (!["completed_consensus", "completed_disagreement"].includes(payload.outcome)) {
        throw new KernelError("INVALID_STATE", "Completed outcome is invalid");
      }
      if (payload.outcome === "completed_consensus") {
        const codex = projection.signoffs.codex;
        const claude = projection.signoffs.claude;
        if (
          !codex ||
          !claude ||
          codex.manifestDigest !== projection.candidate?.digest ||
          codex.verificationDigest !== projection.candidate?.verificationDigest ||
          codex.manifestDigest !== claude.manifestDigest ||
          codex.verificationDigest !== claude.verificationDigest
        ) {
          throw new KernelError("MANIFEST_MISMATCH", "Consensus requires matching provider signoffs");
        }
      }
    }
    if (['planning_context','planning_step','document_posted','document_reviewed','planning_finished','clarification_answered','planning_extension'].includes(command.type)) {
      if (!projection.planning) throw new Error('PLANNING_RUN_REQUIRED');
      const p = projection.planning;
      const payload = command.payload as any;
      if (command.type === 'planning_context' && p.context.length) throw new Error('PLANNING_CONTEXT_IMMUTABLE');
      if (command.type === 'planning_step' && ['cross_review','synthesis','review','revision'].includes(payload.step?.phase) && !projection.barrierReleased) throw new Error('BARRIER_CLOSED');
      if (command.type === 'document_posted') {
        const doc = payload.document;
        validateDocument(doc, projection.goal!.completionEvidence, p.context.map(e => e.id));
        if (!projection.barrierReleased || doc.author !== command.actor || doc.number !== p.documents.length + 1 || doc.number > (p.extensionFocus ? 3 : 2)) throw new Error('DOCUMENT_SEQUENCE_INVALID');
        if (p.documents.some(d => d.revision === doc.revision) || p.documents.at(-1)?.body === doc.body) throw new Error('DOCUMENT_REVISION_UNCHANGED');
        const currentCrossObjections = p.steps.filter(s => s.phase === 'cross_review' && s.key.startsWith(`${p.answers.length}|`)).flatMap(s => (s.output as any).objections ?? []);
        if (!p.documents.length && currentCrossObjections.some(o => o.severity === 'material' && !doc.dispositions.some((d: any) => d.objectionId === o.id))) throw new Error('DOCUMENT_DROPPED_CROSS_REVIEW');
        const previous = p.documents.at(-1);
        if (previous) {
          const objections = p.reviews.filter(r => r.revision === previous.revision).flatMap(r => r.objections.filter(o => o.severity === 'material'));
          if (objections.some(o => !doc.dispositions.some((d: any) => d.objectionId === o.id))) throw new Error('DOCUMENT_DROPPED_OBJECTION');
        }
      }
      if (command.type === 'document_reviewed') {
        const doc = p.documents.at(-1);
        if (!doc || payload.review.reviewer !== command.actor || p.reviews.some(r => r.reviewer === command.actor && r.revision === doc.revision && (r.contextVersion ?? 0) === p.answers.length)) throw new Error('REVIEW_SEQUENCE_INVALID');
        if ((payload.review.contextVersion ?? 0) !== p.answers.length) throw new Error('REVIEW_CONTEXT_MISMATCH');
        validateReview(payload.review, doc, projection.goal!.completionEvidence, p.context.map(e => e.id));
      }
      if (command.type === 'planning_step' && (payload.step.role !== command.actor || p.steps.some(s => s.key === payload.step.key))) throw new Error('PLANNING_STEP_INVALID');
      if (command.type === 'planning_finished' && !p.documents.at(-1)?.body.trim()) throw new Error('DOCUMENT_REQUIRED');
      if (command.type === 'clarification_answered' && (!payload.answer?.trim() || !projection.actions.some(a => a.id === payload.cardId && a.kind === 'needs_input'))) throw new Error('CLARIFICATION_ANSWER_REQUIRED');
      if (command.type === 'planning_extension' && (p.extensionFocus || !payload.focus?.trim() || !projection.actions.some(a => a.id === payload.cardId && a.kind === 'disagreement'))) throw new Error('PLANNING_EXTENSION_INVALID');
    }
    if (
      command.type === "budget_extended" ||
      command.type === "advisor_budget_extended"
    ) {
      const payload = command.payload as any;
      if (!Number.isSafeInteger(payload.units) || payload.units <= 0) {
        throw new KernelError("INVALID_EVENT", "Budget extension units must be a positive integer");
      }
    }
  }
}
