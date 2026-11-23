import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalAuthority } from "./local-authority.js";
import { GOAL_TOOL_NAMES } from "./tool-policy.js";
import { GOAL_STATUS_LABELS, type Goal, type GoalStatus } from "./types.js";

const ENTRY_TYPE = "pi-goalplus:log";
const authority = createLocalAuthority();
export const DEFAULT_GOAL_LOG_LIMIT = 20;
export const MAX_GOAL_LOG_LIMIT = 50;
const events = {
  started: "Goal run started",
  settled: "Goal run settled",
  interrupted: "Goal run interrupted",
  providerFailed: "Provider or Pi run failed",
  providerLimited: "Provider usage limited",
  providerTransient: "Temporary provider failure",
  dispatchMissing: "Pi did not acknowledge the Goal dispatch",
  dispatchUncertain: "Previous Goal dispatch did not settle",
  modelMissing: "Pi model unavailable",
  toolsUnavailable: "Pi Goal tools unavailable",
  modeUnsupported: "Pi session mode cannot run Goals",
  budgetExhausted: "Goal token budget exhausted",
  stalled: "Goal stopped after repeated runs without progress",
  resumed: "Goal resumed",
  paused: "Goal paused by user",
  stopped: "Goal stopped by user",
  goalEdited: "Goal requirements revised",
  definitionRejected: "Goal definition rejected",
  stateUnavailable: "Goal state is unavailable",
  taskAdvanced: "Task checkpoint saved",
  toolFailed: "Tool failed",
  dependency: "Goal reported a dependency",
  compactStarted: "Context compaction started",
  compacted: "Context compaction saved",
  compactFailed: "Context compaction failed",
  compactCancelled: "Context compaction cancelled"
} as const;
type LogEvent = keyof typeof events;

const safeTools = new Set<string>([...GOAL_TOOL_NAMES, "read", "write", "edit", "bash", "powershell", "grep", "find", "ls", "extension tool"]);
const compactSources = new Set(["early", "manual", "threshold", "overflow"]);
const dependencies = new Set(["approval", "user", "external"]);

interface LogDetails {
  runId?: string;
  httpStatus?: number;
  retryMs?: number;
  tool?: string;
  source?: "early" | "manual" | "threshold" | "overflow";
  dependency?: "approval" | "user" | "external";
  contextPercent?: number;
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function cleanDetails(details: Partial<Record<keyof LogDetails, unknown>>) {
  return {
    runId: typeof details.runId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/i.test(details.runId)
      ? details.runId.slice(0, 8) : undefined,
    httpStatus: integer(details.httpStatus, 400, 599) ? details.httpStatus : undefined,
    retryMs: integer(details.retryMs, 1, 60_000) ? details.retryMs : undefined,
    tool: typeof details.tool === "string" && safeTools.has(details.tool) ? details.tool : undefined,
    source: typeof details.source === "string" && compactSources.has(details.source) ? details.source : undefined,
    dependency: typeof details.dependency === "string" && dependencies.has(details.dependency) ? details.dependency : undefined,
    contextPercent: typeof details.contextPercent === "number" && Number.isFinite(details.contextPercent) &&
      details.contextPercent >= 0 && details.contextPercent <= 1000 ? details.contextPercent : undefined,
  };
}

export function diagnosticToolName(name: string): string {
  return safeTools.has(name) ? name : "extension tool";
}

function goalKey(goalId: string): string {
  return createHash("sha256").update(goalId).digest("hex");
}

export function recordGoalLog(
  pi: ExtensionAPI, ctx: ExtensionContext, goal: Goal | undefined, event: LogEvent, details: LogDetails = {}
): void {
  const taskTotal = goal?.plan?.tasks.length;
  const task = goal?.plan ? Math.min(goal.plan.completed + 1, goal.plan.tasks.length) : undefined;
  try {
    const diagnostic = {
      schema: 1, time: Date.now(), goalKey: goal ? goalKey(goal.id) : undefined,
      revision: goal?.revision, status: goal?.status, task, taskTotal, event,
      ...cleanDetails({ ...details, runId: details.runId ?? goal?.dispatch?.id }),
    };
    const origin = authority.sign(ctx, ctx.sessionManager.getLeafId(), diagnostic, true);
    pi.appendEntry(ENTRY_TYPE, { diagnostic, origin });
  } catch {
    // A diagnostic write must not prevent a Goal transition if Pi cannot append the entry.
  }
}

/** Return newest entries for the selected branch, using only bounded diagnostic metadata. */
export function readGoalLogs(ctx: ExtensionContext, goalId: string | undefined, limit: number): string[] {
  const selected = goalId === undefined ? undefined : goalKey(goalId);
  const branch = ctx.sessionManager.getBranch();
  const lines: string[] = [];
  for (let index = branch.length - 1; index >= 0 && lines.length < limit; index--) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
    const saved = entry.data as Record<string, unknown>;
    if (!saved.diagnostic || typeof saved.diagnostic !== "object") continue;
    const data = saved.diagnostic as Record<string, unknown>;
    if (data.schema !== 1 || (selected !== undefined && data.goalKey !== selected) ||
      typeof data.event !== "string" || !Object.hasOwn(events, data.event) ||
      !authority.verify(ctx, entry.parentId, data, saved.origin)) continue;
    const parts = [integer(data.time, 0, 8.64e15) ? new Date(data.time).toISOString() : "Unknown time"];
    if (integer(data.revision, 1)) parts.push(`Rev ${data.revision}`);
    if (integer(data.taskTotal, 1) && integer(data.task, 1, data.taskTotal)) parts.push(`Task ${data.task}/${data.taskTotal}`);
    const detail = cleanDetails(data);
    if (detail.runId) parts.push(`Run ${detail.runId}`);
    parts.push(events[data.event as LogEvent]);
    if (detail.tool) parts.push(detail.tool);
    if (detail.httpStatus) parts.push(`HTTP ${detail.httpStatus}`);
    if (detail.source) parts.push(detail.source);
    if (detail.dependency) parts.push(`Dependency ${detail.dependency}`);
    if (detail.contextPercent !== undefined) parts.push(`${detail.contextPercent.toFixed(1)}% context`);
    if (detail.retryMs) parts.push(`Retry in ${detail.retryMs} ms`);
    if (typeof data.status === "string" && Object.hasOwn(GOAL_STATUS_LABELS, data.status)) {
      parts.push(GOAL_STATUS_LABELS[data.status as GoalStatus]);
    }
    lines.push(parts.join(" · "));
  }
  return lines;
}
