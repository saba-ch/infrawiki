import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { sep } from "node:path";
import { createInterface } from "node:readline";
import { rgPath } from "@vscode/ripgrep";
import { tool } from "ai";
import { z } from "zod";
import { resolveToCwd } from "./paths";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate";

const DEFAULT_LIMIT = 1000;

/**
 * Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md.
 * Pi shells out to fd; this runs on `rg --files` so grep and find share one
 * binary. rg globs use gitignore semantics: '*.md' matches at any depth,
 * 'src/**' anchors at the search root — same intent as pi's fd patterns.
 */
export function findTool(cwd: string) {
  return tool({
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    inputSchema: z.object({
      pattern: z
        .string()
        .describe(
          "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
        ),
      path: z
        .string()
        .optional()
        .describe("Directory to search in (default: current directory)"),
      limit: z
        .number()
        .optional()
        .describe(`Maximum number of results (default: ${DEFAULT_LIMIT})`),
    }),
    execute: async (
      { pattern, path: searchDir, limit },
      { abortSignal },
    ): Promise<string> => {
      const searchPath = resolveToCwd(searchDir || ".", cwd);
      try {
        await stat(searchPath);
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }
      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

      // rg matches globs against paths relative to its cwd, so run it inside
      // the search dir — otherwise anchored patterns like 'src/**' never match
      // the absolute search path.
      const args = [
        "--files",
        "--hidden",
        "--no-require-git",
        "--glob",
        pattern,
        "--glob",
        "!**/.git/**",
      ];

      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };

        // Prefer the system ripgrep; fall back to the bundled platform binary.
        const child = spawn(Bun.which("rg") ?? rgPath, args, {
          cwd: searchPath,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const rl = createInterface({ input: child.stdout });
        let stderr = "";
        let aborted = false;
        let killedDueToLimit = false;
        let resultLimitReached = false;
        const results: string[] = [];

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
          if (!line.trim() || results.length >= effectiveLimit) return;
          results.push(line.split(sep).join("/"));
          // rg --files has no max-results flag; stop the child once we have enough.
          if (results.length >= effectiveLimit) {
            resultLimitReached = true;
            stopChild(true);
          }
        });

        child.on("error", (error) => {
          cleanup();
          settle(() =>
            reject(new Error(`Failed to run ripgrep: ${error.message}`)),
          );
        });

        child.on("close", (code) => {
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
          if (results.length === 0) {
            settle(() => resolve("No files found"));
            return;
          }

          results.sort();
          // Byte truncation only; the result limit already capped rows.
          const truncation = truncateHead(results.join("\n"), {
            maxLines: Number.MAX_SAFE_INTEGER,
          });
          let output = truncation.content;
          const notices: string[] = [];
          if (resultLimitReached) {
            notices.push(
              `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
            );
          }
          if (truncation.truncated) {
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          }
          if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
          settle(() => resolve(output));
        });
      });
    },
  });
}
