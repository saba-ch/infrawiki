import { describe, expect, test } from "bun:test";
import { truncateHead, truncateLine, truncateTail } from "./truncate";

describe("truncateHead", () => {
  test("returns content unchanged when under limits", () => {
    const result = truncateHead("a\nb\nc");
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("a\nb\nc");
    expect(result.totalLines).toBe(3);
  });

  test("trailing newline does not count as an extra line", () => {
    expect(truncateHead("a\nb\n").totalLines).toBe(2);
  });

  test("keeps first N lines when line limit hit", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const result = truncateHead(content, { maxLines: 3 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.content).toBe("line0\nline1\nline2");
    expect(result.totalLines).toBe(10);
  });

  test("keeps complete lines only when byte limit hit", () => {
    const result = truncateHead("aaaa\nbbbb\ncccc", { maxBytes: 11 });
    expect(result.truncatedBy).toBe("bytes");
    expect(result.content).toBe("aaaa\nbbbb");
    expect(result.outputLines).toBe(2);
  });

  test("first line exceeding byte limit returns empty content", () => {
    const result = truncateHead("x".repeat(100), { maxBytes: 10 });
    expect(result.firstLineExceedsLimit).toBe(true);
    expect(result.content).toBe("");
    expect(result.outputLines).toBe(0);
  });
});

describe("truncateTail", () => {
  test("keeps last N lines when line limit hit", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const result = truncateTail(content, { maxLines: 2 });
    expect(result.truncatedBy).toBe("lines");
    expect(result.content).toBe("line8\nline9");
  });

  test("keeps complete tail lines when byte limit hit", () => {
    const result = truncateTail("aaaa\nbbbb\ncccc", { maxBytes: 11 });
    expect(result.truncatedBy).toBe("bytes");
    expect(result.content).toBe("bbbb\ncccc");
  });

  test("oversized last line is kept partially from the end", () => {
    const result = truncateTail(`short\n${"x".repeat(100)}`, { maxBytes: 10 });
    expect(result.lastLinePartial).toBe(true);
    expect(result.content).toBe("x".repeat(10));
  });

  test("partial cut lands on a UTF-8 character boundary", () => {
    const result = truncateTail("é".repeat(100), { maxBytes: 5 });
    expect(result.lastLinePartial).toBe(true);
    // é is 2 bytes; 5 bytes can hold at most 2 whole characters
    expect(result.content).toBe("éé");
  });
});

describe("truncateLine", () => {
  test("short line passes through", () => {
    expect(truncateLine("abc", 10)).toEqual({
      text: "abc",
      wasTruncated: false,
    });
  });

  test("long line gets suffix", () => {
    const result = truncateLine("abcdef", 3);
    expect(result.wasTruncated).toBe(true);
    expect(result.text).toBe("abc... [truncated]");
  });
});
