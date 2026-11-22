import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_NATIVE = new Set(["read", "grep", "find", "ls"]);

export function isNativeReadOnly(pi: ExtensionAPI, toolName: string): boolean {
  return READ_ONLY_NATIVE.has(toolName) &&
    pi.getAllTools().some(({ name, sourceInfo }) => name === toolName && sourceInfo.source === "builtin");
}
