import { describe, expect, it } from "vitest";
import {
  parseMacMemoryPressure,
  ResourceGovernor,
} from "../src/resources.ts";

describe("MacBook Neo resource controls", () => {
  it("classifies official macOS memory-pressure output conservatively", () => {
    expect(
      parseMacMemoryPressure("System-wide memory free percentage: 41%"),
    ).toBe("green");
    expect(
      parseMacMemoryPressure("System-wide memory free percentage: 15%"),
    ).toBe("yellow");
    expect(
      parseMacMemoryPressure("System-wide memory free percentage: 4%"),
    ).toBe("red");
    expect(parseMacMemoryPressure("unrecognized output")).toBe("unknown");
  });

  it("serializes and stops admitting heavy work at a safe pressure boundary", () => {
    const governor = new ResourceGovernor();
    expect(
      governor.sample({
        rssBytes: 100 * 1024 ** 2,
        memoryPressure: "green",
        eventLoopLagMs: 5,
      }),
    ).toMatchObject({
      degraded: false,
      serializeAgents: false,
      admitHeavyWork: true,
    });
    expect(
      governor.sample({
        rssBytes: 100 * 1024 ** 2,
        memoryPressure: "yellow",
        eventLoopLagMs: 5,
      }),
    ).toMatchObject({
      degraded: true,
      serializeAgents: true,
      admitHeavyWork: false,
    });
  });
});
