import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { runGeneration } from "../../agent/loop";
import type { SyncFailure } from "../../sources";
import { Generate } from "./Generate";

const TICK = 30;

const noSync = async () => undefined;

// A run that never produces output and only settles when aborted.
const hangingStart = (signal: AbortSignal): ReturnType<typeof runGeneration> =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });

test("esc aborts the run and reports cancelled", async () => {
  let outcome: { error?: string } | undefined;
  const { lastFrame, stdin } = render(
    <Generate
      sync={noSync}
      start={hangingStart}
      done={false}
      onDone={(o) => (outcome = o)}
    />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Waiting for model output...");
  stdin.write("\x1b");
  await Bun.sleep(TICK * 2);
  expect(outcome).toEqual({ error: "cancelled" });
});

test("sync failure blocks the run until r retries", async () => {
  let syncCalls = 0;
  let startCalls = 0;
  const failure: SyncFailure = {
    label: "aws · dev (123456789012)",
    message: "Token is expired",
  };
  const sync = async () => {
    syncCalls += 1;
    return syncCalls === 1 ? failure : undefined;
  };
  const { lastFrame, stdin } = render(
    <Generate
      sync={sync}
      start={(signal) => {
        startCalls += 1;
        return hangingStart(signal);
      }}
      done={false}
      onDone={() => {}}
    />,
  );
  await Bun.sleep(TICK);
  const frame = lastFrame();
  expect(frame).toContain("sync failed for aws · dev (123456789012)");
  expect(frame).toContain("Token is expired");
  expect(frame).toContain("r retry · esc cancel");
  expect(startCalls).toBe(0);

  stdin.write("r");
  await Bun.sleep(TICK);
  expect(syncCalls).toBe(2);
  expect(startCalls).toBe(1);
  expect(lastFrame()).toContain("Waiting for model output...");
});

test("esc while blocked on a sync failure bails with the failure message", async () => {
  let outcome: { error?: string } | undefined;
  const { stdin } = render(
    <Generate
      sync={async () => ({ label: "aws · dev", message: "Token is expired" })}
      start={hangingStart}
      done={false}
      onDone={(o) => (outcome = o)}
    />,
  );
  await Bun.sleep(TICK);
  stdin.write("\x1b");
  await Bun.sleep(TICK);
  expect(outcome).toEqual({ error: "Token is expired" });
});

test("esc during a hanging sync reports cancelled", async () => {
  let outcome: { error?: string } | undefined;
  const sync = (signal: AbortSignal): Promise<SyncFailure | undefined> =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  const { lastFrame, stdin } = render(
    <Generate
      sync={(signal, onProgress) => {
        onProgress("aws · dev (123456789012)");
        return sync(signal);
      }}
      start={hangingStart}
      done={false}
      onDone={(o) => (outcome = o)}
    />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Syncing sources: aws · dev (123456789012)");
  stdin.write("\x1b");
  await Bun.sleep(TICK * 2);
  expect(outcome).toEqual({ error: "cancelled" });
  expect(lastFrame()).not.toContain("Syncing sources:");
});
