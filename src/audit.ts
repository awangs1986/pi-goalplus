import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recordGoalLog } from "./logs.js";
import { decodeTaskPlan, MAX_TASKS, MAX_TASK_TITLE_LENGTH, MIN_TASKS } from "./store.js";
import { GOAL_CHECKPOINT_TOOL, isGoalTool, isNativeReadOnly } from "./tool-policy.js";
import type { ConstraintReview, Evidence, Goal, GoalRunner, GoalStore } from "./types.js";

const MAX_RECEIPTS = 64;
const MAX_ITEMS = 24;
const id = Type.String({ minLength: 1, maxLength: 256 });
const identity = {
  goalId: id,
  revision: Type.Integer({ minimum: 1 }),
  runId: id
};
const exact = { additionalProperties: false };
type RunIdentity = { goalId: string; revision: number; runId: string };
const criterionReport = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  state: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("retain"), Type.Literal("reopen")]),
  source: Type.Optional(id),
  observed: Type.Optional(Type.String({ minLength: 1, maxLength: 512 }))
}, exact);
const constraintReport = Type.Object({
  index: Type.Integer({ minimum: 1, maximum: MAX_ITEMS, description: "1-based constraint index in goalplus_read." }),
  state: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]),
  evidence: Type.String({ minLength: 1, maxLength: 400, description: "Observed result or unresolved reason." }),
  source: Type.Optional(id)
}, exact);

interface Receipt {
  id: string;
  tool: string;
  isError: boolean;
  fingerprint: string;
}
interface RunBinding {
  goal: Goal;
  runId: string;
}
interface Observation {
  mayWrite: boolean;
  overlappedMutation: boolean;
}
interface RunAudit extends RunBinding {
  receipts: Receipt[];
  read: "unread" | "awaiting-response" | "ready";
  alignment?: { number: number; ready: boolean };
  observations: Map<string, Observation>;
}

function requireFreshRead(state: RunAudit): void {
  state.read = "unread";
  state.alignment = undefined;
}

function aligned(state: RunAudit, number: number): boolean {
  return state.alignment?.number === number && state.alignment.ready;
}

function toolOutput(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined };
}

function receiptPayload(event: ToolResultEvent): Array<string> {
  if (event.toolName === "bash" || event.toolName === "powershell") {
    const result = event.structuredContent;
    if (result && typeof result === "object" && "output" in result && typeof result.output === "string") {
      // Native shell metadata includes wall time and temporary paths, which are not evidence.
      return result.output.trim() ? [result.output] : [];
    }
  }
  const payload: string[] = [];
  for (const part of event.content) {
    if (part.type === "text" && part.text.trim() && part.text.trim() !== "(no output)") {
      payload.push(part.text);
    } else if (part.type === "image" && part.data) {
      payload.push(part.mimeType, part.data);
    }
  }
  const value = event.structuredContent;
  if (value !== undefined && value !== null &&
      (typeof value !== "object" || Object.keys(value).length > 0) &&
      (typeof value !== "string" || value.trim())) payload.push(JSON.stringify(value));
  return payload;
}

function receiptFingerprint(event: ToolResultEvent, payload: string[]): string {
  const digest = createHash("sha256");
  digest.update(JSON.stringify([event.toolName, event.input, event.isError]));
  for (const value of payload) digest.update("\0").update(value);
  return digest.digest("hex");
}

export function registerGoalTools(pi: ExtensionAPI, store: GoalStore, runner: GoalRunner): void {
  let audit: RunAudit | undefined;

  function binding(ctx: ExtensionContext, goal = store.read(ctx)): RunBinding | undefined {
    if (!goal || goal.dispatch?.phase !== "running" || goal.dispatch.revision !== goal.revision) return;
    const runId = runner.current(ctx);
    if (!runId || goal.dispatch.id !== runId) return;
    return { goal, runId };
  }

  function runningAudit(run: RunBinding | undefined): RunAudit | undefined {
    if (!run || run.goal.status !== "active") return;
    const { goal, runId } = run;
    if (!audit || audit.runId !== runId || audit.goal.id !== goal.id || audit.goal.revision !== goal.revision) {
      audit = { goal, runId, receipts: [], read: "unread", observations: new Map() };
    } else {
      audit.goal = goal;
    }
    return audit;
  }

  function current(ctx: ExtensionContext, expected?: RunIdentity): RunAudit {
    const state = runningAudit(binding(ctx));
    if (!state) throw new Error("GoalPlus tools require a running Goal turn.");
    const { goal, runId } = state;
    if (expected && (expected.goalId !== goal.id || expected.revision !== goal.revision || expected.runId !== runId)) {
      throw new Error("The Goal changed. Use goalplus_read and audit the current revision.");
    }
    if (expected && state.read !== "ready") {
      throw new Error("Use goalplus_read and wait for its result in the next assistant response before submitting an audit.");
    }
    if (expected && [...state.observations.values()].some(({ mayWrite }) => mayWrite)) {
      throw new Error("Wait for potentially mutating tools to settle before submitting the audit.");
    }
    return state;
  }

  function invalidate(
    ctx: ExtensionContext,
    goal: Goal,
    state: RunAudit | undefined,
    { workspaceChanged = false, reread = false }: { workspaceChanged?: boolean; reread?: boolean } = {}
  ): void {
    if (goal.status === "complete") return;
    if (state && reread) requireFreshRead(state);
    if (state && workspaceChanged) state.receipts = [];
    if (goal.auditedRunId || goal.completionRunId || (workspaceChanged && (goal.evidence.length || goal.constraintReviews?.length))) {
      store.write(ctx, {
        ...goal,
        evidence: workspaceChanged ? [] : goal.evidence,
        constraintReviews: workspaceChanged ? undefined : goal.constraintReviews,
        auditedRunId: undefined,
        completionRunId: undefined
      });
    }
  }

  pi.on("tool_call", (event, ctx) => {
    if (isGoalTool(event.toolName)) return;
    const run = binding(ctx);
    if (run?.goal.status === "blocked") {
      return { block: true, reason: "The Goal needs a user decision or an external change before it can continue." };
    }
    const state = runningAudit(run);
    if (!state) return;
    if (state.read !== "ready") {
      return { block: true, reason: "Call goalplus_read by itself and use the result in the next assistant response before acting." };
    }
    const mayWrite = !isNativeReadOnly(pi, event.toolName);
    const plan = state.goal.plan;
    if (!plan && mayWrite) {
      return { block: true, reason: "Save an ordered Goal task plan with goalplus_tasks before changing the project." };
    }
    if (plan && !aligned(state, plan.completed + 1)) {
      return { block: true, reason: `Align task ${plan.completed + 1} with the confirmed Goal using goalplus_tasks, and wait for its result before working.` };
    }
    if (mayWrite && state.goal.auditPending) {
      return { block: true, reason: "Reconcile the missed stage audit with goalplus_checkpoint before making further changes." };
    }
    if (event.parentToolCallId) return;
    const observation: Observation = { mayWrite, overlappedMutation: false };
    for (const pending of state.observations.values()) {
      if (mayWrite) pending.overlappedMutation = true;
      if (pending.mayWrite) observation.overlappedMutation = true;
    }
    state.observations.set(event.toolCallId, observation);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const run = binding(ctx);
    if (audit && audit.runId === run?.runId) audit.observations.delete(event.toolCallId);
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const state = runningAudit(binding(ctx));
    if (state?.read === "awaiting-response") state.read = "ready";
    if (state?.alignment) state.alignment.ready = true;
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user") return;
    const state = runningAudit(binding(ctx));
    if (state) invalidate(ctx, state.goal, state, { reread: true });
  });
  pi.on("session_compact", (_event, ctx) => {
    const state = runningAudit(binding(ctx));
    if (state) invalidate(ctx, state.goal, state, { reread: true });
  });
  pi.on("user_bash", (_event, ctx) => {
    const goal = store.read(ctx);
    if (!goal) return;
    const state = runningAudit(binding(ctx, goal));
    for (const pending of state?.observations.values() ?? []) pending.overlappedMutation = true;
    invalidate(ctx, goal, state, { workspaceChanged: true });
  });
  pi.on("tool_result", (event, ctx) => {
    if (isGoalTool(event.toolName)) return;
    const goal = store.read(ctx);
    if (!goal) return;
    const state = runningAudit(binding(ctx, goal));
    const observation = state?.observations.get(event.toolCallId);
    const workspaceChanged = observation?.mayWrite === true || !isNativeReadOnly(pi, event.toolName);
    if (state || workspaceChanged) invalidate(ctx, goal, state, { workspaceChanged });
    if (!state || !observation || observation.overlappedMutation || event.parentToolCallId ||
        isNativeWrite(event.toolName) || !event.toolCallId || event.toolCallId.length > 256 ||
        !event.toolName || event.toolName.length > 128) return;
    const payload = receiptPayload(event);
    state.receipts = state.receipts.filter((item) => item.id !== event.toolCallId);
    if (!payload.length) return;
    state.receipts.push({
      id: event.toolCallId,
      tool: event.toolName,
      isError: event.isError,
      fingerprint: receiptFingerprint(event, payload)
    });
    if (state.receipts.length > MAX_RECEIPTS) state.receipts.shift();
  });

  pi.registerTool({
    name: "goalplus_read",
    label: "Read Goal",
    description: "Read the user's confirmed objective, criteria and constraints, the ordered task plan and progress, and native verification receipts for this run.",
    parameters: Type.Object({}, exact),
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, _args, _signal, _onUpdate, ctx) {
      const state = current(ctx);
      if (state.read === "unread") state.read = "awaiting-response";
      const goal = state.goal;
      return toolOutput({
        goalId: goal.id,
        revision: goal.revision,
        runId: state.runId,
        status: goal.status,
        auditPending: goal.auditPending === true,
        objective: goal.objective,
        criteria: goal.criteria,
        constraints: goal.constraints,
        plan: goal.plan,
        evidence: goal.evidence.map(({ criterionId, verdict, source, observed }) => ({
          criterionId, verdict, source, observed
        })),
        constraintReviews: goal.constraintReviews,
        stage: goal.stage,
        next: goal.next,
        receipts: state.receipts.map(({ id, tool, isError }) => ({ id, tool, isError }))
      });
    }
  });
  pi.registerTool({
    name: "goalplus_tasks",
    label: "Plan and Align Goal Tasks",
    description: "Save an ordered plan covering the confirmed criteria, or align one task with the original objective, constraints and criteria. Supply either plan or align. Reuse steps the user already specified. Keep completed tasks when revising the plan. Read the Goal again after saving a plan. After aligning, wait for the result before working. Align an earlier task to reopen it and all later tasks for repair.",
    parameters: Type.Object({
      ...identity,
      plan: Type.Optional(Type.Array(Type.Object({
        title: Type.String({ minLength: 1, maxLength: MAX_TASK_TITLE_LENGTH }),
        criteria: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: MAX_ITEMS })
      }, exact), { minItems: MIN_TASKS, maxItems: MAX_TASKS })),
      align: Type.Optional(Type.Object({
        number: Type.Integer({ minimum: 1, maximum: MAX_TASKS, description: "1-based task number." }),
        rationale: Type.String({ minLength: 1, maxLength: 400, description: "Why this task advances the confirmed objective and respects its constraints." })
      }, exact))
    }, exact),
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const state = current(ctx, args);
      const { goal } = state;
      if (args.plan !== undefined) {
        if (args.align !== undefined) throw new Error("Submit the plan and align the task in separate calls.");
        const completed = goal.plan?.completed ?? 0;
        const plan = decodeTaskPlan({ tasks: args.plan, completed }, goal.criteria);
        if (completed >= plan.tasks.length || (goal.plan &&
          JSON.stringify(plan.tasks.slice(0, completed)) !== JSON.stringify(goal.plan.tasks.slice(0, completed)))) {
          throw new Error("Retain completed tasks in order and include at least one remaining task.");
        }
        store.write(ctx, { ...goal, plan, completionRunId: undefined });
        requireFreshRead(state);
        return toolOutput({ status: "planned", task: completed + 1, total: plan.tasks.length });
      }
      const plan = goal.plan;
      if (!plan || !args.align) throw new Error("Save a Goal task plan before aligning a task.");
      const { number, rationale } = args.align;
      const currentTask = plan.completed + 1;
      if (number > currentTask) throw new Error(`Finish task ${currentTask} before starting task ${number}.`);
      nonBlank(rationale, "Explain how the task advances the objective and respects its constraints.");
      if (number < currentTask) {
        store.write(ctx, {
          ...goal, plan: { ...plan, completed: number - 1 }, auditedRunId: undefined, completionRunId: undefined
        });
      }
      state.alignment = { number, ready: false };
      return toolOutput({ status: "aligned", task: number, total: plan.tasks.length });
    }
  });
  pi.registerTool({
    name: GOAL_CHECKPOINT_TOOL,
    label: "Audit Goal Stage",
    description: "Audit a stage against the confirmed Goal or recheck it before continuing. Include each criterion and constraint once. Set taskCompleted only after finishing and verifying the current task. Call this on its own at a task boundary. Set nextStageTokens when you can estimate the upcoming work's additional context, including tool output and verification. Finish the last task with goalplus_complete after its final audit. Pass/fail needs a current native source receipt with output and a short observed result. Shell or unknown tools invalidate previous receipts. Group shell checks in one invocation when needed. Retain only evidence unaffected by later work. Keep evidence descriptions short and omit secrets. Reopen any item whose proof is affected, missing, or uncertain. A passed constraint requires a current successful source receipt. Mark an uncertain constraint unknown and explain what needs rechecking.",
    parameters: Type.Object({
      ...identity,
      stage: Type.String({ minLength: 1, maxLength: 240 }),
      next: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
      nextStageTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: "Estimated additional context tokens needed for the next unfinished stage." })),
      taskCompleted: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASKS })),
      criteria: Type.Array(criterionReport, { minItems: 1, maxItems: MAX_ITEMS }),
      constraints: Type.Array(constraintReport, { maxItems: MAX_ITEMS })
    }, exact),
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const state = current(ctx, args);
      const { goal, runId, receipts } = state;
      let plan = goal.plan;
      const taskCompleted = args.taskCompleted;
      if (taskCompleted !== undefined) {
        if (!plan || taskCompleted !== plan.completed + 1 || !aligned(state, taskCompleted)) {
          throw new Error("Finish the current aligned task before recording task progress.");
        }
        if (taskCompleted === plan.tasks.length) {
          throw new Error("Audit the final task, then finish it with goalplus_complete.");
        }
        plan = { ...plan, completed: taskCompleted };
      }
      const stage = nonBlank(args.stage, "Provide a stage name.");
      const next = args.next === undefined ? undefined : nonBlank(args.next, "Provide a concrete next step or omit it.");
      const criterionReports = ordered(args.criteria, goal.criteria.map((item) => item.id), (item) => item.id, "criteria");
      const constraintReviews: ConstraintReview[] = ordered(
        args.constraints, goal.constraints.map((_text, index) => index + 1), (item) => item.index, "constraints"
      ).map((item) => {
        const summary = nonBlank(item.evidence, `Provide evidence or a reason for constraint ${item.index}.`);
        const receipt = receipts.find(({ id }) => id === item.source);
        if ((item.state === "pass" && (!receipt || receipt.isError)) || (item.source && !receipt)) {
          throw new Error(`Constraint ${item.index} needs a current native receipt. A passed constraint needs a successful receipt.`);
        }
        return {
          index: item.index,
          state: item.state,
          evidence: summary,
          ...(receipt ? { source: receipt.id, fingerprint: receipt.fingerprint } : {})
        };
      });
      const evidence: Evidence[] = [];
      for (const item of criterionReports) {
        const { id, state } = item;
        if (state === "retain" || state === "reopen") {
          if (item.source !== undefined || item.observed !== undefined) {
            throw new Error(`Use a fresh pass/fail report when providing new evidence for ${id}.`);
          }
          if (state === "retain") {
            const prior = goal.evidence.find((entry) => entry.criterionId === id);
            if (!prior) throw new Error(`There is no evidence to retain for ${id}.`);
            evidence.push(prior);
          }
          continue;
        }
        const receipt = receipts.find((entry) => entry.id === item.source);
        if (!receipt || (receipt.isError && state === "pass")) {
          throw new Error(`Supply a current native verification receipt with output for ${id}. A failed receipt cannot prove a pass.`);
        }
        evidence.push({
          criterionId: id,
          verdict: state,
          source: receipt.id,
          observed: nonBlank(item.observed, `Describe the observed result for ${id}.`),
          fingerprint: receipt.fingerprint
        });
      }
      store.write(ctx, {
        ...goal,
        plan,
        stage,
        next,
        evidence,
        constraintReviews,
        auditPending: undefined,
        auditedRunId: runId,
        completionRunId: undefined
      });
      if (taskCompleted !== undefined) {
        recordGoalLog(pi, ctx, goal, "taskAdvanced");
        requireFreshRead(state);
      }
      const compact = (taskCompleted !== undefined || next !== undefined || args.nextStageTokens !== undefined) &&
        runner.beforeNextStage(ctx, args.nextStageTokens);
      return { ...toolOutput({
        status: "audited",
        runId,
        passed: evidence.filter((item) => item.verdict === "pass").length,
        total: goal.criteria.length,
        unresolvedConstraints: constraintReviews.filter((item) => item.state !== "pass").map((item) => item.index),
        ...(compact ? { nextStageCompaction: "scheduled" } : {}),
      }), terminate: compact };
    }
  });

  pi.registerTool({
    name: "goalplus_complete",
    label: "Propose Goal Completion",
    description: "Finish the final aligned task after the final audit. Earlier tasks must be complete, and every confirmed criterion and constraint must have current passing evidence. Call as the last action of this run. Pi settles the run before it records completion.",
    parameters: Type.Object(identity, exact),
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const state = current(ctx, args);
      const { goal, runId, receipts } = state;
      if (goal.auditedRunId !== runId) {
        throw new Error("Audit all confirmed criteria and constraints in this turn before proposing completion.");
      }
      const plan = goal.plan;
      if (!plan || plan.completed + 1 !== plan.tasks.length || !aligned(state, plan.tasks.length)) {
        throw new Error("Complete earlier tasks and align the final task before proposing Goal completion.");
      }
      const missing = goal.criteria.find(({ id }) => !goal.evidence.some(
        (evidence) => evidence.criterionId === id && evidence.verdict === "pass" &&
          matchesPass(receipts, evidence)
      ));
      if (missing) throw new Error(`Criterion ${missing.id} needs current passing evidence.`);
      if (!goal.constraints.every((_requirement, index) => goal.constraintReviews?.some(
        (review) => review.index === index + 1 && review.state === "pass" && matchesPass(receipts, review)
      ))) {
        throw new Error("Resolve every user-confirmed constraint with a current successful receipt before proposing completion.");
      }
      if (goal.completionRunId !== runId) store.write(ctx, { ...goal, completionRunId: runId });
      return toolOutput({ status: "completionProposed", runId });
    }
  });

  pi.registerTool({
    name: "goalplus_block",
    label: "Report a Goal Dependency",
    description: "Pause automatic progress when all remaining Goal work needs a real user decision, approval or external change. State the specific dependency and the evidence for it. Use the ordinary approval flow and continue independent work when possible.",
    parameters: Type.Object({
      ...identity,
      dependency: Type.Union([Type.Literal("user"), Type.Literal("approval"), Type.Literal("external")]),
      reason: Type.String({ minLength: 1, maxLength: 240 }),
      evidence: Type.String({ minLength: 1, maxLength: 240 })
    }, exact),
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const { goal } = current(ctx, args);
      const reason = nonBlank(args.reason, "Identify what must change before work can continue.");
      const evidence = nonBlank(args.evidence, "Provide the evidence that blocks further work.");
      const blocked = {
        ...goal,
        status: "blocked",
        reason: `[${args.dependency}] ${reason} Evidence: ${evidence}`,
        auditedRunId: undefined,
        completionRunId: undefined
      } as const;
      store.write(ctx, blocked);
      recordGoalLog(pi, ctx, blocked, "dependency", { dependency: args.dependency });
      return toolOutput({ status: "blocked", dependency: args.dependency, reason });
    }
  });
}

function nonBlank(value: string | undefined, error: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(error);
  return trimmed;
}

function ordered<Key, Item>(items: Item[], expected: Key[], key: (item: Item) => Key, field: string): Item[] {
  const byKey = new Map(items.map((item) => [key(item), item] as const));
  if (items.length !== expected.length || byKey.size !== expected.length) {
    throw new Error(`Audit each confirmed item exactly once in ${field}.`);
  }
  return expected.map((id) => {
    const item = byKey.get(id);
    if (!item) throw new Error(`Audit each confirmed item exactly once in ${field}. Missing ${id}.`);
    return item;
  });
}

function isNativeWrite(name: string): boolean {
  return name === "edit" || name === "write";
}

function matchesPass(receipts: Receipt[], reference: { source?: string; fingerprint?: string }): boolean {
  return receipts.some(({ id, fingerprint, isError }) =>
    !isError && id === reference.source && fingerprint === reference.fingerprint);
}
