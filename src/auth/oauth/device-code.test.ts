import { describe, expect, test } from "bun:test";
import {
  type OAuthDeviceCodePollResult,
  pollOAuthDeviceCodeFlow,
} from "./device-code";

const never = new AbortController().signal;

function sequence(results: OAuthDeviceCodePollResult<string>[]) {
  let i = 0;
  return async () =>
    results[
      Math.min(i++, results.length - 1)
    ] as OAuthDeviceCodePollResult<string>;
}

describe("pollOAuthDeviceCodeFlow", () => {
  test("polls through pending to completion", async () => {
    const value = await pollOAuthDeviceCodeFlow({
      intervalSeconds: 0.001,
      signal: never,
      poll: sequence([
        { status: "pending" },
        { status: "pending" },
        { status: "complete", value: "token" },
      ]),
    });
    expect(value).toBe("token");
  });

  test("slow_down bumps the interval before completing", async () => {
    const started = Date.now();
    const value = await pollOAuthDeviceCodeFlow({
      intervalSeconds: 0.001,
      signal: never,
      poll: sequence([
        { status: "slow_down", intervalSeconds: 1.2 },
        { status: "complete", value: "token" },
      ]),
    });
    expect(value).toBe("token");
    // The second poll must have waited the server-provided 1.2s, not 1ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
  });

  test("failure message propagates", async () => {
    expect(
      pollOAuthDeviceCodeFlow({
        intervalSeconds: 0.001,
        signal: never,
        poll: sequence([{ status: "failed", message: "denied" }]),
      }),
    ).rejects.toThrow("denied");
  });

  test("abort during the wait cancels the login", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    expect(
      pollOAuthDeviceCodeFlow({
        intervalSeconds: 60,
        signal: controller.signal,
        poll: sequence([{ status: "pending" }]),
      }),
    ).rejects.toThrow("Login cancelled");
  });

  test("expiry deadline times out", async () => {
    expect(
      pollOAuthDeviceCodeFlow({
        intervalSeconds: 0.005,
        expiresInSeconds: 0.02,
        signal: never,
        poll: sequence([{ status: "pending" }]),
      }),
    ).rejects.toThrow("Device flow timed out");
  });
});
