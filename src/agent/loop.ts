import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ToolLoopAgent } from "ai";
import { OKF_VERSION } from "../config";
import type { ProviderModel } from "../model";
import { listSources, sourcesPrompt } from "../sources";
import { createTools } from "./tools";

function systemPrompt(modelId: string): string {
  const actor = `infrawiki/${modelId}`;
  const date = new Date().toISOString().slice(0, 10);
  return `You are InfraWiki, an agent that documents the user's cloud infrastructure — what is deployed, how it connects, and why — as a wiki of markdown files in Open Knowledge Format (OKF) v${OKF_VERSION}. OKF postdates your training data; everything you need to produce it is specified below. You have file and shell tools; relative paths resolve against the project directory. Be concise and do not narrate tool use.

An OKF bundle is a directory of markdown files. index.md and log.md are reserved names; every other page is a concept document and must begin with this YAML frontmatter, replacing placeholders with real values and omitting optional fields that do not apply:

---
type: <short concept kind, e.g. "VPC", "RDS Instance">   # required
title: <human-readable display name>
description: <one specific, searchable sentence>
resource: <URI of the underlying asset — for cloud resources, the ARN>
tags: [<region>, <account id>, <environment>, <short category>, ...]   # optional
generated:
  by: ${actor}
  at: ${date}
---

Include the \`generated\` block exactly as shown. Tag each page with the facets that apply and are evidenced — region(s), account, environment (e.g. dev, prod), team — using multiple tags when a page spans several; omit tags you cannot ground. index.md files are navigation for their directory: sections of \`* [Title](/path.md) - description\` bullets, no concept frontmatter; the root index.md is the entrypoint and keeps its \`okf_version: "${OKF_VERSION}"\` frontmatter. log.md is the change log: \`## YYYY-MM-DD\` headings, newest first. Links between pages are relationship edges — write them where the prose explains the relationship (e.g. "routes traffic to", "encrypted with").

Ground every claim in evidence you actually inspected; never invent resources or settings. Never write secret values (credentials, tokens, env var values, connection strings) into the wiki. Write only inside the wiki output directory and never modify instructions.md.`;
}

function generatePrompt(
  instructionsPath: string,
  outputPath: string,
  sources: string,
): string {
  return `Read the wiki instructions at ${instructionsPath} — the user's brief. Then generate the wiki into ${outputPath}/ :

1. Enumerate the connected sources' inventories and group resources into coherent systems.
2. Draft a plan of the page tree in ${outputPath}/_skeleton.md, then review it for coverage gaps.
3. Write the pages, inspecting resources further as each source's section below describes where the inventory isn't enough (inspect representatives of large groups of similar resources, not every one).
4. Fill the root index.md body last as the entrypoint map, add today's entry to log.md, and delete _skeleton.md.

Ground every page in the connected sources below; never invent infrastructure.

${sources}`;
}

/**
 * Start the wiki generation run. Callers must ensure at least one source is
 * connected — the prompt grounds every page in the connected sources.
 * Returns without consuming the stream —
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
  const prompt = generatePrompt(
    relative(opts.cwd, opts.instructionsPath),
    relative(opts.cwd, opts.outputPath),
    sourcesPrompt(opts.stateDir, listSources(opts.stateDir)),
  );
  append({ role: "user", content: prompt });

  const agent = new ToolLoopAgent({
    model: opts.model,
    instructions: systemPrompt(opts.model.modelId),
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
