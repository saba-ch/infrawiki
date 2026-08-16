import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { AuthStore } from "../../auth/store";
import type { Catalog } from "../../catalog";
import type { ProviderOptions } from "../../config";
import { Model } from "./Model";

const TICK = 30;

const CATALOG: Catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        tool_call: true,
        structured_output: true,
        limit: { context: 400000, output: 128000 },
        cost: { input: 1.25, output: 10 },
        release_date: "2025-08-07",
      },
    },
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
let picked: {
  modelId: string;
  providers?: Record<string, ProviderOptions>;
}[];
let continued: number;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-state-"));
  store = AuthStore.load(stateDir);
  picked = [];
  continued = 0;
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function renderModel(props?: { configuredModel?: string }) {
  return render(
    <Model
      catalog={CATALOG}
      store={store}
      configuredModel={props?.configuredModel}
      onPick={(modelId, providers) => picked.push({ modelId, providers })}
      onContinue={() => continued++}
      onBack={() => {}}
    />,
  );
}

test("add provider -> openai key -> model select -> pick returns to list", async () => {
  const { stdin, lastFrame } = renderModel();
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Add provider");
  stdin.write("\r"); // fresh store: Add provider is the first row
  await Bun.sleep(TICK);
  stdin.write("\r"); // openai ranks first
  await Bun.sleep(TICK);
  stdin.write("\x1b[B"); // oauth -> api key
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  stdin.write("sk-test");
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("GPT-5");
  expect(lastFrame()).toContain("400k ctx");
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(picked).toEqual([{ modelId: "openai/gpt-5", providers: undefined }]);
  // Back on the list, the pick shows as the current model.
  expect(lastFrame()).toContain("gpt-5 · current");
  expect(continued).toBe(0);
});

test("azure path collects resource and deployment", async () => {
  const { stdin, lastFrame } = renderModel();
  await Bun.sleep(TICK);
  stdin.write("\r"); // Add provider
  await Bun.sleep(TICK);
  stdin.write("azure"); // type-to-filter
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  stdin.write("my-key");
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("resource name");
  stdin.write("opsy-aoai");
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("deployment name");
  stdin.write("gpt-5.4");
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(picked).toEqual([
    {
      modelId: "azure/gpt-5.4",
      providers: { azure: { resourceName: "opsy-aoai" } },
    },
  ]);
});

test("continue without a model shows an inline error", async () => {
  const { stdin, lastFrame } = renderModel();
  await Bun.sleep(TICK);
  stdin.write("\x1b[B"); // Add provider -> Continue
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("pick a model first");
  expect(continued).toBe(0);
});

test("configured model shows its provider row and Continue is focused", async () => {
  store.set("openai", { type: "api", key: "sk-test" });
  const { stdin, lastFrame } = renderModel({
    configuredModel: "openai/gpt-5",
  });
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("OpenAI");
  expect(lastFrame()).toContain("gpt-5 · current");
  stdin.write("\r"); // focus starts on Continue
  await Bun.sleep(TICK);
  expect(continued).toBe(1);
});

test("selecting a configured provider row reopens its model pick", async () => {
  store.set("openai", { type: "api", key: "sk-test" });
  const { stdin, lastFrame } = renderModel({
    configuredModel: "openai/gpt-5",
  });
  await Bun.sleep(TICK);
  stdin.write("\x1b[A"); // up from Continue to Add provider
  await Bun.sleep(TICK);
  stdin.write("\x1b[A"); // up to the OpenAI row
  await Bun.sleep(TICK);
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(lastFrame()).toContain("Pick a model");
  stdin.write("\r");
  await Bun.sleep(TICK);
  expect(picked).toEqual([{ modelId: "openai/gpt-5", providers: undefined }]);
});
