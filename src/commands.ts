import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GOAL_LOG_LIMIT, MAX_GOAL_LOG_LIMIT, readGoalLogs, recordGoalLog } from "./logs.js";
import { GoalStateError, MAX_CRITERION_TEXT_LENGTH, parseGoalDefinition } from "./store.js";
import { GOAL_STATUS_LABELS as labels, type Goal, type GoalDefinition, type GoalRunner, type GoalStore } from "./types.js";

const widgetKey = "pi-goalplus";
const usage = "/goal <objective> or /goal start <JSON>; /goal status, logs, edit, pause, stop, resume, clear.";
const resumeInput = /^(?:resume|continue|继续)[.!?。！？]*$/i;

function plainLine(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

function brief(value: string, limit: number): string {
  const chars = Array.from(plainLine(value));
  return chars.length <= limit ? chars.join("") : chars.slice(0, limit - 1).join("") + "…";
}

function count(goal: Goal): string {
  const passed = goal.evidence.filter(evidence => evidence.verdict === "pass").length;
  return `${passed}/${goal.criteria.length}`;
}

function taskLine(goal: Goal): string | undefined {
  const plan = goal.plan;
  if (!plan) return goal.status === "active" ? "Planning tasks" : undefined;
  const number = Math.min(plan.completed + 1, plan.tasks.length);
  return `Task ${number}/${plan.tasks.length} · ${brief(plan.tasks[number - 1].title, 120)}`;
}

export function renderGoal(ctx: ExtensionContext, goal: Goal | undefined): void {
  if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
  if (!goal) {
    ctx.ui.setWidget(widgetKey, undefined);
    return;
  }
  const lines = [
    `Goal [${labels[goal.status]}] · ${count(goal)} verified · ${brief(goal.objective, 150)}`
  ];
  const task = taskLine(goal);
  if (task) lines.push(task);
  if (goal.stage) lines.push(`Stage: ${brief(goal.stage, 150)}`);
  if (goal.reason) lines.push(`Reason: ${brief(goal.reason, 150)}`);
  ctx.ui.setWidget(widgetKey, lines, { placement: "aboveEditor" });
}

function reviewText(definition: GoalDefinition): string {
  const lines = [plainLine(definition.objective), "", "Constraints:"];
  lines.push(...(definition.constraints.length ? definition.constraints.map(item => `- ${plainLine(item)}`) : ["- None"]));
  lines.push("", "Acceptance criteria:");
  for (const item of definition.criteria) {
    lines.push(`- [${item.id}] ${plainLine(item.requirement)}`, `  Verify: ${plainLine(item.verification)}`);
  }
  if (definition.budgetTokens !== undefined) lines.push("", `Token budget: ${definition.budgetTokens}`);
  return lines.join("\n");
}

function details(goal: Goal): string {
  const lines = [
    `Goal ${labels[goal.status]} · revision ${goal.revision} · ${count(goal)} verified`,
    reviewText(goal)
  ];
  const task = taskLine(goal);
  if (task) lines.push(task);
  if (goal.stage) lines.push(`Stage: ${plainLine(goal.stage)}`);
  if (goal.next) lines.push(`Next: ${plainLine(goal.next)}`);
  if (goal.reason) lines.push(`Reason: ${plainLine(goal.reason)}`);
  lines.push(`Reported tokens: ${goal.tokensUsed}`);
  if (goal.constraintReviews?.length) {
    lines.push("Constraint evidence:");
    for (const item of goal.constraintReviews) {
      lines.push(`- [${item.index}] ${item.state}: ${plainLine(item.evidence)}`);
    }
  }
  lines.push("Criterion evidence:");
  for (const criterion of goal.criteria) {
    const evidence = goal.evidence.find(item => item.criterionId === criterion.id);
    lines.push(evidence
      ? `- [${criterion.id}] ${evidence.verdict}: ${plainLine(evidence.source)} · ${plainLine(evidence.observed)}`
      : `- [${criterion.id}] unverified`);
  }
  return lines.join("\n");
}

function notify(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message);
  else process.stderr.write(message + "\n");
}

function requireIdle(ctx: ExtensionContext): void {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    throw Error("Wait for the current Pi work and queued input to settle, then try again.");
  }
}

function initialGoal(definition: GoalDefinition): Goal {
  return {
    ...definition,
    schema: 1,
    id: randomUUID(),
    revision: 1,
    status: "active",
    evidence: [],
    tokensUsed: 0,
    noProgress: 0
  };
}

function revisedGoal(goal: Goal, definition: GoalDefinition): Goal {
  const exhausted = definition.budgetTokens !== undefined && goal.tokensUsed >= definition.budgetTokens;
  let status = goal.status;
  let reason = goal.reason;
  if (exhausted) {
    status = "budgetLimited";
    reason = "The confirmed budget is exhausted. Increase or remove it to resume.";
  } else if (status === "budgetLimited" || status === "complete" || goal.needsReview) {
    status = "paused";
    reason = "Requirements changed. Resume to verify the new revision.";
  }
  return {
    ...initialGoal(definition),
    id: goal.id,
    revision: goal.revision + 1,
    tokensUsed: goal.tokensUsed,
    status,
    reason
  };
}

export function registerGoalCommands(pi: ExtensionAPI, store: GoalStore, runner: GoalRunner): void {
  let scope = 0;
  let review: symbol | undefined;

  const refresh = (ctx: ExtensionContext) => {
    scope++;
    review = undefined;
    try {
      renderGoal(ctx, store.read(ctx));
    } catch (error) {
      if (!(error instanceof GoalStateError)) throw error;
      if (ctx.hasUI) ctx.ui.setWidget(widgetKey, ["Goal unavailable · use /goal clear to remove the damaged record"]);
    }
  };
  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", () => {
    scope++;
    review = undefined;
  });

  const getGoal = (ctx: ExtensionContext): Goal => {
    const goal = store.read(ctx);
    if (!goal) throw Error("No Goal is set for this Pi session.");
    return goal;
  };

  function showLogs(ctx: ExtensionContext, count: string): void {
    const limit = count ? Number(count) : DEFAULT_GOAL_LOG_LIMIT;
    if (count && (!/^\d{1,2}$/.test(count) || limit < 1 || limit > MAX_GOAL_LOG_LIMIT)) {
      notify(ctx, `Use /goal logs [1–${MAX_GOAL_LOG_LIMIT}].`);
      return;
    }
    let goal: Goal | undefined;
    let heading = "Goal logs";
    try {
      goal = store.read(ctx);
      if (goal) heading += ` · ${labels[goal.status]} · revision ${goal.revision}`;
    } catch (error) {
      if (!(error instanceof GoalStateError)) throw error;
      heading += " · Goal state unavailable";
    }
    const entries = readGoalLogs(ctx, goal?.id, limit);
    notify(ctx, [heading, ...(entries.length ? entries : ["No diagnostic events recorded here yet."])].join("\n"));
  }

  async function reviewDefinition(
    ctx: ExtensionContext,
    draft: GoalDefinition,
    editing: boolean
  ): Promise<GoalDefinition | undefined> {
    if (!ctx.hasUI) {
      throw Error("This command requires an interactive client. Use /goal start <JSON> or /goal edit <JSON> with a reviewed definition.");
    }
    if (review) throw Error("Finish or cancel the open Goal review first.");
    const token = Symbol("goal-review");
    const currentScope = scope;
    const session = ctx.sessionManager.getSessionId();
    const leaf = ctx.sessionManager.getLeafId();
    review = token;
    const requireCurrent = () => {
      if (scope !== currentScope || ctx.sessionManager.getSessionId() !== session || ctx.sessionManager.getLeafId() !== leaf) {
        throw Error("The Pi session changed while you reviewed the Goal. Open a new review to confirm it.");
      }
      requireIdle(ctx);
    };
    try {
      let prefill = JSON.stringify(draft, null, 2);
      const title = editing ? "Edit Goal definition" : "Review imported Goal";
      while (true) {
        const json = await ctx.ui.editor(title, prefill);
        if (json === undefined) return undefined;
        requireCurrent();
        let definition: GoalDefinition;
        try {
          definition = parseGoalDefinition(json);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : "Invalid Goal definition.", "warning");
          prefill = json;
          continue;
        }
        const confirmed = await ctx.ui.confirm(editing ? "Confirm revised Goal" : "Start this Goal?", reviewText(definition));
        if (!confirmed) return undefined;
        requireCurrent();
        return definition;
      }
    } finally {
      if (review === token) review = undefined;
    }
  }

  async function resumeGoal(ctx: ExtensionContext, goal: Goal): Promise<void> {
    if (goal.status === "complete") throw Error("The Goal is complete. Start a new Goal or edit its definition.");
    if (goal.status === "budgetLimited") throw Error("Increase or remove the Goal budget with /goal edit before resuming.");
    if (goal.status === "active") {
      runner.request(ctx);
      return;
    }
    requireIdle(ctx);
    if (goal.dispatch) throw Error("The previous Goal dispatch has not settled.");
    let resumed: Goal;
    if (goal.needsReview) {
      const { objective, constraints, criteria, budgetTokens } = goal;
      const reviewed = await reviewDefinition(ctx, { objective, constraints, criteria, budgetTokens }, false);
      if (!reviewed) return;
      resumed = initialGoal(reviewed);
      store.write(ctx, resumed, "user-confirmed");
    } else {
      resumed = { ...goal, status: "active", reason: undefined, noProgress: 0, consecutiveFailures: 0 };
      store.write(ctx, resumed);
    }
    recordGoalLog(pi, ctx, resumed, "resumed");
    runner.request(ctx);
  }

  pi.on("input", async (event, ctx) => {
    if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || event.source === "extension" ||
        event.images?.length || !resumeInput.test(event.text.trim())) return;
    try {
      const goal = store.read(ctx);
      if (!goal || goal.status === "complete") return;
      await resumeGoal(ctx, goal);
    } catch (error) {
      if (error instanceof GoalStateError) recordGoalLog(pi, ctx, undefined, "stateUnavailable");
      notify(ctx, error instanceof Error ? error.message : "GoalPlus could not resume the saved Goal.");
    }
    return { action: "handled" };
  });

  pi.registerCommand("goal", {
    description: "Create, inspect and control a persistent Goal",
    handler: async (input, ctx) => {
      const args = input.trim();
      if (args === "logs" || /^logs\s/.test(args)) {
        showLogs(ctx, args.slice(4).trim());
        return;
      }
      if (!args || args === "status") {
        const goal = store.read(ctx);
        notify(ctx, goal ? details(goal) : `No Goal is set for this Pi session. ${usage}`);
        return;
      }

      if (args === "clear") {
        store.write(ctx, null);
        return;
      }

      if (args === "stop" || args === "pause") {
        const goal = getGoal(ctx);
        const ownWork = runner.current(ctx) || runner.compacting(ctx);
        if (goal.status === "active") {
          const paused: Goal = {
            ...goal, status: "paused",
            reason: args === "stop" ? "Stopped by the user." : "Paused by the user.",
            completionRunId: undefined
          };
          store.write(ctx, paused);
          recordGoalLog(pi, ctx, paused, args === "stop" ? "stopped" : "paused");
        } else if (!(args === "stop" && goal.status === "paused" && ownWork)) {
          throw Error("Only an active Goal can be paused or stopped.");
        }
        if (args === "stop" && ownWork) ctx.abort();
        return;
      }

      if (resumeInput.test(args)) {
        await resumeGoal(ctx, getGoal(ctx));
        return;
      }

      requireIdle(ctx);
      const editing = args === "edit" || /^edit\s/.test(args);
      if (editing) {
        const goal = getGoal(ctx);
        if (goal.dispatch) throw Error("The previous Goal dispatch has not settled.");
        const json = args.slice(4).trim();
        const definition = json
          ? parseGoalDefinition(json)
          : await reviewDefinition(ctx, {
            objective: goal.objective, constraints: goal.constraints, criteria: goal.criteria,
            budgetTokens: goal.budgetTokens
          }, true);
        if (!definition) return;
        const next = revisedGoal(goal, definition);
        store.write(ctx, next, "user-confirmed");
        recordGoalLog(pi, ctx, next, "goalEdited");
        if (next.status === "active") runner.request(ctx);
        return;
      }

      const existing = store.read(ctx);
      if (existing && existing.status !== "complete") {
        throw Error("A Goal already exists. Use /goal edit to change its requirements or /goal clear to remove it.");
      }
      const explicitStart = args === "start" || /^start\s/.test(args);
      if (args === "start") throw Error("Use /goal start <JSON> with a reviewed definition, or /goal <objective> to start directly.");
      let definition: GoalDefinition;
      try {
        definition = explicitStart
          ? parseGoalDefinition(args.slice(5).trim())
          : parseGoalDefinition(JSON.stringify({
            objective: args, constraints: [],
            criteria: [{
              id: "c1",
              requirement: args.length <= MAX_CRITERION_TEXT_LENGTH ? args : "The confirmed objective is achieved.",
              verification: "Inspect the result and collect concrete evidence that the objective is met."
            }]
          }));
      } catch (error) {
        recordGoalLog(pi, ctx, existing, "definitionRejected");
        throw error;
      }
      store.write(ctx, initialGoal(definition), "user-confirmed");
      runner.request(ctx);
    }
  });
}
