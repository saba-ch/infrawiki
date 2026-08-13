import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTool } from "./write";

const OPTS = { toolCallId: "test", messages: [], context: {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infrawiki-write-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (input: { path: string; content: string }) =>
  writeTool(dir).execute?.(input, OPTS) as Promise<string>;

describe("write", () => {
  test("creates parent directories and reports bytes", async () => {
    const result = await run({ path: "docs/deep/page.md", content: "# Hi" });
    expect(result).toBe("Successfully wrote 4 bytes to docs/deep/page.md");
    expect(readFileSync(join(dir, "docs/deep/page.md"), "utf-8")).toBe("# Hi");
  });

  test("overwrites existing content", async () => {
    await run({ path: "a.md", content: "old" });
    await run({ path: "a.md", content: "new" });
    expect(readFileSync(join(dir, "a.md"), "utf-8")).toBe("new");
  });

  test("aborted signal rejects before writing", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = writeTool(dir).execute?.(
      { path: "a.md", content: "x" },
      { ...OPTS, abortSignal: controller.signal },
    ) as Promise<string>;
    expect(promise).rejects.toThrow("Operation aborted");
  });
});
