import { Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { runGeneration } from "../../agent/loop";
import type { SyncFailure } from "../../sources";
import { useSpinner } from "../components/useSpinner";

interface Props {
  sync: (
    signal: AbortSignal,
    onProgress: (label: string) => void,
  ) => Promise<SyncFailure | undefined>;
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

export function Generate({ sync, start, done, onDone }: Props) {
  const [actions, setActions] = useState({
    count: 0,
    current: "",
  });
  // A source sync failure blocks the run; bumping attempt re-runs the effect
  // (fresh controller, sync from the top).
  const [attempt, setAttempt] = useState(0);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncFailure, setSyncFailure] = useState<SyncFailure | null>(null);
  const spinner = useSpinner(!done);
  const controllerRef = useRef<AbortController | null>(null);

  useInput((input, key) => {
    if (syncFailure && !done) {
      // Nothing is in flight while blocked on a failure: esc bails out
      // explicitly, r retries.
      if (key.escape) onDone({ error: syncFailure.message });
      else if (input === "r") setAttempt((a) => a + 1);
      return;
    }
    if (key.escape) controllerRef.current?.abort();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per attempt; sync/start/onDone are stable closures from App
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    (async () => {
      try {
        setSyncFailure(null);
        const failure = await sync(controller.signal, setSyncing);
        setSyncing(null);
        if (failure) {
          setSyncFailure(failure);
          return;
        }
        const { result } = await start(controller.signal);
        let error: string | undefined;
        for await (const part of result.fullStream) {
          if (part.type === "tool-call") {
            const current = `${part.toolName} ${toolCallDetail(part.input)}`;
            setActions((a) => ({ count: a.count + 1, current }));
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
        setSyncing(null);
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
  }, [attempt]);

  const { count, current } = actions;
  if (syncFailure) {
    return (
      <>
        <Text bold color="red">
          !! sync failed for {syncFailure.label}: {syncFailure.message}
        </Text>
        {done ? null : <Text dimColor>r retry · esc cancel</Text>}
      </>
    );
  }
  if (syncing !== null) {
    return (
      <Text color="cyan">
        {spinner} Syncing sources: {syncing}
      </Text>
    );
  }
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
  return (
    <Text>
      <Text color="green">* </Text>
      <Text color="gray">Ran {formatCount(count, "action", "actions")}</Text>
    </Text>
  );
}
