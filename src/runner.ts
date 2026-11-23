import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentActivityOutcome, ExtensionAPI, ExtensionContext, SessionEntry, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isGoalTool, isNativeReadOnly } from "./tool-policy.js";
import type { Dispatch, Goal, GoalRunner, GoalStore } from "./types.js";

const TRIGGER = "pi-goalplus-run";
const GOAL_DISPATCH = "GoalPlus control message. Call goalplus_read first to get the original objective and requirements, then work on the saved unfinished task. Check existing results before repeating any interrupted step.";
const NO_PROGRESS_LIMIT = 3;
const SAFE_RETRY_DELAYS = [250, 1000];
const RECENT_PROGRESS_LIMIT = 128;
const RECENT_ACTIVITY_LIMIT = 128;
const START_ACK_TIMEOUT = 30_000;
const EARLY_COMPACTION_PERCENT = 70;
const BUDGET_USED = "The Goal token budget has been used. Raise or remove the budget to continue.";
const GOAL_COMPACTION_INSTRUCTIONS = "Preserve progress on the active Goal, the next unfinished task, changed files, verification results, and unresolved issues. Keep the summary concise. GoalPlus will reread the original requirements and task progress after compaction.";
const VOLATILE_RESULT_FIELDS = /^(?:timestamp|(?:request|response|toolCall|trace|span)_?id|(?:created|updated|started|finished)_?at|(?:elapsed|duration)(?:_?ms)?)$/i;

interface NativeRun {
  sessionId: string;
  goalId: string;
  revision: number;
  id: string;
  startProgress: string;
  activity: Set<string>;
  initialPrompt?: string;
  started: boolean;
  outcome?: AgentActivityOutcome;
  statusCode?: number;
  providerError?: string;
  possibleEffects?: boolean;
  stageStart?: ContextSample;
  stageForecast?: number;
  yieldForCompaction?: boolean;
}

interface ContextSample {
  tokens: number;
  contextWindow: number;
}

interface EarlyCompaction {
  sessionId: string;
  goalId: string;
  revision: number;
  cancelled: boolean;
}

function progressKey(goal: Goal): string {
  const items = goal.evidence.map(item => [
    item.criterionId, item.verdict, item.fingerprint ?? null,
  ]);
  items.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash("sha256").update(JSON.stringify([goal.plan?.completed ?? null, items])).digest("hex");
}

function editKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("oldText" in value) || !("newText" in value) ||
    typeof value.oldText !== "string" || typeof value.newText !== "string" || value.oldText === value.newText) return;
  return createHash("sha256").update(JSON.stringify([value.oldText, value.newText])).digest("hex");
}

function isBuiltin(pi: ExtensionAPI, toolName: string): boolean {
  return pi.getAllTools().some(tool => tool.name === toolName && tool.sourceInfo.source === "builtin");
}

function outputText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "(no output)") return "";
  return value.trim();
}

function stableResult(value: unknown): string | undefined {
  const serialized = JSON.stringify(value, (key, field) => {
    if (VOLATILE_RESULT_FIELDS.test(key)) return undefined;
    if (field === null || typeof field !== "object" || Array.isArray(field)) return field;
    return Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b)));
  });
  if (serialized && !["{}", "[]", '""', "null"].includes(serialized)) return serialized;
}

function outcomeKey(event: ToolResultEvent, cwd: string, builtin: boolean): string | undefined {
  const { input, toolName } = event;
  if (event.isError || isGoalTool(toolName)) return;
  const digest = createHash("sha256").update(JSON.stringify([toolName]));
  if (builtin && typeof input.path === "string" && input.path &&
    (toolName === "edit" || toolName === "write" || toolName === "read")) {
    digest.update(JSON.stringify([resolve(cwd, input.path)]));
  }
  if (builtin && toolName === "write") {
    if (typeof input.content !== "string") return;
    digest.update(input.content);
  } else if (builtin && toolName === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    const keys = edits.map(editKey).filter((value): value is string => value !== undefined);
    if (!keys.length) return;
    digest.update(JSON.stringify(keys.sort()));
  } else if (builtin && (toolName === "bash" || toolName === "powershell")) {
    const structured = event.structuredContent;
    const output = structured && typeof structured === "object" && "output" in structured
      ? outputText(structured.output)
      : event.content.flatMap(part => part.type === "text" ? [outputText(part.text)] : [])
        .join("\n").replace(/\n\s*\[Showing [^\n]*\. Full output: [^\n]*\]\s*$/, "").trim();
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!output && !command) return;
    digest.update(JSON.stringify([command, output]));
  } else if (event.structuredContent !== undefined && event.structuredContent !== null) {
    const stable = stableResult(event.structuredContent);
    if (!stable) return;
    digest.update(stable);
  } else {
    let useful = false;
    for (const part of event.content) {
      const output = part.type === "text" ? outputText(part.text) : part.data;
      if (!output) continue;
      digest.update(JSON.stringify([part.type, part.type === "image" ? part.mimeType : "", output]));
      useful = true;
    }
    if (!useful) return;
  }
  return digest.digest("hex");
}

function safeTokens(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function contextSample(ctx: ExtensionContext): ContextSample | undefined {
  const usage = ctx.getContextUsage();
  if (usage?.tokens == null || !Number.isSafeInteger(usage.tokens) || usage.tokens < 0 ||
      !Number.isSafeInteger(usage.contextWindow) || usage.contextWindow <= 0) return;
  return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}

function stageTokenForecast(ctx: ExtensionContext, current?: ContextSample, start?: ContextSample, estimatedTokens?: number): number {
  const growth = current && start && current.contextWindow === start.contextWindow
    ? Math.max(0, current.tokens - start.tokens) : 0;
  return Math.max(safeTokens(ctx.model?.maxTokens), estimatedTokens ?? growth);
}

function stageKey(goal: Goal): string {
  return `${goal.id}:${goal.revision}:${goal.plan?.completed ?? -1}`;
}

function entryTokens(entry: SessionEntry): number {
  if (entry.type === "message") {
    const message = entry.message;
    return message.role === "assistant" || message.role === "toolResult"
      ? safeTokens(message.usage?.totalTokens) : 0;
  }
  return entry.type === "compaction" || entry.type === "usage"
    ? safeTokens(entry.usage?.totalTokens) : 0;
}

function tokensSinceDispatch(ctx: ExtensionContext, dispatch: Dispatch): number {
  if (dispatch.baseLeafId === undefined) return 0;
  const entries = ctx.sessionManager.getBranch();
  const leaf = dispatch.baseLeafId === null ? -1 : entries.findIndex(entry => entry.id === dispatch.baseLeafId);
  if (dispatch.baseLeafId !== null && leaf === -1) return 0;
  return entries.slice(leaf + 1).reduce((sum, entry) => sum + entryTokens(entry), 0);
}

function addTokens(a: number, b: number): number {
  return Math.min(a + b, Number.MAX_SAFE_INTEGER);
}

function reachedBudget(goal: Goal, tokens = goal.tokensUsed): boolean {
  return goal.budgetTokens !== undefined && tokens >= goal.budgetTokens;
}

function failedRequest(run: NativeRun): "usage" | "transient" | "error" {
  const code = run.statusCode;
  const error = run.providerError ?? "";
  if (code === 429 || /\b(?:429|rate.?limit(?:ed| exceeded)?|insufficient.quota|resource.exhausted|quota exceeded)\b/i.test(error))
    return "usage";
  if ((code !== undefined && [408, 500, 502, 503, 504].includes(code)) ||
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|network error|fetch failed|service unavailable|overloaded)\b/i.test(error))
    return "transient";
  return "error";
}

export function registerGoalRunner(pi: ExtensionAPI, store: GoalStore): GoalRunner {
  let run: NativeRun | undefined;
  let next: ReturnType<typeof setTimeout> | undefined;
  let startWatch: ReturnType<typeof setTimeout> | undefined;
  let compaction: EarlyCompaction | undefined;
  let attemptedStage: string | undefined;
  const issuedInitialPrompts = new Set<string>();

  function cancelNext(): void {
    clearTimeout(next);
    next = undefined;
  }

  function clearStartWatch(): void {
    clearTimeout(startWatch);
    startWatch = undefined;
  }

  function matches(ctx: ExtensionContext, goal: Goal | undefined, candidate: NativeRun): goal is Goal & { dispatch: Dispatch } {
    return goal !== undefined && ctx.sessionManager.getSessionId() === candidate.sessionId &&
      goal.id === candidate.goalId && goal.dispatch?.id === candidate.id &&
      goal.dispatch.revision === candidate.revision;
  }

  function asyncBoundary(ctx: ExtensionContext, action: () => void): void {
    try {
      action();
    } catch {
      ctx.ui.notify("GoalPlus could not confirm the recorded state. Inspect /goal status before resuming.", "error");
    }
  }

  function shouldCompactStage(goal: Goal, usage: ContextSample | undefined, forecast: number): usage is ContextSample {
    if (!usage) return false;
    const key = stageKey(goal);
    if (usage.tokens / usage.contextWindow <= EARLY_COMPACTION_PERCENT / 100) {
      if (attemptedStage === key) attemptedStage = undefined;
      return false;
    }
    return attemptedStage !== key && usage.contextWindow - usage.tokens <= forecast;
  }

  function matchesCompaction(ctx: ExtensionContext, goal: Goal | undefined, candidate: EarlyCompaction): goal is Goal {
    return goal?.id === candidate.goalId && goal.revision === candidate.revision &&
      ctx.sessionManager.getSessionId() === candidate.sessionId;
  }

  function compacting(ctx: ExtensionContext): boolean {
    return compaction !== undefined && matchesCompaction(ctx, store.read(ctx), compaction);
  }

  function compactBeforeStage(ctx: ExtensionContext, goal: Goal, forecast: number): boolean {
    const usage = contextSample(ctx);
    if (!shouldCompactStage(goal, usage, forecast)) return false;
    const attempt: EarlyCompaction = {
      sessionId: ctx.sessionManager.getSessionId(), goalId: goal.id, revision: goal.revision, cancelled: false,
    };
    compaction = attempt;
    attemptedStage = stageKey(goal);
    const percent = (usage.tokens / usage.contextWindow * 100).toFixed(1);
    ctx.ui.notify(`GoalPlus is compacting context at ${percent}% before the next stage.`, "info");

    const finish = (reportedTokens: number, failed = false) => {
      if (compaction !== attempt) return;
      compaction = undefined;
      asyncBoundary(ctx, () => {
        const current = store.read(ctx);
        if (!matchesCompaction(ctx, current, attempt)) return;
        const updated = { ...current, tokensUsed: addTokens(current.tokensUsed, reportedTokens) };
        if (current.status === "active") {
          if (reachedBudget(updated)) {
            updated.status = "budgetLimited";
            updated.reason = BUDGET_USED;
          } else if (attempt.cancelled) {
            updated.status = "paused";
            updated.reason = "Goal context compaction was cancelled. Resume to continue.";
          } else if (failed) {
            ctx.ui.notify("GoalPlus could not compact early. Continuing with Pi's normal context handling.", "warning");
          }
        }
        if (updated.tokensUsed !== current.tokensUsed || updated.status !== current.status) store.write(ctx, updated);
        if (updated.status === "active") schedule(ctx, updated);
      });
    };
    try {
      ctx.compact({
        customInstructions: GOAL_COMPACTION_INSTRUCTIONS,
        onComplete: result => finish(safeTokens(result.usage?.totalTokens)),
        onError: () => finish(0, true),
      });
    } catch {
      finish(0, true);
    }
    return true;
  }

  function abandonStart(ctx: ExtensionContext, candidate: NativeRun): void {
    if (run !== candidate) return;
    clearStartWatch();
    const goal = store.read(ctx);
    run = undefined;
    if (!matches(ctx, goal, candidate)) return;
    store.write(ctx, {
      ...goal, dispatch: undefined,
      tokensUsed: addTokens(goal.tokensUsed, tokensSinceDispatch(ctx, goal.dispatch)),
      status: goal.status === "active" ? "blocked" : goal.status,
      reason: goal.status === "active"
        ? "Pi did not confirm that this Goal dispatch started. Inspect the session before resuming."
        : goal.reason,
    });
  }

  function watchStart(ctx: ExtensionContext, candidate: NativeRun): void {
    startWatch = setTimeout(() => {
      asyncBoundary(ctx, () => {
        if (run !== candidate) return;
        if (ctx.isIdle()) abandonStart(ctx, candidate);
        else watchStart(ctx, candidate);
      });
    }, START_ACK_TIMEOUT);
    startWatch.unref();
  }

  function request(ctx: ExtensionContext, forecast?: number): void {
    if (run || compaction || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const goal = store.read(ctx);
    if (goal?.status !== "active" || goal.dispatch) return;
    cancelNext();
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
      store.write(ctx, { ...goal, status: "blocked", reason: "Resume in Pi's terminal UI or a persistent RPC session." });
      return;
    }
    if (reachedBudget(goal)) {
      store.write(ctx, {
        ...goal, status: "budgetLimited", reason: BUDGET_USED,
      });
      return;
    }
    if (!ctx.model) {
      store.write(ctx, { ...goal, status: "blocked", reason: "Select a Pi model before resuming this Goal." });
      return;
    }
    if (forecast !== undefined && compactBeforeStage(ctx, goal, forecast)) return;

    const id = randomUUID();
    const sessionId = ctx.sessionManager.getSessionId();
    // Pi flushes a new session file only after the first user or assistant
    // message. Use a native user turn once to make the dispatch durable before
    // any provider work begins. Persisted sessions can use hidden turns.
    const newSession = ctx.sessionManager.getSessionFile() !== undefined &&
      !ctx.sessionManager.getEntries().some(entry => entry.type === "message" &&
        (entry.message.role === "user" || entry.message.role === "assistant"));
    const initialPrompt = newSession ? `${GOAL_DISPATCH}\n\nGoalPlus dispatch ${id}` : undefined;
    store.write(ctx, {
      ...goal,
      ownerSessionId: sessionId,
      dispatch: { id, revision: goal.revision, phase: "queued", baseLeafId: ctx.sessionManager.getLeafId() },
      auditedRunId: undefined,
      completionRunId: undefined,
    });
    const candidate: NativeRun = {
      sessionId, goalId: goal.id, revision: goal.revision, id,
      startProgress: progressKey(goal), activity: new Set(), initialPrompt, started: false,
    };
    run = candidate;
    watchStart(ctx, candidate);
    try {
      if (initialPrompt) {
        issuedInitialPrompts.add(initialPrompt);
        pi.sendUserMessage(initialPrompt, { deliverAs: "followUp", expandPromptTemplates: false });
        return;
      }
      const retry = goal.noProgress > 0 ? " Use a different approach to make concrete progress or identify a blocker." : "";
      const reconcile = goal.auditPending ? " The previous run ended without a current audit. Read the Goal and record a checkpoint before advancing." : "";
      pi.sendMessage({
        customType: TRIGGER,
        display: false,
        details: { id },
        content: GOAL_DISPATCH + retry + reconcile,
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch {
      abandonStart(ctx, candidate);
    }
  }

  function schedule(ctx: ExtensionContext, goal: Goal, delay = 0, forecast?: number): void {
    if (next) return;
    const sessionId = ctx.sessionManager.getSessionId();
    next = setTimeout(() => {
      next = undefined;
      asyncBoundary(ctx, () => {
        const current = store.read(ctx);
        if (ctx.sessionManager.getSessionId() === sessionId &&
          current?.id === goal.id && current.revision === goal.revision) request(ctx, forecast);
      });
    }, delay);
  }

  function current(ctx: ExtensionContext): string | undefined {
    const goal = store.read(ctx);
    if (run?.started && matches(ctx, goal, run) && goal.dispatch.phase === "running" &&
      goal.revision === run.revision) return run.id;
  }

  function beforeNextStage(ctx: ExtensionContext, estimatedTokens?: number): boolean {
    const goal = store.read(ctx);
    if (!run?.started || !matches(ctx, goal, run) || goal.status !== "active") return false;
    const usage = contextSample(ctx);
    run.stageForecast = stageTokenForecast(ctx, usage, run.stageStart, estimatedTokens);
    run.stageStart = usage;
    run.yieldForCompaction = !ctx.hasPendingMessages() && shouldCompactStage(goal, usage, run.stageForecast);
    return run.yieldForCompaction;
  }

  pi.on("input", event => {
    if (event.source === "extension") return;
    cancelNext();
    if (run) {
      run.yieldForCompaction = false;
      run.stageForecast = undefined;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    cancelNext();
    const customTrigger = event.messageType === "custom" && event.message.customType === TRIGGER;
    const initialTrigger = event.messageType === "user" && issuedInitialPrompts.delete(event.prompt);
    if (!customTrigger && !initialTrigger) {
      if (run && !run.started) {
        const goal = store.read(ctx);
        if (matches(ctx, goal, run)) store.write(ctx, { ...goal, dispatch: undefined });
        clearStartWatch();
        run = undefined;
      }
      return;
    }
    const goal = store.read(ctx);
    const details = event.messageType === "custom" ? event.message.details : undefined;
    const matchingTrigger = event.messageType === "user"
      ? event.prompt === run?.initialPrompt && !event.images?.length
      : typeof details === "object" && details !== null && "id" in details && details.id === run?.id;
    if (!run || run.started || !matchingTrigger || !matches(ctx, goal, run)) {
      ctx.abort();
      return;
    }
    run.started = true;
    if (goal.status !== "active" || goal.revision !== run.revision) {
      ctx.abort();
      return;
    }
    run.stageStart = contextSample(ctx);
    store.write(ctx, { ...goal, dispatch: { ...goal.dispatch, phase: "running" } });
  });

  pi.on("agent_start", () => {
    if (run?.started) clearStartWatch();
  });

  function enforceBudget(ctx: ExtensionContext, pending = 0): void {
    const goal = store.read(ctx);
    if (!run || !matches(ctx, goal, run) || goal.status !== "active" ||
      goal.budgetTokens === undefined) return;
    if (reachedBudget(goal, addTokens(goal.tokensUsed, tokensSinceDispatch(ctx, goal.dispatch) + pending))) ctx.abort();
  }

  pi.on("after_provider_response", (event, ctx) => {
    if (run?.started && run.sessionId === ctx.sessionManager.getSessionId()) run.statusCode = event.status;
  });

  pi.on("message_end", (event, ctx) => {
    if (!run?.started || event.message.role !== "assistant") return;
    run.outcome = event.message.stopReason === "error" ? "error"
      : event.message.stopReason === "aborted" ? "aborted" : "completed";
    run.providerError = run.outcome === "error" ? event.message.errorMessage?.slice(0, 1000) : undefined;
    // Pi persists the response immediately after message_end, before dispatching its tools.
    enforceBudget(ctx, safeTokens(event.message.usage?.totalTokens));
  });

  pi.on("tool_call", (_event, ctx) => {
    if (!run?.yieldForCompaction) return;
    const goal = store.read(ctx);
    if (matches(ctx, goal, run) && goal.status === "active") {
      return { block: true, terminate: true, reason: "GoalPlus is yielding so Pi can compact before the next stage." };
    }
  });

  pi.on("tool_execution_start", event => {
    if (run?.started && !isGoalTool(event.toolName) &&
      !isNativeReadOnly(pi, event.toolName)) run.possibleEffects = true;
  });
  pi.on("tool_result", (event, ctx) => {
    if (!run?.started || run.sessionId !== ctx.sessionManager.getSessionId()) return;
    const key = outcomeKey(event, ctx.cwd, isBuiltin(pi, event.toolName));
    if (!key || run.activity.has(key)) return;
    if (run.activity.size >= RECENT_ACTIVITY_LIMIT) {
      const oldest = run.activity.values().next().value;
      if (oldest !== undefined) run.activity.delete(oldest);
    }
    run.activity.add(key);
  });

  pi.on("turn_end", (_event, ctx) => {
    enforceBudget(ctx);
    if (run?.started && !run.stageStart) run.stageStart = contextSample(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    enforceBudget(ctx);
    const goal = store.read(ctx);
    if (run && matches(ctx, goal, run)) {
      run.stageStart = undefined;
      run.stageForecast = undefined;
      run.yieldForCompaction = false;
    }
    if (!run && !compaction && goal?.status === "active" && !goal.dispatch) schedule(ctx, goal);
  });
  pi.on("session_compact_failed", (event, ctx) => {
    const goal = store.read(ctx);
    if (compaction && event.reason === "manual" && matchesCompaction(ctx, goal, compaction)) {
      compaction.cancelled = event.aborted;
    }
    if (!run && !compaction && goal?.status === "active" && !goal.dispatch) schedule(ctx, goal);
  });

  pi.on("agent_before_settle", (event) => {
    if (run?.started) run.outcome = event.outcome;
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!ctx.isIdle()) return;
    const settled = run;
    if (settled?.started) {
      clearStartWatch();
      run = undefined;
    }
    const goal = store.read(ctx);
    if (settled?.started && matches(ctx, goal, settled)) {
      const nextGoal: Goal = {
        ...goal, dispatch: undefined, lastSettledId: settled.id,
        auditedRunId: undefined, completionRunId: undefined,
        tokensUsed: addTokens(goal.tokensUsed, tokensSinceDispatch(ctx, goal.dispatch)),
      };
      if (settled.outcome === "completed" && !event.aborted && goal.revision === settled.revision) {
        nextGoal.auditPending = goal.auditedRunId !== settled.id;
      }
      const delay = decideNext(goal, nextGoal, settled, event.aborted);
      store.write(ctx, nextGoal);
      if (nextGoal.status === "active") {
        const forecast = settled.outcome === "completed"
          ? settled.stageForecast ?? stageTokenForecast(ctx, contextSample(ctx), settled.stageStart)
          : undefined;
        schedule(ctx, nextGoal, delay, forecast);
      }
    } else if (!compaction && goal?.status === "active" && !goal.dispatch) {
      schedule(ctx, goal);
    }
  });

  function recover(ctx: ExtensionContext, inherited: boolean): void {
    cancelNext();
    clearStartWatch();
    issuedInitialPrompts.clear();
    run = undefined;
    compaction = undefined;
    attemptedStage = undefined;
    const goal = store.read(ctx);
    if (!goal) return;
    const ownerSessionId = ctx.sessionManager.getSessionId();
    if (inherited || (goal.ownerSessionId && goal.ownerSessionId !== ownerSessionId)) {
      if (goal.status === "active" || goal.dispatch) {
        store.write(ctx, {
          ...goal, ownerSessionId, dispatch: undefined,
          status: goal.status === "active" ? "paused" : goal.status,
          reason: goal.status === "active" ? "This branch inherited a Goal. Resume here to begin work on it." : goal.reason,
          auditedRunId: undefined, completionRunId: undefined,
        });
      }
      return;
    }
    if (goal.dispatch) {
      store.write(ctx, {
        ...goal, ownerSessionId, dispatch: undefined,
        tokensUsed: addTokens(goal.tokensUsed, tokensSinceDispatch(ctx, goal.dispatch)),
        status: goal.status === "active" ? "blocked" : goal.status,
        reason: goal.status === "active"
          ? "Pi could not confirm the prior Goal run settled. Inspect its results before resuming."
          : goal.reason,
        auditedRunId: undefined, completionRunId: undefined,
      });
      return;
    }
    if (goal.status === "active") schedule(ctx, goal);
  }

  pi.on("session_start", (event, ctx) => recover(ctx, event.reason === "fork"));
  pi.on("session_tree", (event, ctx) => {
    if (event.newLeafId !== event.oldLeafId) recover(ctx, true);
  });
  pi.on("session_shutdown", () => {
    cancelNext();
    clearStartWatch();
    issuedInitialPrompts.clear();
    run = undefined;
    compaction = undefined;
    attemptedStage = undefined;
  });

  return { request, current, beforeNextStage, compacting };
}

function decideNext(goal: Goal, next: Goal, run: NativeRun, aborted: boolean): number {
  if (goal.status !== "active" || goal.revision !== run.revision) return 0;
  if (reachedBudget(next)) {
    next.status = "budgetLimited";
    next.reason = BUDGET_USED;
    return 0;
  }
  if (aborted || run.outcome === "aborted") {
    next.status = "paused";
    next.reason = "Pi interrupted this Goal run. Resume to continue.";
    return 0;
  }
  if (run.outcome !== "completed") {
    const failure = failedRequest(run);
    if (failure === "usage") {
      next.status = "usageLimited";
      next.reason = "Provider usage is limited. Resume after the provider allows requests.";
      return 0;
    }
    const failures = goal.consecutiveFailures ?? 0;
    if (failure === "transient" && !run.possibleEffects && failures < SAFE_RETRY_DELAYS.length) {
      next.consecutiveFailures = failures + 1;
      next.reason = "Pi reported a temporary provider failure. GoalPlus is retrying after a delay.";
      return SAFE_RETRY_DELAYS[failures];
    }
    next.status = "blocked";
    next.reason = "Pi did not finish this Goal run successfully. Review the native error and recorded effects before resuming.";
    return 0;
  }
  next.consecutiveFailures = 0;
  next.reason = undefined;
  if (goal.completionRunId === run.id && goal.auditedRunId === run.id) {
    next.status = "complete";
    if (goal.plan) next.plan = { ...goal.plan, completed: goal.plan.tasks.length };
    return 0;
  }
  const observed = progressKey(goal);
  const seen = new Set([...(goal.progressSeen ?? []), run.startProgress]);
  const activities = new Set(goal.activitySeen ?? []);
  const progress = !seen.has(observed) || [...run.activity].some(key => !activities.has(key));
  for (const key of run.activity) activities.add(key);
  seen.add(observed);
  next.progressSeen = [...seen].slice(-RECENT_PROGRESS_LIMIT);
  next.activitySeen = [...activities].slice(-RECENT_ACTIVITY_LIMIT);
  next.noProgress = progress ? 0 : goal.noProgress + 1;
  if (next.noProgress >= NO_PROGRESS_LIMIT) {
    next.status = "blocked";
    next.reason = "Three consecutive runs produced no task progress, new verification evidence or useful tool outcomes. Review the obstacles and resume when another check or approach is available.";
  }
  return progress ? 0 : next.noProgress * 150;
}
