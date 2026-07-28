import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProviderRole, ReadyRole, ReadyWorkItem, WakeReason } from "@collab/contracts";
import { KernelError } from "./errors.ts";

const CAUSAL_REASONS = new Set<WakeReason>([
  "addressed_event",
  "user_action",
  "trusted_timer",
  "recovery_obligation",
]);

export class ReadyQueue {
  private readonly pending: ReadyWorkItem[] = [];
  private readonly seenTriggers = new Set<string>();

  constructor(private readonly db?: DatabaseSync) {
    this.db?.exec(`
      CREATE TABLE IF NOT EXISTS ready_work (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        trigger_event_id TEXT NOT NULL,
        trigger_seq INTEGER NOT NULL,
        reason TEXT NOT NULL,
        issue_id TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        outcome TEXT,
        UNIQUE(run_id, role, trigger_event_id, reason)
      )
    `);
  }

  enqueue(
    input: Omit<ReadyWorkItem, "id" | "role"> & { role: ProviderRole },
  ): ReadyWorkItem | null {
    if (input.role !== "codex" && input.role !== "claude") {
      throw new KernelError(
        "INVALID_EVENT",
        `Worker enqueue accepts provider roles only; use enqueueAdvisor for adviser work (got ${String(
          input.role,
        )})`,
      );
    }
    return this.enqueueItem(input);
  }

  private enqueueItem(input: Omit<ReadyWorkItem, "id">): ReadyWorkItem | null {
    const key = `${input.runId}:${input.role}:${input.triggerEventId}:${input.reason}`;
    if (this.db) {
      const item = { ...input, id: `work_${randomUUID()}` };
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO ready_work(
            id, run_id, role, trigger_event_id, trigger_seq, reason, issue_id, claimed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          item.runId,
          item.role,
          item.triggerEventId,
          item.triggerSeq,
          item.reason,
          item.issueId ?? null,
          item.claimedAt ?? null,
        );
      return result.changes === 1 ? structuredClone(item) : null;
    }
    if (this.seenTriggers.has(key)) return null;
    this.seenTriggers.add(key);
    const item = { ...input, id: `work_${randomUUID()}` };
    this.pending.push(item);
    this.pending.sort((left, right) => left.triggerSeq - right.triggerSeq || left.id.localeCompare(right.id));
    return item;
  }

  /**
   * Enqueues adviser work. The adviser shares the causal durable queue but
   * nothing else: its role value never reaches worker, billing, budget, or
   * signoff maps, and worker `claim()` can never return it.
   */
  enqueueAdvisor(
    input: Omit<ReadyWorkItem, "id" | "role">,
  ): ReadyWorkItem | null {
    return this.enqueueItem({ ...input, role: "advisor" });
  }

  claim(
    role: ProviderRole,
    now = new Date().toISOString(),
    runId?: string,
  ): ReadyWorkItem | null {
    if ((role as ReadyRole) === "advisor") {
      throw new KernelError(
        "INVALID_EVENT",
        "Worker claim can never return adviser work; use claimAdvisor",
      );
    }
    return this.claimRole(role, now, runId);
  }

  /** Claims the next adviser ready item; never a worker item. */
  claimAdvisor(
    now = new Date().toISOString(),
    runId?: string,
  ): ReadyWorkItem | null {
    return this.claimRole("advisor", now, runId);
  }

  private claimRole(
    role: ReadyRole,
    now: string,
    runId?: string,
  ): ReadyWorkItem | null {
    if (this.db) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db
          .prepare(
            `SELECT id, run_id, role, trigger_event_id, trigger_seq, reason, issue_id
             FROM ready_work
             WHERE role=? AND claimed_at IS NULL
               AND (? IS NULL OR run_id=?)
             ORDER BY trigger_seq, id
             LIMIT 1`,
          )
          .get(role, runId ?? null, runId ?? null) as
          | Record<string, unknown>
          | undefined;
        if (!row) {
          this.db.exec("COMMIT");
          return null;
        }
        const reason = String(row.reason) as WakeReason;
        if (!CAUSAL_REASONS.has(reason)) {
          this.db.exec("ROLLBACK");
          throw new KernelError(
            "INVALID_EVENT",
            `Ready item ${String(row.id)} cannot launch a model for zero-cost reason ${reason}`,
          );
        }
        const result = this.db
          .prepare(
            "UPDATE ready_work SET claimed_at=? WHERE id=? AND claimed_at IS NULL",
          )
          .run(now, String(row.id));
        if (result.changes !== 1) {
          this.db.exec("ROLLBACK");
          throw new KernelError(
            "STALE_SEQUENCE",
            `Ready item ${String(row.id)} was claimed concurrently`,
          );
        }
        this.db.exec("COMMIT");
        return {
          id: String(row.id),
          runId: String(row.run_id),
          role: String(row.role) as ReadyRole,
          triggerEventId: String(row.trigger_event_id),
          triggerSeq: Number(row.trigger_seq),
          reason,
          ...(row.issue_id ? { issueId: String(row.issue_id) } : {}),
          claimedAt: now,
        };
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // The successful COMMIT/no-row path leaves no open transaction.
        }
        throw error;
      }
    }
    const index = this.pending.findIndex(
      (item) =>
        item.role === role &&
        !item.claimedAt &&
        (runId === undefined || item.runId === runId),
    );
    if (index < 0) return null;
    const item = this.pending[index]!;
    if (!CAUSAL_REASONS.has(item.reason)) {
      throw new KernelError(
        "INVALID_EVENT",
        `Ready item ${item.id} cannot launch a model for zero-cost reason ${item.reason}`,
      );
    }
    item.claimedAt = now;
    return structuredClone(item);
  }

  /**
   * Records an explicit completion outcome for a claimed item. Recovery uses
   * this to distinguish "claimed and resolved" from "claimed with an unknown
   * crash outcome", which is failed visibly and never replayed.
   */
  complete(id: string, outcome: string, now = new Date().toISOString()): void {
    if (this.db) {
      const result = this.db
        .prepare(
          "UPDATE ready_work SET completed_at=?, outcome=? WHERE id=? AND claimed_at IS NOT NULL AND completed_at IS NULL",
        )
        .run(now, outcome, id);
      if (result.changes !== 1) {
        throw new KernelError(
          "INVALID_STATE",
          `Ready item ${id} is not an uncompleted claimed item`,
        );
      }
      return;
    }
    const item = this.pending.find((entry) => entry.id === id);
    if (!item || !item.claimedAt || item.completedAt) {
      throw new KernelError(
        "INVALID_STATE",
        `Ready item ${id} is not an uncompleted claimed item`,
      );
    }
    item.completedAt = now;
    item.outcome = outcome;
  }

  /** Claimed adviser items with no completion outcome (crash recovery scan). */
  unresolvedAdvisorClaims(runId?: string): ReadyWorkItem[] {
    if (this.db) {
      return (
        this.db
          .prepare(
            `SELECT id, run_id, role, trigger_event_id, trigger_seq, reason, issue_id,
                    claimed_at, completed_at, outcome
             FROM ready_work
             WHERE role='advisor' AND claimed_at IS NOT NULL AND completed_at IS NULL
               AND (? IS NULL OR run_id=?)
             ORDER BY trigger_seq, id`,
          )
          .all(runId ?? null, runId ?? null) as Array<Record<string, unknown>>
      ).map((row) => this.rowToItem(row));
    }
    return this.pending
      .filter(
        (item) =>
          item.role === "advisor" &&
          item.claimedAt &&
          !item.completedAt &&
          (runId === undefined || item.runId === runId),
      )
      .map((item) => structuredClone(item));
  }

  size(role?: ReadyRole): number {
    if (this.db) {
      return Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM ready_work
               WHERE claimed_at IS NULL AND (? IS NULL OR role=?)`,
            )
            .get(role ?? null, role ?? null) as { count: number }
        ).count,
      );
    }
    return this.pending.filter(
      (item) => !item.claimedAt && (role === undefined || item.role === role),
    ).length;
  }

  claimedItem(id: string): ReadyWorkItem | null {
    if (this.db) {
      const row = this.db
        .prepare(
          `SELECT id, run_id, role, trigger_event_id, trigger_seq, reason, issue_id,
                  claimed_at, completed_at, outcome
           FROM ready_work WHERE id=? AND claimed_at IS NOT NULL`,
        )
        .get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return this.rowToItem(row);
    }
    const item = this.pending.find((entry) => entry.id === id && entry.claimedAt);
    return item ? structuredClone(item) : null;
  }

  private rowToItem(row: Record<string, unknown>): ReadyWorkItem {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      role: String(row.role) as ReadyRole,
      triggerEventId: String(row.trigger_event_id),
      triggerSeq: Number(row.trigger_seq),
      reason: String(row.reason) as WakeReason,
      ...(row.issue_id ? { issueId: String(row.issue_id) } : {}),
      ...(row.claimed_at ? { claimedAt: String(row.claimed_at) } : {}),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      ...(row.outcome ? { outcome: String(row.outcome) } : {}),
    };
  }
}
