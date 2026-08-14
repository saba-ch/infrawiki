import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { IndexState, IndexType } from "@aws-sdk/client-resource-explorer-2";
import {
  awsPrompt,
  describeAwsError,
  listAwsProfiles,
  loadRegionRows,
  type RegionRow,
} from "./aws";
import { awsFilesFixture, fakeAwsApi } from "./aws.fixtures";

awsFilesFixture();

test("lists profiles from both files, dropping sso-session sections", async () => {
  writeFileSync(
    process.env.AWS_CONFIG_FILE as string,
    [
      "[profile dev]",
      "region = eu-west-1",
      "sso_session = corp",
      "",
      "[sso-session corp]",
      "sso_start_url = https://corp.awsapps.com/start",
      "sso_region = us-east-1",
    ].join("\n"),
  );
  writeFileSync(
    process.env.AWS_SHARED_CREDENTIALS_FILE as string,
    ["[legacy]", "aws_access_key_id = AKIA", "aws_secret_access_key = x"].join(
      "\n",
    ),
  );
  const profiles = await listAwsProfiles();
  expect(profiles.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: "dev", region: "eu-west-1" },
    { name: "legacy", region: undefined },
  ]);
});

test("credentials-file region wins over config-file region", async () => {
  writeFileSync(
    process.env.AWS_CONFIG_FILE as string,
    ["[profile dev]", "region = eu-west-1"].join("\n"),
  );
  writeFileSync(
    process.env.AWS_SHARED_CREDENTIALS_FILE as string,
    ["[dev]", "region = us-west-2"].join("\n"),
  );
  const profiles = await listAwsProfiles();
  expect(profiles).toEqual([{ name: "dev", region: "us-west-2" }]);
});

test("loadRegionRows reports progressively and checks only indexed regions", async () => {
  const fetched: string[] = [];
  const api = fakeAwsApi({
    enabledRegions: async () => ["eu-west-1", "us-east-1", "us-west-2"],
    listIndexes: async () =>
      new Map([
        ["us-east-1", { arn: "arn:agg", type: IndexType.AGGREGATOR }],
        ["us-west-2", { arn: "arn:local", type: IndexType.LOCAL }],
      ]),
    getIndex: async (_profile, region) => {
      fetched.push(region);
      return {
        arn: `arn:${region}`,
        type: region === "us-east-1" ? IndexType.AGGREGATOR : IndexType.LOCAL,
        state: IndexState.ACTIVE,
      };
    },
  });
  const updates: RegionRow[][] = [];
  await loadRegionRows(api, "dev", (rows) => updates.push(rows), 0);
  expect(fetched.sort()).toEqual(["us-east-1", "us-west-2"]);
  // First update: full region list, indexed regions still state-pending.
  expect(updates[0]).toEqual([
    { region: "eu-west-1", index: undefined },
    {
      region: "us-east-1",
      index: { arn: "arn:agg", type: IndexType.AGGREGATOR },
    },
    { region: "us-west-2", index: { arn: "arn:local", type: IndexType.LOCAL } },
  ]);
  // Final update: every indexed region has live state.
  expect(updates.length).toBe(3);
  expect(updates[updates.length - 1]).toEqual([
    { region: "eu-west-1", index: undefined },
    {
      region: "us-east-1",
      index: {
        arn: "arn:us-east-1",
        type: IndexType.AGGREGATOR,
        state: IndexState.ACTIVE,
      },
    },
    {
      region: "us-west-2",
      index: {
        arn: "arn:us-west-2",
        type: IndexType.LOCAL,
        state: IndexState.ACTIVE,
      },
    },
  ]);
});

test("awsPrompt tells the agent what is connected and how to explore it", () => {
  const prompt = awsPrompt({
    type: "aws",
    profile: "dev",
    accountId: "123456789012",
    regions: [
      { name: "eu-west-1", index: IndexType.LOCAL },
      { name: "us-east-1", index: IndexType.AGGREGATOR },
    ],
    addedAt: "2026-08-14T00:00:00.000Z",
  });
  expect(prompt).toContain(
    'AWS account 123456789012 is connected via AWS CLI profile "dev"',
  );
  expect(prompt).toContain("eu-west-1 (local index");
  expect(prompt).toContain("us-east-1 (aggregator index");
  expect(prompt).toContain(
    "aws resource-explorer-2 list-resources --profile dev --region <region>",
  );
});

test("describeAwsError adds an sso login hint", () => {
  const err = Object.assign(
    new Error(
      "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
    ),
    { name: "CredentialsProviderError" },
  );
  expect(describeAwsError(err, "dev")).toEqual({
    message: err.message,
    hint: "run `aws sso login --profile dev`",
  });
  expect(describeAwsError(new Error("Region is missing"), "dev")).toEqual({
    message: "Region is missing",
  });
});
