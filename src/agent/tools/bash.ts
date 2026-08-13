import { type ChildProcess, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { OutputAccumulator } from "./output-accumulator";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate";

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to terminate without hanging on inherited stdio
 * handles. Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md.
 *
 * A short-lived child can `exit` while a detached descendant keeps its
 * stdout/stderr pipe open. After `exit` we wait for the pipes to fall idle:
 * the grace timer is re-armed on every chunk, so an actively writing
 * descendant keeps us reading, while a quiet inherited handle still releases
 * us after the grace elapses.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      // Output is still arriving after exit; defer finalizing so we don't
      // destroy the stream mid-write and truncate the tail.
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => {
      finalize(code);
    };
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

// SIGKILL the whole process group; fall back to the single pid when the
// group is already gone.
function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

/** Adapted from @earendil-works/pi (MIT) — see THIRD_PARTY_NOTICES.md. */
export function bashTool(cwd: string) {
  return tool({
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    inputSchema: z.object({
      command: z.string().describe("Bash command to execute"),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in seconds (optional, no default timeout)"),
    }),
    execute: async ({ command, timeout }, { abortSignal }): Promise<string> => {
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(
          `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
        );
      }
      if (abortSignal?.aborted) throw new Error("Command aborted");

      const output = new OutputAccumulator();
      const finishOutput = async () => {
        output.finish();
        const snapshot = output.snapshot();
        await output.closeTempFile();
        return snapshot;
      };
      const formatOutput = (
        snapshot: Awaited<ReturnType<typeof finishOutput>>,
      ) => {
        const truncation = snapshot.truncation;
        let text = snapshot.content;
        if (truncation.truncated) {
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }
        return text;
      };
      const appendStatus = (text: string, status: string) =>
        `${text ? `${text}\n\n` : ""}${status}`;

      const shell = existsSync("/bin/bash") ? "/bin/bash" : "sh";
      const child = spawn(shell, ["-c", command], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (data: Buffer) => output.append(data));
      child.stderr?.on("data", (data: Buffer) => output.append(data));

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, timeout * 1000);
        }
        const exitCode = await waitForChildProcess(child);
        const text = formatOutput(await finishOutput());
        if (abortSignal?.aborted) {
          throw new Error(appendStatus(text, "Command aborted"));
        }
        if (timedOut) {
          throw new Error(
            appendStatus(text, `Command timed out after ${timeout} seconds`),
          );
        }
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(
            appendStatus(text, `Command exited with code ${exitCode}`),
          );
        }
        return text || "(no output)";
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        abortSignal?.removeEventListener("abort", onAbort);
      }
    },
  });
}
