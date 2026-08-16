// Vendored from GoogleCloudPlatform/knowledge-catalog
// (okf/tests/test_viewer.py), Apache License 2.0. See THIRD_PARTY_NOTICES.md.
// Modified: bun:test port; dynamic-palette color assertions; infrawiki
// excluded files and bundle-root-absolute link cases.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateVisualization, PALETTE } from "./generator";

const tempDirs: string[] = [];

async function makeBundle(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "infrawiki-okf-"));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

const BUNDLE = {
  "datasets/my_dataset.md": `---
type: BigQuery Dataset
title: My dataset
description: A test dataset.
resource: https://example.com/dataset
tags: [test]
generated: {by: 'reference_agent/gemini', at: '2026-05-28T00:00:00+00:00'}
---
Parent dataset for [users](../tables/users.md).
`,
  "tables/users.md": `---
type: BigQuery Table
title: Users
description: User profiles.
resource: https://example.com/users
tags: [users]
status: deprecated
generated: {by: 'reference_agent/gemini', at: '2026-05-28T00:00:00+00:00'}
verified:
  - {by: 'process:finance-nightly', at: '2026-05-29T00:00:00+00:00'}
  - {by: 'human:ahormati', at: '2026-05-30T00:00:00+00:00'}
stale_after: '2020-01-01'
sources:
  - {id: bq, resource: 'https://example.com/users', title: BigQuery}
---
Joinable with [events](events.md) and see [DAU](/references/metrics/dau.md).
`,
  "tables/events.md": `---
type: BigQuery Table
title: Events
description: User events.
resource: https://example.com/events
tags: [events]
generated: {by: 'reference_agent/gemini', at: '2026-05-28T00:00:00+00:00'}
---
See [users](users.md).
`,
  "references/metrics/dau.md": `---
type: Reference
title: Daily active users
description: DAU metric.
resource: https://example.com/dau
tags: [metric]
generated: {by: 'reference_agent/gemini', at: '2026-05-28T00:00:00+00:00'}
---
COUNT(DISTINCT user_id) per day.
`,
  // Scaffolding that must NOT appear as concept nodes.
  "index.md": "# My Bundle\n- tables/users\n- tables/events\n",
  "instructions.md": "user brief\n",
  "log.md": "## 2026-08-16\ninit\n",
};

interface BundleData {
  nodes: { data: Record<string, unknown> }[];
  edges: { data: { source: string; target: string } }[];
  links: Record<string, Record<string, string>>;
  entry?: string;
  types: string[];
}

async function generate(root: string): Promise<{
  html: string;
  data: BundleData;
  stats: { concepts: number; edges: number };
}> {
  const out = path.join(root, "..", `${path.basename(root)}-viz.html`);
  tempDirs.push(out);
  const stats = await generateVisualization(root, out, {
    bundleName: "My Bundle",
  });
  const html = await Bun.file(out).text();
  const match = html.match(/window\.BUNDLE\s*=\s*(\{.*?\});\n/s);
  if (!match?.[1]) throw new Error("BUNDLE JSON not found in generated HTML");
  return { html, data: JSON.parse(match[1]) as BundleData, stats };
}

describe("generateVisualization", () => {
  test("writes a self-contained HTML file", async () => {
    const root = await makeBundle(BUNDLE);
    const { html, stats } = await generate(root);
    expect(stats.concepts).toBe(4);
    expect(html).toContain("<title>OKF Bundle Viewer</title>");
    expect(html.toLowerCase()).toContain("cytoscape");
    expect(html.toLowerCase()).toContain("marked");
    expect(html).toContain('"My Bundle"');
  });

  test("index and scaffolding pages are not concepts", async () => {
    const root = await makeBundle(BUNDLE);
    const { data } = await generate(root);
    const ids = new Set(data.nodes.map((n) => n.data.id));
    expect(ids).toEqual(
      new Set([
        "datasets/my_dataset",
        "tables/users",
        "tables/events",
        "references/metrics/dau",
      ]),
    );
  });

  test("relative and bundle-root-absolute links become edges", async () => {
    const root = await makeBundle(BUNDLE);
    const { data } = await generate(root);
    const pairs = new Set(
      data.edges.map((e) => `${e.data.source}>${e.data.target}`),
    );
    expect(pairs).toContain("datasets/my_dataset>tables/users");
    expect(pairs).toContain("tables/users>tables/events");
    // From the absolute /references/metrics/dau.md link.
    expect(pairs).toContain("tables/users>references/metrics/dau");
    expect(pairs).toContain("tables/events>tables/users");
  });

  test("client link map resolves raw hrefs and names the entry", async () => {
    const root = await makeBundle(BUNDLE);
    const { data } = await generate(root);
    expect(data.links["tables/users"]).toEqual({
      "events.md": "tables/events",
      "/references/metrics/dau.md": "references/metrics/dau",
    });
    // Alphabetically first concept.
    expect(data.entry).toBe("datasets/my_dataset");
  });

  test("missing link targets are skipped", async () => {
    const root = await makeBundle({
      "tables/lonely.md": `---
type: BigQuery Table
title: Lonely
description: Has a dangling link.
---
Links to [missing](missing.md).
`,
    });
    const { data } = await generate(root);
    expect(data.edges).toEqual([]);
    expect(data.nodes.length).toBe(1);
  });

  test("node colors come from the shared palette by type order", async () => {
    const root = await makeBundle(BUNDLE);
    const { data } = await generate(root);
    const byId = new Map(data.nodes.map((n) => [n.data.id, n.data]));
    // types sorted: BigQuery Dataset, BigQuery Table, Reference
    expect(byId.get("datasets/my_dataset")?.color).toBe(PALETTE[0]);
    expect(byId.get("tables/users")?.color).toBe(PALETTE[1]);
    expect(byId.get("references/metrics/dau")?.color).toBe(PALETTE[2]);
  });

  test("v0.2 signals appear in the graph payload", async () => {
    const root = await makeBundle(BUNDLE);
    const { data } = await generate(root);
    const users = data.nodes.find((n) => n.data.id === "tables/users")?.data;
    if (!users) throw new Error("tables/users node missing");
    expect(users.status).toBe("deprecated");
    // Both a process and a human attestation -> human-reviewed tier.
    expect(users.trust_tier).toBe("human-reviewed");
    // stale_after is in the past -> stale.
    expect(users.stale).toBe(true);
    const generated = users.generated as Record<string, unknown>;
    expect(generated.by).toBe("reference_agent/gemini");
    expect(users.verified as unknown[]).toHaveLength(2);
    const sources = users.sources as Record<string, unknown>[];
    expect(sources[0]?.id).toBe("bq");
  });

  test("throws when the bundle directory is missing", async () => {
    const root = await makeBundle({});
    expect(
      generateVisualization(path.join(root, "nope"), path.join(root, "v.html")),
    ).rejects.toThrow("Bundle directory not found");
  });
});
