import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeAwsApi, devSource as source } from "./connectors/aws.fixtures";
import {
  fetchSource,
  formatSourcesDetail,
  listSources,
  markProcessed,
  readMeta as readMetaOrUndefined,
  saveSource,
  sourceDataDir,
  sourcePath,
  sourcesPrompt,
  syncSources,
} from "./sources";

// Meta is always present where these tests read it; fail loudly otherwise.
function readMeta(dataDir: string) {
  const meta = readMetaOrUndefined(dataDir);
  if (!meta) throw new Error(`no meta.json in ${dataDir}`);
  return meta;
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-sources-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
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
  expect(sourcesPrompt(stateDir, [])).toBe("");
  const prompt = sourcesPrompt(stateDir, [
    source(),
    source({ accountId: "999999999999", profile: "prod" }),
  ]);
  expect(prompt).toStartWith("Connected sources:");
  expect(prompt).toContain("AWS account 123456789012");
  expect(prompt).toContain("AWS account 999999999999");
  expect(prompt).toContain('profile "prod"');
});

test("fetchSource writes a snapshot dir and the meta.json manifest", async () => {
  const s = source();
  const api = fakeAwsApi({
    listResources: async () => [{ Arn: "arn:aws:s3:::bucket" }],
  });
  await fetchSource(api, stateDir, s);
  const dataDir = sourceDataDir(stateDir, s);
  const meta = readMeta(dataDir);
  expect(new Date(meta.fetchedAt).toISOString()).toBe(meta.fetchedAt);
  expect(meta.processed).toBeUndefined();
  expect(
    readFileSync(join(dataDir, meta.latest, "resources.jsonl"), "utf8"),
  ).toBe('{"Arn":"arn:aws:s3:::bucket"}\n');
});

test("snapshots accumulate; processed survives refetch until markProcessed", async () => {
  const s = source();
  saveSource(stateDir, s);
  const dataDir = sourceDataDir(stateDir, s);
  await fetchSource(fakeAwsApi(), stateDir, s);
  const first = readMeta(dataDir).latest;

  markProcessed(stateDir);
  expect(readMeta(dataDir).processed).toBe(first);

  await fetchSource(fakeAwsApi(), stateDir, s);
  const meta = readMeta(dataDir);
  expect(meta.latest).not.toBe(first);
  expect(meta.processed).toBe(first);
  expect(existsSync(join(dataDir, first, "resources.jsonl"))).toBe(true);
  expect(existsSync(join(dataDir, meta.latest, "resources.jsonl"))).toBe(true);

  markProcessed(stateDir);
  expect(readMeta(dataDir).processed).toBe(meta.latest);
});

test("fetchSource failure leaves no meta.json", async () => {
  const s = source();
  const api = fakeAwsApi({
    listResources: async () => {
      throw new Error("boom");
    },
  });
  await expect(fetchSource(api, stateDir, s)).rejects.toThrow("boom");
  expect(existsSync(join(sourceDataDir(stateDir, s), "meta.json"))).toBe(false);
});

test("syncSources fetches in order and reports the first failure", async () => {
  saveSource(stateDir, source());
  saveSource(
    stateDir,
    source({
      accountId: "999999999999",
      profile: "prod",
      addedAt: "2026-08-15T00:00:00.000Z",
    }),
  );
  const progress: string[] = [];
  const ok = await syncSources(fakeAwsApi(), stateDir, {
    onProgress: (label) => progress.push(label),
  });
  expect(ok).toBeUndefined();
  expect(progress).toEqual([
    "aws · dev (123456789012)",
    "aws · prod (999999999999)",
  ]);

  const calls: string[] = [];
  const failing = fakeAwsApi({
    listResources: async (profile) => {
      calls.push(profile);
      throw new Error(
        "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
      );
    },
  });
  const failure = await syncSources(failing, stateDir);
  expect(failure).toEqual({
    label: "aws · dev (123456789012)",
    message: expect.stringContaining("aws sso login"),
  });
  // Stops at the first failing source.
  expect(calls).toEqual(["dev"]);
});

test("syncSources rethrows on abort", async () => {
  saveSource(stateDir, source());
  const controller = new AbortController();
  const api = fakeAwsApi({
    listResources: async () => {
      controller.abort();
      throw new Error("aborted");
    },
  });
  await expect(
    syncSources(api, stateDir, { signal: controller.signal }),
  ).rejects.toThrow("aborted");
});

test("sourcesPrompt points at fetched data once a pull completed", async () => {
  const s = source();
  saveSource(stateDir, s);
  await fetchSource(fakeAwsApi(), stateDir, s);
  const dataDir = sourceDataDir(stateDir, s);
  const prompt = sourcesPrompt(stateDir, [s]);
  expect(prompt).toContain(
    join(dataDir, readMeta(dataDir).latest, "resources.jsonl"),
  );
  expect(prompt).toContain("do not run resource-explorer-2 yourself");
  expect(prompt).not.toContain("aws resource-explorer-2 list-resources");
  // No baseline yet — nothing to diff against.
  expect(prompt).not.toContain("last wiki update");
});

test("sourcesPrompt adds the previous inventory only once a processed baseline differs", async () => {
  const s = source();
  saveSource(stateDir, s);
  const dataDir = sourceDataDir(stateDir, s);
  await fetchSource(fakeAwsApi(), stateDir, s);
  markProcessed(stateDir);
  // Processed === latest: the wiki already documents this snapshot.
  expect(sourcesPrompt(stateDir, [s])).not.toContain("last wiki update");

  await fetchSource(fakeAwsApi(), stateDir, s);
  const meta = readMeta(dataDir);
  const prompt = sourcesPrompt(stateDir, [s]);
  expect(prompt).toContain(
    `The inventory as of the last wiki update is at ${join(dataDir, meta.processed as string, "resources.jsonl")}`,
  );
  expect(prompt).toContain(join(dataDir, meta.latest, "resources.jsonl"));
});

test("legacy pre-snapshot meta.json is treated as no data", () => {
  const s = source();
  saveSource(stateDir, s);
  const dataDir = sourceDataDir(stateDir, s);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "meta.json"),
    '{"fetchedAt":"2026-08-12T00:00:00.000Z"}\n',
  );
  writeFileSync(join(dataDir, "resources.jsonl"), "{}\n");
  const prompt = sourcesPrompt(stateDir, [s]);
  expect(prompt).toContain("aws resource-explorer-2 list-resources");
  expect(prompt).not.toContain("resources.jsonl");
});

test("formatSourcesDetail", () => {
  expect(formatSourcesDetail([])).toBe("no sources");
  expect(formatSourcesDetail([source()])).toBe("aws · dev (123456789012)");
  expect(
    formatSourcesDetail([source(), source({ accountId: "999999999999" })]),
  ).toBe("2 sources");
});
