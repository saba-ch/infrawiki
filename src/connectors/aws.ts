import {
  AccountClient,
  paginateListRegions,
  RegionOptStatus,
} from "@aws-sdk/client-account";
import {
  CreateIndexCommand,
  GetIndexCommand,
  type IndexState,
  IndexType,
  paginateListIndexes,
  ResourceExplorer2Client,
  UpdateIndexTypeCommand,
} from "@aws-sdk/client-resource-explorer-2";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { parseKnownFiles } from "@smithy/shared-ini-file-loader";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import { z } from "zod";

// Persisted per-source config: <stateDir>/sources/aws-<accountId>/source.json.
export const AwsSourceSchema = z.object({
  type: z.literal("aws"),
  profile: z.string(),
  accountId: z.string(),
  // Regions whose Resource Explorer index this source queries; index type is
  // captured at selection time so the sources page can render it disk-only.
  regions: z
    .array(z.object({ name: z.string(), index: z.enum(IndexType) }))
    .default([]),
  addedAt: z.string(), // ISO timestamp; display ordering on the sources page
});

export type AwsSource = z.infer<typeof AwsSourceSchema>;

export interface AwsProfile {
  name: string;
  region?: string;
}

export async function listAwsProfiles(): Promise<AwsProfile[]> {
  // parseKnownFiles merges config + credentials (credentials wins) but keeps
  // sso-session.* / services.* sections as dotted keys — only bare names are
  // profiles.
  const profiles = await parseKnownFiles({});
  return Object.entries(profiles)
    .filter(([name]) => !name.includes("."))
    .map(([name, values]) => ({ name, region: values.region }));
}

export interface IndexInfo {
  arn: string;
  type: IndexType;
  state: IndexState;
}

export interface RegionRow {
  region: string;
  // state is absent between ListIndexes (which has no state) and this
  // region's GetIndex response landing.
  index?: { arn: string; type: IndexType; state?: IndexState };
}

// Injectable seam: screens and loadRegionRows take this instead of clients so
// tests can drive them with an object literal.
export interface AwsApi {
  callerIdentity(profile: string): Promise<{ accountId: string; arn: string }>;
  enabledRegions(profile: string): Promise<string[]>;
  listIndexes(
    profile: string,
  ): Promise<Map<string, { arn: string; type: IndexType }>>;
  getIndex(profile: string, region: string): Promise<IndexInfo>;
  createIndex(profile: string, region: string): Promise<void>;
  promoteIndex(profile: string, region: string, arn: string): Promise<void>;
}

export function createAwsApi(): AwsApi {
  // One credential chain per profile, shared by every client — each chain
  // resolution (ini, SSO refresh, assume-role) costs hundreds of ms, so
  // per-region clients must not each run their own.
  const chains = new Map<string, AwsCredentialIdentityProvider>();
  const clients = new Map<string, unknown>();
  let profiles: Promise<AwsProfile[]> | undefined;

  const credentials = (profile: string): AwsCredentialIdentityProvider => {
    let chain = chains.get(profile);
    if (!chain) {
      chain = fromNodeProviderChain({ profile });
      chains.set(profile, chain);
    }
    return chain;
  };

  const profileRegion = async (profile: string): Promise<string> => {
    profiles ??= listAwsProfiles();
    return (
      (await profiles).find((p) => p.name === profile)?.region ?? "us-east-1"
    );
  };

  const client = <T>(key: string, make: () => T): T => {
    let cached = clients.get(key) as T | undefined;
    if (!cached) {
      cached = make();
      clients.set(key, cached);
    }
    return cached;
  };

  const explorer = (profile: string, region: string) =>
    client(
      `explorer:${profile}:${region}`,
      () =>
        new ResourceExplorer2Client({
          region,
          credentials: credentials(profile),
        }),
    );

  return {
    async callerIdentity(profile) {
      const region = await profileRegion(profile);
      const sts = client(
        `sts:${profile}`,
        () => new STSClient({ region, credentials: credentials(profile) }),
      );
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      return {
        accountId: identity.Account as string,
        arn: identity.Arn as string,
      };
    },

    async enabledRegions(profile) {
      const region = await profileRegion(profile);
      const account = client(
        `account:${profile}`,
        () => new AccountClient({ region, credentials: credentials(profile) }),
      );
      const regions: string[] = [];
      for await (const page of paginateListRegions(
        { client: account },
        {
          RegionOptStatusContains: [
            RegionOptStatus.ENABLED,
            RegionOptStatus.ENABLED_BY_DEFAULT,
          ],
        },
      ))
        for (const entry of page.Regions ?? [])
          if (entry.RegionName) regions.push(entry.RegionName);
      return regions.sort();
    },

    // One call from any region returns the indexes in every region.
    async listIndexes(profile) {
      const indexes = new Map<string, { arn: string; type: IndexType }>();
      const client = explorer(profile, await profileRegion(profile));
      for await (const page of paginateListIndexes({ client }, {}))
        for (const index of page.Indexes ?? [])
          if (index.Region && index.Arn && index.Type)
            indexes.set(index.Region, { arn: index.Arn, type: index.Type });
      return indexes;
    },

    async getIndex(profile, region) {
      const index = await explorer(profile, region).send(
        new GetIndexCommand({}),
      );
      return {
        arn: index.Arn as string,
        type: index.Type as IndexType,
        state: index.State as IndexState,
      };
    },

    async createIndex(profile, region) {
      await explorer(profile, region).send(new CreateIndexCommand({}));
    },

    async promoteIndex(profile, region, arn) {
      await explorer(profile, region).send(
        new UpdateIndexTypeCommand({ Arn: arn, Type: IndexType.AGGREGATOR }),
      );
    },
  };
}

// Resource Explorer caps non-Search operations at 3/sec.
const THROTTLE_MS = 350;

// Progressive: onRows fires as soon as the region list is known (indexed
// regions marked state-pending), then again per GetIndex response. The state
// checks are pipelined at the rate cap, not run serially.
export async function loadRegionRows(
  api: AwsApi,
  profile: string,
  onRows: (rows: RegionRow[]) => void,
  throttleMs = THROTTLE_MS,
): Promise<void> {
  const [regions, indexes] = await Promise.all([
    api.enabledRegions(profile),
    api.listIndexes(profile),
  ]);
  let rows: RegionRow[] = regions.map((region) => ({
    region,
    index: indexes.get(region),
  }));
  onRows(rows);
  const indexed = regions.filter((region) => indexes.has(region));
  await Promise.all(
    indexed.map(async (region, i) => {
      await Bun.sleep(i * throttleMs);
      const info = await api.getIndex(profile, region);
      rows = rows.map((row) =>
        row.region === region ? { region, index: info } : row,
      );
      onRows(rows);
    }),
  );
}

// List label for a configured AWS source.
export function awsLabel(source: AwsSource): string {
  return `aws · ${source.profile} (${source.accountId})`;
}

// One-glance region summary for the sources list.
export function awsSummary(source: AwsSource): string {
  if (source.regions.length === 0) return "⚠ no regions selected";
  if (source.regions.length <= 2)
    return source.regions
      .map((r) => `${r.name} (${r.index.toLowerCase()})`)
      .join(", ");
  const aggregator = source.regions.some(
    (r) => r.index === IndexType.AGGREGATOR,
  );
  return `${source.regions.length} regions${aggregator ? " · aggregator" : ""}`;
}

// The connector's contribution to the generation prompt: what is connected
// and how the agent explores it with its own shell tool.
export function awsPrompt(source: AwsSource): string {
  const regions = source.regions
    .map(
      (r) =>
        `${r.name} (${
          r.index === IndexType.AGGREGATOR
            ? "aggregator index: returns resources from every region in the account"
            : "local index: returns only that region's resources"
        })`,
    )
    .join(", ");
  const flags = `--profile ${source.profile}`;
  return (
    `AWS account ${source.accountId} is connected via AWS CLI profile "${source.profile}".\n` +
    `Query regions via Resource Explorer: ${regions}.\n` +
    `Enumerate resources with: aws resource-explorer-2 list-resources ${flags} --region <region>\n` +
    `Inspect specific resources with the relevant AWS service CLI command, always passing ${flags}.`
  );
}

export function describeAwsError(
  err: unknown,
  profile: string,
): { message: string; hint?: string } {
  const message = err instanceof Error ? err.message : String(err);
  // Every SSO-expiry variant from the SDK says to run `aws sso login`.
  if (message.includes("aws sso login"))
    return { message, hint: `run \`aws sso login --profile ${profile}\`` };
  return { message };
}
