import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "./read";

const OPTS = { toolCallId: "test", messages: [], context: {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infrawiki-read-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (input: { path: string; offset?: number; limit?: number }) =>
  readTool(dir).execute?.(input, OPTS) as Promise<string>;

describe("read", () => {
  test("reads a file relative to cwd", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\nworld");
    expect(await run({ path: "a.txt" })).toBe("hello\nworld");
  });

  test("missing file rejects", async () => {
    expect(run({ path: "nope.txt" })).rejects.toThrow();
  });

  test("offset beyond end of file throws with line count", async () => {
    writeFileSync(join(dir, "a.txt"), "one\ntwo");
    expect(run({ path: "a.txt", offset: 10 })).rejects.toThrow(
      "Offset 10 is beyond end of file (2 lines total)",
    );
  });

  test("user limit with remaining content appends continuation notice", async () => {
    writeFileSync(join(dir, "a.txt"), "l1\nl2\nl3\nl4\nl5");
    expect(await run({ path: "a.txt", offset: 2, limit: 2 })).toBe(
      "l2\nl3\n\n[2 more lines in file. Use offset=4 to continue.]",
    );
  });

  test("line-limit truncation appends offset notice", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`);
    writeFileSync(join(dir, "big.txt"), lines.join("\n"));
    const output = await run({ path: "big.txt" });
    expect(output).toEndWith(
      "[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]",
    );
    expect(output).toStartWith("line1\n");
  });

  test("oversized single line points at bash fallback", async () => {
    writeFileSync(join(dir, "wide.txt"), "x".repeat(60 * 1024));
    expect(await run({ path: "wide.txt" })).toBe(
      "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' wide.txt | head -c 51200]",
    );
  });
});
