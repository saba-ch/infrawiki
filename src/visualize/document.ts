// Vendored from GoogleCloudPlatform/knowledge-catalog
// (okf/src/reference_agent/bundle/document.py), Apache License 2.0.
// See THIRD_PARTY_NOTICES.md.
// Modified: TypeScript port; YAML parsing via Bun.YAML; parse failures return
// null instead of raising, so the walker can skip malformed pages.

/**
 * A raw frontmatter mapping as parsed from a page's YAML block.
 */
export type Frontmatter = Record<string, unknown>;

/**
 * A parsed OKF page: its frontmatter mapping and markdown body.
 */
export interface OKFDocument {
  frontmatter: Frontmatter;
  body: string;
}

const FRONTMATTER_DELIM = "---";

/**
 * Parse a page into frontmatter and body. A page without a leading `---` line
 * has empty frontmatter. Returns null for an unterminated or invalid block.
 */
export function parseDocument(text: string): OKFDocument | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    return { frontmatter: {}, body: text };
  }
  const endIdx = lines.findIndex(
    (line, i) => i > 0 && line.trim() === FRONTMATTER_DELIM,
  );
  if (endIdx === -1) return null;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(lines.slice(1, endIdx).join("\n")) ?? {};
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  let body = lines.slice(endIdx + 1).join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  return { frontmatter: parsed as Frontmatter, body };
}

/**
 * An actor event, e.g. one `generated` or `verified` entry: `{ by, at }`.
 */
export type ActorEvent = Record<string, unknown>;

/**
 * Return the `verified` events as a list (OKF v0.2 §5.2).
 *
 * A single verifier MAY be written as one `{ by, at }` mapping without the
 * list dash; consumers MUST treat a bare mapping as a one-element list.
 */
export function normalizeVerified(frontmatter: Frontmatter): ActorEvent[] {
  const verified = frontmatter.verified;
  if (verified === null || verified === undefined) return [];
  if (Array.isArray(verified)) {
    return verified.filter(
      (v): v is ActorEvent => typeof v === "object" && v !== null,
    );
  }
  if (typeof verified === "object") return [verified as ActorEvent];
  return [];
}

/**
 * Derive a concept's trust tier from `verified` (OKF v0.2 §5.3).
 *
 * - No `verified` key ⇒ "unverified".
 * - `verified` by non-`human:` actors only ⇒ "machine-confirmed".
 * - `verified` by a `human:<id>` actor ⇒ "human-reviewed".
 */
export function trustTier(frontmatter: Frontmatter): string {
  const events = normalizeVerified(frontmatter);
  if (events.length === 0) return "unverified";
  for (const event of events) {
    if (String(event.by ?? "").startsWith("human:")) return "human-reviewed";
  }
  return "machine-confirmed";
}

/**
 * Whether a concept is stale per `stale_after` (OKF v0.2 §5.5).
 *
 * A concept is stale when `today >= stale_after`. Returns false when
 * `stale_after` is absent or unparseable.
 */
export function isStale(frontmatter: Frontmatter, today = new Date()): boolean {
  const raw = frontmatter.stale_after;
  if (!raw) return false;
  const staleAfter = new Date(String(raw).slice(0, 10));
  if (Number.isNaN(staleAfter.getTime())) return false;
  const day = new Date(today.toISOString().slice(0, 10));
  return day.getTime() >= staleAfter.getTime();
}
