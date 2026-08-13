import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { render } from "ink-testing-library";
import type { Catalog } from "../catalog";
import { Config } from "../config";
import { App } from "./App";

let projectDir: string;
let home: string;

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

function renderApp(config: Config, model?: MockLanguageModelV3) {
  return render(
    <App config={config} catalog={Promise.resolve(CATALOG)} model={model} />,
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

test("fresh project starts on the model step", async () => {
  const { lastFrame } = renderApp(Config.load(projectDir, home));
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("InfraWiki");
  expect(lastFrame()).toContain("❯ Model");
  expect(lastFrame()).toContain("○ Output");
  expect(lastFrame()).toContain("○ Instructions");
  expect(lastFrame()).toContain("Which model provider");
});

test("full run: model -> output -> instructions -> generate -> done", async () => {
  const { frames, lastFrame, stdin } = renderApp(
    Config.load(projectDir, home),
    mockGenerationModel(),
  );
  await Bun.sleep(TICK);
  await completeModelStep(stdin);
  expect(lastFrame()).toContain("✓ Model");
  expect(lastFrame()).toContain("openai/gpt-5");
  expect(lastFrame()).toContain("Where should the wiki be generated?");
  stdin.write("\r"); // accept default output dir
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("❯ Instructions");
  stdin.write("\r"); // use default instructions
  await Bun.sleep(TICK * 2);
  const generating = frames.find((frame) => frame.includes("❯ Generate"));
  expect(generating).toBeDefined();
  const done = frames.find((frame) =>
    frame.includes("Successfully initialized wiki at"),
  );
  expect(done).toBeDefined();
  expect(done).toContain("✓ Model");
  expect(done).toContain("✓ Generate");
  // The run log persists into the done state, openwiki-style.
  expect(done).toContain("Ran 1 action");
  expect(done).toContain('run "infrawiki update" to update');
  expect(existsSync(join(projectDir, "infrawiki/example.md"))).toBe(true);
  const reloaded = Config.load(projectDir, home);
  expect(reloaded.initialized).toBe(true);
  expect(reloaded.model).toBe("openai/gpt-5");
});

test("generation error still shows init summary with the failure", async () => {
  const model = new MockLanguageModelV3({
    doStream: [streamOf([{ type: "error", error: new Error("boom") }])],
  });
  const { frames, stdin } = renderApp(Config.load(projectDir, home), model);
  await Bun.sleep(TICK);
  await completeModelStep(stdin);
  stdin.write("\r"); // accept default output dir
  await Bun.sleep(TICK);
  stdin.write("\r"); // use default instructions
  await Bun.sleep(TICK * 2);
  const done = frames.find((frame) =>
    frame.includes("Successfully initialized wiki at"),
  );
  expect(done).toBeDefined();
  expect(done).toContain("generation failed: boom");
});

test("esc from the output step returns to the model step", async () => {
  const { lastFrame, stdin } = renderApp(Config.load(projectDir, home));
  await Bun.sleep(TICK);
  await completeModelStep(stdin);
  expect(lastFrame()).toContain("Where should the wiki be generated?");
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
  expect(lastFrame()).toContain("✓ Output");
  expect(lastFrame()).toContain("docs");
});
