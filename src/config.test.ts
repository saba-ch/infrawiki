import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, DEFAULT_INSTRUCTIONS } from "./config";

let projectDir: string;
let home: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "infrawiki-project-"));
  home = mkdtempSync(join(tmpdir(), "infrawiki-home-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("lifecycle", () => {
  test("fresh load has defaults and is not initialized", () => {
    const config = Config.load(projectDir, home);
    expect(config.initialized).toBe(false);
    expect(config.outputDir).toBe("infrawiki");
    expect(config.checkpoint).toBeUndefined();
  });

  test("update persists across loads", () => {
    Config.load(projectDir, home).update({
      outputDir: "docs",
      init: { step: "instructions" },
    });
    const reloaded = Config.load(projectDir, home);
    expect(reloaded.outputDir).toBe("docs");
    expect(reloaded.checkpoint).toEqual({ step: "instructions" });
  });

  test("updating a field keeps the others", () => {
    const config = Config.load(projectDir, home);
    config.update({ outputDir: "docs" });
    config.update({ initialized: true });
    const reloaded = Config.load(projectDir, home);
    expect(reloaded.outputDir).toBe("docs");
    expect(reloaded.initialized).toBe(true);
  });

  test("persists model and provider options without secrets", () => {
    Config.load(projectDir, home).update({
      model: "azure/gpt-5.4",
      providers: { azure: { resourceName: "my-resource" } },
    });
    const reloaded = Config.load(projectDir, home);
    expect(reloaded.model).toBe("azure/gpt-5.4");
    expect(reloaded.providers).toEqual({
      azure: { resourceName: "my-resource" },
    });
  });
});

describe("id", () => {
  test("is stable for the same path", () => {
    expect(Config.load(projectDir, home).id).toBe(
      Config.load(projectDir, home).id,
    );
  });

  test("differs for different paths", () => {
    expect(Config.load(projectDir, home).id).not.toBe(
      Config.load(home, home).id,
    );
  });

  test("slugifies the directory name", () => {
    expect(Config.load(projectDir, home).id).toMatch(
      /^infrawiki-project-[a-z0-9-]+-[0-9a-f]{8}$/,
    );
  });
});

describe("stateDir", () => {
  test("defaults to the global projects dir", () => {
    const config = Config.load(projectDir, home);
    expect(config.stateDir).toBe(
      join(home, ".infrawiki", "projects", config.id),
    );
  });

  test("honors a local stateDir from infrawiki.json", () => {
    writeFileSync(
      join(projectDir, Config.FILE),
      JSON.stringify({ stateDir: ".infrawiki" }),
    );
    expect(Config.load(projectDir, home).stateDir).toBe(
      join(projectDir, ".infrawiki"),
    );
  });
});

describe("initialize", () => {
  test("writes config, state dir, and instructions", () => {
    const config = Config.load(projectDir, home);
    config.update({ outputDir: "wiki" });
    const result = config.initialize(DEFAULT_INSTRUCTIONS);
    expect(existsSync(result.configPath)).toBe(true);
    expect(existsSync(join(result.stateDir, "auth.json"))).toBe(true);
    expect(existsSync(join(result.stateDir, "sources"))).toBe(true);
    expect(result.instructionsPath).toBe(
      join(projectDir, "wiki", "instructions.md"),
    );
    expect(readFileSync(result.instructionsPath, "utf8")).toBe(
      DEFAULT_INSTRUCTIONS,
    );
  });

  test("writes custom instructions", () => {
    const result = Config.load(projectDir, home).initialize(
      "Focus on networking.",
    );
    expect(readFileSync(result.instructionsPath, "utf8")).toBe(
      "Focus on networking.",
    );
  });

  test("clears the checkpoint and marks initialized", () => {
    const config = Config.load(projectDir, home);
    config.update({ init: { step: "instructions" } });
    config.initialize(DEFAULT_INSTRUCTIONS);
    const reloaded = Config.load(projectDir, home);
    expect(reloaded.initialized).toBe(true);
    expect(reloaded.checkpoint).toBeUndefined();
  });

  // Guards the existsSync(authPath) check: re-initializing a project must not
  // wipe stored credentials.
  test("re-init preserves an existing auth.json", () => {
    const first = Config.load(projectDir, home).initialize(
      DEFAULT_INSTRUCTIONS,
    );
    writeFileSync(join(first.stateDir, "auth.json"), '{"aws":"secret"}');
    Config.load(projectDir, home).initialize(DEFAULT_INSTRUCTIONS);
    expect(readFileSync(join(first.stateDir, "auth.json"), "utf8")).toBe(
      '{"aws":"secret"}',
    );
  });
});
