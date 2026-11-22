import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalStateError, parseGoalDefinition } from "./store.js";
import type { Goal, GoalDefinition, GoalRunner, GoalStore } from "./types.js";

const widgetKey = "pi-goalplus";
const usage = "/goal <objective> or /goal start <JSON>; /goal status, edit, pause, stop, resume, clear.";
const labels = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget exhausted",
  complete: "Complete"
} as const;

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

export function renderGoal(ctx: ExtensionContext, goal: Goal | undefined): void {
  if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
  if (!goal) {
    ctx.ui.setWidget(widgetKey, undefined);
    return;
  }
  const lines = [
    `Goal [${labels[goal.status]}] · ${count(goal)} verified · ${brief(goal.objective, 150)}`
  ];
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

  async function reviewDefinition(
    ctx: ExtensionCommandContext,
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
      const json = await ctx.ui.editor(editing ? "Edit Goal definition" : "Draft Goal requirements", JSON.stringify(draft, null, 2));
      if (json === undefined) return undefined;
      requireCurrent();
      const definition = parseGoalDefinition(json);
      const confirmed = await ctx.ui.confirm(editing ? "Confirm revised Goal" : "Start this Goal?", reviewText(definition));
      if (!confirmed) return undefined;
      requireCurrent();
      return definition;
    } finally {
      if (review === token) review = undefined;
    }
  }

  pi.registerCommand("goal", {
    description: "Create, inspect and control a persistent Goal",
    handler: async (input, ctx) => {
      const args = input.trim();
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
        const ownRun = runner.current(ctx);
        if (goal.status === "active") {
          store.write(ctx, {
            ...goal, status: "paused",
            reason: args === "stop" ? "Stopped by the user." : "Paused by the user.",
            completionRunId: undefined
          });
        } else if (!(args === "stop" && goal.status === "paused" && ownRun)) {
          throw Error("Only an active Goal can be paused or stopped.");
        }
        if (args === "stop" && ownRun) ctx.abort();
        return;
      }

      if (args === "resume") {
        const goal = getGoal(ctx);
        if (goal.status === "active") return;
        if (goal.needsReview) {
          requireIdle(ctx);
          const { objective, constraints, criteria, budgetTokens } = goal;
          const reviewed = await reviewDefinition(ctx, { objective, constraints, criteria, budgetTokens }, false);
          if (!reviewed) return;
          store.write(ctx, initialGoal(reviewed), "user-confirmed");
          runner.request(ctx);
          return;
        }
        if (goal.status === "complete") throw Error("The Goal is complete. Start a new Goal or edit its definition.");
        if (goal.status === "budgetLimited") throw Error("Increase or remove the Goal budget with /goal edit before resuming.");
        requireIdle(ctx);
        if (goal.dispatch) throw Error("The previous Goal dispatch has not settled.");
        store.write(ctx, { ...goal, status: "active", reason: undefined, noProgress: 0, consecutiveFailures: 0 });
        runner.request(ctx);
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
        if (next.status === "active") runner.request(ctx);
        return;
      }

      const existing = store.read(ctx);
      if (existing && existing.status !== "complete") {
        throw Error("A Goal already exists. Use /goal edit to change its requirements or /goal clear to remove it.");
      }
      const explicitStart = args === "start" || /^start\s/.test(args);
      if (args === "start") throw Error("Use /goal start <JSON> with a reviewed definition, or /goal <objective> to open the editor.");
      const definition = explicitStart
        ? parseGoalDefinition(args.slice(5).trim())
        : await reviewDefinition(ctx, {
          objective: args, constraints: [],
          criteria: [{ id: "c1", requirement: "", verification: "" }]
        }, false);
      if (!definition) return;
      store.write(ctx, initialGoal(definition), "user-confirmed");
      runner.request(ctx);
    }
  });
}
