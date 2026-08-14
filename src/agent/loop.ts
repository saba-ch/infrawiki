import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ToolLoopAgent } from "ai";
import type { ProviderModel } from "../model";
import { listSources, sourcesPrompt } from "../sources";
import { createTools } from "./tools";

const SYSTEM_PROMPT =
  "You are InfraWiki, an agent that generates infrastructure documentation wikis as markdown files. " +
  "You have file and shell tools; relative paths resolve against the project directory. " +
  "Be concise and do not narrate tool use.";

function examplePagePrompt(
  instructionsPath: string,
  outputPath: string,
  sources: string,
): string {
  const base =
    `Read the wiki instructions at ${instructionsPath}. ` +
    `Then write ONE example wiki page to ${outputPath}/example.md showing what a page in this wiki will look like, ` +
    "following the instructions. " +
    "Keep it under about 60 lines. Do not create or modify any other files. ";
  if (!sources)
    return `${base}Use plausible placeholder infrastructure (e.g. a small AWS account).`;
  return `${base}Ground the example in the connected sources below instead of inventing infrastructure.\n\n${sources}`;
}

/**
 * Start the example-page generation run. Returns without consuming the stream —
 * the caller owns result.fullStream. The JSONL log holds the user prompt plus
 * every step's response messages; replayed top-to-bottom they form a valid
 * `messages` array, which is how resume will work later.
 */
export async function runGeneration(opts: {
  model: ProviderModel;
  cwd: string;
  instructionsPath: string;
  outputPath: string;
  stateDir: string;
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
  const prompt = examplePagePrompt(
    relative(opts.cwd, opts.instructionsPath),
    relative(opts.cwd, opts.outputPath),
    sourcesPrompt(listSources(opts.stateDir)),
  );
  append({ role: "user", content: prompt });

  const agent = new ToolLoopAgent({
    model: opts.model,
    instructions: SYSTEM_PROMPT,
    tools: createTools(opts.cwd),
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
