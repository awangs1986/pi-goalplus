import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_NATIVE = new Set(["read", "grep", "find", "ls"]);
export const GOAL_TOOL_NAMES = ["goalplus_read", "goalplus_tasks", "goalplus_checkpoint", "goalplus_complete", "goalplus_block"] as const;
const GOAL_TOOLS = new Set<string>(GOAL_TOOL_NAMES);

export function isGoalTool(name: string): boolean {
  return GOAL_TOOLS.has(name);
}

export function isNativeReadOnly(pi: ExtensionAPI, toolName: string): boolean {
  return READ_ONLY_NATIVE.has(toolName) &&
    pi.getAllTools().some(({ name, sourceInfo }) => name === toolName && sourceInfo.source === "builtin");
}
