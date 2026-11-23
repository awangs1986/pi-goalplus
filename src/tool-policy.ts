import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_NATIVE = new Set(["read", "grep", "find", "ls"]);
export const GOAL_CHECKPOINT_TOOL = "goalplus_checkpoint";
export const GOAL_TOOL_NAMES = ["goalplus_read", "goalplus_tasks", GOAL_CHECKPOINT_TOOL, "goalplus_complete", "goalplus_block"] as const;
const GOAL_TOOLS = new Set<string>(GOAL_TOOL_NAMES);

export function isGoalTool(name: string): boolean {
  return GOAL_TOOLS.has(name);
}

export function unavailableGoalToolReason(pi: ExtensionAPI, names: readonly string[]): string | undefined {
  const harness: { mode?: unknown } = {};
  pi.events?.emit("pi-coffee:harness-mode:query:v1", harness);
  if (harness.mode === "chat") return "Goal tools require Coffee Work mode. Switch to /work, then run /goal resume.";
  const available = new Set(names);
  const missing = GOAL_TOOL_NAMES.filter(name => !available.has(name));
  if (missing.length) return `Pi Goal tools unavailable (${missing.join(", ")}). Check the tool filters, then run /goal resume.`;
}

export function isNativeReadOnly(pi: ExtensionAPI, toolName: string): boolean {
  return READ_ONLY_NATIVE.has(toolName) &&
    pi.getAllTools().some(({ name, sourceInfo }) => name === toolName && sourceInfo.source === "builtin");
}
