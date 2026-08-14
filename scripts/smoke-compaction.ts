/**
 * Live compaction smoke test: runs a real generation against the configured
 * provider with a tiny context window so compaction fires within a few steps,
 * then verifies the run completed and the JSONL log replays.
 *
 * Usage: bun scripts/smoke-compaction.ts [projectDir]
 * Needs an initialized project with a model and at least one connected source.
 * The wiki is written to a scratch dir; only the run log lands in the real
 * state dir.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayRunLog, runGeneration } from "../src/agent/loop";
import { AuthStore } from "../src/auth/store";
import { loadCatalog } from "../src/catalog";
import { Config, DEFAULT_INSTRUCTIONS } from "../src/config";
import { createModel } from "../src/model";
import { listSources } from "../src/sources";

const fail = (message: string): never => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const config = Config.load(process.argv[2] ?? process.cwd());
if (!config.initialized)
  fail("project is not initialized — run infrawiki init");
if (!config.model) fail("no model configured — run infrawiki init");
if (listSources(config.stateDir).length === 0)
  fail("no sources connected — run infrawiki init");

const store = AuthStore.load(config.stateDir);
const catalog = await loadCatalog();
const model = await createModel({
  modelId: config.model as string,
  store,
  providers: config.providers,
  catalog,
});

const dir = mkdtempSync(join(tmpdir(), "infrawiki-smoke-"));
const outputPath = join(dir, "wiki");
mkdirSync(outputPath);
const instructionsPath = join(outputPath, "instructions.md");
writeFileSync(instructionsPath, DEFAULT_INSTRUCTIONS);
console.log(`model: ${config.model}`);
console.log(`scratch wiki: ${outputPath}`);

const { result, logPath } = await runGeneration({
  model,
  cwd: dir,
  instructionsPath,
  outputPath,
  stateDir: config.stateDir,
  // Small window: the ~13.6k-token threshold is crossed within a few real
  // steps, so compaction fires mid-run without waiting for a 200k context.
  contextWindow: 30000,
});
console.log(`run log: ${logPath}`);

let sawError: unknown;
for await (const part of result.fullStream) {
  if (part.type === "tool-call") console.log(`tool: ${part.toolName}`);
  if (part.type === "error") sawError = part.error;
}
if (sawError) fail(`stream error: ${sawError}`);

const lines = readFileSync(logPath, "utf-8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const compactions = lines.filter((l) => l.type === "compaction");
console.log(`log lines: ${lines.length}, compactions: ${compactions.length}`);
if (compactions.length === 0) fail("no compaction line in the run log");
for (const c of compactions) {
  if (typeof c.summary !== "string" || c.summary.length === 0)
    fail("compaction line has an empty summary");
  console.log(`--- checkpoint (kept ${c.kept}) ---\n${c.summary}\n---`);
}

const replayed = replayRunLog(lines);
if (replayed[0]?.role !== "user")
  fail("replayed log does not start with the prompt");
console.log(`replayed messages: ${replayed.length}`);
console.log("PASS");
