import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { resolveToCwd } from "./paths";

/** Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md. */
export function writeTool(cwd: string) {
  return tool({
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Path to the file to write (relative or absolute)"),
      content: z.string().describe("Content to write to the file"),
    }),
    execute: async ({ path, content }, { abortSignal }): Promise<string> => {
      // Aborts are observed between awaits rather than via an event listener so
      // an in-flight filesystem operation always settles before we bail.
      const throwIfAborted = () => {
        if (abortSignal?.aborted) throw new Error("Operation aborted");
      };
      const absolutePath = resolveToCwd(path, cwd);
      throwIfAborted();
      await mkdir(dirname(absolutePath), { recursive: true });
      throwIfAborted();
      await writeFile(absolutePath, content, "utf-8");
      return `Successfully wrote ${content.length} bytes to ${path}`;
    },
  });
}
