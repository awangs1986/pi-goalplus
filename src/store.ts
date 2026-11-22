import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Criterion, Goal, GoalDefinition, GoalStore } from "./types.js";

const ENTRY_TYPE = "pi-goalplus:state";
const MAX_DEFINITION_BYTES = 32768;
const MAX_ITEMS = 24;
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
      requirement: text(item.requirement, "The criterion requirement", 1000),
      verification: text(item.verification, "The verification method", 1000)
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

function decodeSnapshot(value: unknown): Goal | undefined {
  if (!isRecord(value) || value.schema !== 1) throw new GoalStateError();
  if (value.goal === null) return undefined;
  const goal = value.goal;
  if (!isRecord(goal) || goal.schema !== 1 || typeof goal.id !== "string" || !goal.id ||
      !wholeNumber(goal.revision, 1) || typeof goal.status !== "string" || !statuses.has(goal.status) ||
      !wholeNumber(goal.tokensUsed, 0) || !wholeNumber(goal.noProgress, 0) || !Array.isArray(goal.evidence)) {
    throw new GoalStateError();
  }
  for (const key of ["stage", "next", "reason", "lastSettledId", "auditedRunId", "completionRunId"]) {
    if (goal[key] !== undefined && typeof goal[key] !== "string") throw new GoalStateError();
  }
  if (goal.dispatch !== undefined && (!isRecord(goal.dispatch) ||
    typeof goal.dispatch.id !== "string" || !goal.dispatch.id || !wholeNumber(goal.dispatch.revision, 1) ||
    (goal.dispatch.phase !== "queued" && goal.dispatch.phase !== "running"))) {
    throw new GoalStateError();
  }
  let definition: GoalDefinition;
  try {
    definition = decodeDefinition(goal);
  } catch {
    throw new GoalStateError();
  }
  const ids = new Set(definition.criteria.map(criterion => criterion.id));
  for (const evidence of goal.evidence) {
    if (!isRecord(evidence) || typeof evidence.criterionId !== "string" || !ids.delete(evidence.criterionId) ||
        (evidence.verdict !== "pass" && evidence.verdict !== "fail") ||
        typeof evidence.source !== "string" || !evidence.source.trim() ||
        typeof evidence.observed !== "string" || !evidence.observed.trim()) {
      throw new GoalStateError();
    }
  }
  return { ...goal, ...definition } as Goal;
}

export function createGoalStore(
  pi: ExtensionAPI,
  onChange?: (ctx: ExtensionContext, goal: Goal | undefined) => void
): GoalStore {
  return {
    read(ctx) {
      const branch = ctx.sessionManager.getBranch();
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return decodeSnapshot(entry.data);
      }
      return undefined;
    },
    write(ctx, goal) {
      pi.appendEntry(ENTRY_TYPE, { schema: 1, goal });
      onChange?.(ctx, goal ?? undefined);
    }
  };
}
