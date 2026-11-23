import type { ExtensionAPI, ExtensionContext, ExtensionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGoalRunner } from "../src/runner.js";
import { GOAL_TOOL_NAMES } from "../src/tool-policy.js";
import type { Goal, GoalStore } from "../src/types.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Trigger = Parameters<ExtensionAPI["sendMessage"]>[0];
type TestEvent = { type: ExtensionEvent["type"] } & Record<string, unknown>;

function fixture(goalChanges: Partial<Goal> = {}, blankPersistentSession = false) {
  const handlers = new Map<string, Handler[]>();
  const triggers: Trigger[] = [];
  const userPrompts: string[] = [];
  const branch: SessionEntry[] = [];
  const compactions: NonNullable<Parameters<ExtensionContext["compact"]>[0]>[] = [];
  const sources = new Map(["edit", "write", "read", "bash", "grep", "find", "ls", "powershell"].map(name => [name, "builtin"]));
  for (const name of GOAL_TOOL_NAMES) sources.set(name, "extension");
  let idle = true;
  let queued = false;
  let aborted = false;
  let context: ReturnType<ExtensionContext["getContextUsage"]>;
  let goal: Goal | undefined = {
    schema: 1, id: "g", revision: 1, status: "active",
    objective: "Repair the fixtures",
    constraints: ["Keep the normal command working"],
    criteria: [{ id: "c1", requirement: "The suite passes", verification: "Run the suite" }],
    evidence: [], tokensUsed: 0, noProgress: 0, ...goalChanges,
  };

  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage(trigger: Trigger) { triggers.push(trigger); },
    sendUserMessage(prompt: string) { userPrompts.push(prompt); },
    getAllTools() { return [...sources].map(([name, source]) => ({ name, sourceInfo: { source } })); },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "rpc",
    cwd: "/workspace",
    model: { id: "test-model" },
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    getContextUsage: () => context,
    compact: (options: (typeof compactions)[number]) => { compactions.push(options); },
    abort: () => { aborted = true; },
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => branch.at(-1)?.id ?? null,
      getBranch: () => branch,
      getEntries: () => branch,
      getSessionFile: () => blankPersistentSession ? "/workspace/session.jsonl" : undefined,
    },
  } as unknown as ExtensionContext;
  const store: GoalStore = {
    read: () => goal,
    write: (_ctx, next) => { goal = next ?? undefined; },
  };
  const runner = registerGoalRunner(pi, store);
  const emit = async (event: TestEvent) => {
    for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
  };
  const claim = async (trigger: Trigger) => {
    idle = false;
    await emit({ type: "before_agent_start", messageType: "custom", message: trigger });
  };
  const settle = async () => {
    idle = true;
    await emit({ type: "agent_settled", aborted });
    aborted = false;
  };
  const change = (updates: Partial<Goal>) => { goal = { ...goal!, ...updates }; };
  return {
    runner, ctx, triggers, userPrompts, emit, claim, settle, change, branch, sources, compactions,
    goal: () => goal!,
    setPending: (state: boolean) => { queued = state; },
    setContext: (tokens: number) => { context = { tokens, contextWindow: 64_000, percent: tokens / 640 }; },
    aborted: () => aborted,
  };
}

afterEach(() => vi.useRealTimers());

describe("proactive Goal compaction", () => {
  async function reachStageBoundary(f: ReturnType<typeof fixture>) {
    f.setContext(10_000);
    f.runner.request(f.ctx);
    await f.claim(f.triggers[0]);
    f.setContext(47_000);
    expect(f.runner.beforeNextStage(f.ctx, 20_000)).toBe(true);
    await f.emit({ type: "agent_before_settle", outcome: "completed" });
    await f.settle();
    await vi.runOnlyPendingTimersAsync();
    expect(f.compactions).toHaveLength(1);
    expect(f.triggers).toHaveLength(1);
    expect(f.runner.compacting(f.ctx)).toBe(true);
  }

  it("counts early compaction usage before starting the next stage", async () => {
    vi.useFakeTimers();
    const f = fixture({ budgetTokens: 50 });
    await reachStageBoundary(f);

    f.compactions[0].onComplete?.({
      summary: "The first stage is settled", firstKeptEntryId: "new", tokensBefore: 47_000, usage: usage(50),
    });
    await vi.runOnlyPendingTimersAsync();
    expect(f.goal()).toMatchObject({ status: "budgetLimited", tokensUsed: 50 });
    expect(f.triggers).toHaveLength(1);
  });

  it.each([true, false])("handles native early compaction failure (cancelled: %s)", async cancelled => {
    vi.useFakeTimers();
    const f = fixture();
    await reachStageBoundary(f);

    await f.emit({ type: "session_compact_failed", reason: "manual", aborted: cancelled });
    f.compactions[0].onError?.(new Error("Fixture compaction did not finish"));
    await vi.runOnlyPendingTimersAsync();
    expect(f.goal().status).toBe(cancelled ? "paused" : "active");
    expect(f.triggers).toHaveLength(cancelled ? 1 : 2);
    if (!cancelled) {
      await f.claim(f.triggers[1]);
      expect(f.runner.beforeNextStage(f.ctx, 20_000)).toBe(false);
      expect(f.compactions).toHaveLength(1);
    }
  });
});

describe("native Goal continuation", () => {
  it("automatically runs beyond three settled stages with current evidence", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    for (let stage = 1; stage <= 5; stage++) {
      expect(f.triggers).toHaveLength(stage);
      await f.claim(f.triggers[stage - 1]);
      const run = f.runner.current(f.ctx);
      expect(run).toBeDefined();
      f.change({
        evidence: [{ criterionId: "c1", verdict: stage === 5 ? "pass" : "fail", source: "fixture", observed: "report", fingerprint: "run" + stage }],
        auditedRunId: stage === 5 ? run : undefined,
        completionRunId: stage === 5 ? run : undefined,
      });
      await f.emit({ type: "agent_before_settle", outcome: "completed" });
      await f.settle();
      await vi.runOnlyPendingTimersAsync();
    }
    expect(f.goal().status).toBe("complete");
    expect(f.triggers).toHaveLength(5);
  });

  it("continues through distinct edits before the first acceptance check can pass", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    for (let stage = 1; stage <= 5; stage++) {
      expect(f.triggers).toHaveLength(stage);
      await f.claim(f.triggers[stage - 1]);
      await f.emit({
        type: "tool_result", toolName: "edit", toolCallId: "edit-" + stage, isError: false,
        input: { path: "app.ts", edits: [{ oldText: "part" + (stage - 1), newText: "part" + stage }] },
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in app.ts." }],
      });
      if (stage === 5) {
        const run = f.runner.current(f.ctx);
        f.change({
          evidence: [{ criterionId: "c1", verdict: "pass", source: "tests", observed: "Suite passed" }],
          auditedRunId: run, completionRunId: run,
        });
      }
      await f.emit({ type: "agent_before_settle", outcome: "completed" });
      await f.settle();
      await vi.runOnlyPendingTimersAsync();
    }
    expect(f.goal().status).toBe("complete");
    expect(f.triggers).toHaveLength(5);
  });

  it("continues through distinct successful native shell actions before proving acceptance", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    for (let stage = 1; stage <= 5; stage++) {
      expect(f.triggers).toHaveLength(stage);
      await f.claim(f.triggers[stage - 1]);
      await f.emit({
        type: "tool_result", toolName: "bash", toolCallId: "shell-" + stage, isError: false,
        input: { command: "apply-migration-part " + stage },
        content: [{ type: "text", text: "(no output)" }],
        structuredContent: { output: "", exit_code: 0, durationMs: stage * 200 },
      });
      const run = f.runner.current(f.ctx);
      f.change({ auditedRunId: run });
      if (stage === 5) f.change({
        evidence: [{ criterionId: "c1", verdict: "pass", source: "tests", observed: "Suite passed" }],
        completionRunId: run,
      });
      await f.emit({ type: "agent_before_settle", outcome: "completed" });
      await f.settle();
      await vi.runOnlyPendingTimersAsync();
    }
    expect(f.goal().status).toBe("complete");
  });

  it("does not turn native shell metadata into progress", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    for (let stage = 1; stage <= 4; stage++) {
      expect(f.triggers).toHaveLength(stage);
      await f.claim(f.triggers[stage - 1]);
      await f.emit({
        type: "tool_result", toolName: "bash", toolCallId: "shell-" + stage, isError: false,
        input: { command: "inspect-build-output", timeout: stage + 10 },
        content: [{ type: "text", text: "same\n\nFull output in /tmp/shell-" + stage }],
        structuredContent: { output: "same", exit_code: 0, timestamp: stage * 200 },
      });
      await f.emit({ type: "agent_before_settle", outcome: "completed" });
      await f.settle();
      await vi.runOnlyPendingTimersAsync();
    }
    expect(f.goal().status).toBe("blocked");
    expect(f.triggers).toHaveLength(4);
  });

  it("distinguishes useful generic results from repeats with changing metadata", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    const states = ["downloaded", "unpacked", "configured", "built", "tested", "tested", "tested", "tested"];
    for (const [index, state] of states.entries()) {
      expect(f.triggers).toHaveLength(index + 1);
      await f.claim(f.triggers[index]);
      const data = { state, timestamp: index, requestId: "request-" + index };
      await f.emit({
        type: "tool_result", toolName: "read_job_status", toolCallId: "job-" + index, isError: false,
        input: { job: "build" },
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
      });
      await f.emit({ type: "agent_before_settle", outcome: "completed" });
      await f.settle();
      await vi.runOnlyPendingTimersAsync();
    }
    expect(f.goal().status).toBe("blocked");
    expect(f.triggers).toHaveLength(states.length);
  });

  it("requires a current checkpoint before advancing after a missed audit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    await f.claim(f.triggers[0]);
    await f.emit({ type: "agent_before_settle", outcome: "completed" });
    await f.settle();
    expect(f.goal().auditPending).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(f.triggers[1].content).toMatch(/checkpoint before advancing/);
    await f.claim(f.triggers[1]);
    f.change({ auditedRunId: f.runner.current(f.ctx) });
    await f.emit({ type: "agent_before_settle", outcome: "completed" });
    await f.settle();
    expect(f.goal().auditPending).toBe(false);
  });

  it("stalls on the same write outcome even when the call ID and result messages vary", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    for (let stage = 1; stage <= 4; stage++) {
      expect(f.triggers).toHaveLength(stage);
      await f.claim(f.triggers[stage - 1]);
      await f.emit({
        type: "tool_result", toolName: "write", toolCallId: "write-" + stage, isError: false,
        input: { path: stage % 2 ? "app.ts" : "./app.ts", content: "same contents" },
        content: [{ type: "text", text: "Successfully wrote to app.ts at second " + stage }],
      });
      await f.emit({ type: "agent_before_settle", outcome: "completed" });
      await f.settle();
      await vi.runOnlyPendingTimersAsync();
    }
    expect(f.goal().status).toBe("blocked");
    expect(f.triggers).toHaveLength(4);
  });
});

describe("Goal interruption and recovery", () => {
  it("starts a blank persistent session with a claimed native user message", async () => {
    vi.useFakeTimers();
    const f = fixture({}, true);
    f.runner.request(f.ctx);
    expect(f.userPrompts).toHaveLength(1);
    expect(f.triggers).toHaveLength(0);
    const dispatch = f.goal().dispatch?.id;
    await f.emit({ type: "before_agent_start", messageType: "user", prompt: f.userPrompts[0] });
    expect(f.runner.current(f.ctx)).toBe(dispatch);
    expect(f.goal().dispatch?.phase).toBe("running");
    f.branch.push(assistantEntry("first", 2));
    await f.emit({ type: "agent_before_settle", outcome: "completed" });
    await f.settle();
    await vi.runOnlyPendingTimersAsync();
    expect(f.userPrompts).toHaveLength(1);
    expect(f.triggers).toHaveLength(1);
  });

  it("restores a settled active Goal but does not replay an uncertain dispatch", async () => {
    vi.useFakeTimers();
    const safe = fixture({ lastSettledId: "prior" });
    await safe.emit({ type: "session_start", reason: "startup" });
    await vi.runOnlyPendingTimersAsync();
    expect(safe.triggers).toHaveLength(1);

    const uncertain = fixture({ dispatch: { id: "prior", revision: 1, phase: "running" } });
    await uncertain.emit({ type: "session_start", reason: "startup" });
    await vi.runOnlyPendingTimersAsync();
    expect(uncertain.triggers).toHaveLength(0);
    expect(uncertain.goal()).toMatchObject({ status: "blocked", reason: expect.stringContaining("could not confirm") });
    expect(uncertain.goal().dispatch).toBeUndefined();
  });

  it("does not reactivate an inherited Goal when loading a fork", async () => {
    vi.useFakeTimers();
    const f = fixture({ lastSettledId: "original" });
    await f.emit({ type: "session_start", reason: "fork" });
    await vi.runOnlyPendingTimersAsync();
    expect(f.triggers).toHaveLength(0);
    expect(f.goal().status).toBe("paused");
  });
});

describe("continuation boundaries", () => {
  it("tries a different approach and stalls on repeated prose-only changes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) expect(f.triggers[attempt - 1].content).toMatch(/different approach/i);
      await f.claim(f.triggers[attempt - 1]);
      f.change({ stage: "Changed wording " + attempt, next: "Continue " + attempt });
      await f.emit({ type: "agent_before_settle", outcome: "completed" });
      await f.settle();
      await vi.runOnlyPendingTimersAsync();
    }
    expect(f.triggers).toHaveLength(3);
    expect(f.goal()).toMatchObject({ status: "blocked", reason: expect.stringContaining("new verification evidence") });
  });

  it.each([100, 105])("stops at the explicit %i token budget including native compaction", async budgetTokens => {
    vi.useFakeTimers();
    const f = fixture({ budgetTokens });
    f.branch.push(assistantEntry("earlier", 500));
    f.runner.request(f.ctx);
    f.branch.push(compactionEntry("compacted", 30));
    await f.claim(f.triggers[0]);
    f.branch.push(assistantEntry("new", 75));
    await f.emit({ type: "turn_end" });
    expect(f.aborted()).toBe(true);
    await f.settle();
    await vi.runOnlyPendingTimersAsync();
    expect(f.goal()).toMatchObject({ status: "budgetLimited", tokensUsed: 105 });
    expect(f.triggers).toHaveLength(1);
  });

  it("parks a provider-throttled request after Pi finishes its native retry window", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    await f.claim(f.triggers[0]);
    await f.emit({ type: "after_provider_response", status: 429 });
    await f.emit({ type: "agent_before_settle", outcome: "error" });
    await f.settle();
    await vi.runOnlyPendingTimersAsync();
    expect(f.goal()).toMatchObject({ status: "usageLimited" });
    expect(f.triggers).toHaveLength(1);
  });

  it("does not dispatch over queued user input and aborts a paused late trigger", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setPending(true);
    f.runner.request(f.ctx);
    expect(f.triggers).toHaveLength(0);
    f.setPending(false);
    f.runner.request(f.ctx);
    f.change({ status: "paused", reason: "Paused by the user." });
    await f.claim(f.triggers[0]);
    expect(f.aborted()).toBe(true);
    expect(f.runner.current(f.ctx)).toBeUndefined();
    await f.settle();
    await vi.runOnlyPendingTimersAsync();
    expect(f.goal()).toMatchObject({ status: "paused", reason: "Paused by the user." });
    expect(f.goal().dispatch).toBeUndefined();
    expect(f.triggers).toHaveLength(1);
  });
});

function usage(totalTokens: number) {
  return { input: 0, output: totalTokens, cacheRead: 0, cacheWrite: 0, totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistantEntry(id: string, tokens: number): SessionEntry {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: { role: "assistant", content: [], usage: usage(tokens), api: "test-api",
      provider: "test-provider", model: "test-model", stopReason: "stop", timestamp: 0 },
  };
}

function compactionEntry(id: string, tokens: number): SessionEntry {
  return {
    type: "compaction", id, parentId: null, timestamp: "",
    summary: "A native compaction.", firstKeptEntryId: "earlier", tokensBefore: 500, usage: usage(tokens),
  };
}

describe("dispatch integrity", () => {
  it("treats a lost native start as uncertain without scheduling another request", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.goal().status).toBe("blocked");
    expect(f.goal().dispatch).toBeUndefined();
    expect(f.triggers).toHaveLength(1);
    await f.claim(f.triggers[0]);
    expect(f.aborted()).toBe(true);
  });

  it("gives an intervening native user run priority over a deferred Goal trigger", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    await f.emit({ type: "before_agent_start", messageType: "user", prompt: "Handle my correction first." });
    expect(f.goal().dispatch).toBeUndefined();
    await f.claim(f.triggers[0]);
    expect(f.aborted()).toBe(true);
    await f.settle();
    await vi.runOnlyPendingTimersAsync();
    expect(f.goal().status).toBe("active");
    expect(f.triggers).toHaveLength(2);
  });

  it("backs off clean transient failures and does not retry a run with possible effects", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runner.request(f.ctx);
    await f.claim(f.triggers[0]);
    await f.emit({ type: "after_provider_response", status: 503 });
    await f.emit({ type: "agent_before_settle", outcome: "error" });
    await f.settle();
    expect(f.goal().status).toBe("active");
    expect(f.triggers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.triggers).toHaveLength(2);

    await f.claim(f.triggers[1]);
    await f.emit({ type: "tool_execution_start", toolName: "bash" });
    await f.emit({ type: "after_provider_response", status: 503 });
    await f.emit({ type: "agent_before_settle", outcome: "error" });
    await f.settle();
    await vi.runOnlyPendingTimersAsync();
    expect(f.goal().status).toBe("blocked");
    expect(f.triggers).toHaveLength(2);
  });

  it.each([["builtin", "active"], ["sdk", "blocked"]])(
    "treats a read tool from %s according to its source before retrying",
    async (source, expectedStatus) => {
      vi.useFakeTimers();
      const f = fixture();
      f.sources.set("read", source);
      f.runner.request(f.ctx);
      await f.claim(f.triggers[0]);
      await f.emit({ type: "tool_execution_start", toolName: "read" });
      await f.emit({ type: "after_provider_response", status: 503 });
      await f.emit({ type: "agent_before_settle", outcome: "error" });
      await f.settle();
      expect(f.goal().status).toBe(expectedStatus);
    }
  );
});
