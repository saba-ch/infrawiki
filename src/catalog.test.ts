import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentModels, type CatalogProvider, loadCatalog } from "./catalog";

const FIXTURE = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
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
      "gpt-4-turbo": {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        tool_call: true,
        structured_output: true,
        release_date: "2024-04-09",
        status: "deprecated",
      },
      whisper: { id: "whisper", name: "Whisper" },
      broken: { name: 42 },
    },
  },
  broken: { name: "No id" },
};

function fetchOk(body: unknown = FIXTURE) {
  return () => Promise.resolve(Response.json(body));
}

const fetchFail = () => Promise.reject(new Error("offline"));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "infrawiki-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const cachePath = () => join(home, ".infrawiki", "cache", "models.json");

describe("loadCatalog", () => {
  test("fetches, parses, and drops malformed entries", async () => {
    const catalog = await loadCatalog({ home, fetchFn: fetchOk() });
    expect(Object.keys(catalog ?? {})).toEqual(["openai"]);
    expect(Object.keys(catalog?.openai?.models ?? {})).toEqual([
      "gpt-5",
      "gpt-4-turbo",
      "whisper",
    ]);
  });

  test("serves the cache without fetching while fresh", async () => {
    let calls = 0;
    const counting = () => {
      calls++;
      return fetchOk()();
    };
    await loadCatalog({ home, fetchFn: counting });
    const again = await loadCatalog({ home, fetchFn: counting });
    expect(calls).toBe(1);
    expect(again?.openai?.name).toBe("OpenAI");
  });

  test("refetches once the cache expires", async () => {
    await loadCatalog({ home, fetchFn: fetchOk() });
    const old = new Date(Date.now() - 1000);
    utimesSync(cachePath(), old, old);
    const catalog = await loadCatalog({
      home,
      ttlMs: 0,
      fetchFn: fetchOk({
        ...FIXTURE,
        openai: { ...FIXTURE.openai, name: "Fresh" },
      }),
    });
    expect(catalog?.openai?.name).toBe("Fresh");
  });

  test("falls back to a stale cache when the fetch fails", async () => {
    await loadCatalog({ home, fetchFn: fetchOk() });
    const catalog = await loadCatalog({ home, ttlMs: 0, fetchFn: fetchFail });
    expect(catalog?.openai?.name).toBe("OpenAI");
  });

  test("returns undefined with no cache and no network", async () => {
    expect(await loadCatalog({ home, fetchFn: fetchFail })).toBeUndefined();
  });

  test("survives a corrupt malformed body", async () => {
    const catalog = await loadCatalog({ home, fetchFn: fetchOk("nonsense") });
    expect(catalog).toEqual({});
  });
});

describe("agentModels", () => {
  test("filters to agent-capable, non-deprecated, newest first", async () => {
    const catalog = await loadCatalog({ home, fetchFn: fetchOk() });
    const provider = catalog?.openai as CatalogProvider;
    expect(agentModels(provider).map((m) => m.id)).toEqual(["gpt-5"]);
  });
});
