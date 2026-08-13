import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { resolveToCwd } from "./paths";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "./truncate";

/**
 * Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md.
 * Text files only; pi's image support is dropped (wiki generation reads text).
 */
export function readTool(cwd: string) {
  return tool({
    description: `Read the contents of a file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    inputSchema: z.object({
      path: z
        .string()
        .describe("Path to the file to read (relative or absolute)"),
      offset: z
        .number()
        .optional()
        .describe("Line number to start reading from (1-indexed)"),
      limit: z.number().optional().describe("Maximum number of lines to read"),
    }),
    execute: async ({ path, offset, limit }): Promise<string> => {
      const absolutePath = resolveToCwd(path, cwd);
      await access(absolutePath, constants.R_OK);
      const allLines = (await readFile(absolutePath, "utf-8")).split("\n");
      const totalFileLines = allLines.length;

      // Convert from 1-indexed input to 0-indexed array access.
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(
          `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
        );
      }

      // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
      let selectedContent: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent);
      if (truncation.firstLineExceedsLimit) {
        // First line alone exceeds the byte limit. Point the model at a bash fallback.
        const firstLineSize = formatSize(
          Buffer.byteLength(allLines[startLine] ?? "", "utf-8"),
        );
        return `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
      }
      if (truncation.truncated) {
        // Truncation occurred. Build an actionable continuation notice.
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        const limitNote =
          truncation.truncatedBy === "lines"
            ? ""
            : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
        return `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${limitNote}. Use offset=${nextOffset} to continue.]`;
      }
      if (
        userLimitedLines !== undefined &&
        startLine + userLimitedLines < allLines.length
      ) {
        // User-specified limit stopped early, but the file still has more content.
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      }
      return truncation.content;
    },
  });
}
