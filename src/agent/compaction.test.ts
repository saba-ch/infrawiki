import { describe, expect, test } from "bun:test";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  compact,
  estimateTokens,
  serializeMessages,
  shouldCompact,
  splitForCompaction,
} from "./compaction";

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const assistant = (text: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolCall = (id: string, input: object): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input }],
});
const toolResult = (id: string, value: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read",
      output: { type: "text", value },
    },
  ],
});

const usage = (u: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): LanguageModelUsage => ({
  inputTokens: u.inputTokens,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokens: u.outputTokens,
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens: u.totalTokens,
});

describe("shouldCompact", () => {
  // Fixed reserve is 16384, so a 20000 window compacts at 3616 live tokens.
  const contextWindow = 20000;

  test("fires at the threshold, not below it", () => {
    const at = usage({ inputTokens: 3516, outputTokens: 100 });
    const below = usage({ inputTokens: 3515, outputTokens: 100 });
    expect(shouldCompact(at, contextWindow)).toBe(true);
    expect(shouldCompact(below, contextWindow)).toBe(false);
  });

  test("falls back to totalTokens when inputTokens is missing", () => {
    expect(shouldCompact(usage({ totalTokens: 9000 }), contextWindow)).toBe(
      true,
    );
    expect(shouldCompact(usage({ totalTokens: 3000 }), contextWindow)).toBe(
      false,
    );
    expect(shouldCompact(usage({}), contextWindow)).toBe(false);
  });
});

describe("splitForCompaction", () => {
  test("excludes the initial prompt and keeps a tail within budget", () => {
    const messages = [
      user("initial prompt"),
      assistant("a1"),
      assistant("a2"),
      assistant("a3"),
      assistant("a4"),
    ];
    // Budget fits roughly one small message.
    const split = splitForCompaction(messages, 20);
    expect(split).toBeDefined();
    expect(split?.head[0]).toEqual(assistant("a1"));
    expect([...(split?.head ?? []), ...(split?.tail ?? [])]).not.toContainEqual(
      user("initial prompt"),
    );
    expect(split?.tail.at(-1)).toEqual(assistant("a4"));
    expect((split?.head.length ?? 0) >= 2).toBe(true);
  });

  test("tail never starts with a tool result", () => {
    const result = toolResult("c1", "big".repeat(150));
    const done = assistant("done");
    const messages = [
      user("initial prompt"),
      assistant("a1"),
      assistant("a2"),
      toolCall("c1", { path: "x" }),
      result,
      done,
    ];
    // Budget admits the tool result but not its tool call, so the naive cut
    // lands on the tool result and must move back to the call.
    const split = splitForCompaction(
      messages,
      estimateTokens(result) + estimateTokens(done),
    );
    expect(split).toBeDefined();
    expect(split?.tail[0]?.role).not.toBe("tool");
    expect(split?.tail.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  test("returns undefined when the head is too small", () => {
    const messages = [user("initial prompt"), assistant("a1"), assistant("a2")];
    expect(splitForCompaction(messages, 5)).toBeUndefined();
  });
});

describe("serializeMessages", () => {
  test("labels roles and truncates long tool results", () => {
    const text = serializeMessages([
      user("do the thing"),
      toolCall("c1", { path: "src/x.ts" }),
      toolResult("c1", "x".repeat(3000)),
      assistant("did the thing"),
    ]);
    expect(text).toContain("[User]: do the thing");
    expect(text).toContain('[Tool call]: read({"path":"src/x.ts"})');
    expect(text).toContain("[Tool result]: ");
    expect(text).toContain("... [truncated]");
    expect(text).not.toContain("x".repeat(2001));
    expect(text).toContain("[Assistant]: did the thing");
  });
});

describe("compact", () => {
  const generated = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  });

  // The big tool result overflows the default keep-recent budget, forcing the
  // cut right after it: head = [tool call, tool result], tail = the rest.
  const messages = [
    user("initial prompt with source paths"),
    toolCall("c1", { path: "old.ts" }),
    toolResult("c1", `old file body ${"x".repeat(90000)}`),
    assistant("read the old file"),
    assistant("recent progress"),
  ];

  test("rebuilds [initial prompt, checkpoint, tail]", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => generated("## Goal\nDocument the infra"),
    });
    const result = await compact({ model, messages, contextWindow: 80000 });
    expect(result).toBeDefined();
    expect(result?.summary).toBe("## Goal\nDocument the infra");
    expect(result?.kept).toBe(2);
    expect(result?.messages[0]).toEqual(
      user("initial prompt with source paths"),
    );
    expect(result?.messages[1]?.role).toBe("user");
    expect(JSON.stringify(result?.messages[1])).toContain(
      "Earlier history was compacted",
    );
    expect(result?.messages.slice(2)).toEqual([
      assistant("read the old file"),
      assistant("recent progress"),
    ]);

    // The summarizer saw the serialized head, not the tail.
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("[Tool call]: read(");
    expect(prompt).toContain("old file body");
    expect(prompt).not.toContain("recent progress");
  });

  test("returns undefined when there is nothing to summarize", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => generated("unused"),
    });
    const result = await compact({
      model,
      messages: [user("initial"), assistant("a1"), assistant("a2")],
      contextWindow: 80000,
    });
    expect(result).toBeUndefined();
    expect(model.doGenerateCalls.length).toBe(0);
  });
});
