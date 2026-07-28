#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCollabServer } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const productRoot = resolve(here, "../../..");
const stateRoot =
  process.env.COLLAB_STATE_DIR ?? join(homedir(), "Library", "Application Support", "Collaboration");

// Operator schema migration: `collab migrate-db` upgrades the state database
// from schema v1 to v2 through the quiesced-WAL, verified-byte-backup
// transactional path and exits without starting the service.
if (process.argv[2] === "migrate-db") {
  const database = join(stateRoot, "collab.sqlite");
  const backup = `${database}.v1.backup`;
  const { migrateCollabDatabaseV1ToV2 } = await import("@collab/migration");
  const result = migrateCollabDatabaseV1ToV2({ database, backup });
  process.stdout.write(
    `RESULT ${JSON.stringify({
      command: "migrate-db",
      database,
      backup,
      ...result,
    })}\n`,
  );
  process.exit(0);
}

const legacyRootIndex = process.argv.indexOf("--legacy-tasks-root");
if (legacyRootIndex >= 0 && !process.argv[legacyRootIndex + 1]) {
  throw new Error("LEGACY_TASKS_ROOT_VALUE_REQUIRED");
}
const legacyTasksRoot =
  legacyRootIndex >= 0 ? resolve(process.argv[legacyRootIndex + 1]!) : null;
mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
const app = createCollabServer({
  stateFile: join(stateRoot, "collab.sqlite"),
  uiDirectory: join(productRoot, "packages", "ui", "dist"),
  ...(legacyTasksRoot ? { legacyTasksRoot } : {}),
});
const address = await app.listen(Number(process.env.COLLAB_PORT ?? 0));
process.stdout.write(`Collaboration dashboard: ${address.launchUrl}\n`);
process.stdout.write("The URL fragment is a single-use local capability. It is removed after bootstrap.\n");
if (legacyTasksRoot) {
  process.stdout.write(
    `Legacy browser: read-only immediate task folders under ${legacyTasksRoot}\n`,
  );
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
