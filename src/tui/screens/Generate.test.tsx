import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { runGeneration } from "../../agent/loop";
import { Generate } from "./Generate";

const TICK = 30;

test("esc aborts the run and reports cancelled", async () => {
  // A run that never produces output and only settles when aborted.
  const start = (signal: AbortSignal): ReturnType<typeof runGeneration> =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  let outcome: { error?: string } | undefined;
  const { lastFrame, stdin } = render(
    <Generate start={start} done={false} onDone={(o) => (outcome = o)} />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Waiting for model output...");
  stdin.write("\x1b");
  await Bun.sleep(TICK * 2);
  expect(outcome).toEqual({ error: "cancelled" });
});
