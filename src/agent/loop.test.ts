import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { IndexType } from "@aws-sdk/client-resource-explorer-2";
import { type ModelMessage, ToolLoopAgent } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { saveSource } from "../sources";
import { runGeneration } from "./loop";
import { createTools } from "./tools";

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const streamOf = (parts: LanguageModelV3StreamPart[]) => ({
  stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
    { type: "stream-start", warnings: [] },
    ...parts,
  ]),
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infrawiki-loop-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runGeneration", () => {
  test("tool-loop writes the file, streams, and logs resumable messages", async () => {
    const model = new MockLanguageModelV3({
      doStream: [
        streamOf([
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "write",
            input: JSON.stringify({
              path: "infrawiki/example.md",
              content: "# Example",
            }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: USAGE,
          },
        ]),
        streamOf([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Created an example page." },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: USAGE,
          },
        ]),
      ],
    });

    const { result, logPath } = await runGeneration({
      model,
      cwd: dir,
      instructionsPath: join(dir, "infrawiki/instructions.md"),
      outputPath: join(dir, "infrawiki"),
      stateDir: join(dir, "state"),
    });

    const partTypes: string[] = [];
    for await (const part of result.fullStream) partTypes.push(part.type);
    expect(partTypes).toContain("tool-call");
    expect(partTypes).toContain("tool-result");
    expect(await result.text).toBe("Created an example page.");

    // The real write tool ran against the filesystem.
    expect(readFileSync(join(dir, "infrawiki/example.md"), "utf-8")).toBe(
      "# Example",
    );

    // Log replays as user prompt + per-step response messages.
    const lines = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((l) => l.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(lines[0].content).toContain("example wiki page");
    // No sources connected: the prompt falls back to placeholder infra.
    expect(lines[0].content).toContain("placeholder infrastructure");
  });

  test("connected sources are injected into the prompt", async () => {
    const stateDir = join(dir, "state");
    saveSource(stateDir, {
      type: "aws",
      profile: "dev",
      accountId: "123456789012",
      regions: [{ name: "us-east-1", index: IndexType.AGGREGATOR }],
      addedAt: "2026-08-14T00:00:00.000Z",
    });
    const model = new MockLanguageModelV3({
      doStream: [
        streamOf([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "ok" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: USAGE,
          },
        ]),
      ],
    });
    const { result, logPath } = await runGeneration({
      model,
      cwd: dir,
      instructionsPath: join(dir, "infrawiki/instructions.md"),
      outputPath: join(dir, "infrawiki"),
      stateDir,
    });
    for await (const _ of result.fullStream) {
    }
    const first = JSON.parse(
      readFileSync(logPath, "utf-8").trim().split("\n")[0] as string,
    );
    expect(first.content).toContain("Connected sources:");
    expect(first.content).toContain("AWS account 123456789012");
    expect(first.content).not.toContain("placeholder infrastructure");
  });

  test("run log replays as messages into a fresh agent", async () => {
    const model = new MockLanguageModelV3({
      doStream: [
        streamOf([
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "write",
            input: JSON.stringify({
              path: "infrawiki/example.md",
              content: "# Example",
            }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: USAGE,
          },
        ]),
      ],
    });
    const { result, logPath } = await runGeneration({
      model,
      cwd: dir,
      instructionsPath: join(dir, "infrawiki/instructions.md"),
      outputPath: join(dir, "infrawiki"),
      stateDir: join(dir, "state"),
    });
    // Drain the single step; the run ends interrupted (no final assistant text).
    for await (const _ of result.fullStream) {
    }

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ModelMessage);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

    const resumeModel = new MockLanguageModelV3({
      doStream: [
        streamOf([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Done." },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: USAGE,
          },
        ]),
      ],
    });
    const agent = new ToolLoopAgent({
      model: resumeModel,
      tools: createTools(dir),
    });
    const resumed = await agent.stream({ messages });
    expect(await resumed.text).toBe("Done.");

    // The model saw the full logged history: prompt, tool call, tool result.
    const seen = resumeModel.doStreamCalls[0]?.prompt ?? [];
    expect(seen.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  test("model error is surfaced in the stream; log keeps only messages", async () => {
    const model = new MockLanguageModelV3({
      doStream: [streamOf([{ type: "error", error: new Error("boom") }])],
    });

    const { result, logPath } = await runGeneration({
      model,
      cwd: dir,
      instructionsPath: join(dir, "infrawiki/instructions.md"),
      outputPath: join(dir, "infrawiki"),
      stateDir: join(dir, "state"),
    });

    let sawError = false;
    for await (const part of result.fullStream) {
      if (part.type === "error") sawError = true;
    }
    expect(sawError).toBe(true);

    const lines = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((l) => l.role)).toEqual(["user"]);
  });
});
