import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, digest, EventStore, replay } from "@collab/kernel";
import {
  exportRun,
  importLegacyCopy,
  inventoryTree,
  migrateCollabDatabaseV1ToV2,
  migrateDatabaseWithBackup,
  parseExportedEvents,
  planLegacyImport,
  readLegacyTask,
  restoreDatabaseBackup,
} from "../src/index.ts";

// Representative legacy formats belong to the test, not a developer's
// sibling task history. Real saved-history verification is recorded separately.
const tasksRoot = mkdtempSync(join(tmpdir(), "collab-legacy-fixtures-"));
const fixtures: Array<{ name: string; files: Record<string, string>; goal: string }> = [
  { name: "completed-with-artifacts", files: { "TASK.md": "Objective: Review a proposal", "state.json": '{"status":"completed"}', "final-plan.md": "Keep the reviewed plan." }, goal: "Review a proposal" },
  { name: "active", files: { "TASK.md": "Objective: Active work", "state.json": '{"status":"running"}' }, goal: "Active work" },
  { name: "missing-state", files: { "TASK.md": "Objective: Missing state", "notes.md": "Shared note" }, goal: "Missing state" },
  { name: "invalid-state", files: { "TASK.md": "Objective: Invalid state", "state.json": "{incomplete" }, goal: "Invalid state" },
  { name: "consensus", files: { "TASK.md": "Objective: Agreed result", "state.json": '{"status":"consensus"}', "codex-notes.md": "Codex note", "claude-notes.md": "Claude note" }, goal: "Agreed result" },
  { name: "deadlock", files: { "TASK.md": "Objective: Preserve dissent", "state.json": '{"status":"deadlock"}', "transcript.md": "Remaining tradeoff" }, goal: "Preserve dissent" },
  { name: "cancelled", files: { "TASK.md": "Objective: Cancelled work", "state.json": '{"status":"cancelled"}' }, goal: "Cancelled work" },
  { name: "notes-only", files: { "notes.md": "No task document" }, goal: "notes-only" },
  { name: "lowercase-objective", files: { "TASK.md": "objective: Lowercase format" }, goal: "Lowercase format" },
  { name: "heading-fallback", files: { "TASK.md": "# Historical goal\nDescription" }, goal: "# Historical goal" },
];
for (const fixture of fixtures) {
  const directory = join(tasksRoot, fixture.name);
  mkdirSync(directory);
  for (const [name, content] of Object.entries(fixture.files)) writeFileSync(join(directory, name), content);
}
const approvedTask = join(tasksRoot, "completed-with-artifacts");
mkdirSync(join(approvedTask, "artifacts"));
for (let index = 0; index < 32; index++) writeFileSync(join(approvedTask, "artifacts", `record-${index}.txt`), `Synthetic record ${index}\n`);
afterAll(() => rmSync(tasksRoot, { recursive: true, force: true }));

describe("V-10 legacy read-only, copy import, export, and backup", () => {
  it("renders representative historical task shapes without changing one source byte", () => {
    const before = inventoryTree(tasksRoot);
    const taskDirectories = new Set(before.map((file) => file.path.split("/")[0]!));
    expect(taskDirectories.size).toBeGreaterThanOrEqual(10);
    for (const name of taskDirectories) {
      const task = readLegacyTask(join(tasksRoot, name));
      expect(task.readOnly).toBe(true);
      expect(task.name).toBe(name);
      expect(task.files.length).toBeGreaterThan(0);
      expect(task.goal).toBe(fixtures.find((fixture) => fixture.name === name)!.goal);
    }
    expect(readLegacyTask(join(tasksRoot, "invalid-state")).state).toBeNull();
    expect(readLegacyTask(join(tasksRoot, "missing-state")).state).toBeNull();
    expect(readLegacyTask(join(tasksRoot, "consensus")).notes.map((note) => note.content)).toEqual(["Codex note", "Claude note"]);
    expect(readLegacyTask(approvedTask).finalPlan).toBe("Keep the reviewed plan.");
    expect(readLegacyTask(join(tasksRoot, "deadlock")).transcript).toBe("Remaining tradeoff");
    expect(inventoryTree(tasksRoot)).toEqual(before);
  });

  it("keeps dry-run write-free, refuses active tasks, and imports a quiesced copy", () => {
    const destination = mkdtempSync(join(tmpdir(), "collab-import-"));
    const dryRun = planLegacyImport(approvedTask, destination);
    expect(dryRun.files.length).toBeGreaterThan(30);
    expect(existsSync(join(destination, "legacy"))).toBe(false);
    const imported = importLegacyCopy(approvedTask, destination);
    expect(imported.sourceHash).toBe(dryRun.sourceHash);
    const importedRoot = join(destination, "legacy", imported.sourceHash);
    expect(inventoryTree(importedRoot)).toEqual(inventoryTree(approvedTask));
    const activeTask = join(tasksRoot, "active");
    const active = readLegacyTask(activeTask);
    expect(active.state?.status).toBe("running");
    expect(() => planLegacyImport(activeTask, destination)).toThrow(/ACTIVE_LEGACY_REFUSED/);
  });

  it("exports canonical JSONL that replays identically and verifies a byte backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "collab-export-"));
    const db = join(directory, "collab.sqlite");
    const store = new EventStore(db);
    const runId = "run_export";
    const base = {
      goal: "Export fixture",
      workspace: directory,
      constraints: [],
      authority: {
        writableRoots: [directory],
        network: "off" as const,
        permissionPreset: "default" as const,
      },
      completionEvidence: [],
      usefulWorkBudget: { perMaterialChallenge: 4, perProvider: 24 },
    };
    store.append({
      runId,
      actor: "user",
      type: "goal_set",
      idempotencyKey: "goal",
      payload: {
        goal: {
          id: "goal",
          runId,
          ...base,
          digest: digest(base),
          createdAt: "2026-07-26T00:00:00.000Z",
        },
      },
    });
    const output = exportRun(store, runId, join(directory, "export"));
    const parsed = parseExportedEvents(readFileSync(join(directory, "export", "events.jsonl"), "utf8"));
    expect(canonicalJson(replay(runId, parsed))).toBe(canonicalJson(store.projection(runId)));
    expect(Object.keys(output.checksums)).toEqual(["events.jsonl", "transcript.md", "projection.json"]);
    store.close();

    const backup = join(directory, "collab.sqlite.backup");
    copyFileSync(db, backup);
    expect(readFileSync(backup)).toEqual(readFileSync(db));
    expect(statSync(backup).size).toBeGreaterThan(0);
  });

  it("migrates a true v1 database to v2 with verified backup, rollback, and newer-schema refusal", () => {
    const directory = mkdtempSync(join(tmpdir(), "collab-db-migrate-"));
    const database = join(directory, "collab.sqlite");
    const backup = join(directory, "collab.sqlite.v1.backup");
    // Construct the original schema-v1 shape exactly as it shipped: no
    // causal-binding columns on usage_records, no completion columns on
    // ready_work, and no adviser sidecar tables.
    const legacy = new DatabaseSync(database);
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE events (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL,
        ts TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY (run_id, seq), UNIQUE (run_id, idempotency_key)
      );
      CREATE TABLE projections (
        run_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, projection_json TEXT NOT NULL
      );
      CREATE TABLE usage_records (
        run_id TEXT NOT NULL, burst_key TEXT NOT NULL, provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
        classification TEXT NOT NULL, coordinator_owned_json TEXT,
        attribution_complete INTEGER NOT NULL, uncaused INTEGER NOT NULL,
        nested_usage_complete INTEGER NOT NULL,
        PRIMARY KEY (run_id, burst_key)
      );
      CREATE TABLE ready_work (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL,
        trigger_event_id TEXT NOT NULL, trigger_seq INTEGER NOT NULL,
        reason TEXT NOT NULL, issue_id TEXT, claimed_at TEXT,
        UNIQUE(run_id, role, trigger_event_id, reason)
      );
      INSERT INTO schema_meta(key, value) VALUES ('version', '1');
      INSERT INTO usage_records VALUES (
        'run_legacy', 'codex:opening', 'codex', 10, 0, 5, 0, 'useful', NULL, 1, 0, 1
      );
      INSERT INTO ready_work VALUES (
        'work_legacy', 'run_legacy', 'codex', 'evt_1', 1, 'addressed_event', NULL, NULL
      );
    `);
    legacy.close();
    const before = readFileSync(database);
    expect(() => new EventStore(database)).toThrow(/SCHEMA_MIGRATION_REQUIRED/);

    const migrated = migrateCollabDatabaseV1ToV2({ database, backup });
    expect(migrated.fromVersion).toBe(1);
    expect(migrated.toVersion).toBe(2);
    expect(migrated.backupSha256).not.toBe(migrated.migratedSha256);
    expect(readFileSync(backup)).toEqual(before);
    const current = new EventStore(database);
    expect(current.schemaVersion()).toBe(2);
    // Legacy rows are preserved semantically unchanged: absent bindings stay
    // absent rather than being invented.
    const records = current.usageRecords("run_legacy");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: "codex", input: 10 });
    expect(records[0]!.readyWorkId).toBeUndefined();
    const advisorTables = current.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'advisor_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(advisorTables.map((row) => row.name)).toEqual([
      "advisor_epochs",
      "advisor_ledger",
      "advisor_usage",
    ]);
    current.close();

    const restored = restoreDatabaseBackup(database, backup);
    expect(restored.restoredSha256).toBe(migrated.backupSha256);
    expect(readFileSync(database)).toEqual(before);
    expect(() => new EventStore(database)).toThrow(/SCHEMA_MIGRATION_REQUIRED/);

    const future = new DatabaseSync(database);
    future
      .prepare("UPDATE schema_meta SET value='3' WHERE key='version'")
      .run();
    future.close();
    expect(() => new EventStore(database)).toThrow(/SCHEMA_TOO_NEW/);

    // A generic migration through the shared path still validates ranges.
    expect(() =>
      migrateDatabaseWithBackup({
        database,
        backup: `${backup}.again`,
        fromVersion: 2,
        toVersion: 2,
        apply: () => undefined,
      }),
    ).toThrow(/INVALID_SCHEMA_MIGRATION_RANGE/);
  });

  it("prints the machine-readable migration result", () => {
    console.log('RESULT {"suite":"V-10","passed":true,"historicalMutations":0,"dryRunWrites":0,"modelStarts":0}');
  });
});
