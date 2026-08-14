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
  AwsSourceSchema,
  awsLabel,
  awsPrompt,
  awsSummary,
} from "./connectors/aws";

// A source is a connector instance configured as a data source. Grows into a
// discriminated union as connectors are added.
const SourceSchema = AwsSourceSchema;

export type Source = z.infer<typeof SourceSchema>;

// Each source owns <stateDir>/sources/<type>-<id>/ — config now, that
// source's raw fetched data later.
export function sourcePath(stateDir: string, source: Source): string {
  return join(
    stateDir,
    "sources",
    `${source.type}-${source.accountId}`,
    "source.json",
  );
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

// Each connector defines the prompt, label, and summary for its own sources;
// these only route by the source's type. The switches are exhaustive — a new
// connector in the union fails typecheck until it is wired here.
function connectorPrompt(source: Source): string {
  switch (source.type) {
    case "aws":
      return awsPrompt(source);
  }
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
export function sourcesPrompt(sources: Source[]): string {
  if (sources.length === 0) return "";
  return `Connected sources:\n\n${sources.map(connectorPrompt).join("\n\n")}`;
}

export function formatSourcesDetail(sources: Source[]): string {
  if (sources.length === 0) return "no sources";
  const first = sources[0];
  if (sources.length === 1 && first) return sourceLabel(first);
  return `${sources.length} sources`;
}
