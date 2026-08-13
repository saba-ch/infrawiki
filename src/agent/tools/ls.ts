import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { resolveToCwd } from "./paths";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate";

const DEFAULT_LIMIT = 500;

/** Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md. */
export function lsTool(cwd: string) {
  return tool({
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe("Directory to list (default: current directory)"),
      limit: z
        .number()
        .optional()
        .describe(
          `Maximum number of entries to return (default: ${DEFAULT_LIMIT})`,
        ),
    }),
    execute: async ({ path, limit }): Promise<string> => {
      const dirPath = resolveToCwd(path || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      let dirStat: Awaited<ReturnType<typeof stat>>;
      try {
        dirStat = await stat(dirPath);
      } catch {
        throw new Error(`Path not found: ${dirPath}`);
      }
      if (!dirStat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }
      let entries: string[];
      try {
        entries = await readdir(dirPath);
      } catch (e) {
        throw new Error(`Cannot read directory: ${(e as Error).message}`);
      }
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        try {
          const entryStat = await stat(join(dirPath, entry));
          results.push(entry + (entryStat.isDirectory() ? "/" : ""));
        } catch {
          // Skip entries we cannot stat.
        }
      }
      if (results.length === 0) return "(empty directory)";

      // Byte truncation only; entry count is already capped by the limit.
      const truncation = truncateHead(results.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      let output = truncation.content;
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
        );
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return output;
    },
  });
}
