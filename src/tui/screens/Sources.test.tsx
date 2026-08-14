import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexType } from "@aws-sdk/client-resource-explorer-2";
import { render } from "ink-testing-library";
import {
  awsFilesFixture,
  DEV_PROFILE,
  fakeAwsApi,
} from "../../connectors/aws.fixtures";
import { type Source, saveSource } from "../../sources";
import { Sources } from "./Sources";

let stateDir: string;
awsFilesFixture(DEV_PROFILE);

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-state-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const TICK = 30;

const source = (patch: Partial<Source> = {}): Source => ({
  type: "aws",
  profile: "dev",
  accountId: "123456789012",
  regions: [],
  addedAt: "2026-08-14T00:00:00.000Z",
  ...patch,
});

const noop = () => {};

test("empty state continues with no sources", async () => {
  let detail: string | undefined;
  const { lastFrame, stdin } = render(
    <Sources
      onHint={noop}
      stateDir={stateDir}
      api={fakeAwsApi()}
      onContinue={(d) => {
        detail = d;
      }}
      onBack={noop}
    />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Add AWS");
  expect(lastFrame()).toContain("Continue");
  stdin.write("\x1b[B"); // down to Continue
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(detail).toBe("no sources");
});

test("source without selected regions warns", async () => {
  saveSource(stateDir, source());
  let continued = false;
  const { lastFrame, stdin } = render(
    <Sources
      onHint={noop}
      stateDir={stateDir}
      api={fakeAwsApi()}
      onContinue={() => {
        continued = true;
      }}
      onBack={noop}
    />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("aws · dev (123456789012)");
  expect(lastFrame()).toContain("⚠ no regions selected");
  stdin.write("\x1b[B\x1b[B"); // down to Continue
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(continued).toBe(false);
  expect(lastFrame()).toContain(
    "select at least one region for aws · dev (123456789012)",
  );
});

test("selected regions show with their index type", async () => {
  saveSource(
    stateDir,
    source({
      regions: [
        { name: "eu-west-1", index: IndexType.LOCAL },
        { name: "us-east-1", index: IndexType.AGGREGATOR },
      ],
    }),
  );
  const { lastFrame } = render(
    <Sources
      onHint={noop}
      stateDir={stateDir}
      api={fakeAwsApi()}
      onContinue={noop}
      onBack={noop}
    />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("eu-west-1 (local), us-east-1 (aggregator)");
  expect(lastFrame()).not.toContain("⚠");
});

test("add aws flows through and toggling a region reflects on the list", async () => {
  const { lastFrame, stdin } = render(
    <Sources
      onHint={noop}
      stateDir={stateDir}
      api={fakeAwsApi()}
      onContinue={noop}
      onBack={noop}
    />,
  );
  await Bun.sleep(TICK);
  stdin.write("\r"); // Add AWS
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Pick an AWS profile");
  stdin.write("\r"); // dev
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain("Regions · dev (123456789012)");
  stdin.write("\t"); // toggle us-east-1 (only region)
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("✓ selected");
  stdin.write("\r"); // continue back to the list
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain("aws · dev (123456789012)");
  expect(lastFrame()).toContain("us-east-1");
  expect(lastFrame()).not.toContain("⚠");
});

test("esc on the list goes back", async () => {
  let back = false;
  const { stdin } = render(
    <Sources
      onHint={noop}
      stateDir={stateDir}
      api={fakeAwsApi()}
      onContinue={noop}
      onBack={() => {
        back = true;
      }}
    />,
  );
  await Bun.sleep(TICK);
  stdin.write("\x1b");
  await Bun.sleep(TICK * 2);
  expect(back).toBe(true);
});
