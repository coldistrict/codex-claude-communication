import { readFile } from "node:fs/promises";
import { reportOverhead, type UsageRecord } from "../packages/kernel/src/index.ts";

const runIndex = process.argv.indexOf("--run");
const records: UsageRecord[] =
  runIndex >= 0
    ? JSON.parse(await readFile(process.argv[runIndex + 1]!, "utf8"))
    : [
        {
          provider: "codex",
          input: 1_000,
          cachedInput: 0,
          output: 0,
          reasoning: 0,
          classification: "useful",
          attributionComplete: true,
          uncaused: false,
          nestedUsageComplete: true,
        },
        {
          provider: "claude",
          input: 40,
          cachedInput: 0,
          output: 0,
          reasoning: 0,
          classification: "coordination",
          attributionComplete: true,
          uncaused: false,
          nestedUsageComplete: true,
        },
      ];
const report = reportOverhead(records);
process.stdout.write(`${JSON.stringify(report, null, process.argv.includes("--json") ? 0 : 2)}\n`);
process.stdout.write(
  `RESULT ${JSON.stringify({ suite: "V-7-report", ...report, modelStarts: 0 })}\n`,
);
if (!report.passed) process.exitCode = 1;
