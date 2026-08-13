import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolve a tool-supplied path relative to the project directory.
 * Handles ~ expansion and absolute paths.
 * Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  let expanded = filePath;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/"))
    expanded = join(homedir(), expanded.slice(2));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
