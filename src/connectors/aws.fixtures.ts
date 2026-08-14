import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexState, IndexType } from "@aws-sdk/client-resource-explorer-2";
import type { AwsApi } from "./aws";

/** Stub AwsApi with benign defaults; override the calls a test cares about. */
export const fakeAwsApi = (overrides: Partial<AwsApi> = {}): AwsApi => ({
  callerIdentity: async () => ({ accountId: "123456789012", arn: "arn" }),
  enabledRegions: async () => ["us-east-1"],
  listIndexes: async () =>
    new Map([["us-east-1", { arn: "arn:idx", type: IndexType.LOCAL }]]),
  getIndex: async () => ({
    arn: "arn:idx",
    type: IndexType.LOCAL,
    state: IndexState.ACTIVE,
  }),
  createIndex: async () => {},
  promoteIndex: async () => {},
  ...overrides,
});

/**
 * Points AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE at temp files for every
 * test in the suite (restored after each). `configLines` pre-writes the config
 * file; omit it to start empty and write per test.
 */
export function awsFilesFixture(configLines?: string[]): void {
  let awsDir: string;
  const savedEnv = {
    config: process.env.AWS_CONFIG_FILE,
    credentials: process.env.AWS_SHARED_CREDENTIALS_FILE,
  };
  beforeEach(() => {
    awsDir = mkdtempSync(join(tmpdir(), "infrawiki-aws-"));
    process.env.AWS_CONFIG_FILE = join(awsDir, "config");
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(awsDir, "credentials");
    if (configLines)
      writeFileSync(process.env.AWS_CONFIG_FILE, configLines.join("\n"));
  });
  afterEach(() => {
    rmSync(awsDir, { recursive: true, force: true });
    process.env.AWS_CONFIG_FILE = savedEnv.config;
    process.env.AWS_SHARED_CREDENTIALS_FILE = savedEnv.credentials;
  });
}

export const DEV_PROFILE = ["[profile dev]", "region = us-east-1"];
