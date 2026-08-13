import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { editTool } from "./edit";

const OPTS = { toolCallId: "test", messages: [], context: {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infrawiki-edit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (input: {
  path: string;
  edits: { oldText: string; newText: string }[];
}) => editTool(dir).execute?.(input, OPTS) as Promise<string>;

const file = (name: string) => join(dir, name);
const content = (name: string) => readFileSync(file(name), "utf-8");

describe("edit", () => {
  test("exact single replacement", async () => {
    writeFileSync(file("a.md"), "hello world\ngoodbye world");
    const result = await run({
      path: "a.md",
      edits: [{ oldText: "hello world", newText: "hi world" }],
    });
    expect(result).toBe("Successfully replaced 1 block(s) in a.md.");
    expect(content("a.md")).toBe("hi world\ngoodbye world");
  });

  test("fuzzy match via smart quotes and trailing whitespace", async () => {
    writeFileSync(file("a.md"), "it’s “quoted”  \nnext");
    await run({
      path: "a.md",
      edits: [{ oldText: `it's "quoted"`, newText: "plain" }],
    });
    expect(content("a.md")).toBe("plain\nnext");
  });

  test("multiple disjoint edits apply against the original file", async () => {
    writeFileSync(file("a.md"), "one two three four");
    await run({
      path: "a.md",
      edits: [
        { oldText: "four", newText: "FOUR" },
        { oldText: "one", newText: "ONE" },
      ],
    });
    expect(content("a.md")).toBe("ONE two three FOUR");
  });

  test("CRLF files keep CRLF endings", async () => {
    writeFileSync(file("a.md"), "line1\r\nline2\r\n");
    await run({
      path: "a.md",
      edits: [{ oldText: "line2", newText: "LINE2" }],
    });
    expect(content("a.md")).toBe("line1\r\nLINE2\r\n");
  });

  test("BOM is preserved", async () => {
    writeFileSync(file("a.md"), "﻿hello");
    await run({ path: "a.md", edits: [{ oldText: "hello", newText: "hi" }] });
    expect(content("a.md")).toBe("﻿hi");
  });

  test("edits sent as a JSON string are coerced by the input schema", async () => {
    // The SDK validates tool input against inputSchema before execute; parse
    // through the schema here the same way to exercise the coercion.
    writeFileSync(file("a.md"), "hello");
    const tool = editTool(dir);
    const schema = tool.inputSchema as z.ZodType<{
      path: string;
      edits: { oldText: string; newText: string }[];
    }>;
    const input = schema.parse({
      path: "a.md",
      edits: JSON.stringify([{ oldText: "hello", newText: "hi" }]),
    });
    expect(await (tool.execute?.(input, OPTS) as Promise<string>)).toBe(
      "Successfully replaced 1 block(s) in a.md.",
    );
    expect(content("a.md")).toBe("hi");
  });

  test("not-found error names the failing edit", async () => {
    writeFileSync(file("a.md"), "hello");
    expect(
      run({
        path: "a.md",
        edits: [
          { oldText: "hello", newText: "hi" },
          { oldText: "missing", newText: "x" },
        ],
      }),
    ).rejects.toThrow(
      "Could not find edits[1] in a.md. The oldText must match exactly including all whitespace and newlines.",
    );
  });

  test("ambiguous text errors with occurrence count", async () => {
    writeFileSync(file("a.md"), "dup\ndup");
    expect(
      run({ path: "a.md", edits: [{ oldText: "dup", newText: "x" }] }),
    ).rejects.toThrow(
      "Found 2 occurrences of the text in a.md. The text must be unique. Please provide more context to make it unique.",
    );
  });

  test("empty oldText errors", async () => {
    writeFileSync(file("a.md"), "hello");
    expect(
      run({ path: "a.md", edits: [{ oldText: "", newText: "x" }] }),
    ).rejects.toThrow("oldText must not be empty in a.md.");
  });

  test("overlapping edits error", async () => {
    writeFileSync(file("a.md"), "abcdef");
    expect(
      run({
        path: "a.md",
        edits: [
          { oldText: "abcd", newText: "x" },
          { oldText: "cdef", newText: "y" },
        ],
      }),
    ).rejects.toThrow(
      "edits[0] and edits[1] overlap in a.md. Merge them into one edit or target disjoint regions.",
    );
  });

  test("identical replacement errors", async () => {
    writeFileSync(file("a.md"), "same");
    expect(
      run({ path: "a.md", edits: [{ oldText: "same", newText: "same" }] }),
    ).rejects.toThrow(
      "No changes made to a.md. The replacement produced identical content.",
    );
  });

  test("missing file errors with code", async () => {
    expect(
      run({ path: "nope.md", edits: [{ oldText: "a", newText: "b" }] }),
    ).rejects.toThrow("Could not edit file: nope.md. Error code: ENOENT.");
  });
});
