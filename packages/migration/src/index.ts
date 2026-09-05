import { documentMarkdown } from '@collab/kernel';
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredEvent } from "@collab/contracts";
import { canonicalJson, EventStore } from "@collab/kernel";

export interface LegacyTask {
  path: string;
  name: string;
  state: Record<string, unknown> | null;
  goal: string;
  notes: Array<{ name: string; content: string }>;
  transcript: string;
  finalPlan: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  readOnly: true;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function inventoryTree(root: string): Array<{ path: string; sha256: string; size: number }> {
  const output: Array<{ path: string; sha256: string; size: number }> = [];
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        output.push({
          path: relative(root, full),
          sha256: hashFile(full),
          size: statSync(full).size,
        });
      }
    }
  }
  walk(root);
  return output;
}

export function readLegacyTask(path: string): LegacyTask {
  const read = (name: string): string =>
    existsSync(join(path, name)) ? readFileSync(join(path, name), "utf8") : "";
  let state: Record<string, unknown> | null = null;
  try {
    state = JSON.parse(read("state.json"));
  } catch {
    state = null;
  }
  const task = read("TASK.md");
  const goalMatch = task.match(/(?:Objective|objective):\*?\*?\s*(.+)/);
  return {
    path,
    name: basename(path),
    state,
    goal: goalMatch?.[1]?.trim() ?? task.split("\n").find((line) => line.trim()) ?? basename(path),
    notes: ["notes.md", "codex-notes.md", "claude-notes.md"]
      .filter((name) => existsSync(join(path, name)))
      .map((name) => ({ name, content: read(name) })),
    transcript: read("transcript.md"),
    finalPlan: read("final-plan.md"),
    files: inventoryTree(path),
    readOnly: true,
  };
}

export interface LegacyTaskSummary {
  id: string;
  name: string;
  goal: string;
  status: string | null;
  fileCount: number;
  readOnly: true;
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * Resolve only an immediate child of the configured legacy root. The caller
 * never supplies an arbitrary filesystem path.
 */
export function resolveLegacyTask(root: string, id: string): string {
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error("INVALID_LEGACY_TASK_ID");
  }
  const canonicalRoot = realpathSync(resolve(root));
  const candidate = realpathSync(join(canonicalRoot, id));
  if (!contained(canonicalRoot, candidate)) {
    throw new Error("LEGACY_TASK_OUTSIDE_CONFIGURED_ROOT");
  }
  if (basename(candidate) !== id || !statSync(candidate).isDirectory()) {
    throw new Error("LEGACY_TASK_NOT_FOUND");
  }
  return candidate;
}

export function listLegacyTasks(root: string): LegacyTaskSummary[] {
  const canonicalRoot = realpathSync(resolve(root));
  if (!statSync(canonicalRoot).isDirectory()) {
    throw new Error("LEGACY_ROOT_NOT_DIRECTORY");
  }
  return readdirSync(canonicalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const task = readLegacyTask(resolveLegacyTask(canonicalRoot, entry.name));
      return {
        id: entry.name,
        name: task.name,
        goal: task.goal,
        status:
          task.state?.status === undefined ? null : String(task.state.status),
        fileCount: task.files.length,
        readOnly: true,
      };
    });
}

export function readConfiguredLegacyTask(root: string, id: string): LegacyTask {
  return readLegacyTask(resolveLegacyTask(root, id));
}

export function legacyIsActive(task: LegacyTask): boolean {
  const status = task.state?.status;
  return status !== undefined && !["consensus", "deadlock", "completed", "cancelled"].includes(String(status));
}

export interface ImportPlan {
  source: string;
  sourceHash: string;
  files: LegacyTask["files"];
  writes: string[];
}

export function planLegacyImport(source: string, destination: string): ImportPlan {
  const task = readLegacyTask(source);
  if (legacyIsActive(task)) throw new Error("ACTIVE_LEGACY_REFUSED");
  const sourceHash = createHash("sha256").update(canonicalJson(task.files)).digest("hex");
  return {
    source,
    sourceHash,
    files: task.files,
    writes: task.files.map((file) => join(destination, "legacy", sourceHash, file.path)),
  };
}

export function importLegacyCopy(source: string, destination: string): ImportPlan {
  const plan = planLegacyImport(source, destination);
  const target = join(destination, "legacy", plan.sourceHash);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  return plan;
}

export function exportRun(
  store: EventStore,
  runId: string,
  destination: string,
  options: { advisorDirectory?: string } = {},
): {
  files: string[];
  checksums: Record<string, string>;
} {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const events = store.events(runId);
  const jsonlPath = join(destination, "events.jsonl");
  const transcriptPath = join(destination, "transcript.md");
  const manifestPath = join(destination, "projection.json");
  writeFileSync(jsonlPath, `${events.map((event) => canonicalJson(event)).join("\n")}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    transcriptPath,
    events
      .map((event) => `## ${event.seq} · ${event.type}\n\nActor: ${event.actor}\n\n\`\`\`json\n${JSON.stringify(event.payload, null, 2)}\n\`\`\`\n`)
      .join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(manifestPath, `${canonicalJson(store.projection(runId))}\n`, { mode: 0o600 });
  const files = [jsonlPath, transcriptPath, manifestPath];
  const planning = store.projection(runId).planning;
  if (planning?.documents.length) {
    const path = join(destination, 'document.md');
    writeFileSync(path, documentMarkdown(planning), { mode: 0o600 }); files.push(path);
  }
  // Adviser files (observations.jsonl, notes.md, retrospective.md) are copied
  // by content with checksums; symbolic links are never followed.
  if (options.advisorDirectory) {
    const advisorDestination = join(destination, "advisor");
    for (const name of ["observations.jsonl", "notes.md", "retrospective.md"]) {
      const source = join(options.advisorDirectory, name);
      let stat;
      try {
        stat = lstatSync(source);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      mkdirSync(advisorDestination, { recursive: true, mode: 0o700 });
      const target = join(advisorDestination, name);
      writeFileSync(target, readFileSync(source), { mode: 0o600 });
      files.push(target);
    }
  }
  return {
    files,
    checksums: Object.fromEntries(
      files.map((file) => [
        file.includes(`${sep}advisor${sep}`) ? `advisor/${basename(file)}` : basename(file),
        hashFile(file),
      ]),
    ),
  };
}

export function parseExportedEvents(jsonl: string): StoredEvent[] {
  return jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function migrateDatabaseWithBackup(input: {
  database: string;
  backup: string;
  fromVersion: number;
  toVersion: number;
  apply: (database: DatabaseSync) => void;
}): {
  backupSha256: string;
  migratedSha256: string;
  fromVersion: number;
  toVersion: number;
} {
  if (
    !Number.isSafeInteger(input.fromVersion) ||
    !Number.isSafeInteger(input.toVersion) ||
    input.toVersion <= input.fromVersion
  ) {
    throw new Error("INVALID_SCHEMA_MIGRATION_RANGE");
  }
  if (existsSync(`${input.database}-wal`) && statSync(`${input.database}-wal`).size > 0) {
    throw new Error("ACTIVE_DATABASE_WAL_REFUSED");
  }
  copyFileSync(input.database, input.backup, 0);
  const sourceSha256 = hashFile(input.database);
  const backupSha256 = hashFile(input.backup);
  if (sourceSha256 !== backupSha256) {
    throw new Error("DATABASE_BACKUP_VERIFICATION_FAILED");
  }
  const database = new DatabaseSync(input.database);
  try {
    const row = database
      .prepare("SELECT value FROM schema_meta WHERE key='version'")
      .get() as { value: string } | undefined;
    if (Number(row?.value) !== input.fromVersion) {
      throw new Error(
        `DATABASE_SCHEMA_VERSION_MISMATCH:${String(row?.value)}!=${input.fromVersion}`,
      );
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      input.apply(database);
      database
        .prepare("UPDATE schema_meta SET value=? WHERE key='version'")
        .run(String(input.toVersion));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    database.close();
    copyFileSync(input.backup, input.database, 0);
    if (hashFile(input.database) !== backupSha256) {
      throw new Error("DATABASE_ROLLBACK_VERIFICATION_FAILED");
    }
    throw error;
  }
  database.close();
  return {
    backupSha256,
    migratedSha256: hashFile(input.database),
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
  };
}

export function restoreDatabaseBackup(
  database: string,
  backup: string,
): { restoredSha256: string } {
  const backupSha256 = hashFile(backup);
  copyFileSync(backup, database, 0);
  const restoredSha256 = hashFile(database);
  if (restoredSha256 !== backupSha256) {
    throw new Error("DATABASE_ROLLBACK_VERIFICATION_FAILED");
  }
  return { restoredSha256 };
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

/**
 * The schema v1 -> v2 apply step. v2 adds:
 * - invocation-unique worker-usage causal-binding columns
 *   (`ready_work_id`, `claim_event_id`, `trigger_event_id`);
 * - ready-work completion fields (`completed_at`, `outcome`) for explicit
 *   no-replay recovery;
 * - the kernel-owned, hash-linked adviser sidecar tables
 *   (`advisor_ledger`, `advisor_usage`, `advisor_epochs`).
 * Legacy worker/usage/ready rows are preserved byte-for-byte semantically:
 * new columns are nullable and legacy rows keep NULL bindings, which the
 * report layer treats as "recorded before invocation binding existed".
 * Run only through `migrateDatabaseWithBackup` (quiesced WAL, verified byte
 * backup, transactional apply, verified rollback on failure).
 */
export function applySchemaV1ToV2(db: DatabaseSync): void {
  if (tableExists(db, "usage_records")) {
    const columns = columnNames(db, "usage_records");
    for (const column of ["ready_work_id", "claim_event_id", "trigger_event_id"]) {
      if (!columns.has(column)) {
        db.exec(`ALTER TABLE usage_records ADD COLUMN ${column} TEXT`);
      }
    }
  }
  if (tableExists(db, "ready_work")) {
    const columns = columnNames(db, "ready_work");
    for (const column of ["completed_at", "outcome"]) {
      if (!columns.has(column)) {
        db.exec(`ALTER TABLE ready_work ADD COLUMN ${column} TEXT`);
      }
    }
  }
  db.exec(`
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

/** Operator entry point: quiesced-WAL, verified-backup transactional v1->v2. */
export function migrateCollabDatabaseV1ToV2(input: {
  database: string;
  backup: string;
}): ReturnType<typeof migrateDatabaseWithBackup> {
  return migrateDatabaseWithBackup({
    database: input.database,
    backup: input.backup,
    fromVersion: 1,
    toVersion: 2,
    apply: applySchemaV1ToV2,
  });
}
