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

  private providers(): Record<string, unknown> {
    return (this.readFile().providers ?? {}) as Record<string, unknown>;
  }

  get(id: string): Credential | undefined {
    const parsed = CredentialSchema.safeParse(this.providers()[id]);
    return parsed.success ? parsed.data : undefined;
  }

  set(id: string, credential: Credential): void {
    const data = this.readFile();
    data.providers = { ...this.providers(), [id]: credential };
    this.writeFile(data);
  }

  remove(id: string): void {
    const data = this.readFile();
    const providers = this.providers();
    delete providers[id];
    data.providers = providers;
    this.writeFile(data);
  }

  list(): Record<string, Credential> {
    const entries: Record<string, Credential> = {};
    for (const [id, value] of Object.entries(this.providers())) {
      const parsed = CredentialSchema.safeParse(value);
      if (parsed.success) entries[id] = parsed.data;
    }
    return entries;
  }
}

export interface ResolvedAuth {
  credential: Credential;
  source: string; // "auth.json" or "$ENV_VAR"
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
): ResolvedAuth | undefined {
  const stored = store.get(providerId);
  if (stored) return { credential: stored, source: "auth.json" };
  for (const name of envNames) {
    const key = process.env[name];
    if (key) return { credential: { type: "api", key }, source: `$${name}` };
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
