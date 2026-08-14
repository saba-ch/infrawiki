import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { IndexState, IndexType } from "@aws-sdk/client-resource-explorer-2";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { render } from "ink-testing-library";
import type { Catalog } from "../catalog";
import { Config } from "../config";
import type { AwsApi } from "../connectors/aws";
import {
  awsFilesFixture,
  DEV_PROFILE,
  devSource,
  fakeAwsApi,
} from "../connectors/aws.fixtures";
import { listSources, saveSource } from "../sources";
import { App } from "./App";

let projectDir: string;
let home: string;
awsFilesFixture(DEV_PROFILE);

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "infrawiki-tui-"));
  home = mkdtempSync(join(tmpdir(), "infrawiki-home-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// Ink defers a lone ESC briefly to tell it apart from an escape sequence,
// so waits must outlast that delay.
const TICK = 30;

const CATALOG: Catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        tool_call: true,
        structured_output: true,
        release_date: "2025-08-07",
      },
    },
  },
};

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const streamOf = (parts: LanguageModelV3StreamPart[]) => ({
  stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
    { type: "stream-start", warnings: [] },
    ...parts,
  ]),
});

// Scripted generation: one write tool call, then a summary sentence.
function mockGenerationModel() {
  return new MockLanguageModelV3({
    doStream: [
      streamOf([
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "write",
          input: JSON.stringify({
            path: "infrawiki/example.md",
            content: "# Example",
          }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: USAGE,
        },
      ]),
      streamOf([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Created an example page." },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
        },
      ]),
    ],
  });
}

function renderApp(
  config: Config,
  model?: MockLanguageModelV3,
  awsApi?: AwsApi,
) {
  return render(
    <App
      config={config}
      catalog={Promise.resolve(CATALOG)}
      model={model}
      awsApi={awsApi}
    />,
  );
}

// Drives the model step: openai -> API key -> masked key -> pick gpt-5.
async function completeModelStep(stdin: { write: (data: string) => void }) {
  stdin.write("\r"); // openai ranks first
  await Bun.sleep(TICK);
  stdin.write("\x1b[B"); // oauth -> api key
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  stdin.write("sk-test");
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  stdin.write("\r"); // select gpt-5
  await Bun.sleep(TICK);
}

// Skips the sources step: with no sources the list is Add AWS / Continue.
async function completeSourcesStep(stdin: { write: (data: string) => void }) {
  stdin.write("\x1b[B"); // down to Continue
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
}

test("fresh project starts on the model step", async () => {
  const { lastFrame } = renderApp(Config.load(projectDir, home));
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("InfraWiki");
  expect(lastFrame()).toContain("❯ Model");
  expect(lastFrame()).toContain("○ Sources");
  expect(lastFrame()).toContain("○ Output");
  expect(lastFrame()).toContain("○ Instructions");
  expect(lastFrame()).toContain("Which model provider");
});

test("full run without sources initializes but skips generation", async () => {
  const { frames, lastFrame, stdin } = renderApp(
    Config.load(projectDir, home),
    mockGenerationModel(),
  );
  await Bun.sleep(TICK);
  await completeModelStep(stdin);
  expect(lastFrame()).toContain("✓ Model");
  expect(lastFrame()).toContain("openai/gpt-5");
  expect(lastFrame()).toContain("Add AWS");
  await completeSourcesStep(stdin);
  expect(lastFrame()).toContain("✓ Sources");
  expect(lastFrame()).toContain("no sources");
  expect(lastFrame()).toContain("Where should the wiki be generated?");
  stdin.write("\r"); // accept default output dir
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("❯ Instructions");
  stdin.write("\r"); // use default instructions
  await Bun.sleep(TICK * 2);
  const done = frames.find((frame) =>
    frame.includes("Successfully initialized wiki at"),
  );
  expect(done).toBeDefined();
  expect(done).toContain("✓ Model");
  expect(done).toContain("○ Generate");
  expect(done).toContain("no sources connected");
  // No run started: the bundle root only holds the seeded files.
  expect(existsSync(join(projectDir, "infrawiki/index.md"))).toBe(true);
  expect(existsSync(join(projectDir, "infrawiki/example.md"))).toBe(false);
  const reloaded = Config.load(projectDir, home);
  expect(reloaded.initialized).toBe(true);
  expect(reloaded.model).toBe("openai/gpt-5");
});

test("generation error still shows init summary with the failure", async () => {
  const config = Config.load(projectDir, home);
  config.update({ model: "openai/gpt-5", init: { step: "instructions" } });
  saveSource(
    config.stateDir,
    devSource({
      regions: [{ name: "us-east-1", index: IndexType.AGGREGATOR }],
    }),
  );
  const model = new MockLanguageModelV3({
    doStream: [streamOf([{ type: "error", error: new Error("boom") }])],
  });
  const awsApi = fakeAwsApi({
    listResources: async () => [{ Arn: "arn:aws:s3:::bucket" }],
  });
  const { frames, stdin } = renderApp(
    Config.load(projectDir, home),
    model,
    awsApi,
  );
  await Bun.sleep(TICK);
  stdin.write("\r"); // resume at instructions
  await Bun.sleep(TICK);
  stdin.write("\r"); // use default instructions
  await Bun.sleep(TICK * 3);
  const done = frames.find((frame) =>
    frame.includes("Successfully initialized wiki at"),
  );
  expect(done).toBeDefined();
  expect(done).toContain("generation failed: boom");
});

test("esc walks back from output to sources to model", async () => {
  const { lastFrame, stdin } = renderApp(Config.load(projectDir, home));
  await Bun.sleep(TICK);
  await completeModelStep(stdin);
  await completeSourcesStep(stdin);
  expect(lastFrame()).toContain("Where should the wiki be generated?");
  stdin.write("\x1b");
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain("Add AWS");
  stdin.write("\x1b");
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain("Which model provider");
});

test("unfinished setup resumes with model and output details seeded", async () => {
  Config.load(projectDir, home).update({
    outputDir: "docs",
    model: "azure/gpt-5.4",
    init: { step: "instructions" },
  });
  // Reload from disk to prove the checkpoint actually persisted.
  const { lastFrame, stdin } = renderApp(Config.load(projectDir, home));
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Found an unfinished setup.");
  stdin.write("\r"); // "Resume where I left off"
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("❯ Instructions");
  expect(lastFrame()).toContain("✓ Model");
  expect(lastFrame()).toContain("azure/gpt-5.4");
  expect(lastFrame()).toContain("✓ Sources");
  expect(lastFrame()).toContain("no sources");
  expect(lastFrame()).toContain("✓ Output");
  expect(lastFrame()).toContain("docs");
});

test("start over wipes configured sources", async () => {
  const config = Config.load(projectDir, home);
  config.update({ model: "openai/gpt-5", init: { step: "sources" } });
  saveSource(
    config.stateDir,
    devSource({
      regions: [{ name: "us-east-1", index: IndexType.LOCAL }],
    }),
  );
  const { lastFrame, stdin } = renderApp(Config.load(projectDir, home));
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Found an unfinished setup.");
  stdin.write("\x1b[B"); // down to "Start over"
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(listSources(config.stateDir)).toEqual([]);
  expect(lastFrame()).toContain("Which model provider");
});

test("generate syncs configured sources before the run", async () => {
  const config = Config.load(projectDir, home);
  config.update({ model: "openai/gpt-5", init: { step: "instructions" } });
  saveSource(
    config.stateDir,
    devSource({
      regions: [{ name: "us-east-1", index: IndexType.AGGREGATOR }],
    }),
  );
  const awsApi = fakeAwsApi({
    listResources: async () => [{ Arn: "arn:aws:s3:::bucket" }],
  });
  const { frames, stdin } = renderApp(
    Config.load(projectDir, home),
    mockGenerationModel(),
    awsApi,
  );
  await Bun.sleep(TICK);
  stdin.write("\r"); // resume at instructions
  await Bun.sleep(TICK);
  stdin.write("\r"); // use default instructions
  await Bun.sleep(TICK * 3);
  const done = frames.find((frame) =>
    frame.includes("Successfully initialized wiki at"),
  );
  expect(done).toBeDefined();
  expect(done).not.toContain("generation failed");
  expect(
    readFileSync(
      join(
        config.stateDir,
        "sources",
        "aws-123456789012",
        "data",
        "resources.jsonl",
      ),
      "utf8",
    ),
  ).toBe('{"Arn":"arn:aws:s3:::bucket"}\n');
});

test("adding an aws source persists it and checkpoints past sources", async () => {
  const awsApi = fakeAwsApi({
    listIndexes: async () =>
      new Map([["us-east-1", { arn: "arn:idx", type: IndexType.AGGREGATOR }]]),
    getIndex: async () => ({
      arn: "arn:idx",
      type: IndexType.AGGREGATOR,
      state: IndexState.ACTIVE,
    }),
  });
  const { lastFrame, stdin } = renderApp(
    Config.load(projectDir, home),
    undefined,
    awsApi,
  );
  await Bun.sleep(TICK);
  await completeModelStep(stdin);
  stdin.write("\r"); // Add AWS
  await Bun.sleep(TICK);
  stdin.write("\r"); // pick dev
  await Bun.sleep(TICK * 3);
  expect(lastFrame()).toContain("Regions · dev (123456789012)");
  stdin.write("\t"); // select us-east-1
  await Bun.sleep(TICK);
  stdin.write("\r"); // continue back to the sources list
  await Bun.sleep(TICK * 2);
  expect(lastFrame()).toContain("aws · dev (123456789012)");
  expect(lastFrame()).toContain("us-east-1");
  stdin.write("\x1b[B"); // down to Add AWS
  await Bun.sleep(TICK);
  stdin.write("\x1b[B"); // down to Continue
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("✓ Sources");
  expect(lastFrame()).toContain("aws · dev (123456789012)");
  const reloaded = Config.load(projectDir, home);
  expect(reloaded.checkpoint).toEqual({ step: "output-dir" });
  expect(
    existsSync(
      join(reloaded.stateDir, "sources", "aws-123456789012", "source.json"),
    ),
  ).toBe(true);
});
