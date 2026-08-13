import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "./auth/store";
import { createModel, splitModelId } from "./model";

let stateDir: string;
let store: AuthStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-state-"));
  store = AuthStore.load(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("splitModelId", () => {
  test("splits on the first slash only", () => {
    expect(splitModelId("openrouter/anthropic/claude-opus-4-5")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-opus-4-5",
    });
  });
});

describe("createModel", () => {
  test("azure uses the deployment name as the model id", async () => {
    store.set("azure", { type: "api", key: "az-key" });
    const model = await createModel({
      modelId: "azure/gpt-5.4",
      store,
      providers: { azure: { resourceName: "my-resource" } },
    });
    expect(model.modelId).toBe("gpt-5.4");
    expect(model.provider).toContain("azure");
  });

  test("azure without resourceName fails with a pointer to config", async () => {
    store.set("azure", { type: "api", key: "az-key" });
    expect(createModel({ modelId: "azure/gpt-5.4", store })).rejects.toThrow(
      /resourceName/,
    );
  });

  test("missing credentials fail with a pointer to init", async () => {
    expect(createModel({ modelId: "openai/gpt-5", store })).rejects.toThrow(
      /infrawiki init/,
    );
  });

  test("unknown provider resolves through openai-compatible with baseURL", async () => {
    store.set("groq", { type: "api", key: "gk" });
    const model = await createModel({
      modelId: "groq/llama-4",
      store,
      providers: { groq: { baseURL: "https://api.groq.com/openai/v1" } },
    });
    expect(model.modelId).toBe("llama-4");
  });

  test("unknown provider without any endpoint fails", async () => {
    store.set("mystery", { type: "api", key: "mk" });
    expect(createModel({ modelId: "mystery/model-1", store })).rejects.toThrow(
      /baseURL/,
    );
  });
});
