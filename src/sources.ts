import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";
import {
  type AwsApi,
  AwsSourceSchema,
  awsLabel,
  awsPrompt,
  awsSummary,
  fetchAwsResources,
} from "./connectors/aws";

// A source is a connector instance configured as a data source. Grows into a
// discriminated union as connectors are added.
const SourceSchema = AwsSourceSchema;

export type Source = z.infer<typeof SourceSchema>;

// Each source owns <stateDir>/sources/<type>-<id>/ — source.json config plus
// that source's raw fetched data under data/.
function sourceDir(stateDir: string, source: Source): string {
  return join(stateDir, "sources", `${source.type}-${source.accountId}`);
}

export function sourcePath(stateDir: string, source: Source): string {
  return join(sourceDir(stateDir, source), "source.json");
}

export function sourceDataDir(stateDir: string, source: Source): string {
  return join(sourceDir(stateDir, source), "data");
}

export function listSources(stateDir: string): Source[] {
  const dir = join(stateDir, "sources");
  if (!existsSync(dir)) return [];
  const sources: Source[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry, "source.json");
    if (!existsSync(path)) continue;
    sources.push(SourceSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
  }
  return sources.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

// Sources are added before Config.initialize() runs, so this ensures the
// state dir on demand (mirrors AuthStore.writeFile).
export function saveSource(stateDir: string, source: Source): void {
  const path = sourcePath(stateDir, source);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(source, null, 2)}\n`);
}

// "Start over" wipes configured sources (and their raw data); credentials in
// auth.json survive, mirroring re-init.
export function clearSources(stateDir: string): void {
  rmSync(join(stateDir, "sources"), { recursive: true, force: true });
}

// Each connector defines the prompt, label, summary, and fetch for its own
// sources; these only route by the source's type. The switches are exhaustive
// — a new connector in the union fails typecheck until it is wired here.
function connectorPrompt(stateDir: string, source: Source): string {
  switch (source.type) {
    case "aws": {
      const dir = sourceDataDir(stateDir, source);
      const metaPath = join(dir, "meta.json");
      const data = existsSync(metaPath)
        ? { dir, fetchedAt: readMeta(metaPath).fetchedAt }
        : undefined;
      return awsPrompt(source, data);
    }
  }
}

function readMeta(path: string): { fetchedAt: string } {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Pull a source's current raw data into its data/ dir. meta.json is written
// only after the fetch succeeds, so a recorded fetchedAt implies complete
// data; it grows into the state/delta manifest later.
export async function fetchSource(
  api: AwsApi,
  stateDir: string,
  source: Source,
  signal?: AbortSignal,
): Promise<void> {
  const dataDir = sourceDataDir(stateDir, source);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  switch (source.type) {
    case "aws":
      await fetchAwsResources(api, dataDir, source, signal);
      break;
  }
  writeFileSync(
    join(dataDir, "meta.json"),
    `${JSON.stringify({ fetchedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

export interface SyncFailure {
  label: string;
  message: string;
}

// Refresh every source's raw data before a run. Stops at the first failure
// (a failed source blocks the run); rethrows on abort so callers can tell
// cancellation from failure. Reused by the future update command.
export async function syncSources(
  api: AwsApi,
  stateDir: string,
  opts: { signal?: AbortSignal; onProgress?: (label: string) => void } = {},
): Promise<SyncFailure | undefined> {
  for (const source of listSources(stateDir)) {
    opts.onProgress?.(sourceLabel(source));
    try {
      await fetchSource(api, stateDir, source, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return {
        label: sourceLabel(source),
        message: (err as Error).message,
      };
    }
  }
  return undefined;
}

export function sourceLabel(source: Source): string {
  switch (source.type) {
    case "aws":
      return awsLabel(source);
  }
}

export function sourceSummary(source: Source): string {
  switch (source.type) {
    case "aws":
      return awsSummary(source);
  }
}

// Assembles every connected source's connector prompt for the generation
// phase.
export function sourcesPrompt(stateDir: string, sources: Source[]): string {
  if (sources.length === 0) return "";
  const prompts = sources.map((source) => connectorPrompt(stateDir, source));
  return `Connected sources:\n\n${prompts.join("\n\n")}`;
}

export function formatSourcesDetail(sources: Source[]): string {
  if (sources.length === 0) return "no sources";
  const first = sources[0];
  if (sources.length === 1 && first) return sourceLabel(first);
  return `${sources.length} sources`;
}
