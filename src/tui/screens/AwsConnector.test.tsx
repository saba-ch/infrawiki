import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexState, IndexType } from "@aws-sdk/client-resource-explorer-2";
import { render } from "ink-testing-library";
import type { AwsApi } from "../../connectors/aws";
import {
  awsFilesFixture,
  DEV_PROFILE,
  devSource,
  fakeAwsApi,
} from "../../connectors/aws.fixtures";
import { listSources, sourcePath } from "../../sources";
import { AwsConnector } from "./AwsConnector";

let stateDir: string;
awsFilesFixture(DEV_PROFILE);

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-state-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const TICK = 30;

// Two regions so tests can hit both an indexed and an index-less row.
const fakeApi = (overrides: Partial<AwsApi> = {}): AwsApi =>
  fakeAwsApi({
    enabledRegions: async () => ["eu-west-1", "us-east-1"],
    ...overrides,
  });

const existing = devSource({ regions: [] });

const noop = () => {};

test("profile pick validates, saves the source, and shows regions", async () => {
  const { lastFrame, stdin } = render(
    <AwsConnector
      onHint={noop}
      api={fakeApi()}
      stateDir={stateDir}
      onExit={noop}
    />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Pick an AWS profile");
  expect(lastFrame()).toContain("dev");
  stdin.write("\r");
  await Bun.sleep(TICK * 2);
  expect(listSources(stateDir).map((s) => [s.profile, s.accountId])).toEqual([
    ["dev", "123456789012"],
  ]);
  expect(existsSync(sourcePath(stateDir, existing))).toBe(true);
  expect(lastFrame()).toContain("Regions · dev (123456789012)");
  expect(lastFrame()).toContain("eu-west-1");
  expect(lastFrame()).toContain("no index · → enable");
  expect(lastFrame()).toContain("local index");
});

test("auth failure shows the error and retry recovers", async () => {
  let calls = 0;
  const api = fakeApi({
    callerIdentity: async () => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(
          new Error(
            "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
          ),
          { name: "CredentialsProviderError" },
        );
      return { accountId: "123456789012", arn: "arn" };
    },
  });
  const { lastFrame, stdin } = render(
    <AwsConnector onHint={noop} api={api} stateDir={stateDir} onExit={noop} />,
  );
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain("Token is expired");
  stdin.write("\r"); // Retry
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain("Regions · dev (123456789012)");
});

test("tab toggles a region; enter continues only once something is selected", async () => {
  let exited = false;
  const { lastFrame, stdin } = render(
    <AwsConnector
      onHint={noop}
      api={fakeApi()}
      stateDir={stateDir}
      existing={existing}
      onExit={() => {
        exited = true;
      }}
    />,
  );
  await Bun.sleep(TICK * 2);
  stdin.write("\r"); // nothing selected yet
  await Bun.sleep(TICK);
  expect(exited).toBe(false);
  expect(lastFrame()).toContain("select at least one region first");
  stdin.write("us-east-1"); // filter to the indexed row
  await Bun.sleep(TICK);
  stdin.write("\t"); // toggle on
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("✓ selected");
  expect(listSources(stateDir)[0]?.regions).toEqual([
    { name: "us-east-1", index: IndexType.LOCAL },
  ]);
  stdin.write("\t"); // toggle off
  await Bun.sleep(TICK);
  expect(lastFrame()).not.toContain("✓ selected");
  expect(listSources(stateDir)[0]?.regions).toEqual([]);
  stdin.write("\t"); // back on, then continue
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(exited).toBe(true);
});

test("right arrow enables an index-less region and polling lands it", async () => {
  let created = false;
  const api = fakeApi({
    listIndexes: async () => new Map(),
    createIndex: async () => {
      created = true;
    },
    getIndex: async () => ({
      arn: "arn:new",
      type: IndexType.LOCAL,
      state: IndexState.ACTIVE,
    }),
  });
  const { lastFrame, stdin } = render(
    <AwsConnector
      onHint={noop}
      api={api}
      stateDir={stateDir}
      existing={existing}
      onExit={noop}
      pollMs={50}
    />,
  );
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain("no index · → enable");
  stdin.write("\x1b[C"); // right arrow on eu-west-1 -> action menu
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Create index");
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(created).toBe(true);
  expect(lastFrame()).toContain("creating…");
  await Bun.sleep(100); // poll tick
  expect(lastFrame()).toContain("local index");
});

test("right arrow opens promote; conflict restores and explains", async () => {
  const api = fakeApi({
    promoteIndex: async () => {
      throw Object.assign(new Error("conflict"), { name: "ConflictException" });
    },
  });
  const { lastFrame, stdin } = render(
    <AwsConnector
      onHint={noop}
      api={api}
      stateDir={stateDir}
      existing={existing}
      onExit={noop}
      pollMs={50}
    />,
  );
  await Bun.sleep(TICK * 2);
  stdin.write("us-east-1"); // filter to the indexed row
  await Bun.sleep(TICK);
  stdin.write("\x1b[C");
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Make aggregator");
  stdin.write("\r");
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain(
    "another region is already the aggregator — demote it first",
  );
  expect(lastFrame()).toContain("local index");
});

test("esc exits from regions; the source stays saved", async () => {
  let exited = false;
  const { stdin } = render(
    <AwsConnector
      onHint={noop}
      api={fakeApi()}
      stateDir={stateDir}
      existing={existing}
      onExit={() => {
        exited = true;
      }}
    />,
  );
  await Bun.sleep(TICK * 2);
  stdin.write("\x1b");
  await Bun.sleep(TICK * 2);
  expect(exited).toBe(true);
});
