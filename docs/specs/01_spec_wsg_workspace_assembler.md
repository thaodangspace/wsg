---
title: WSG workspace assembler — contracts, runtime spike, explicit-input slice (M1–M2)
tags: [wsg, typescript, node, cli, git, git-worktree, yaml, typebox, sqlite, node-sqlite, pi-durable, llm-agent, crash-recovery, developer-tools]
weight: 01
---

> Canonical product contract: `/Users/dt/code/wsg/docs/spec.md` (repo spec). Roadmap: `/Users/dt/code/wsg/docs/implementation-plan.md`.
> This document scopes **Milestones 1 and 2** of that plan for this delivery, records review findings and decisions, and pins the technical approach. Where this document resolves a gap, the repo spec is patched to match (see "Repo spec patches").

## Problem Statement

A coding agent needs a single directory holding the right repos (as isolated worktrees), docs, and a concise context file; today the user assembles that by hand. M1–M2 deliver a reliable, crash-safe assembler from **explicit** inputs, plus a de-risked runtime for the later autonomous scout.

## Goals & Non-Goals

Goals (this delivery):
- G1. TypeScript/Node CLI `wsg` with config loading, safe slug/path handling, workspace resolution (repo spec §3).
- G2. Version-1 `workspace.yaml` schema: parse, strict validation, serialize (repo spec §5).
- G3. Pi Durable spike proving: SQLite-persisted conversation, one bounded read tool, structured result via terminal tool, restart/resume — with the OpenAI provider configured and the faux provider for CI.
- G4. `wsg create` from `--repo/--doc/--context` (no discovery): worktrees, doc snapshots, URL references, manifest, README, `docs/context.md`, optional `AGENTS.md`/`CLAUDE.md`.
- G5. Writer lock, operation journal, generated-file ownership hashes, `--dry-run`, `--resume`.
- G6. `wsg explain` over the saved manifest (cheap, no model; needed to make M2 usable). *Deviation from plan: plan places explain in M3; here it is a read-only manifest printer and the evidence/exclusion sections stay empty until M3.*

Non-Goals (this delivery): autonomous repo discovery and LLM scouting (M3), `add`/`refresh` (M4), command discovery and wrappers (M5), URL content fetching (M4 — URLs are stored as `mode: reference` only), CI/packaging (M6).

## User Stories / Use Cases

- As a developer, I run `wsg create "port EMR" --name port-emr --repo ~/code/a --repo ~/code/b --doc ~/docs/m.md --for agents,claude` and get `~/wsg/port-emr/` with two worktrees on `wsg/port-emr/<repo>` branches, a snapshot of `m.md`, a manifest, and adapters, then start my coding harness there.
- As a developer whose `create` was interrupted (Ctrl‑C, crash), I run the same command with `--resume` and it completes without duplicate worktrees or overwriting my changes.
- As a developer, I run `wsg create ... --dry-run` and see the destination, repo→path/branch mapping, docs, and gaps, with nothing written to the output root.
- As a developer inside any subdirectory of a WSG (including a worktree), I run `wsg explain` and see the saved repos, docs, context, and gaps.

## Functional Requirements

- FR1 Config: `~/.config/wsg/config.yaml` optional; keys `code_roots`, `workspace_root`, `adapters`, `max_discovered_repos`, `scout.{provider,model}`; strict (unknown keys rejected with message). Precedence CLI > config > defaults. No credential fields; env only.
- FR2 Slugs: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, not `.`/`..`, not a reserved root name (`workspace.yaml README.md AGENTS.md CLAUDE.md docs scripts .wsg`). `--name` wins; otherwise slug derived from the request (deterministic, lowercased, truncated).
- FR3 Workspace resolution for `explain` (and later add/refresh): `--workspace <dir>` or nearest ancestor containing `workspace.yaml`, including from inside a worktree.
- FR4 Manifest: required `version,name,request,repos,docs`; other collections default empty; reject unsupported `version` with a specific message before shape validation; reject unknown fields with `line:col`. Cross-field checks: unique repo `name`/`path`/canonical `source`; relative confined paths; 40-hex `base_commit`; branch valid per `git check-ref-format --branch`; `commands[].cwd` equals a repo `path`. All validation runs **before** any mutation.
- FR5 Repo entries: entry name = source basename; collisions get a stable suffix from a hash of the canonical source path; mapping shown before mutation. Explicit repos: `added_by: user`, `intent: unspecified` (Decision D6), `evidence: []`, `reason: "Explicit repository supplied by the user."`.
- FR6 Worktrees: `git -C <source> worktree add -b wsg/<ws>/<entry> -- <dest> <HEAD sha>`; source branch/working files untouched; dirty source → warning listing that uncommitted changes are not carried over; existing branch or destination → conflict (exit 2) with actionable text; never reset/stash/fetch/pull/prune/remove/force/delete-branch.
- FR7 Docs: local file → snapshot to `docs/<basename>` (collision suffix as FR5), record `source` (realpath), `sha256`, `fetched_at`, `mode: snapshot`. Non-text files copied, marked unread. Unreadable explicit doc → error before mutation. URL → `mode: reference`, reason "Not fetched in this version".
- FR8 Generation: `docs/context.md` (goal, context lines, repo roles/paths/branches/base commits, docs, gaps, "commands discovered, not verified" section empty for now), `README.md` (how to use with a harness), adapters per `--for` (default `agents`; `none` writes neither) that point to `docs/context.md` and state repo-local instructions also apply.
- FR9 Ownership: generated-file hashes kept in `.wsg/operation.json`; regeneration overwrites only unchanged WSG-owned files; a user-edited file is left intact, a `<file>.wsg-new` proposal written, status partial, nonzero exit.
- FR10 Lock + journal: `.wsg/lock` via O_EXCL with `{pid,hostname,startedAt,opId}`; stale lock (same host, dead pid) taken over with warning; otherwise exit 2 naming holder. Journal steps written before each Git/file mutation; manifest published last.
- FR11 Resume: `--resume` requires an existing dir with an incomplete operation of the same name; complete workspace → conflict, never overwrite. Worktree step recovery matrix: absent → retry; registered at recorded dest + HEAD==base + branch matches → adopt; branch at base, unchecked-out, created by this step → `worktree add -- <dest> <branch>`; anything else → conflict report with exact state, no mutation.
- FR12 Dry run: prints plan; creates no worktrees or workspace files; must not create `<root>/<name>`.
- FR13 Explain: prints manifest-derived summary (repos with intent/reason/evidence, docs with mode, exclusions, gaps, commands); works with no network/model and with `.wsg/runtime.sqlite` absent.
- FR14 Exit codes: 0 success; 1 invalid input / unexpected error; 2 conflict or needs-user-decision (prints exact rerun guidance); partial completion (e.g. `.wsg-new` reconciliation) → 3.
- FR15 Spike (M1): standalone under `spikes/pi-durable/`, pinned exact `@earendil-works/pi-durable@1.0.2`, `pi-ai@1.0.2`, `chord@1.0.2`; OpenAI provider wiring via `OPENAI_API_KEY`; test with faux provider: one `replay:"safe"` read tool, terminal `submit_selection` tool (TypeBox, `additionalProperties:false`, returns `control:{terminate:true}`), process killed mid-run and resumed from `runtime.sqlite`. Findings written to `spikes/pi-durable/FINDINGS.md`.

## Non-Functional Requirements

- Performance: create with 2–5 local repos completes in seconds (dominated by `git worktree add`); no network in M2.
- Security: see Security section; all subprocesses via `execFile` (no shell); every path validated before mutation; `.wsg/` mode 0700 with `.gitignore` `*`.
- Observability: concise human output to stdout, warnings/errors to stderr; `WSG_DEBUG=1` prints executed git argv; journal records each step with status for post-mortem.
- Maintainability: single package, modules per repo spec §11 plan layout; strict TypeScript; no framework; selection/manifest logic callable without an LLM.
- Portability: Node `>=24` (engines), macOS + Linux; paths with spaces supported.

## Technical Approach

- Language/runtime: TypeScript, Node ≥24 (local 25.9), npm. ESM, `tsc` (`module nodenext`, `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`) → `dist/`, `bin: wsg → dist/cli.js`.
- Tests: `node:test` + `node:assert/strict` running `.ts` via Node type stripping; real temp git repos via `execFile`. No vitest/tsx.
- CLI: `node:util.parseArgs` + small dispatcher; hand-written help.
- Schema: `typebox@1.3.27` (same pin as Pi) for config, manifest, and later scout tool payloads; cross-field rules hand-written. YAML: `yaml@2.x` `parseDocument` + `LineCounter` for positioned errors, duplicate keys rejected; `stringify` with stable key order and block scalar `request`.
- Scout seam: `src/scout.ts` defines `Scout`/`ScoutResult` (`selection | ambiguous | none`); M2 ships `ExplicitScout` only. Pi packages are not dependencies of the main package until M3; `PiScout` will be dynamically imported.
- Journal/lock/ownership: single `.wsg/operation.json` `{version:1, owned:{path:{sha256,generatedAt}}, operation:{id,command,status,args,steps[]}|null}`, written tmp+fsync+rename. Generated files staged in `.wsg/tmp/<opId>/`, renamed in order snapshots → context → adapters → README → `workspace.yaml` last.
- Modules: `cli.ts, config.ts, slug.ts/paths.ts, manifest.ts, git.ts, operation.ts (lock+journal), materialize.ts, documents.ts, generate.ts, scout.ts, create.ts, explain.ts`.

## Security

- Path containment: realpath sources; materialized paths relative, normalized, no `..`, no `\`, no NUL, resolved inside workspace. Docs copied only if realpath is a regular file; refuse secret-like files (`.env`, `id_rsa`, `BEGIN PRIVATE KEY`) with exit 1 and a message (D7).
- Git: `execFile("git", ["-C", src, ...])`, `--` before paths, reject refs/paths starting with `-`, `rev-parse --verify <sha>^{commit}`, env sanitized (`GIT_DIR`/`GIT_WORK_TREE` unset, `GIT_TERMINAL_PROMPT=0`).
- Credentials: never in config/manifest (strict schemas reject unknown keys); runtime.sqlite documented as possibly containing repo snippets.

## Edge Cases & Error Handling

- Source path not a git repo / is bare / has unborn HEAD → exit 1 before mutation.
- Same source given twice (different spellings) → dedupe by realpath.
- Two sources with same basename → suffixed entries, mapping printed.
- Target `<root>/<name>` exists and complete → exit 2; exists incomplete without `--resume` → exit 2 suggesting `--resume`.
- Branch `wsg/<ws>/<entry>` already exists (e.g. name reused after manual deletion) → exit 2 with manual cleanup commands printed (`git worktree prune`, `git branch -D` — printed, never run).
- Lock held by live process → exit 2.
- Crash between worktree add and journal update → resume adopts per matrix.
- Crash between generated-file renames and manifest → resume regenerates (owned hashes guard user edits).
- Submodules / LFS in source → recorded as gaps, no download.
- Source path with spaces / unicode → supported and tested.

## Decisions (from review, user-confirmed 2026-10-05)

- D1 Repo `docs/spec.md` stays canonical; this doc scopes and annotates it.
- D2 Delivery scope: Milestones 1–2.
- D3 Initial scout provider: OpenAI (configured via `scout.provider: openai`, `OPENAI_API_KEY`); faux provider in tests.
- D4 No interactive prompts: ambiguity / dirty-only evidence / conflicts stop with candidates and exact rerun command, exit 2. `--allow-dirty-evidence` flag reserved for M3.
- D5 Scout runtime: Pi Durable (pinned 1.0.2), gated by spike; fallback is direct OpenAI SDK + `node:sqlite` checkpoint if spike fails.
- D6 Explicit repo `intent`: `unspecified` by default (schema enum `source|target|reference|shared|unspecified`), since explicit inputs carry no role; user may edit. *(Proposed — confirm in review.)*
- D7 Secret-like doc snapshot: refuse with exit 1. *(Proposed — confirm in review.)*

## Repo spec patches (applied by implementer in Phase 1)

- §3: document exit codes (FR14) and no-prompt behaviour (D4); `--allow-dirty-evidence` (M3).
- §4/§7: note there is no `wsg remove` in the MVP; document manual teardown (`git worktree remove`, `git branch -D wsg/<ws>/<repo>`) and that reusing a name requires it.
- §5: add `intent` enum incl. `unspecified`.
- §10 open item for M4: user-edited snapshot + changed source → `<snapshot>.wsg-new`, partial result (to confirm at M4).
- Plan: Node baseline `>=24` (spike confirms 25.x); `explain` moved into M2 as manifest printer.

## Assumptions & Risks

- A1 `node:sqlite` ExperimentalWarning is acceptable; filter only that warning. Risk: API change → spike pins Node range.
- A2 Pi Durable API is experimental; exact pins; isolated behind `Scout` so failure only affects M3.
- A3 pi-ai pulls all provider SDKs (install weight) — accepted for M3; not a main-package dep in M2.
- R1 Git worktree semantics vary by version — tests use real git; min git version check (≥2.38) at startup.
- R2 Crash recovery correctness — covered by fault-injection tests (env hook `WSG_FAULT=after-worktree:<n>` in test builds only).

## Out of Scope (explicitly)

Discovery, LLM scouting, `add`, `refresh`, URL fetching, command discovery/wrappers, CI/packaging, nested workspaces, orchestration, remote clone, connectors, embeddings, `wsg remove`.
