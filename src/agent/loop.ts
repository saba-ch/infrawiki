import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { type ModelMessage, ToolLoopAgent } from "ai";
import type { ProviderModel } from "../model";
import { listSources, sourcesPrompt } from "../sources";
import { applyCompaction, compact, shouldCompact } from "./compaction";
import { generatePrompt, systemPrompt, updatePrompt } from "./prompts";
import { createTools } from "./tools";

/**
 * Rebuild the `messages` array a run log encodes. Message lines accumulate;
 * a `{type:"compaction"}` line replaces everything but the initial prompt
 * with its checkpoint summary plus the last `kept` messages — mirroring what
 * prepareStep did to the live context when the line was written.
 */
export function replayRunLog(lines: unknown[]): ModelMessage[] {
  let messages: ModelMessage[] = [];
  for (const line of lines) {
    const record = line as
      | (ModelMessage & { type?: undefined })
      | { type: "compaction"; summary: string; kept: number };
    if (record.type === "compaction") {
      messages = applyCompaction(messages, record.summary, record.kept);
    } else {
      messages.push(record);
    }
  }
  return messages;
}

/**
 * Start the wiki generation run. Callers must ensure at least one source is
 * connected — the prompt grounds every page in the connected sources.
 * Returns without consuming the stream —
 * the caller owns result.fullStream. The JSONL log holds the user prompt,
 * every step's response messages, and any `{type:"compaction"}` lines;
 * replayRunLog folds them back into a valid `messages` array, which is how
 * resume will work later. With `contextWindow` known (from the models.dev
 * catalog), the context is compacted in-flight whenever the previous step's
 * usage gets near the window.
 */
export async function runGeneration(opts: {
  model: ProviderModel;
  cwd: string;
  instructionsPath: string;
  outputPath: string;
  stateDir: string;
  mode?: "generate" | "update";
  contextWindow?: number;
  abortSignal?: AbortSignal;
}) {
  const runsDir = join(opts.stateDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  const logPath = join(runsDir, `${runId}.jsonl`);
  const append = (line: object) =>
    appendFileSync(logPath, `${JSON.stringify(line)}\n`);

  // Relative paths in the prompt keep the model's tool calls (and the UI's
  // action lines) short — tools resolve them against cwd anyway.
  const buildPrompt = opts.mode === "update" ? updatePrompt : generatePrompt;
  const prompt = buildPrompt(
    relative(opts.cwd, opts.instructionsPath),
    relative(opts.cwd, opts.outputPath),
    sourcesPrompt(opts.stateDir, listSources(opts.stateDir)),
  );
  append({ role: "user", content: prompt });

  const contextWindow = opts.contextWindow;
  const agent = new ToolLoopAgent({
    model: opts.model,
    instructions: systemPrompt(opts.model.modelId),
    tools: createTools(opts.cwd),
    prepareStep: contextWindow
      ? async ({ steps, messages }) => {
          const usage = steps.at(-1)?.usage;
          if (!usage || !shouldCompact(usage, contextWindow)) return;
          const compacted = await compact({
            model: opts.model,
            messages,
            contextWindow,
          });
          if (!compacted) return;
          append({
            type: "compaction",
            summary: compacted.summary,
            kept: compacted.kept,
          });
          return { messages: compacted.messages };
        }
      : undefined,
  });
  const result = await agent.stream({
    prompt,
    abortSignal: opts.abortSignal,
    onStepEnd: (step) => {
      for (const message of step.response.messages) append(message);
    },
  });
  return { result, logPath };
}
