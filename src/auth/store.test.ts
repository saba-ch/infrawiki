import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStore,
  type Credential,
  getFreshAccess,
  type OAuthCredential,
  resolveAuth,
} from "./store";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "infrawiki-state-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const API_CRED: Credential = { type: "api", key: "sk-test" };
const oauthCred = (expires: number): OAuthCredential => ({
  type: "oauth",
  refresh: "rt-1",
  access: "at-1",
  expires,
});

describe("AuthStore", () => {
  test("set/get round-trip under the providers namespace", () => {
    const store = AuthStore.load(stateDir);
    store.set("openai", API_CRED);
    store.set("azure", { type: "api", key: "az-key" });
    expect(store.get("openai")).toEqual(API_CRED);
    const raw = JSON.parse(readFileSync(store.path, "utf8"));
    expect(Object.keys(raw.providers)).toEqual(["openai", "azure"]);
  });

  test("writes the file 0600", () => {
    const store = AuthStore.load(stateDir);
    store.set("openai", API_CRED);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  test("tightens a pre-existing umask-mode file to 0600", () => {
    const path = join(stateDir, "auth.json");
    writeFileSync(path, "{}\n"); // how the old scaffold created it
    AuthStore.load(stateDir).set("openai", API_CRED);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("preserves sibling namespaces on write", () => {
    const path = join(stateDir, "auth.json");
    writeFileSync(path, JSON.stringify({ sources: { aws: "token" } }));
    AuthStore.load(stateDir).set("openai", API_CRED);
    expect(JSON.parse(readFileSync(path, "utf8")).sources).toEqual({
      aws: "token",
    });
  });

  test("ignores malformed credential entries", () => {
    const path = join(stateDir, "auth.json");
    writeFileSync(path, JSON.stringify({ providers: { openai: { bad: 1 } } }));
    const store = AuthStore.load(stateDir);
    expect(store.get("openai")).toBeUndefined();
  });

  test("providers lists stored ids", () => {
    const store = AuthStore.load(stateDir);
    expect(store.providers()).toEqual([]);
    store.set("openai", API_CRED);
    store.set("anthropic", oauthCred(Date.now() + 1000));
    expect(store.providers()).toEqual(["openai", "anthropic"]);
  });
});

describe("resolveAuth", () => {
  test("stored credential wins over env", () => {
    process.env.INFRAWIKI_TEST_KEY = "env-key";
    try {
      const store = AuthStore.load(stateDir);
      store.set("openai", API_CRED);
      expect(resolveAuth(store, "openai", ["INFRAWIKI_TEST_KEY"])).toEqual(
        API_CRED,
      );
    } finally {
      delete process.env.INFRAWIKI_TEST_KEY;
    }
  });

  test("falls back to the first set env var", () => {
    process.env.INFRAWIKI_TEST_KEY = "env-key";
    try {
      const resolved = resolveAuth(AuthStore.load(stateDir), "openai", [
        "INFRAWIKI_MISSING",
        "INFRAWIKI_TEST_KEY",
      ]);
      expect(resolved).toEqual({ type: "api", key: "env-key" });
    } finally {
      delete process.env.INFRAWIKI_TEST_KEY;
    }
  });

  test("returns undefined with nothing stored and no env", () => {
    expect(
      resolveAuth(AuthStore.load(stateDir), "openai", ["INFRAWIKI_MISSING"]),
    ).toBeUndefined();
  });
});

describe("getFreshAccess", () => {
  test("returns the access token while still valid", async () => {
    const store = AuthStore.load(stateDir);
    const cred = oauthCred(Date.now() + 60 * 60 * 1000);
    const access = await getFreshAccess(store, "anthropic", cred, () => {
      throw new Error("should not refresh");
    });
    expect(access).toBe("at-1");
  });

  test("refreshes an expiring credential and persists it", async () => {
    const store = AuthStore.load(stateDir);
    const renewed = {
      type: "oauth",
      refresh: "rt-2",
      access: "at-2",
      expires: Date.now() + 60 * 60 * 1000,
    } as const;
    const access = await getFreshAccess(
      store,
      "anthropic",
      oauthCred(Date.now() + 1000),
      async () => renewed,
    );
    expect(access).toBe("at-2");
    expect(store.get("anthropic")).toEqual(renewed);
  });
});
