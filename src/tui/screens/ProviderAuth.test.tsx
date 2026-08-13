import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { AuthStore } from "../../auth/store";
import type { Catalog } from "../../catalog";
import { ProviderAuth } from "./ProviderAuth";

const TICK = 30;

const CATALOG: Catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {},
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {},
  },
  azure: {
    id: "azure",
    name: "Azure",
    env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
    models: {},
  },
};

let stateDir: string;
let store: AuthStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-state-"));
  store = AuthStore.load(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

test("azure api-key path stores the credential 0600", async () => {
  const done: string[] = [];
  const { stdin, lastFrame } = render(
    <ProviderAuth
      catalog={CATALOG}
      store={store}
      onDone={(p) => done.push(p)}
    />,
  );
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Which model provider");
  stdin.write("azure"); // type-to-filter
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  // Azure has no OAuth flow and no env set -> jumps straight to key entry.
  expect(lastFrame()).toContain("Azure API key");
  stdin.write("az-secret-key");
  await Bun.sleep(TICK);
  expect(lastFrame()).not.toContain("az-secret-key");
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(done).toEqual(["azure"]);
  expect(store.get("azure")).toEqual({ type: "api", key: "az-secret-key" });
  expect(statSync(store.path).mode & 0o777).toBe(0o600);
});

test("detected env var appears as a method that stores nothing", async () => {
  process.env.OPENAI_API_KEY = "sk-env";
  try {
    const done: string[] = [];
    const { stdin, lastFrame } = render(
      <ProviderAuth
        catalog={CATALOG}
        store={store}
        onDone={(p) => done.push(p)}
      />,
    );
    await Bun.sleep(TICK);
    stdin.write("openai"); // type-to-filter
    await Bun.sleep(TICK);
    stdin.write("\r");
    await Bun.sleep(TICK);
    expect(lastFrame()).toContain("ChatGPT Plus/Pro subscription");
    expect(lastFrame()).toContain("Use $OPENAI_API_KEY from environment");
    stdin.write("\x1b[B\x1b[B"); // oauth -> api key -> env
    await Bun.sleep(TICK);
    stdin.write("\r");
    await Bun.sleep(TICK);
    expect(done).toEqual(["openai"]);
    expect(store.get("openai")).toBeUndefined();
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("anthropic oauth shows the extra-usage notice before sign-in", async () => {
  const { stdin, lastFrame } = render(
    <ProviderAuth catalog={CATALOG} store={store} onDone={() => {}} />,
  );
  await Bun.sleep(TICK);
  stdin.write("\r"); // anthropic
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Claude Pro/Max subscription");
  stdin.write("\r"); // choose oauth
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("extra-usage credits");
});
