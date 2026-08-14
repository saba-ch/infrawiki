import { generateText, type LanguageModelUsage, type ModelMessage } from "ai";
import type { ProviderModel } from "../model";
import { truncateLine } from "./tools/truncate";

const RESERVE_TOKENS = 16384;
const KEEP_RECENT_TOKENS = 20000;
const TOOL_RESULT_MAX_CHARS = 2000;

export function shouldCompact(
  usage: LanguageModelUsage,
  contextWindow: number,
): boolean {
  // inputTokens already includes cache reads; add the step's output since it
  // becomes context for the next step.
  const live =
    usage.inputTokens !== undefined
      ? usage.inputTokens + (usage.outputTokens ?? 0)
      : usage.totalTokens;
  return live !== undefined && live >= contextWindow - RESERVE_TOKENS;
}

export const estimateTokens = (message: ModelMessage) =>
  Math.ceil(JSON.stringify(message).length / 4);

/**
 * Split the live context for compaction: messages[0] (the initial prompt,
 * which carries the connector-injected source paths) is set aside and never
 * summarized; the rest is cut into a head to summarize and a recent tail kept
 * verbatim. The tail never starts with a tool message, so an assistant
 * tool call is never separated from its results. Returns undefined when the
 * head is too small to be worth summarizing.
 */
export function splitForCompaction(
  messages: ModelMessage[],
  keepRecentTokens = KEEP_RECENT_TOKENS,
): { head: ModelMessage[]; tail: ModelMessage[] } | undefined {
  const rest = messages.slice(1);
  let cut = rest.length;
  let kept = 0;
  while (cut > 0) {
    const size = estimateTokens(rest[cut - 1] as ModelMessage);
    if (kept + size > keepRecentTokens && kept > 0) break;
    kept += size;
    cut--;
  }
  while (cut > 0 && rest[cut]?.role === "tool") cut--;
  if (cut < 2) return undefined;
  return { head: rest.slice(0, cut), tail: rest.slice(cut) };
}

const partText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

export function serializeMessages(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const label = message.role === "user" ? "User" : "Assistant";
    if (typeof message.content === "string") {
      lines.push(`[${label}]: ${message.content}`);
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          lines.push(`[${label}]: ${part.text}`);
          break;
        case "tool-call":
          // Inputs can carry whole page bodies (write); cap them like results.
          lines.push(
            `[Tool call]: ${part.toolName}(${truncateLine(partText(part.input), TOOL_RESULT_MAX_CHARS).text})`,
          );
          break;
        case "tool-result": {
          const value =
            "value" in part.output ? part.output.value : part.output;
          lines.push(
            `[Tool result]: ${truncateLine(partText(value), TOOL_RESULT_MAX_CHARS).text}`,
          );
          break;
        }
        default:
          break; // reasoning, files, images add nothing for a checkpoint
      }
    }
  }
  return lines.join("\n");
}

function summaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: `Earlier history was compacted. Checkpoint:\n\n${summary}\n\nContinue the task from here.`,
  };
}

/**
 * The one interpretation of a compaction: rebuild the context as
 * [initial prompt, checkpoint, last `kept` messages]. Used by compact() for
 * the live context and by run-log replay for {type:"compaction"} lines.
 */
export function applyCompaction(
  messages: ModelMessage[],
  summary: string,
  kept: number,
): ModelMessage[] {
  return [
    messages[0] as ModelMessage,
    summaryMessage(summary),
    ...(kept ? messages.slice(-kept) : []),
  ];
}

/**
 * Summarize the older history into a checkpoint and rebuild the context as
 * [initial prompt, checkpoint, ...recent tail]. Returns undefined when there
 * is not enough head to summarize.
 */
export async function compact(opts: {
  model: ProviderModel;
  messages: ModelMessage[];
  contextWindow: number;
}): Promise<
  { messages: ModelMessage[]; summary: string; kept: number } | undefined
> {
  // The tail budget scales down with small windows so compaction still has a
  // head to work with, capped at the default for large ones.
  const split = splitForCompaction(
    opts.messages,
    Math.min(KEEP_RECENT_TOKENS, Math.floor(opts.contextWindow / 4)),
  );
  if (!split) return undefined;

  // On repeat compaction the previous checkpoint message is part of the head,
  // so the summarizer carries it forward without extra plumbing.
  const { text } = await generateText({
    model: opts.model,
    system:
      "You summarize an in-progress agent session so a fresh context can continue it. Reply with only the summary.",
    prompt: `Summarize the conversation below as a checkpoint with sections: Goal, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps, Critical Context. Preserve exact file paths, symbols, commands, and error strings.
<conversation>
${serializeMessages(split.head)}
</conversation>`,
  });

  const kept = split.tail.length;
  return {
    messages: applyCompaction(opts.messages, text, kept),
    summary: text,
    kept,
  };
}
