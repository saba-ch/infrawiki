import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveToCwd } from "./paths";

describe("resolveToCwd", () => {
  test("relative path resolves against cwd", () => {
    expect(resolveToCwd("docs/page.md", "/project")).toBe(
      "/project/docs/page.md",
    );
  });

  test("absolute path wins over cwd", () => {
    expect(resolveToCwd("/etc/hosts", "/project")).toBe("/etc/hosts");
  });

  test("tilde expands to home", () => {
    expect(resolveToCwd("~/notes.md", "/project")).toBe(
      join(homedir(), "notes.md"),
    );
    expect(resolveToCwd("~", "/project")).toBe(homedir());
  });
});
