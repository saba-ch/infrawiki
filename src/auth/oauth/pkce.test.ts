import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generatePKCE } from "./pkce";

describe("generatePKCE", () => {
  test("challenge is the base64url SHA-256 of the verifier", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });

  test("verifiers are unique", async () => {
    expect((await generatePKCE()).verifier).not.toBe(
      (await generatePKCE()).verifier,
    );
  });
});
