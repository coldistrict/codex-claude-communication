import type { DatabaseSync } from "node:sqlite";
import type { AdvisorTriggerKind, ProviderRole } from "@collab/contracts";
import { canonicalJson, digest, newId, sha256 } from "./canonical.ts";
import { KernelError } from "./errors.ts";

const GENESIS_HASH = "0".repeat(64);

export type AdvisorLedgerKind =
  | "wake_claimed"
  | "wake_outcome"
  | "observation"
  | "failure";

export interface AdvisorLedgerRow<T = unknown> {
  runId: string;
  seq: number;
  id: string;
  kind: AdvisorLedgerKind;
  wakeId: string | null;
  ts: string;
  payload: T;
  prevHash: string;
  hash: string;
}

export interface AdvisorWakeClaim {
  wakeId: string;
  provider: ProviderRole;
  readyWorkId: string;
  triggerEventId: string;
  triggerKind: AdvisorTriggerKind;
  conditionInstanceId: string;
  purpose: "advisor_observation" | "advisor_retrospective";
  observedThroughSeq: number;
}

export interface AdvisorUsageRow {
  runId: string;
  wakeId: string;
  provider: ProviderRole;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  complete: boolean;
}

export interface AdvisorUsageReport {
  wakeCount: number;
  usageRows: number;
  usageCoverageComplete: boolean;
  uncausedWakes: number;
  totalTokens: number;
  byProvider: Record<
    string,
    { input: number; cachedInput: number; output: number; reasoning: number }
  >;
}

/**
 * Kernel-owned, append-only, hash-linked adviser sidecar. It records wake
 * claims, outcomes, validated observations, failures, and unique per-wake
 * usage. It is deliberately separate from the core event log: the core
 * Actor union, packets, manifests, signoffs, and terminal-state enforcement
 * are untouched, and sidecar appends remain legal after a terminal core
 * event (a non-cancel retrospective) without weakening the core store's
 * terminal append rejection. The adviser model itself never writes here —
 * only validated service code does — and nothing here can author a core
 * event.
 */
export class AdvisorSidecar {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
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
  }

  append<T>(
    runId: string,
    kind: AdvisorLedgerKind,
    wakeId: string | null,
    payload: T,
    ts = new Date().toISOString(),
  ): AdvisorLedgerRow<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare(
          "SELECT seq, hash FROM advisor_ledger WHERE run_id=? ORDER BY seq DESC LIMIT 1",
        )
        .get(runId) as { seq: number; hash: string } | undefined;
      const seq = (previous?.seq ?? 0) + 1;
      const base = {
        runId,
        seq,
        id: newId("advrec"),
        kind,
        wakeId,
        ts,
        payload,
        prevHash: previous?.hash ?? GENESIS_HASH,
      };
      const row: AdvisorLedgerRow<T> = { ...base, hash: digest(base) };
      this.db
        .prepare(
          `INSERT INTO advisor_ledger(
            run_id, seq, id, kind, wake_id, ts, payload_json, prev_hash, hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.runId,
          row.seq,
          row.id,
          row.kind,
          row.wakeId,
          row.ts,
          canonicalJson(row.payload),
          row.prevHash,
          row.hash,
        );
      this.db.exec("COMMIT");
      return row;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rows(runId: string): AdvisorLedgerRow[] {
    return (
      this.db
        .prepare(
          `SELECT run_id, seq, id, kind, wake_id, ts, payload_json, prev_hash, hash
           FROM advisor_ledger WHERE run_id=? ORDER BY seq`,
        )
        .all(runId) as Array<Record<string, any>>
    ).map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      id: row.id,
      kind: row.kind,
      wakeId: row.wake_id ?? null,
      ts: row.ts,
      payload: JSON.parse(row.payload_json),
      prevHash: row.prev_hash,
      hash: row.hash,
    }));
  }

  verifyChain(runId: string): { ok: true; count: number } {
    let previousHash = GENESIS_HASH;
    const rows = this.rows(runId);
    for (const row of rows) {
      const { hash, ...base } = row;
      if (row.prevHash !== previousHash || digest(base) !== hash) {
        throw new KernelError(
          "INVALID_EVENT",
          `Adviser sidecar hash chain failed at seq ${row.seq}`,
        );
      }
      previousHash = hash;
    }
    return { ok: true, count: rows.length };
  }

  /** Unique adviser usage keyed by wake id; identical re-record is idempotent. */
  recordUsage(row: AdvisorUsageRow): void {
    const counts = [row.input, row.cachedInput, row.output, row.reasoning];
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new KernelError(
        "INVALID_EVENT",
        "Adviser usage counters must be non-negative integers",
      );
    }
    const result = this.db
      .prepare(
        `INSERT INTO advisor_usage(
          run_id, wake_id, provider, input_tokens, cached_input_tokens,
          output_tokens, reasoning_tokens, complete
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, wake_id) DO NOTHING`,
      )
      .run(
        row.runId,
        row.wakeId,
        row.provider,
        row.input,
        row.cachedInput,
        row.output,
        row.reasoning,
        row.complete ? 1 : 0,
      );
    if (result.changes === 1) return;
    const existing = this.usage(row.runId).find(
      (candidate) => candidate.wakeId === row.wakeId,
    );
    if (!existing || canonicalJson(existing) !== canonicalJson(row)) {
      throw new KernelError(
        "DUPLICATE_CONFLICT",
        `ADVISOR_USAGE_WAKE_REUSED:${row.wakeId}`,
      );
    }
  }

  usage(runId: string): AdvisorUsageRow[] {
    return (
      this.db
        .prepare(
          `SELECT run_id, wake_id, provider, input_tokens, cached_input_tokens,
                  output_tokens, reasoning_tokens, complete
           FROM advisor_usage WHERE run_id=? ORDER BY wake_id`,
        )
        .all(runId) as Array<Record<string, any>>
    ).map((row) => ({
      runId: row.run_id,
      wakeId: row.wake_id,
      provider: row.provider,
      input: row.input_tokens,
      cachedInput: row.cached_input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
      complete: Boolean(row.complete),
    }));
  }

  /**
   * Adviser accounting: full separate usage plus coverage and causality.
   * Adviser tokens, calls, and wakes never enter the worker gate's total,
   * useful lower bound, ratio, or burst count.
   */
  usageReport(runId: string): AdvisorUsageReport {
    const ledger = this.rows(runId);
    const claims = ledger.filter((row) => row.kind === "wake_claimed");
    const usage = this.usage(runId);
    const claimedWakeIds = new Set(
      claims.map((row) => String(row.wakeId ?? "")),
    );
    const byProvider: AdvisorUsageReport["byProvider"] = {};
    let totalTokens = 0;
    let uncausedWakes = 0;
    let usageCoverageComplete = true;
    for (const row of usage) {
      const bucket = (byProvider[row.provider] ??= {
        input: 0,
        cachedInput: 0,
        output: 0,
        reasoning: 0,
      });
      bucket.input += row.input;
      bucket.cachedInput += row.cachedInput;
      bucket.output += row.output;
      bucket.reasoning += row.reasoning;
      totalTokens += row.input + row.cachedInput + row.output + row.reasoning;
      if (!row.complete) usageCoverageComplete = false;
      if (!claimedWakeIds.has(row.wakeId)) uncausedWakes += 1;
    }
    // Every wake that reached a guarded model start must have a usage row.
    for (const claim of claims) {
      const payload = claim.payload as { modelStarted?: unknown };
      const outcome = ledger.find(
        (row) => row.kind === "wake_outcome" && row.wakeId === claim.wakeId,
      );
      const started =
        (outcome?.payload as { modelStarted?: unknown } | undefined)
          ?.modelStarted === true || payload?.modelStarted === true;
      if (started && !usage.some((row) => row.wakeId === claim.wakeId)) {
        usageCoverageComplete = false;
      }
    }
    return {
      wakeCount: claims.length,
      usageRows: usage.length,
      usageCoverageComplete,
      uncausedWakes,
      totalTokens,
      byProvider,
    };
  }

  /** Durable scheduler epochs (resource degradation and similar deadlines). */
  upsertEpoch(input: {
    runId: string;
    kind: string;
    epochKey: string;
    startedAt: string;
    deadlineAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO advisor_epochs(run_id, kind, epoch_key, started_at, deadline_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, kind, epoch_key) DO NOTHING`,
      )
      .run(input.runId, input.kind, input.epochKey, input.startedAt, input.deadlineAt);
  }

  markEpochFired(runId: string, kind: string, epochKey: string, at: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE advisor_epochs SET fired_at=? WHERE run_id=? AND kind=? AND epoch_key=? AND fired_at IS NULL`,
        )
        .run(at, runId, kind, epochKey).changes === 1
    );
  }

  clearEpoch(runId: string, kind: string, epochKey: string): void {
    this.db
      .prepare(
        "DELETE FROM advisor_epochs WHERE run_id=? AND kind=? AND epoch_key=? AND fired_at IS NULL",
      )
      .run(runId, kind, epochKey);
  }

  epochs(runId: string): Array<{
    runId: string;
    kind: string;
    epochKey: string;
    startedAt: string;
    deadlineAt: string;
    firedAt: string | null;
  }> {
    return (
      this.db
        .prepare(
          `SELECT run_id, kind, epoch_key, started_at, deadline_at, fired_at
           FROM advisor_epochs WHERE run_id=? ORDER BY started_at`,
        )
        .all(runId) as Array<Record<string, any>>
    ).map((row) => ({
      runId: row.run_id,
      kind: row.kind,
      epochKey: row.epoch_key,
      startedAt: row.started_at,
      deadlineAt: row.deadline_at,
      firedAt: row.fired_at ?? null,
    }));
  }
}

export function advisorInputDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}
