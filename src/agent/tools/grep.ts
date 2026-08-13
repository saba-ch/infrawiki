import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { createInterface } from "node:readline";
import { rgPath } from "@vscode/ripgrep";
import { tool } from "ai";
import { z } from "zod";
import { resolveToCwd } from "./paths";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
} from "./truncate";

const DEFAULT_LIMIT = 100;

/** Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md. */
export function grepTool(cwd: string) {
  return tool({
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    inputSchema: z.object({
      pattern: z.string().describe("Search pattern (regex or literal string)"),
      path: z
        .string()
        .optional()
        .describe("Directory or file to search (default: current directory)"),
      glob: z
        .string()
        .optional()
        .describe(
          "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
        ),
      ignoreCase: z
        .boolean()
        .optional()
        .describe("Case-insensitive search (default: false)"),
      literal: z
        .boolean()
        .optional()
        .describe(
          "Treat pattern as literal string instead of regex (default: false)",
        ),
      context: z
        .number()
        .optional()
        .describe(
          "Number of lines to show before and after each match (default: 0)",
        ),
      limit: z
        .number()
        .optional()
        .describe(
          `Maximum number of matches to return (default: ${DEFAULT_LIMIT})`,
        ),
    }),
    execute: async (
      { pattern, path: searchDir, glob, ignoreCase, literal, context, limit },
      { abortSignal },
    ): Promise<string> => {
      const searchPath = resolveToCwd(searchDir || ".", cwd);
      let isDirectory: boolean;
      try {
        isDirectory = (await stat(searchPath)).isDirectory();
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }
      const contextValue = context && context > 0 ? context : 0;
      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
      const formatPath = (filePath: string) => {
        if (isDirectory) {
          const rel = relative(searchPath, filePath);
          if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
        }
        return basename(filePath);
      };

      const fileCache = new Map<string, string[]>();
      const getFileLines = async (filePath: string) => {
        let lines = fileCache.get(filePath);
        if (!lines) {
          try {
            const content = await readFile(filePath, "utf-8");
            lines = content
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n")
              .split("\n");
          } catch {
            lines = [];
          }
          fileCache.set(filePath, lines);
        }
        return lines;
      };

      const args = ["--json", "--line-number", "--color=never", "--hidden"];
      if (ignoreCase) args.push("--ignore-case");
      if (literal) args.push("--fixed-strings");
      if (glob) args.push("--glob", glob);
      args.push("--", pattern, searchPath);

      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };

        const child = spawn(Bun.which("rg") ?? rgPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const rl = createInterface({ input: child.stdout });
        let stderr = "";
        let matchCount = 0;
        let matchLimitReached = false;
        let linesTruncated = false;
        let aborted = false;
        let killedDueToLimit = false;
        const matches: {
          filePath: string;
          lineNumber: number;
          lineText?: string;
        }[] = [];

        const stopChild = (dueToLimit = false) => {
          if (!child.killed) {
            killedDueToLimit = dueToLimit;
            child.kill();
          }
        };
        const onAbort = () => {
          aborted = true;
          stopChild();
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        const cleanup = () => {
          rl.close();
          abortSignal?.removeEventListener("abort", onAbort);
        };

        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        rl.on("line", (line) => {
          if (!line.trim() || matchCount >= effectiveLimit) return;
          let event: {
            type?: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              lines?: { text?: string };
            };
          };
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === "match") {
            matchCount++;
            const filePath = event.data?.path?.text;
            const lineNumber = event.data?.line_number;
            if (filePath && typeof lineNumber === "number") {
              matches.push({
                filePath,
                lineNumber,
                lineText: event.data?.lines?.text,
              });
            }
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              stopChild(true);
            }
          }
        });

        child.on("error", (error) => {
          cleanup();
          settle(() =>
            reject(new Error(`Failed to run ripgrep: ${error.message}`)),
          );
        });

        child.on("close", async (code) => {
          cleanup();
          if (aborted) {
            settle(() => reject(new Error("Operation aborted")));
            return;
          }
          if (!killedDueToLimit && code !== 0 && code !== 1) {
            const errorMsg =
              stderr.trim() || `ripgrep exited with code ${code}`;
            settle(() => reject(new Error(errorMsg)));
            return;
          }
          if (matchCount === 0) {
            settle(() => resolve("No matches found"));
            return;
          }

          // Format matches after streaming finishes; context blocks re-read the file.
          const outputLines: string[] = [];
          for (const match of matches) {
            if (contextValue === 0 && match.lineText !== undefined) {
              const relativePath = formatPath(match.filePath);
              const sanitized = match.lineText
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "")
                .replace(/\n$/, "");
              const { text, wasTruncated } = truncateLine(sanitized);
              if (wasTruncated) linesTruncated = true;
              outputLines.push(`${relativePath}:${match.lineNumber}: ${text}`);
            } else {
              const relativePath = formatPath(match.filePath);
              const lines = await getFileLines(match.filePath);
              if (!lines.length) {
                outputLines.push(
                  `${relativePath}:${match.lineNumber}: (unable to read file)`,
                );
                continue;
              }
              const start = Math.max(1, match.lineNumber - contextValue);
              const end = Math.min(
                lines.length,
                match.lineNumber + contextValue,
              );
              for (let current = start; current <= end; current++) {
                const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
                const { text, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) linesTruncated = true;
                outputLines.push(
                  current === match.lineNumber
                    ? `${relativePath}:${current}: ${text}`
                    : `${relativePath}-${current}- ${text}`,
                );
              }
            }
          }

          // Byte truncation only; the match limit already capped rows.
          const truncation = truncateHead(outputLines.join("\n"), {
            maxLines: Number.MAX_SAFE_INTEGER,
          });
          let output = truncation.content;
          const notices: string[] = [];
          if (matchLimitReached) {
            notices.push(
              `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
            );
          }
          if (truncation.truncated) {
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          }
          if (linesTruncated) {
            notices.push(
              `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
            );
          }
          if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
          settle(() => resolve(output));
        });
      });
    },
  });
}
