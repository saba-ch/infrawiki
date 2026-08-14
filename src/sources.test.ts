import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IndexType } from "@aws-sdk/client-resource-explorer-2";
import {
  formatSourcesDetail,
  listSources,
  type Source,
  saveSource,
  sourcePath,
  sourcesPrompt,
} from "./sources";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-sources-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const source = (patch: Partial<Source> = {}): Source => ({
  type: "aws",
  profile: "dev",
  accountId: "123456789012",
  regions: [{ name: "us-east-1", index: IndexType.LOCAL }],
  addedAt: "2026-08-14T00:00:00.000Z",
  ...patch,
});

test("save then list round-trips", () => {
  saveSource(stateDir, source());
  expect(listSources(stateDir)).toEqual([source()]);
});

test("missing sources dir lists empty", () => {
  expect(listSources(stateDir)).toEqual([]);
});

test("same account overwrites, different account accumulates", () => {
  saveSource(stateDir, source());
  saveSource(stateDir, source({ profile: "dev-sso", regions: [] }));
  saveSource(
    stateDir,
    source({ accountId: "999999999999", addedAt: "2026-08-15T00:00:00.000Z" }),
  );
  const sources = listSources(stateDir);
  expect(sources.map((s) => [s.accountId, s.profile])).toEqual([
    ["123456789012", "dev-sso"],
    ["999999999999", "dev"],
  ]);
});

test("source dir is created private", () => {
  saveSource(stateDir, source());
  const dir = dirname(sourcePath(stateDir, source()));
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("sourcesPrompt assembles per-source blocks", () => {
  expect(sourcesPrompt([])).toBe("");
  const prompt = sourcesPrompt([
    source(),
    source({ accountId: "999999999999", profile: "prod" }),
  ]);
  expect(prompt).toStartWith("Connected sources:");
  expect(prompt).toContain("AWS account 123456789012");
  expect(prompt).toContain("AWS account 999999999999");
  expect(prompt).toContain('profile "prod"');
});

test("formatSourcesDetail", () => {
  expect(formatSourcesDetail([])).toBe("no sources");
  expect(formatSourcesDetail([source()])).toBe("aws · dev (123456789012)");
  expect(
    formatSourcesDetail([source(), source({ accountId: "999999999999" })]),
  ).toBe("2 sources");
});
