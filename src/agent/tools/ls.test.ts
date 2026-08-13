import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lsTool } from "./ls";

const OPTS = { toolCallId: "test", messages: [], context: {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infrawiki-ls-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (input: { path?: string; limit?: number }) =>
  lsTool(dir).execute?.(input, OPTS) as Promise<string>;

describe("ls", () => {
  test("sorts case-insensitively and suffixes directories", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "B.txt"), "");
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, ".hidden"), "");
    expect(await run({})).toBe(".hidden\na.txt\nB.txt\nsub/");
  });

  test("empty directory", async () => {
    expect(await run({})).toBe("(empty directory)");
  });

  test("entry limit appends notice", async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), "");
    expect(await run({ limit: 3 })).toBe(
      "f0.txt\nf1.txt\nf2.txt\n\n[3 entries limit reached. Use limit=6 for more]",
    );
  });

  test("missing path errors", async () => {
    expect(run({ path: "nope" })).rejects.toThrow("Path not found:");
  });

  test("file path errors as not a directory", async () => {
    writeFileSync(join(dir, "f.txt"), "");
    expect(run({ path: "f.txt" })).rejects.toThrow("Not a directory:");
  });
});
