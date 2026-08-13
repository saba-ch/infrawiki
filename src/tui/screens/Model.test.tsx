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
let submitted: {
  modelId: string;
  providers?: Record<string, ProviderOptions>;
  detail: string;
}[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-state-"));
  store = AuthStore.load(stateDir);
  submitted = [];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function renderModel() {
  return render(
    <Model
      catalog={CATALOG}
      store={store}
      onSubmit={(modelId, providers, detail) =>
        submitted.push({ modelId, providers, detail })
      }
    />,
  );
}

test("openai key -> model select -> submit", async () => {
  const { stdin, lastFrame } = renderModel();
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
  expect(submitted).toEqual([
    { modelId: "openai/gpt-5", providers: undefined, detail: "openai/gpt-5" },
  ]);
});

test("azure path collects resource and deployment", async () => {
  const { stdin, lastFrame } = renderModel();
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
  expect(submitted).toEqual([
    {
      modelId: "azure/gpt-5.4",
      providers: { azure: { resourceName: "opsy-aoai" } },
      detail: "azure/gpt-5.4",
    },
  ]);
});
