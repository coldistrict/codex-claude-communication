import { describe, expect, it, vi } from "vitest";

const queryCalls: Array<{ prompt: string; options: any }> = [];
let scripts: Array<() => AsyncGenerator<unknown>> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (input: { prompt: string; options: any }) => {
    queryCalls.push(input);
    const generator = scripts.shift();
    if (!generator) throw new Error("fixture: no scripted stream left");
    const stream = generator() as AsyncGenerator<unknown> & {
      interrupt: () => Promise<void>;
      close: () => void;
    };
    stream.interrupt = async () => undefined;
    stream.close = () => undefined;
    return stream;
  },
}));

const { ClaudeAgentAdapter } = await import("../src/claude-adapter.ts");

function init(sessionId: string) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    apiKeySource: "none",
    model: "claude-opus-5",
  };
}

describe("claude burst continuation on turn exhaustion", () => {
  it("resumes the same session with a fresh budget and returns the completed outcome", async () => {
    queryCalls.length = 0;
    scripts = [
      async function* first() {
        yield init("session-1");
        yield {
          type: "result",
          is_error: true,
          errors: ["Reached maximum number of turns (24)"],
        };
      },
      async function* second() {
        yield init("session-1");
        yield {
          type: "result",
          subtype: "success",
          result: "review complete",
          structured_output: { verdict: "pass" },
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    ];
    const adapter = new ClaudeAgentAdapter({ cwd: "/tmp/collab-ws" });
    (adapter as any).billing = { route: "subscription_allowance" };
    const result = await adapter.startBurst({
      runId: "run_continuation",
      prompt: "Review the candidate.",
      authorization: {
        id: "auth-1",
        kind: "user_goal",
        runId: "run_continuation",
        providers: ["claude"],
        recordedAt: new Date().toISOString(),
      },
      maxTurns: 24,
    });
    expect(result.text).toBe("review complete");
    expect(result.structuredOutput).toEqual({ verdict: "pass" });
    expect(result.sessionId).toBe("session-1");
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[1]!.options.resume).toBe("session-1");
    expect(queryCalls[1]!.prompt).toContain("Continue in this same session");
  });

  it("keeps hard-failure semantics for non-turn errors and when no session exists", async () => {
    queryCalls.length = 0;
    scripts = [
      async function* onlyFailure() {
        // No init message: the session never reported an id.
        yield {
          type: "result",
          is_error: true,
          errors: ["Reached maximum number of turns (24)"],
        };
      },
    ];
    const adapter = new ClaudeAgentAdapter({ cwd: "/tmp/collab-ws" });
    (adapter as any).billing = { route: "subscription_allowance" };
    await expect(
      adapter.startBurst({
        runId: "run_no_session",
        prompt: "Review the candidate.",
        authorization: {
          id: "auth-2",
          kind: "user_goal",
          runId: "run_no_session",
          providers: ["claude"],
          recordedAt: new Date().toISOString(),
        },
        maxTurns: 24,
      }),
    ).rejects.toThrow(/CLAUDE_BURST_FAILED/);
    expect(queryCalls).toHaveLength(1);
  });
});


describe('planning SDK tool and turn boundaries', () => {
  it('disables every tool and never silently continues a planning call after the turn limit', async () => {
    queryCalls.length=0;
    scripts=[async function* () { yield init('planning-session'); yield {type:'result',is_error:true,errors:['Reached maximum number of turns (2)']}; }];
    const adapter=new ClaudeAgentAdapter({cwd:'/tmp/planning'});
    (adapter as any).billing={route:'subscription_allowance'};
    await expect(adapter.startBurst({runId:'plan',prompt:'Create a plan',executionProfile:'planning',readOnly:true,maxTurns:2,authorization:{id:'plan-auth',kind:'user_goal',runId:'plan',providers:['claude'],recordedAt:new Date().toISOString()}})).rejects.toThrow('CLAUDE_BURST_FAILED');
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.options).toMatchObject({tools:[],mcpServers:{},permissionMode:'dontAsk',maxTurns:2,settingSources:[],strictMcpConfig:true});
    expect(queryCalls[0]?.options.canUseTool).toBeUndefined();
  });
});
