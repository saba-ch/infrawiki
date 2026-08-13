import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "./bash";

const OPTS = { toolCallId: "test", messages: [], context: {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "infrawiki-bash-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (
  input: { command: string; timeout?: number },
  abortSignal?: AbortSignal,
) =>
  bashTool(dir).execute?.(input, { ...OPTS, abortSignal }) as Promise<string>;

describe("bash", () => {
  test("captures stdout and stderr", async () => {
    expect(await run({ command: "echo out; echo err >&2" })).toBe("out\nerr\n");
  });

  test("runs in the tool cwd", async () => {
    expect((await run({ command: "pwd" })).trim()).toEndWith(
      dir.split("/").pop() as string,
    );
  });

  test("no output", async () => {
    expect(await run({ command: "true" })).toBe("(no output)");
  });

  test("non-zero exit throws with output and code", async () => {
    expect(run({ command: "echo before; exit 3" })).rejects.toThrow(
      "before\n\n\nCommand exited with code 3",
    );
  });

  test("timeout kills the command", async () => {
    const start = Date.now();
    expect(run({ command: "sleep 5", timeout: 1 })).rejects.toThrow(
      "Command timed out after 1 seconds",
    );
    await Bun.sleep(1200);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("abort kills the command promptly", async () => {
    const controller = new AbortController();
    const promise = run({ command: "sleep 5" }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    expect(promise).rejects.toThrow("Command aborted");
    await promise.catch(() => {});
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("large output is tail-truncated with a temp file footer", async () => {
    const output = await run({
      command: 'for i in $(seq 1 3000); do echo "line $i"; done',
    });
    expect(output).toContain("line 3000");
    expect(output).not.toContain('"line 1"');
    expect(output).toContain("[Showing lines 1001-3000 of 3000. Full output: ");
    const fullPath = output.match(/Full output: (\S+)\]/)?.[1] as string;
    expect(existsSync(fullPath)).toBe(true);
    rmSync(fullPath, { force: true });
  });
});
