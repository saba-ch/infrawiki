import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const CredentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api"), key: z.string() }),
  // Loose: flows attach provider-specific fields (openai-codex accountId,
  // github-copilot enterpriseUrl) that the transport layer reads back.
  z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(), // epoch ms
    })
    .loose(),
]);

export type Credential = z.infer<typeof CredentialSchema>;

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// auth.json namespaces its top-level keys by lifecycle: "providers" holds LLM
// credentials; source-connector tokens will get their own namespace later.
// Writes are read-merge-write so sibling namespaces are preserved.
export class AuthStore {
  readonly path: string;

  private constructor(private readonly stateDir: string) {
    this.path = join(stateDir, "auth.json");
  }

  static load(stateDir: string): AuthStore {
    return new AuthStore(stateDir);
  }

  private readFile(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, "utf8"));
  }

  private writeFile(data: Record<string, unknown>): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    // The mode option only applies on creation; existing files (e.g. the empty
    // one scaffolded by initialize) keep their umask mode without this.
    chmodSync(this.path, 0o600);
  }

  get(id: string): Credential | undefined {
    const providers = this.readFile().providers as
      | Record<string, unknown>
      | undefined;
    const parsed = CredentialSchema.safeParse(providers?.[id]);
    return parsed.success ? parsed.data : undefined;
  }

  set(id: string, credential: Credential): void {
    const data = this.readFile();
    data.providers = { ...(data.providers as object), [id]: credential };
    this.writeFile(data);
  }
}

// models.dev env lists include non-secret config vars (AZURE_RESOURCE_NAME);
// only KEY/TOKEN-style vars can stand in for an API key.
export function apiKeyEnvNames(envNames: string[]): string[] {
  return envNames.filter((name) => /KEY|TOKEN/i.test(name));
}

// A stored credential owns the provider; env vars are only consulted when
// nothing is stored (pi's precedence — avoids "logged in but a stale shell
// export won").
export function resolveAuth(
  store: AuthStore,
  providerId: string,
  envNames: string[],
): Credential | undefined {
  const stored = store.get(providerId);
  if (stored) return stored;
  for (const name of envNames) {
    const key = process.env[name];
    if (key) return { type: "api", key };
  }
  return undefined;
}

export type OAuthCredential = Extract<Credential, { type: "oauth" }>;

export async function getFreshAccess(
  store: AuthStore,
  providerId: string,
  credential: OAuthCredential,
  refreshFn: (credential: OAuthCredential) => Promise<OAuthCredential>,
): Promise<string> {
  if (credential.expires > Date.now() + EXPIRY_SKEW_MS) {
    return credential.access;
  }
  const renewed = await refreshFn(credential);
  store.set(providerId, renewed);
  return renewed.access;
}
