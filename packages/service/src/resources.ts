export interface ResourceSample {
  rssBytes: number;
  memoryPressure: "green" | "yellow" | "red" | "unknown";
  eventLoopLagMs: number;
}

export interface ResourceState {
  degraded: boolean;
  reason: string | null;
  serializeAgents: boolean;
  admitHeavyWork: boolean;
  lastSample: ResourceSample | null;
}

export class ResourceGovernor {
  private state: ResourceState = {
    degraded: false,
    reason: null,
    serializeAgents: false,
    admitHeavyWork: true,
    lastSample: null,
  };

  sample(sample: ResourceSample): ResourceState {
    const degraded =
      sample.memoryPressure === "yellow" ||
      sample.memoryPressure === "red" ||
      sample.rssBytes > 2.5 * 1024 ** 3 ||
      sample.eventLoopLagMs > 250;
    this.state = {
      degraded,
      reason: degraded
        ? `Resource pressure: ${sample.memoryPressure}; RSS ${Math.round(sample.rssBytes / 1024 ** 2)} MiB; event-loop lag ${sample.eventLoopLagMs.toFixed(1)} ms`
        : null,
      serializeAgents: degraded,
      admitHeavyWork: !degraded,
      lastSample: sample,
    };
    return this.current();
  }

  current(): ResourceState {
    return structuredClone(this.state);
  }
}

export function parseMacMemoryPressure(
  output: string,
): ResourceSample["memoryPressure"] {
  const match = output.match(/memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  if (!match) return "unknown";
  const freePercent = Number(match[1]);
  if (!Number.isFinite(freePercent)) return "unknown";
  if (freePercent < 10) return "red";
  if (freePercent < 20) return "yellow";
  return "green";
}

export async function readMacMemoryPressure(): Promise<
  ResourceSample["memoryPressure"]
> {
  if (process.platform !== "darwin") return "unknown";
  try {
    const { stdout } = await execFileAsync("/usr/bin/memory_pressure", ["-Q"], {
      timeout: 5_000,
    });
    return parseMacMemoryPressure(stdout);
  } catch {
    return "unknown";
  }
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
