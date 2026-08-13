import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "./grep";

const OPTS = { toolCallId: "test", messages: [], context: {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infrawiki-grep-"));
  // An empty .git dir makes rg apply .gitignore semantics without running git.
  mkdirSync(join(dir, ".git"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (input: {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}) => grepTool(dir).execute?.(input, OPTS) as Promise<string>;

describe("grep", () => {
  test("returns matches with path and line number", async () => {
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma");
    writeFileSync(join(dir, "b.txt"), "beta only");
    const output = await run({ pattern: "beta" });
    const lines = output.split("\n").sort();
    expect(lines).toEqual(["a.txt:2: beta", "b.txt:1: beta only"]);
  });

  test("no matches", async () => {
    writeFileSync(join(dir, "a.txt"), "alpha");
    expect(await run({ pattern: "zeta" })).toBe("No matches found");
  });

  test("respects .gitignore", async () => {
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "ignored.txt"), "needle");
    writeFileSync(join(dir, "kept.txt"), "needle");
    expect(await run({ pattern: "needle" })).toBe("kept.txt:1: needle");
  });

  test("match limit kills rg and appends notice", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `needle ${i}`).join(
      "\n",
    );
    writeFileSync(join(dir, "a.txt"), lines);
    const output = await run({ pattern: "needle", limit: 5 });
    expect(output).toEndWith(
      "[5 matches limit reached. Use limit=10 for more, or refine pattern]",
    );
    expect(output.split("\n").filter((l) => l.includes("needle")).length).toBe(
      5,
    );
  });

  test("context lines use - separators around the match", async () => {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive");
    expect(await run({ pattern: "three", context: 1 })).toBe(
      "a.txt-2- two\na.txt:3: three\na.txt-4- four",
    );
  });

  test("long lines are truncated with notice", async () => {
    writeFileSync(join(dir, "a.txt"), `needle ${"x".repeat(600)}`);
    const output = await run({ pattern: "needle" });
    expect(output).toContain("... [truncated]");
    expect(output).toEndWith(
      "[Some lines truncated to 500 chars. Use read tool to see full lines]",
    );
  });

  test("glob filters files", async () => {
    writeFileSync(join(dir, "a.md"), "needle");
    writeFileSync(join(dir, "a.txt"), "needle");
    expect(await run({ pattern: "needle", glob: "*.md" })).toBe(
      "a.md:1: needle",
    );
  });

  test("literal disables regex", async () => {
    writeFileSync(join(dir, "a.txt"), "a.b\naxb");
    expect(await run({ pattern: "a.b", literal: true })).toBe("a.txt:1: a.b");
  });

  test("missing search path errors", async () => {
    expect(run({ pattern: "x", path: "nope" })).rejects.toThrow(
      "Path not found:",
    );
  });
});
