import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const MODELS_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const CatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  tool_call: z.boolean().default(false),
  structured_output: z.boolean().default(false),
  limit: z.object({ context: z.number(), output: z.number() }).optional(),
  cost: z
    .object({ input: z.number().optional(), output: z.number().optional() })
    .optional(),
  release_date: z.string().optional(),
  status: z.string().optional(),
});

// Providers parse without their models so one malformed model entry (models.dev
// is third-party data) drops that model, not the whole provider.
const CatalogProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  env: z.array(z.string()).default([]),
  npm: z.string().optional(),
  api: z.string().optional(),
  doc: z.string().optional(),
  models: z.record(z.string(), z.unknown()).default({}),
});

export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export interface CatalogProvider
  extends Omit<z.infer<typeof CatalogProviderSchema>, "models"> {
  models: Record<string, CatalogModel>;
}
export type Catalog = Record<string, CatalogProvider>;

function parseCatalog(raw: unknown): Catalog {
  const catalog: Catalog = {};
  if (typeof raw !== "object" || raw === null) return catalog;
  for (const [id, value] of Object.entries(raw)) {
    const provider = CatalogProviderSchema.safeParse(value);
    if (!provider.success) continue;
    const models: Record<string, CatalogModel> = {};
    for (const [modelId, entry] of Object.entries(provider.data.models)) {
      const model = CatalogModelSchema.safeParse(entry);
      if (model.success) models[modelId] = model.data;
    }
    catalog[id] = { ...provider.data, models };
  }
  return catalog;
}

export interface LoadCatalogOptions {
  home?: string;
  fetchFn?: (url: string) => Promise<Response>;
  ttlMs?: number;
}

export async function loadCatalog(
  opts: LoadCatalogOptions = {},
): Promise<Catalog | undefined> {
  const home = opts.home ?? homedir();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const fetchFn = opts.fetchFn ?? fetch;
  const cacheDir = join(home, ".infrawiki", "cache");
  const cachePath = join(cacheDir, "models.json");

  const readCache = () =>
    parseCatalog(JSON.parse(readFileSync(cachePath, "utf8")));

  if (
    existsSync(cachePath) &&
    Date.now() - statSync(cachePath).mtimeMs < ttlMs
  ) {
    return readCache();
  }

  try {
    const res = await fetchFn(MODELS_URL);
    if (!res.ok) throw new Error(`models.dev responded ${res.status}`);
    const raw = await res.json();
    mkdirSync(cacheDir, { recursive: true });
    const tmp = join(cacheDir, "models.json.tmp");
    writeFileSync(tmp, JSON.stringify(raw));
    renameSync(tmp, cachePath);
    return parseCatalog(raw);
  } catch {
    if (existsSync(cachePath)) return readCache();
    return undefined;
  }
}

export function agentModels(provider: CatalogProvider): CatalogModel[] {
  return Object.values(provider.models)
    .filter(
      (m) => m.tool_call && m.structured_output && m.status !== "deprecated",
    )
    .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""));
}
