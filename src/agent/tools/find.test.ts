import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "./find";

const OPTS = { toolCallId: "test", messages: [], context: {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infrawiki-find-"));
  // An empty .git dir makes rg apply .gitignore semantics without running git.
  mkdirSync(join(dir, ".git"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (input: { pattern: string; path?: string; limit?: number }) =>
  findTool(dir).execute?.(input, OPTS) as Promise<string>;

describe("find", () => {
  test("'*.md' matches at any depth", async () => {
    mkdirSync(join(dir, "docs/deep"), { recursive: true });
    writeFileSync(join(dir, "top.md"), "");
    writeFileSync(join(dir, "docs/deep/nested.md"), "");
    writeFileSync(join(dir, "docs/other.txt"), "");
    expect(await run({ pattern: "*.md" })).toBe("docs/deep/nested.md\ntop.md");
  });

  test("anchored 'src/**/*.ts' matches only under src", async () => {
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "src/lib/a.ts"), "");
    writeFileSync(join(dir, "other/b.ts"), "");
    expect(await run({ pattern: "src/**/*.ts" })).toBe("src/lib/a.ts");
  });

  test("respects .gitignore and excludes .git contents", async () => {
    writeFileSync(join(dir, ".gitignore"), "dist/\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/out.md"), "");
    writeFileSync(join(dir, ".git/config.md"), "");
    writeFileSync(join(dir, "kept.md"), "");
    expect(await run({ pattern: "*.md" })).toBe("kept.md");
  });

  test("no matches", async () => {
    expect(await run({ pattern: "*.xyz" })).toBe("No files found");
  });

  test("result limit appends notice", async () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `f${i}.md`), "");
    const output = await run({ pattern: "*.md", limit: 4 });
    expect(output).toEndWith(
      "[4 results limit reached. Use limit=8 for more, or refine pattern]",
    );
    expect(output.split("\n").filter((l) => l.endsWith(".md")).length).toBe(4);
  });

  test("missing search path errors", async () => {
    expect(run({ pattern: "*", path: "nope" })).rejects.toThrow(
      "Path not found:",
    );
  });
});
