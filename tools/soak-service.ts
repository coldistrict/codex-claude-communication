import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { createCollabServer } from "../packages/service/src/server.ts";

const stateDirectory = process.argv[2] ? resolve(process.argv[2]) : null;
const uiDirectory = process.argv[3] ? resolve(process.argv[3]) : null;
if (!stateDirectory || !uiDirectory) throw new Error("SOAK_SERVICE_PATHS_REQUIRED");

const app = createCollabServer({
  stateFile: join(stateDirectory, "events.sqlite"),
  uiDirectory,
});
const address = await app.listen();
let expectedTick = performance.now() + 250;
let maxEventLoopLagMs = 0;
const interval = setInterval(() => {
  const now = performance.now();
  maxEventLoopLagMs = Math.max(maxEventLoopLagMs, Math.max(0, now - expectedTick));
  expectedTick = now + 250;
}, 250);
interval.unref();

function control(body: unknown): void {
  process.stdout.write(`CONTROL ${JSON.stringify(body)}\n`);
}

control({ type: "ready", address });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "SAMPLE") {
    control({
      type: "sample",
      rssBytes: process.memoryUsage().rss,
      eventLoopLagMs: maxEventLoopLagMs,
    });
  }
  if (line === "DEGRADE") {
    control({
      type: "degraded",
      state: app.resources.sample({
        rssBytes: process.memoryUsage().rss,
        memoryPressure: "red",
        eventLoopLagMs: 300,
      }),
    });
  }
});

const shutdown = async () => {
  clearInterval(interval);
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
