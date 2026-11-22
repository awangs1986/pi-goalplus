import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerGoalTools } from "../src/audit.js";
import type { Goal, GoalRunner, GoalStore } from "../src/types.js";

type ToolResult = { content: Array<{ text: string }> };
type Tool = { name: string; execute: (id: string, params: unknown, signal: undefined, update: undefined, context: ExtensionToolContext) => Promise<ToolResult> };

function nativeTools(options: { constraints?: string[]; auditPending?: boolean } = {}) {
  let current: Goal | undefined = {
    schema: 1,
    id: "user-goal",
    revision: 2,
    objective: "Keep the build and smoke test green",
    constraints: options.constraints ?? [],
    criteria: [
      { id: "build", requirement: "Build succeeds", verification: "npm run build" },
      { id: "smoke", requirement: "Smoke test succeeds", verification: "npm run smoke" }
    ],
    status: "active",
    evidence: [],
    ...(options.auditPending ? { auditPending: true } : {}),
    dispatch: { id: "r1", revision: 2, phase: "running" },
    tokensUsed: 0,
    noProgress: 0
  };
  const ctx = {
    cwd: "/work",
    sessionManager: { getSessionId: () => "session" }
  } as ExtensionToolContext;
  const store: GoalStore = {
    read: () => current,
    write: (_ctx, goal) => { current = goal ?? undefined; }
  };
  let nativeRun: string | undefined = "r1";
  const runner: GoalRunner = { current: () => nativeRun, request: () => {} };
  const tools = new Map<string, Tool>();
  const listeners = new Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>();
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    getAllTools: () => ["read", "bash", "grep", "find", "ls"].map(name => ({ name, sourceInfo: { source: "builtin" } })),
    on: (name: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) => listeners.set(name, handler)
  } as unknown as ExtensionAPI;
  registerGoalTools(pi, store, runner);

  const identity = { goalId: "user-goal", revision: 2, runId: "r1" };
  async function call(name: string, input: Record<string, unknown> = {}) {
    const tool = tools.get("goalplus_" + name);
    if (!tool) throw new Error("Tool not registered: " + name);
    const result = await tool.execute("goal-tool-id", input, undefined, undefined, ctx);
    return JSON.parse(result.content[0].text);
  }
  function event(name: string, data: Record<string, unknown>) {
    return listeners.get(name)?.({ type: name, ...data }, ctx);
  }
  function receipt(id: string, output: string, isError = false, toolName = "read", structuredContent?: unknown) {
    const input = toolName === "bash"
      ? { command: "npm run verify" }
      : { path: id.startsWith("smoke") ? "smoke.log" : "build.log" };
    const started = event("tool_call", { toolCallId: id, toolName, input });
    if (started && typeof started === "object" && "block" in started && started.block) {
      throw new Error("Fixture attempted to run a blocked verification tool");
    }
    event("tool_result", {
      toolCallId: id, toolName, input, content: [{ type: "text", text: output }], isError, structuredContent
    });
    event("tool_execution_end", { toolCallId: id, toolName, isError });
  }
  function nextAssistant() {
    event("message_start", { message: { role: "assistant" } });
  }
  async function begin() {
    const goal = await call("read");
    nextAssistant();
    return goal;
  }
  function settle() {
    nativeRun = undefined;
    if (current) current = { ...current, dispatch: undefined, auditedRunId: undefined, completionRunId: undefined };
  }
  function nextRun() {
    nativeRun = "r2";
    if (current) current = { ...current, dispatch: { id: nativeRun, revision: current.revision, phase: "running" } };
    return { ...identity, runId: nativeRun };
  }
  return { call, begin, nextAssistant, event, receipt, identity, settle, nextRun };
}

describe("GoalPlus native evidence tools", () => {
  it("reports the confirmed Goal and exposes pointers to native verification results", async () => {
    const pi = nativeTools();
    await pi.begin();
    await pi.receipt("build-result", "Build output to keep only in the transcript");
    const goal = await pi.call("read");

    expect(goal).toMatchObject({
      objective: "Keep the build and smoke test green",
      criteria: [
        { id: "build", verification: "npm run build" },
        { id: "smoke", verification: "npm run smoke" }
      ],
      receipts: [{ id: "build-result", tool: "read", isError: false }]
    });
    expect(JSON.stringify(goal)).not.toContain("Build output to keep only in the transcript");
  });
  it("reopens a failed earlier criterion and allows completion only after re-verification", async () => {
    const pi = nativeTools();
    const constraints: unknown[] = [];
    const checkpoint = (criteria: unknown[]) => pi.call("checkpoint", {
      ...pi.identity, stage: "Verification", criteria, constraints
    });
    const build = { id: "build", state: "pass", source: "build-result", observed: "Build exited successfully" };
    const smoke = { id: "smoke", state: "pass", source: "smoke-result", observed: "Smoke test exited successfully" };

    await pi.begin();
    await pi.receipt("build-result", "Build completed");
    await checkpoint([build, { id: "smoke", state: "reopen" }]);
    await expect(pi.call("complete", pi.identity)).rejects.toThrow(/smoke/);

    await pi.receipt("smoke-result", "Smoke completed");
    await pi.receipt("build-regression", "Build reported a regression", true);
    await checkpoint([
      { ...build, state: "fail", source: "build-regression", observed: "Compiler rejected the changed fixture" },
      smoke
    ]);
    expect(await pi.call("read")).toMatchObject({
      evidence: [{ criterionId: "build", verdict: "fail" }, { criterionId: "smoke", verdict: "pass" }]
    });
    await expect(pi.call("complete", pi.identity)).rejects.toThrow(/build/);

    await pi.receipt("build-recheck", "Build completed");
    await checkpoint([{ ...build, source: "build-recheck" }, { id: "smoke", state: "retain" }]);
    await expect(pi.call("complete", pi.identity)).resolves.toMatchObject({
      status: "completionProposed", runId: "r1"
    });
  });

  it("invalidates an accepted completion and old verification receipts when native code edits follow the audit", async () => {
    const pi = nativeTools();
    const criteria = [
      { id: "build", state: "pass", source: "build-result", observed: "Build exited successfully" },
      { id: "smoke", state: "pass", source: "smoke-result", observed: "Smoke test exited successfully" }
    ];
    const review = {
      ...pi.identity, stage: "Final verification", criteria,
      constraints: []
    };

    await pi.begin();
    await pi.receipt("build-result", "Build completed");
    await pi.receipt("smoke-result", "Smoke passed");
    await pi.call("checkpoint", review);
    await pi.call("complete", pi.identity);
    await pi.event("tool_result", {
      toolCallId: "edit-result", toolName: "edit", input: { path: "main.ts" }, content: [], isError: false
    });

    await expect(pi.call("complete", pi.identity)).rejects.toThrow(/audit/i);
    await expect(pi.call("checkpoint", review)).rejects.toThrow(/current native verification receipt/);
    expect(await pi.call("read")).toMatchObject({ evidence: [] });
  });

  it("requires a confirmed Goal read before acting again after Pi compacts the run", async () => {
    const pi = nativeTools();
    const bash = { toolCallId: "verify", toolName: "bash", input: { command: "npm run build" } };

    expect(pi.event("tool_call", bash)).toMatchObject({ block: true });
    await pi.begin();
    expect(pi.event("tool_call", bash)).toBeUndefined();
    await pi.event("session_compact", {});
    expect(pi.event("tool_call", bash)).toMatchObject({ block: true });
    expect(await pi.begin()).toMatchObject({ goalId: "user-goal", revision: 2 });
    expect(pi.event("tool_call", bash)).toBeUndefined();
  });

  it("records a concrete dependency when further Goal work requires user input", async () => {
    const pi = nativeTools();
    await pi.begin();

    await expect(pi.call("block", {
      ...pi.identity, dependency: "user", reason: "Choose a supported runtime for the test.",
      evidence: "The confirmed Goal names two incompatible runtime targets."
    })).resolves.toMatchObject({ status: "blocked", dependency: "user" });
    await expect(pi.call("complete", pi.identity)).rejects.toThrow(/running Goal turn/);
    expect(pi.event("tool_call", {
      toolCallId: "blocked-call", toolName: "bash", input: { command: "npm run smoke" }
    })).toMatchObject({ block: true });
  });

  it("rejects stale or invented evidence and an unresolved constraint", async () => {
    const pi = nativeTools({ constraints: ["Remain in the current workspace"] });
    await pi.begin();
    await pi.receipt("build-result", "Build passed");
    await pi.receipt("smoke-result", "Smoke passed");
    const audit = {
      ...pi.identity, stage: "Verification",
      criteria: [
        { id: "build", state: "pass", source: "build-result", observed: "Build passed" },
        { id: "smoke", state: "pass", source: "smoke-result", observed: "Smoke passed" }
      ],
      constraints: [{ index: 1, state: "unknown", evidence: "The path of the native test workspace could not be verified." }]
    };

    await expect(pi.call("checkpoint", { ...audit, revision: 1 })).rejects.toThrow(/Goal changed/);
    await expect(pi.call("checkpoint", {
      ...audit, criteria: [audit.criteria[0], { ...audit.criteria[1], source: "invented" }]
    })).rejects.toThrow(/current native verification receipt/);
    await pi.call("checkpoint", audit);
    await expect(pi.call("complete", pi.identity)).rejects.toThrow(/resolve every.*constraint/i);
  });

  const constraints: unknown[] = [];
  const build = { id: "build", state: "pass", source: "build-result", observed: "Build passed" };
  const smoke = { id: "smoke", state: "pass", source: "smoke-result", observed: "Smoke passed" };

  it.each(["bash", "external_change"])("invalidates pre-%s proof while allowing a fresh verification receipt", async (tool) => {
    const pi = nativeTools();
    const checkpoint = (criteria: unknown[]) => pi.call("checkpoint", {
      ...pi.identity, stage: "Verification", criteria, constraints
    });
    await pi.begin();
    await pi.receipt("build-result", "Build passed");
    await pi.receipt("smoke-result", "Smoke passed");
    await checkpoint([build, smoke]);
    await pi.call("complete", pi.identity);

    await pi.receipt("latest-check", "Build passed; smoke passed", false, tool);
    await expect(pi.call("complete", pi.identity)).rejects.toThrow(/audit/i);
    await expect(checkpoint([build, smoke])).rejects.toThrow(/current native verification receipt/);
    expect(await pi.call("read")).toMatchObject({ evidence: [], receipts: [{ id: "latest-check" }] });
    await checkpoint([{ ...build, source: "latest-check" }, { ...smoke, source: "latest-check" }]);
    await expect(pi.call("complete", pi.identity)).resolves.toMatchObject({ status: "completionProposed" });
  });

  it.each([["", false], ["  ", false], ["(no output)", false], ["Build failed", true]])(
    "rejects a pass backed by result %j (error %s)", async (output, error) => {
      const pi = nativeTools();
      await pi.begin();
      await pi.receipt("build-result", output, error, "bash");

      await expect(pi.call("checkpoint", {
        ...pi.identity, stage: "Verification", criteria: [build, { id: "smoke", state: "reopen" }], constraints
      })).rejects.toThrow(/receipt/i);
    }
  );

  it("rejects a shell placeholder backed only by invocation metadata", async () => {
    const pi = nativeTools();
    await pi.begin();
    await pi.receipt("build-result", "(no output)", false, "bash", {
      output: "", exit_code: 0, wall_time_seconds: 0.1
    });
    await expect(pi.call("checkpoint", {
      ...pi.identity, stage: "Verification", criteria: [build, { id: "smoke", state: "reopen" }], constraints
    })).rejects.toThrow(/receipt/i);
  });

  it.each(["tool_result", "user_bash"] as const)("reopens previous passes after ordinary Pi activity (%s)", async (type) => {
    const pi = nativeTools();
    await pi.begin();
    await pi.receipt("build-result", "Build passed");
    await pi.call("checkpoint", {
      ...pi.identity, stage: "Verification", criteria: [build, { id: "smoke", state: "reopen" }], constraints
    });
    pi.settle();
    if (type === "tool_result") {
      await pi.receipt("outside-run", "Ordinary prompt changed a fixture", false, "bash");
    } else {
      await pi.event(type, { command: "make fixture", cwd: "/work", excludeFromContext: false });
    }

    pi.nextRun();
    expect(await pi.call("read")).toMatchObject({ evidence: [], receipts: [] });
  });

  it("allows retained progress but rejects prior-turn proof in a final audit", async () => {
    const pi = nativeTools();
    await pi.begin();
    await pi.receipt("build-result", "Build passed");
    await pi.call("checkpoint", {
      ...pi.identity, stage: "Build", criteria: [build, { id: "smoke", state: "reopen" }], constraints
    });

    pi.settle();
    const scope = pi.nextRun();
    await pi.begin();
    await pi.receipt("smoke-result", "Smoke passed");
    await expect(pi.call("checkpoint", {
      ...scope, stage: "Smoke", criteria: [{ id: "build", state: "retain" }, smoke], constraints
    })).resolves.toMatchObject({ passed: 2, total: 2 });
    await expect(pi.call("complete", scope)).rejects.toThrow(/build.*current passing evidence/i);
    await pi.receipt("fresh-build", "Build passed");
    await pi.call("checkpoint", {
      ...scope, stage: "Final verification", criteria: [{ ...build, source: "fresh-build" }, smoke], constraints
    });
    await expect(pi.call("complete", pi.identity)).rejects.toThrow(/Goal changed/);
    await expect(pi.call("complete", scope)).resolves.toMatchObject({ status: "completionProposed" });
  });

  it("requires the next native assistant response before the model can act on a first Goal read", async () => {
    const pi = nativeTools();
    const nativeRead = { toolCallId: "observation", toolName: "read", input: { path: "build.log" } };
    await pi.call("read");
    expect(pi.event("tool_call", nativeRead)).toMatchObject({ block: true });
    await expect(pi.call("checkpoint", {
      ...pi.identity, stage: "Premature audit", criteria: [{ id: "build", state: "reopen" }, { id: "smoke", state: "reopen" }], constraints
    })).rejects.toThrow(/read|response/i);
    pi.nextAssistant();
    expect(pi.event("tool_call", nativeRead)).toBeUndefined();
  });

  it("requires a missed stage audit before more possible changes in the next run", async () => {
    const pi = nativeTools({
      auditPending: true,
      constraints: ["Remain in the current workspace"]
    });
    const edit = { toolCallId: "modify", toolName: "edit", input: { path: "main.ts" } };
    expect(await pi.begin()).toMatchObject({ auditPending: true });
    expect(pi.event("tool_call", edit)).toMatchObject({ block: true });
    await pi.receipt("build-result", "Build evidence inspected");
    await pi.call("checkpoint", {
      ...pi.identity, stage: "Re-open affected items",
      criteria: [{ id: "build", state: "reopen" }, { id: "smoke", state: "reopen" }],
      constraints: [{ index: 1, state: "unknown", evidence: "Working directory needs a fresh observation" }]
    });
    expect(pi.event("tool_call", edit)).toBeUndefined();
    expect(await pi.call("read")).toMatchObject({ auditPending: false });
  });

  it("requires actual passing native proof for every passed constraint", async () => {
    const pi = nativeTools({ constraints: ["Remain in the current workspace"] });
    await pi.begin();
    await pi.receipt("build-result", "Build passed");
    await pi.receipt("smoke-result", "Smoke passed");
    await pi.receipt("failed-directory", "Directory unavailable", true);
    const checkpoint = (proof: Record<string, unknown>) => pi.call("checkpoint", {
      ...pi.identity, stage: "Verification", criteria: [build, smoke],
      constraints: [{ index: 1, state: "pass", evidence: "Observed the exact working directory", ...proof }]
    });
    await expect(checkpoint({})).rejects.toThrow(/constraint.*receipt/i);
    await expect(checkpoint({ source: "failed-directory" })).rejects.toThrow(/constraint.*receipt/i);
    await pi.receipt("work-directory", "/work");
    await checkpoint({ source: "work-directory" });
    await expect(pi.call("complete", pi.identity)).resolves.toMatchObject({ status: "completionProposed" });
  });

  it.each([true, false])("rejects evidence that overlaps an edit (read begins first: %s)", async (readFirst) => {
    const pi = nativeTools();
    await pi.begin();
    const read = { toolCallId: "build-result", toolName: "read", input: { path: "build.log" } };
    const edit = { toolCallId: "edit", toolName: "edit", input: { path: "build.log" } };
    pi.event("tool_call", readFirst ? read : edit);
    pi.event("tool_call", readFirst ? edit : read);
    pi.event("tool_result", { ...edit, isError: false, content: [{ type: "text", text: "Edited" }] });
    pi.event("tool_execution_end", { ...edit, isError: false });
    pi.event("tool_result", { ...read, isError: false, content: [{ type: "text", text: "Build passed" }] });
    pi.event("tool_execution_end", { ...read, isError: false });
    const checkpoint = (source: string) => pi.call("checkpoint", {
      ...pi.identity, stage: "Verification", criteria: [{ ...build, source }, { id: "smoke", state: "reopen" }], constraints
    });
    await expect(checkpoint("build-result")).rejects.toThrow(/current native verification receipt/);
    await pi.receipt("fresh-build", "Re-verified after the edit");
    await expect(checkpoint("fresh-build")).resolves.toMatchObject({ status: "audited", passed: 1 });
  });

});
