import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GOAL_STATUS_LABELS = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget exhausted",
  complete: "Complete"
} as const;
export type GoalStatus = keyof typeof GOAL_STATUS_LABELS;

export interface Criterion {
  id: string;
  requirement: string;
  verification: string;
}
export interface GoalDefinition {
  objective: string;
  constraints: string[];
  criteria: Criterion[];
  budgetTokens?: number;
}
export interface GoalTask {
  title: string;
  criteria: string[];
}
export interface GoalPlan {
  tasks: GoalTask[];
  completed: number;
}
export interface Evidence {
  criterionId: string;
  verdict: "pass" | "fail";
  source: string;
  observed: string;
  fingerprint?: string;
}
export interface ConstraintReview {
  index: number;
  state: "pass" | "fail" | "unknown";
  evidence: string;
  source?: string;
  fingerprint?: string;
}
export interface Dispatch {
  id: string;
  revision: number;
  phase: "queued" | "running";
  /** Native branch leaf immediately before dispatch, for Goal usage accounting. */
  baseLeafId?: string | null;
}
export interface Goal extends GoalDefinition {
  schema: 1;
  id: string;
  ownerSessionId?: string;
  /** Display-only projection of a record without verified local origin. */
  needsReview?: true;
  revision: number;
  status: GoalStatus;
  plan?: GoalPlan;
  evidence: Evidence[];
  constraintReviews?: ConstraintReview[];
  stage?: string;
  next?: string;
  reason?: string;
  dispatch?: Dispatch;
  tokensUsed: number;
  noProgress: number;
  progressSeen?: string[];
  /** Recent successful native outcomes, stored as hashes for stall detection. */
  activitySeen?: string[];
  consecutiveFailures?: number;
  lastSettledId?: string;
  /** Reconcile a missed audit before starting new mutations. */
  auditPending?: boolean;
  /** The evidence set was checked in this run. */
  auditedRunId?: string;
  /** A completion proposal passes only after the native run settles successfully. */
  completionRunId?: string;
}
export interface GoalStore {
  read(ctx: ExtensionContext): Goal | undefined;
  write(ctx: ExtensionContext, goal: Goal | null, authorization?: "user-confirmed"): void;
}
export interface GoalRunner {
  /** Attempt at most one dispatch, using Pi's persisted run and native queue. */
  request(ctx: ExtensionContext): void;
  /** ID of the current Goal run; undefined outside its owned turn. */
  current(ctx: ExtensionContext): string | undefined;
  /** Return whether a checkpoint should end its run before native compaction. */
  beforeNextStage(ctx: ExtensionContext, estimatedTokens?: number): boolean;
  /** A proactive compaction is in progress for the current Goal. */
  compacting(ctx: ExtensionContext): boolean;
}
