import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
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

test("fresh project shows the checklist and starts on the output step", async () => {
  const { lastFrame, stdin } = render(
    <App config={Config.load(projectDir, home)} />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("InfraWiki");
  expect(lastFrame()).toContain("❯ Output");
  expect(lastFrame()).toContain("○ Instructions");
  expect(lastFrame()).toContain("Where should the wiki be generated?");

  stdin.write("\r"); // accept default output dir
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("✓ Output");
  expect(lastFrame()).toContain("infrawiki"); // completed answer shown as detail
  expect(lastFrame()).toContain("❯ Instructions");
  expect(lastFrame()).toContain("esc back");
});

test("esc goes back to the previous step", async () => {
  const { lastFrame, stdin } = render(
    <App config={Config.load(projectDir, home)} />,
  );
  await Bun.sleep(TICK);
  stdin.write("\r"); // to instructions
  await Bun.sleep(TICK);
  stdin.write("\x1b"); // esc
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Where should the wiki be generated?");
  expect(lastFrame()).toContain("❯ Output");
});

test("finishing shows the done log without box or esc hint, then exits", async () => {
  const { frames, stdin } = render(
    <App config={Config.load(projectDir, home)} />,
  );
  await Bun.sleep(TICK);
  stdin.write("\r"); // accept default output dir
  await Bun.sleep(TICK);
  stdin.write("\r"); // use this text
  await Bun.sleep(TICK);
  const done = frames.find((frame) => frame.includes("Wiki initialized"));
  expect(done).toBeDefined();
  expect(done).toContain("✓ Output");
  expect(done).toContain("✓ Instructions");
  expect(done).not.toContain("esc back");
  expect(done).not.toContain("╭"); // the prompt box is gone
  expect(Config.load(projectDir, home).initialized).toBe(true);
});

test("unfinished setup offers resume and lands on the checkpointed step", async () => {
  Config.load(projectDir, home).update({
    outputDir: "docs",
    init: { step: "instructions" },
  });
  // Reload from disk to prove the checkpoint actually persisted.
  const { lastFrame, stdin } = render(
    <App config={Config.load(projectDir, home)} />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Found an unfinished setup.");
  stdin.write("\r"); // "Resume where I left off"
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("❯ Instructions");
  expect(lastFrame()).toContain("✓ Output");
  expect(lastFrame()).toContain("docs");
});
