import { describe, expect, it } from "vitest";
import { EventStore, replay } from "../src/index.ts";
import { goal, tempStore } from "./helpers.ts";

describe("V-2 crash atomicity", () => {
  for (const boundary of ["pre_txn", "post_txn_pre_projection", "post_projection"] as const) {
    it(`repairs ${boundary} without projection skew`, () => {
      const { file, store } = tempStore(`collab-${boundary}-`);
      store.close();
      const crashing = new EventStore(file, { crashAt: boundary });
      expect(() =>
        crashing.append({
          runId: "run_crash",
          actor: "user",
          type: "goal_set",
          idempotencyKey: "goal",
          payload: { goal: goal("run_crash") },
        }),
      ).toThrow(/CRASH_INJECTED/);
      crashing.close();
      const repaired = new EventStore(file);
      const events = repaired.events("run_crash");
      expect(repaired.projection("run_crash")).toEqual(replay("run_crash", events));
      expect(events).toHaveLength(boundary === "pre_txn" ? 0 : 1);
      repaired.close();
    });
  }

  it("prints the machine-readable crash result", () => {
    console.log('RESULT {"suite":"V-2-crash","passed":true,"modelStarts":0}');
  });
});
