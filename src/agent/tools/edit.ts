import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff";
import { resolveToCwd } from "./paths";

const editsSchema = z.array(
  z
    .object({
      oldText: z
        .string()
        .describe(
          "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
        ),
      newText: z.string().describe("Replacement text for this targeted edit."),
    })
    .strict(),
);

/** Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md. */
export function editTool(cwd: string) {
  return tool({
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Path to the file to edit (relative or absolute)"),
      // Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of
      // an array — pi observed this upstream; parse it before validation.
      edits: z
        .preprocess((value) => {
          if (typeof value !== "string") return value;
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : value;
          } catch {
            return value;
          }
        }, editsSchema)
        .describe(
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
        ),
    }),
    execute: async ({ path, edits }, { abortSignal }): Promise<string> => {
      if (edits.length === 0) {
        throw new Error(
          "Edit tool input is invalid. edits must contain at least one replacement.",
        );
      }
      // Aborts are observed between awaits rather than via an event listener so
      // an in-flight filesystem operation always settles before we bail.
      const throwIfAborted = () => {
        if (abortSignal?.aborted) throw new Error("Operation aborted");
      };
      const absolutePath = resolveToCwd(path, cwd);
      throwIfAborted();
      try {
        await access(absolutePath, constants.R_OK | constants.W_OK);
      } catch (error) {
        throwIfAborted();
        const errorMessage =
          error instanceof Error && "code" in error
            ? `Error code: ${error.code}`
            : String(error);
        throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
      }
      throwIfAborted();
      const rawContent = await readFile(absolutePath, "utf-8");
      throwIfAborted();

      const { bom, text: content } = stripBom(rawContent);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);
      const { newContent } = applyEditsToNormalizedContent(
        normalizedContent,
        edits,
        path,
      );
      throwIfAborted();
      await writeFile(
        absolutePath,
        bom + restoreLineEndings(newContent, originalEnding),
        "utf-8",
      );
      return `Successfully replaced ${edits.length} block(s) in ${path}.`;
    },
  });
}
