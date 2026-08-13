import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function renderApp(config: Config) {
  return render(
    <App
      config={config}
      catalog={Promise.resolve(CATALOG)}
      verify={async () => {}}
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
  stdin.write("\r"); // select gpt-5, verify stub resolves
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

test("full run: model -> output -> instructions -> done", async () => {
  const { frames, lastFrame, stdin } = renderApp(Config.load(projectDir, home));
  await Bun.sleep(TICK);
  await completeModelStep(stdin);
  expect(lastFrame()).toContain("✓ Model");
  expect(lastFrame()).toContain("openai/gpt-5");
  expect(lastFrame()).toContain("Where should the wiki be generated?");
  stdin.write("\r"); // accept default output dir
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("❯ Instructions");
  stdin.write("\r"); // use default instructions
  await Bun.sleep(TICK);
  const done = frames.find((frame) => frame.includes("Wiki initialized"));
  expect(done).toBeDefined();
  expect(done).toContain("✓ Model");
  expect(done).toContain("model openai/gpt-5");
  const reloaded = Config.load(projectDir, home);
  expect(reloaded.initialized).toBe(true);
  expect(reloaded.model).toBe("openai/gpt-5");
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
