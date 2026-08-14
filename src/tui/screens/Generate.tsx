import { Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { runGeneration } from "../../agent/loop";
import { useSpinner } from "../components/useSpinner";

interface Props {
  start: (signal: AbortSignal) => ReturnType<typeof runGeneration>;
  done: boolean;
  onDone: (outcome: { error?: string }) => void;
}

export const GENERATE_HINT = "esc cancel";

const DETAIL_CHARS = 60;

function toolCallDetail(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const args = input as Record<string, unknown>;
  const detail = args.command ?? args.pattern ?? args.path ?? "";
  return String(detail).replace(/\n/g, " ").slice(0, DETAIL_CHARS);
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function Generate({ start, done, onDone }: Props) {
  const [actions, setActions] = useState({
    count: 0,
    failures: 0,
    current: "",
  });
  const spinner = useSpinner(!done);
  const controllerRef = useRef(new AbortController());

  useInput((_input, key) => {
    if (key.escape) controllerRef.current.abort();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the run starts once on mount; start/onDone are stable closures from App
  useEffect(() => {
    const controller = controllerRef.current;
    (async () => {
      try {
        const { result } = await start(controller.signal);
        let error: string | undefined;
        for await (const part of result.fullStream) {
          if (part.type === "tool-call") {
            const current = `${part.toolName} ${toolCallDetail(part.input)}`;
            setActions((a) => ({ ...a, count: a.count + 1, current }));
          } else if (part.type === "tool-error") {
            setActions((a) => ({ ...a, failures: a.failures + 1 }));
          } else if (part.type === "error") {
            error =
              part.error instanceof Error
                ? part.error.message
                : String(part.error);
          } else if (part.type === "abort") {
            error = "cancelled";
          }
        }
        onDone({ error });
      } catch (err) {
        onDone({
          error: controller.signal.aborted
            ? "cancelled"
            : err instanceof Error
              ? err.message
              : String(err),
        });
      }
    })();
    return () => controller.abort();
  }, []);

  const { count, failures, current } = actions;
  if (count === 0) {
    return done ? null : <Text color="gray">Waiting for model output...</Text>;
  }
  if (!done) {
    return (
      <Text color="cyan">
        {spinner} Running {formatCount(count, "action", "actions")}: {current}
      </Text>
    );
  }
  if (failures > 0) {
    return (
      <Text bold color="red">
        !! Ran {formatCount(count, "action", "actions")} with{" "}
        {formatCount(failures, "failure", "failures")}
      </Text>
    );
  }
  return (
    <Text>
      <Text color="green">* </Text>
      <Text color="gray">Ran {formatCount(count, "action", "actions")}</Text>
    </Text>
  );
}
