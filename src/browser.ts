import { execFile } from "node:child_process";

/**
 * Open the default browser without a shell (the URL is never interpolated).
 * Fire-and-forget; callers show the URL for manual opening too.
 */
export function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}
