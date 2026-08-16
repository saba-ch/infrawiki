// Vendored from GoogleCloudPlatform/knowledge-catalog
// (okf/src/reference_agent/viewer/generator.py), Apache License 2.0.
// See THIRD_PARTY_NOTICES.md.
// Modified: TypeScript port; infrawiki excluded files; bundle-root-absolute
// link resolution; internal links resolved here into a per-concept href map
// (the client does no path arithmetic); node colors assigned dynamically from
// a palette instead of a fixed BigQuery type map.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INDEX_PAGE,
  INSTRUCTIONS_PAGE,
  LOG_PAGE,
  SKELETON_PAGE,
} from "../config";
import { VIZ_CSS, VIZ_JS, VIZ_TEMPLATE } from "./assets";
import {
  type ActorEvent,
  type Frontmatter,
  isStale,
  normalizeVerified,
  parseDocument,
  trustTier,
} from "./document";

/**
 * Node colors, assigned to types by sorted order.
 */
export const PALETTE = [
  "#4FA8F0",
  "#B6DE3E",
  "#D96FA6",
  "#A97FE0",
  "#D98A6B",
  "#3FBFA0",
  "#E0A63E",
  "#6E8FF0",
] as const;

/**
 * Map each distinct concept type to a palette color by its position in the
 * sorted type list, so colors stay stable across regenerations.
 */
function colorsForTypes(types: readonly string[]): Record<string, string> {
  const colors: Record<string, string> = {};
  types.forEach((type, i) => {
    colors[type] = PALETTE[i % PALETTE.length] ?? PALETTE[0];
  });
  return colors;
}

/**
 * Pages that are bundle scaffolding, not concepts (reserved names from config).
 */
const EXCLUDED_FILES = new Set([
  INDEX_PAGE,
  INSTRUCTIONS_PAGE,
  LOG_PAGE,
  SKELETON_PAGE,
]);

/**
 * Matches a markdown link target (`foo.md` or `/foo.md`, optionally with an
 * `#anchor`), capturing the raw href as written.
 */
const LINK_RE = /\]\(([^)\s]+\.md(?:#[A-Za-z0-9_-]*)?)\)/g;

/**
 * One wiki page as a concept, with the OKF v0.2 signals the viewer surfaces.
 */
interface Concept {
  id: string;
  type: string;
  title: string;
  description: string;
  resource: string;
  tags: string[];
  body: string;
  status: string;
  generated: ActorEvent;
  verified: ActorEvent[];
  stale_after: string;
  sources: ActorEvent[];
  trust_tier: string;
  stale: boolean;
  /**
   * Raw hrefs in the body mapped to the node id they resolve to. Escapes from
   * the bundle root and external URLs are dropped.
   */
  hrefs: Record<string, string>;
}

/**
 * The cytoscape payload embedded into the generated page as window.BUNDLE.
 */
interface BundlePayload {
  nodes: { data: Record<string, unknown> }[];
  edges: { data: { id: string; source: string; target: string } }[];
  bodies: Record<string, string>;
  /**
   * Per-concept map of raw body hrefs to node ids, for in-app navigation.
   */
  links: Record<string, Record<string, string>>;
  /**
   * Id of the concept shown on load, absent for an empty bundle.
   */
  entry?: string;
  types: string[];
}

/**
 * Resolve every internal link in a body to a node id, keyed by the raw href as
 * written. A leading `/` is bundle-root-absolute (InfraWiki's index-page
 * style); other targets are relative to the linking page. External URLs and
 * escapes from the bundle root are dropped.
 */
function extractLinks(
  body: string,
  docDir: string,
  bundleRoot: string,
): Record<string, string> {
  const hrefs: Record<string, string> = {};
  for (const match of body.matchAll(LINK_RE)) {
    const href = match[1];
    if (!href || href.includes("://")) continue;
    const target = href.split("#")[0] ?? href;
    const full = target.startsWith("/")
      ? path.join(bundleRoot, target)
      : path.resolve(docDir, target);
    const rel = path.relative(bundleRoot, full).replace(/\\/g, "/");
    if (rel.startsWith("..")) continue;
    const id = rel.replace(/\.md$/, "");
    if (id) hrefs[href] = id;
  }
  return hrefs;
}

/**
 * Recursively collect markdown files under `dir`, excluding scaffolding. A
 * symlink dirent is neither `isDirectory()` nor `isFile()`, so a symlink
 * pointing outside the bundle is never followed or read.
 */
async function collectMarkdown(
  dir: string,
  out: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdown(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !EXCLUDED_FILES.has(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Read a frontmatter value as a string, "" when absent.
 */
function scalar(frontmatter: Frontmatter, key: string): string {
  const value = frontmatter[key];
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Walk the bundle and parse every concept page. Pages with malformed
 * frontmatter are skipped.
 */
async function walkConcepts(bundleRoot: string): Promise<Concept[]> {
  const files = (await collectMarkdown(bundleRoot)).sort();
  const concepts = await Promise.all(
    files.map(async (file): Promise<Concept | null> => {
      const doc = parseDocument(await readFile(file, "utf8"));
      if (!doc) return null;
      const fm = doc.frontmatter;
      const id = path
        .relative(bundleRoot, file)
        .replace(/\\/g, "/")
        .replace(/\.md$/, "");
      const rawTags = fm.tags;
      const tags = Array.isArray(rawTags)
        ? rawTags.map(String)
        : rawTags
          ? [String(rawTags)]
          : [];
      const generated =
        typeof fm.generated === "object" && fm.generated !== null
          ? (fm.generated as ActorEvent)
          : {};
      const rawSources = fm.sources;
      const sources = Array.isArray(rawSources)
        ? rawSources.filter(
            (s): s is ActorEvent => typeof s === "object" && s !== null,
          )
        : typeof rawSources === "object" && rawSources !== null
          ? [rawSources as ActorEvent]
          : [];
      return {
        id,
        type: scalar(fm, "type") || "Unknown",
        title: scalar(fm, "title") || id,
        description: scalar(fm, "description"),
        resource: scalar(fm, "resource"),
        tags,
        body: doc.body,
        status: scalar(fm, "status") || "stable",
        generated,
        verified: normalizeVerified(fm),
        stale_after: scalar(fm, "stale_after"),
        sources,
        trust_tier: trustTier(fm),
        stale: isStale(fm),
        hrefs: extractLinks(doc.body, path.dirname(file), bundleRoot),
      };
    }),
  );
  return concepts.filter((c): c is Concept => c !== null);
}

/**
 * Build the cytoscape payload: nodes carrying the OKF signals, deduplicated
 * edges between known concepts, and the per-concept href map for the client.
 */
function buildGraph(concepts: Concept[]): BundlePayload {
  const ids = new Set(concepts.map((c) => c.id));
  const types = [...new Set(concepts.map((c) => c.type))].sort();
  const colors = colorsForTypes(types);
  const nodes = concepts.map(({ hrefs, body, ...c }) => ({
    data: {
      ...c,
      label: c.title || c.id,
      color: colors[c.type],
      size: 30 + Math.min(60, Math.floor(body.length / 200)),
    },
  }));
  const edges: BundlePayload["edges"] = [];
  const links: BundlePayload["links"] = {};
  const seenEdges = new Set<string>();
  for (const c of concepts) {
    const known = Object.entries(c.hrefs).filter(([, id]) => ids.has(id));
    links[c.id] = Object.fromEntries(known);
    for (const [, target] of known) {
      if (target === c.id) continue;
      const key = `${c.id}\n${target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({
        data: { id: `${c.id}__${target}`, source: c.id, target },
      });
    }
  }
  const bodies = Object.fromEntries(concepts.map((c) => [c.id, c.body]));
  return { nodes, edges, bodies, links, entry: concepts[0]?.id, types };
}

/**
 * Walk a bundle and write a single self-contained HTML visualization.
 *
 * Returns counts: {concepts, edges}.
 */
export async function generateVisualization(
  bundleRoot: string,
  outPath: string,
  options: { bundleName?: string } = {},
): Promise<{ concepts: number; edges: number }> {
  const info = await stat(bundleRoot).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Bundle directory not found: ${bundleRoot}`);
  }
  const concepts = await walkConcepts(bundleRoot);
  const graph = buildGraph(concepts);
  const name = options.bundleName ?? path.basename(path.resolve(bundleRoot));
  // Function replacements: a plain string replacement would interpret `$`
  // patterns inside the assets or the wiki-sourced JSON.
  const html = VIZ_TEMPLATE.replace("/*__VIZ_CSS__*/", () => VIZ_CSS)
    .replace("/*__VIZ_JS__*/", () => VIZ_JS)
    .replace("__BUNDLE_NAME__", () => JSON.stringify(name))
    .replace("__BUNDLE_DATA__", () => JSON.stringify(graph));
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  return { concepts: concepts.length, edges: graph.edges.length };
}
