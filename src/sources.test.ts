import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeAwsApi, devSource as source } from "./connectors/aws.fixtures";
import {
  fetchSource,
  formatSourcesDetail,
  listSources,
  saveSource,
  sourceDataDir,
  sourcePath,
  sourcesPrompt,
  syncSources,
} from "./sources";

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

test("fetchSource writes resources.jsonl and meta.json under data/", async () => {
  const s = source();
  const api = fakeAwsApi({
    listResources: async () => [{ Arn: "arn:aws:s3:::bucket" }],
  });
  await fetchSource(api, stateDir, s);
  const dataDir = sourceDataDir(stateDir, s);
  expect(readFileSync(join(dataDir, "resources.jsonl"), "utf8")).toBe(
    '{"Arn":"arn:aws:s3:::bucket"}\n',
  );
  const meta = JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8"));
  expect(new Date(meta.fetchedAt).toISOString()).toBe(meta.fetchedAt);
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
  const prompt = sourcesPrompt(stateDir, [s]);
  expect(prompt).toContain(join(sourceDataDir(stateDir, s), "resources.jsonl"));
  expect(prompt).toContain("do not run resource-explorer-2 yourself");
  expect(prompt).not.toContain("aws resource-explorer-2 list-resources");
});

test("formatSourcesDetail", () => {
  expect(formatSourcesDetail([])).toBe("no sources");
  expect(formatSourcesDetail([source()])).toBe("aws · dev (123456789012)");
  expect(
    formatSourcesDetail([source(), source({ accountId: "999999999999" })]),
  ).toBe("2 sources");
});
