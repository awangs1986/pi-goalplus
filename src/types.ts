import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

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
export interface Evidence {
  criterionId: string;
  verdict: "pass" | "fail";
  source: string;
  observed: string;
}
export interface Dispatch {
  id: string;
  revision: number;
  phase: "queued" | "running";
}
export interface Goal extends GoalDefinition {
  schema: 1;
  id: string;
  revision: number;
  status: GoalStatus;
  evidence: Evidence[];
  stage?: string;
  next?: string;
  reason?: string;
  dispatch?: Dispatch;
  tokensUsed: number;
  noProgress: number;
  lastSettledId?: string;
  /** The evidence set was checked in this run. */
  auditedRunId?: string;
  /** A completion proposal passes only after the native run settles successfully. */
  completionRunId?: string;
}
export interface GoalStore {
  read(ctx: ExtensionContext): Goal | undefined;
  write(ctx: ExtensionContext, goal: Goal | null): void;
}
export interface GoalRunner {
  /** Attempt at most one dispatch, using Pi's persisted run and native queue. */
  request(ctx: ExtensionContext): void;
  /** ID of the current Goal run; undefined outside its owned turn. */
  current(ctx: ExtensionContext): string | undefined;
}
