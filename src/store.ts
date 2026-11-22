import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalAuthority } from "./local-authority.js";
import type { Criterion, Goal, GoalDefinition, GoalPlan, GoalStore } from "./types.js";

const ENTRY_TYPE = "pi-goalplus:state";
const MAX_DEFINITION_BYTES = 32768;
const MAX_ITEMS = 24;
export const MAX_CRITERION_TEXT_LENGTH = 1000;
export const MIN_TASKS = 2;
export const MAX_TASKS = 24;
export const MAX_TASK_TITLE_LENGTH = 160;
const statuses = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

export class GoalStateError extends Error {
  constructor() {
    super("The persisted Goal is incompatible or damaged. Use /goal clear to remove its active record.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wholeNumber(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw Error(`${label} must contain between 1 and ${maximum} characters.`);
  }
  return value.trim();
}

function decodeDefinition(value: unknown): GoalDefinition {
  if (!isRecord(value)) throw Error("Provide a Goal definition as a JSON object.");
  const objective = text(value.objective, "The objective", 4000);
  if (!Array.isArray(value.criteria) || !value.criteria.length || value.criteria.length > MAX_ITEMS) {
    throw Error(`A Goal needs between 1 and ${MAX_ITEMS} acceptance criteria with verification methods.`);
  }
  const criteria: Criterion[] = value.criteria.map((item: unknown) => {
    if (!isRecord(item)) throw Error("Every acceptance criterion must be an object.");
    if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id)) {
      throw Error("Criterion IDs need 1–64 ASCII letters, digits, hyphens, or underscores.");
    }
    return {
      id: item.id,
      requirement: text(item.requirement, "The criterion requirement", MAX_CRITERION_TEXT_LENGTH),
      verification: text(item.verification, "The verification method", MAX_CRITERION_TEXT_LENGTH)
    };
  });
  if (new Set(criteria.map(criterion => criterion.id)).size !== criteria.length) {
    throw Error("Criterion IDs must be unique within the Goal.");
  }
  const inputConstraints = value.constraints === undefined ? [] : value.constraints;
  if (!Array.isArray(inputConstraints) || inputConstraints.length > MAX_ITEMS) {
    throw Error(`Provide at most ${MAX_ITEMS} constraints as an array of strings.`);
  }
  const constraints = inputConstraints.map((item: unknown) => text(item, "A constraint", 1000));
  const budgetTokens = value.budgetTokens;
  if (budgetTokens !== undefined && !wholeNumber(budgetTokens, 1)) {
    throw Error("The Goal token budget must be a positive integer. Omit it for no budget.");
  }
  return {
    objective,
    criteria,
    constraints,
    ...(budgetTokens === undefined ? {} : { budgetTokens })
  };
}

export function parseGoalDefinition(json: string): GoalDefinition {
  if (Buffer.byteLength(json, "utf8") > MAX_DEFINITION_BYTES) {
    throw Error("Goal definitions must fit within 32 KiB. Reference longer requirements by path.");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw Error("Enter a valid Goal JSON object with objective, constraints and criteria.");
  }
  const definition = decodeDefinition(value);
  if (isRecord(value) && Object.keys(value).some(key => !["objective", "criteria", "constraints", "budgetTokens"].includes(key))) {
    throw Error("A Goal definition accepts only objective, criteria, constraints and budgetTokens.");
  }
  return definition;
}

export function decodeTaskPlan(value: unknown, criteria: Criterion[]): GoalPlan {
  if (!isRecord(value) || !Array.isArray(value.tasks) || value.tasks.length < MIN_TASKS || value.tasks.length > MAX_TASKS) {
    throw Error(`A Goal task plan needs ${MIN_TASKS}–${MAX_TASKS} ordered tasks.`);
  }
  const completed = value.completed;
  if (!wholeNumber(completed, 0) || completed > value.tasks.length) throw Error("Invalid task progress.");
  const ids = new Set(criteria.map(({ id }) => id));
  const covered = new Set<string>();
  const tasks = value.tasks.map((item: unknown) => {
    if (!isRecord(item) || !Array.isArray(item.criteria) || !item.criteria.length || item.criteria.length > ids.size) {
      throw Error("Each task must name the confirmed criteria it advances.");
    }
    const title = text(item.title, "The task title", MAX_TASK_TITLE_LENGTH);
    const taskCriteria = new Set<string>();
    for (const id of item.criteria) {
      if (typeof id !== "string" || !ids.has(id) || taskCriteria.has(id)) {
        throw Error("Use unique, confirmed criterion IDs for each task.");
      }
      taskCriteria.add(id);
      covered.add(id);
    }
    return { title, criteria: [...taskCriteria] };
  });
  if (covered.size !== ids.size) throw Error("The task plan must cover every confirmed criterion.");
  return { tasks, completed };
}

function decodeSnapshot(value: unknown): Goal | undefined {
  if (!isRecord(value) || value.schema !== 1) throw new GoalStateError();
  if (value.goal === null) return undefined;
  const goal = value.goal;
  if (!isRecord(goal) || goal.schema !== 1 || typeof goal.id !== "string" || !goal.id || goal.id.length > 128 ||
      !wholeNumber(goal.revision, 1) || typeof goal.status !== "string" || !statuses.has(goal.status) ||
      !wholeNumber(goal.tokensUsed, 0) || !wholeNumber(goal.noProgress, 0) || !Array.isArray(goal.evidence)) {
    throw new GoalStateError();
  }
  if (goal.needsReview !== undefined ||
      (goal.consecutiveFailures !== undefined && !wholeNumber(goal.consecutiveFailures, 0)) ||
      (goal.auditPending !== undefined && typeof goal.auditPending !== "boolean")) {
    throw new GoalStateError();
  }
  for (const key of ["progressSeen", "activitySeen"]) {
    const keys = goal[key];
    if (keys !== undefined && (!Array.isArray(keys) || keys.length > 128 ||
        keys.some(key => !digest(key)))) {
      throw new GoalStateError();
    }
  }
  for (const key of ["stage", "next", "reason", "ownerSessionId", "lastSettledId", "auditedRunId", "completionRunId"]) {
    if (goal[key] !== undefined && typeof goal[key] !== "string") throw new GoalStateError();
  }
  if (goal.dispatch !== undefined && (!isRecord(goal.dispatch) ||
    typeof goal.dispatch.id !== "string" || !goal.dispatch.id || !wholeNumber(goal.dispatch.revision, 1) ||
    (goal.dispatch.phase !== "queued" && goal.dispatch.phase !== "running") ||
    (goal.dispatch.baseLeafId !== undefined && goal.dispatch.baseLeafId !== null &&
      (typeof goal.dispatch.baseLeafId !== "string" || !goal.dispatch.baseLeafId)))) {
    throw new GoalStateError();
  }
  let definition: GoalDefinition;
  let plan: GoalPlan | undefined;
  try {
    definition = decodeDefinition(goal);
    if (goal.plan !== undefined) {
      plan = decodeTaskPlan(goal.plan, definition.criteria);
      if ((goal.status === "complete") !== (plan.completed === plan.tasks.length)) throw new GoalStateError();
    }
  } catch {
    throw new GoalStateError();
  }
  const ids = new Set(definition.criteria.map(criterion => criterion.id));
  for (const evidence of goal.evidence) {
    if (!isRecord(evidence) || typeof evidence.criterionId !== "string" || !ids.delete(evidence.criterionId) ||
        (evidence.verdict !== "pass" && evidence.verdict !== "fail") ||
        typeof evidence.source !== "string" || !evidence.source.trim() ||
        typeof evidence.observed !== "string" || !evidence.observed.trim() ||
        (evidence.fingerprint !== undefined && !digest(evidence.fingerprint))) {
      throw new GoalStateError();
    }
  }
  if (goal.constraintReviews !== undefined) {
    const indexes = new Set(definition.constraints.map((_item, index) => index + 1));
    if (!Array.isArray(goal.constraintReviews) || goal.constraintReviews.some(item =>
      !isRecord(item) || !wholeNumber(item.index, 1) || !indexes.delete(item.index) ||
      (item.state !== "pass" && item.state !== "fail" && item.state !== "unknown") ||
      typeof item.evidence !== "string" || !item.evidence.trim() ||
      (item.source !== undefined || item.fingerprint !== undefined) &&
        (typeof item.source !== "string" || !item.source.trim() || !digest(item.fingerprint))
    )) throw new GoalStateError();
  }
  return { ...goal, ...definition, plan } as Goal;
}

function unconfirmed(goal: Goal): Goal {
  const { objective, criteria, constraints, budgetTokens, id, revision } = goal;
  return {
    schema: 1, id, revision, objective, criteria, constraints, budgetTokens,
    status: "paused", needsReview: true, evidence: [], tokensUsed: 0, noProgress: 0,
    reason: "This Goal has no verified local origin. Review it with /goal resume before starting work."
  };
}

export function createGoalStore(
  pi: ExtensionAPI,
  onChange?: (ctx: ExtensionContext, goal: Goal | undefined) => void
): GoalStore {
  const authority = createLocalAuthority();

  const read = (ctx: ExtensionContext): Goal | undefined => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const goal = decodeSnapshot(entry.data);
      if (!goal || !isRecord(entry.data)) return undefined;
      return authority.verify(ctx, entry.parentId, entry.data.goal, entry.data.origin) ? goal : unconfirmed(goal);
    }
    return undefined;
  };

  return {
    read,
    write(ctx, goal, authorization) {
      if (goal === null) {
        pi.appendEntry(ENTRY_TYPE, { schema: 1, goal });
        onChange?.(ctx, undefined);
        return;
      }
      const confirmed = authorization === "user-confirmed";
      if (!confirmed) {
        const previous = read(ctx);
        if (!previous || previous.needsReview || previous.id !== goal.id || previous.revision !== goal.revision) {
          throw Error("Goal changes require a verified local Goal or a fresh user confirmation.");
        }
      }
      const snapshot = { schema: 1, goal };
      decodeSnapshot(snapshot);
      const origin = authority.sign(ctx, ctx.sessionManager.getLeafId(), goal, confirmed);
      pi.appendEntry(ENTRY_TYPE, { ...snapshot, origin });
      onChange?.(ctx, goal);
    }
  };
}
