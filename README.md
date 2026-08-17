<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/saba-ch/infrawiki/main/docs/logo-dark.svg" />
    <img src="https://raw.githubusercontent.com/saba-ch/infrawiki/main/docs/logo-light.svg" alt="infrawiki" width="480" />
  </picture>
</p>

<p align="center">
  Point infrawiki at your cloud and it writes a wiki of your infrastructure —
  markdown pages in <a href="#the-wiki-it-writes">Open Knowledge Format (OKF)</a> that agents can read, grep, and trust.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/infrawiki"><img src="https://img.shields.io/npm/v/infrawiki" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/infrawiki"><img src="https://img.shields.io/npm/dm/infrawiki" alt="npm downloads" /></a>
  <a href="https://github.com/saba-ch/infrawiki/actions/workflows/ci.yml"><img src="https://github.com/saba-ch/infrawiki/actions/workflows/ci.yml/badge.svg" alt="build" /></a></p>

- **Grounded, not guessed** — every page is written from resources the agent actually inspected. It never invents infrastructure and never writes secrets.
- **Plain markdown** — the wiki is a directory of `.md` files with typed frontmatter. Read it, grep it, commit it, feed it to your coding agent.
- **A real graph** — pages are OKF concepts linked by relationship edges, with trust tiers and freshness built into the format. `infrawiki visualize` renders it interactively.

<p align="center">
  <img src="https://raw.githubusercontent.com/saba-ch/infrawiki/main/docs/visualize.png" alt="infrawiki visualize — interactive OKF graph viewer" />
</p>

---

## Quick start

infrawiki runs on [Bun](https://bun.sh) (the CLI executes TypeScript directly — no build step):

```bash
npm i -g infrawiki
```

Then initialize a wiki in any directory:

```bash
cd your-project
infrawiki init
```

The wizard walks you through:

1. **Model** — pick an LLM provider and sign in (OAuth with your existing Claude / ChatGPT / Copilot subscription, or an API key).
2. **Sources** — connect AWS: pick a profile from `~/.aws`, choose regions, and let the wizard create a Resource Explorer index if one is missing.
3. **Output** — where the wiki lives (default `infrawiki/`).
4. **Instructions** — a brief the agent follows; edit it in `$EDITOR` or accept the default.
5. **Generate** — sources sync, then the agent inventories your resources, inspects them with the AWS CLI, and writes the wiki.

Init is resumable — if you quit halfway, `infrawiki init` picks up where you left off.

When your infrastructure changes, refresh with:

```bash
infrawiki update
```

It re-fetches every source, diffs the new snapshot against the last documented one, and rewrites only the affected pages (and logs the delta in `log.md`).

---

## The wiki it writes

The output is a self-contained OKF v0.2 bundle:

```
infrawiki/
├── index.md            # root navigation + okf_version
├── log.md              # change log, newest first
├── instructions.md     # your brief — the agent never edits it
└── aws/
    ├── index.md
    ├── accounts/706436713848.md
    └── eks/acme-model.md
```

Every concept page carries typed frontmatter, so the wiki doubles as structured data:

```yaml
---
type: aws_account
title: Opsy management account (706436713848)
description: Management AWS account hosting the acme-model EKS platform.
resource: arn:aws:iam::706436713848:root
tags: [706436713848, management]
generated:
  by: infrawiki/gpt-5.6-sol
  at: 2026-08-17
---
```

Links between pages are relationship edges — which is what makes `visualize` possible.

---

## Commands

| Command | What it does |
| --- | --- |
| `infrawiki` | Show the wiki path, state dir, and configured model |
| `infrawiki init` | Initialize a wiki in the current directory (interactive, resumable) |
| `infrawiki update` | Re-fetch sources, diff against the last snapshot, rewrite affected pages |
| `infrawiki visualize` | Render the wiki as an interactive graph and open it (`--no-open` to skip the browser) |

The viewer supports search by title / id / tag, filtering by concept type, multiple layouts, trust and freshness badges, and a light/dark theme toggle.

---

## How it works

- **Connectors and sources.** A connector is an integration (AWS today); a source is a configured instance of one (profile + account + regions). Each `update` snapshots the source's full resource inventory; the agent diffs snapshots to know what changed.
- **The agent loop.** The wiki is written by an LLM agent with `read` / `write` / `edit` / `ls` / `grep` / `find` / `bash` tools, sandboxed to the output directory for writes. It shells out to the AWS CLI to inspect resources beyond the raw inventory, and compacts its own context in-flight on large estates.
- **State.** Project config lives in `infrawiki.json` (no secrets). Credentials, source snapshots, run logs, and `visualize.html` live in a per-project state dir under `~/.infrawiki/projects/` (`auth.json` is chmod 600); set `stateDir` in `infrawiki.json` to keep state in-project instead.

### Providers

| Provider | Auth |
| --- | --- |
| Anthropic | Claude Pro/Max OAuth or API key |
| OpenAI | ChatGPT Plus/Pro OAuth (Codex) or API key |
| GitHub Copilot | Device-code OAuth |
| OpenRouter | OAuth (mints an API key) |
| xAI | SuperGrok / X Premium OAuth or API key |
| Google Gemini | API key |
| Azure OpenAI | API key + resource name |
| OpenAI-compatible | Custom base URL + optional key |

API keys can also be picked up from environment variables.

### Requirements

- **Bun** — the CLI runs from TypeScript source.
- **AWS CLI** with profiles in `~/.aws` — used both for auth and for the agent's deep inspection.
- **AWS Resource Explorer 2** — an index in each region you connect; the init wizard can create local indexes or promote one to aggregator for you.

---

## License

Elastic License 2.0. Portions adapted from other projects — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
