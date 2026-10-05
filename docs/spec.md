# WSG MVP specification

Status: proposed implementation contract. No CLI is implemented yet.

## 1. Product goal

Given a feature request, scout local code and relevant documents, then assemble one directory from which a coding agent can work.

The reference use case is:

> Port EMR from the monolith into the modular architecture of the new system.

The user should not have to identify every repository, collect every useful document, or manually prepare worktrees before starting a coding harness.

The public model is intentionally small: **one task → one WSG directory**. Users can have many independent WSG directories, including directories that use separate worktrees of the same repository. There is no parent group, child workspace, resource lifecycle, or coordination graph.

WSG prepares context and filesystem layout. It does not implement the feature or launch a coding harness automatically.

## 2. MVP scope

Required capabilities:

- Accept a natural language task with optional repository, document, and context hints.
- Scout Git repositories under configured code roots, defaulting to `~/code`.
- Use local supplied documents and relevant document mentions as discovery inputs.
- Select repositories using concrete evidence and explain both selection and meaningful exclusions.
- Create isolated Git worktrees directly inside `~/wsg/<name>`, with a configurable output root.
- Write a portable `workspace.yaml`, concise context, and optional `AGENTS.md` / `CLAUDE.md` adapters.
- Discover useful validation commands and optionally generate wrappers for known commands.
- Attach another repository, file, script, or URL later; update context without rebuilding existing worktrees.
- Refresh documents and generated context without changing repository branches or revisions.
- Recover an interrupted operation without duplicating worktrees or overwriting user changes.

Out of scope: remote repository discovery/cloning, Jira/Linear/wiki authentication connectors, embeddings, a persistent repository catalog, nested workspaces, multi-agent orchestration, automatic feature implementation, and automatically generated tool/subagent installations. Record useful tool recommendations as notes; installation is future work.

## 3. User workflow and CLI

```bash
wsg create "port EMR mono to modular for new system" \
  --name port-emr \
  --repo ~/code/legacy-platform \
  --doc ~/docs/emr-migration.md \
  --context "The target uses patient-service module boundaries" \
  --for agents,claude

cd ~/wsg/port-emr
wsg explain
wsg add ~/code/emr-importer
wsg add ~/docs/mapping-notes.md
wsg add https://internal-wiki.example/emr
wsg add ./reproduce-timeout.sh --as script
wsg refresh
wsg refresh docs/emr-migration.md
```

| Command | Contract |
| --- | --- |
| `create <request>` | Scout, select, assemble, and print the workspace location and evidence summary. |
| `add <path-or-url>` | Attach an explicit input to an existing WSG and regenerate affected context. |
| `refresh [doc-path-or-url]` | Update selected document snapshots and generated context; with no argument, refresh all documents. |
| `explain [repo-name]` | Show saved selection evidence, exclusions, unresolved inputs, and validation gaps; no model call required. |

`create` supports repeatable `--code-root`, `--repo`, `--doc`, and `--context`; also `--name`, `--root`, `--for`, `--dry-run`, `--resume`, and `--allow-dirty-evidence` (reserved M3).

- `--name` wins over a suggested slug. Slugs are safe single directory names; reject traversal, separators, empty names, and reserved output names.
- `--root` overrides the WSG output root, not the code roots.
- `--for agents` is the default; `agents,claude` writes both adapters and `none` writes neither.
- `--dry-run` shows the proposed output, repos, documents, commands, and gaps without creating worktrees or workspace files. Model/runtime caching outside the target is allowed and documented.
- `--resume` requires the same named interrupted operation. An existing complete workspace is a conflict, never an implicit overwrite.
- `--allow-dirty-evidence` (reserved M3) allows proceeding when evidence relies on uncommitted or dirty source changes.

WSG operates non-interactively and adheres to a strict no-prompt statement: ambiguity, dirty-only evidence, or conflicts stop execution with candidates, reasons, and an exact rerun command (exit code 2).

### Exit-code table

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Invalid input or unexpected error |
| `2` | Conflict or needs-user-decision (prints exact rerun guidance) |
| `3` | Partial completion (e.g. `.wsg-new` reconciliation) |


`add`, `refresh`, and `explain` accept `--workspace <directory>`. Otherwise resolve the nearest ancestor containing `workspace.yaml`, including when called inside a repo worktree. Relative inputs to `add` resolve against the caller's current directory before copying.

Configuration is optional, in `~/.config/wsg/config.yaml`:

```yaml
code_roots: [~/code]
workspace_root: ~/wsg
adapters: [agents]
max_discovered_repos: 5
scout:
  provider: openai
  model: YOUR_MODEL_ID
```

Precedence: CLI options > config > defaults. Credentials use the provider's environment/configuration, never the workspace manifest. Provider and model are explicit configuration choices; no specific vendor or model is part of the workspace format.

## 4. Output layout

```text
~/wsg/port-emr/
├── workspace.yaml
├── README.md
├── AGENTS.md                 # when selected
├── CLAUDE.md                 # when selected
├── legacy-platform/          # worktree
├── new-platform/             # worktree
├── shared-health-model/      # worktree
├── docs/
│   ├── context.md             # generated task/repo/doc/validation summary
│   └── emr-migration.md       # snapshot of supplied document
├── scripts/
│   └── test-new-platform.sh   # only when a concrete command is known
└── .wsg/
    ├── runtime.sqlite         # scout transcript/checkpoints; disposable for use
    └── operation.json         # filesystem recovery and generated-file ownership
```

The repository names are illustrative, not assumptions about the user's actual code.

Root entries `workspace.yaml`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs`, `scripts`, and `.wsg` are reserved. Resolve basename collisions with a stable suffix derived from the canonical source path, and show the mapping before mutation.

Note on workspace removal: there is no `wsg remove` in the MVP (no-remove + manual teardown note). To tear down an assembled workspace manually:
1. Remove Git worktrees: `git worktree remove <path>`
2. Delete workspace branches: `git branch -D wsg/<workspace-name>/<repo-entry-name>`
3. Delete the workspace directory.
Reusing an existing workspace name requires manual teardown first; an existing complete workspace is a conflict, never an implicit overwrite.

## 5. Manifest contract

`workspace.yaml` is the human-readable source of truth for the assembled workspace. Runtime storage is orchestration state, not a requirement for understanding or using the workspace.

Example; commit and hash values below are placeholders:

```yaml
version: 1
name: port-emr
request: |
  Port EMR from the monolith to the modular architecture of the new system.
context:
  - The target uses patient-service module boundaries.
adapters: [agents, claude]

repos:
  - name: legacy-platform
    source: /home/user/code/legacy-platform
    path: legacy-platform
    base_commit: FULL_GIT_COMMIT_SHA
    branch: wsg/port-emr/legacy-platform
    intent: reference
    added_by: scout
    reason: Owns the current EMR implementation.
    evidence:
      - file: src/emr/MedicalRecord.ts
        lines: [12, 48]
        summary: Defines the source MedicalRecord model.
  - name: new-platform
    source: /home/user/code/new-platform
    path: new-platform
    base_commit: FULL_GIT_COMMIT_SHA
    branch: wsg/port-emr/new-platform
    intent: target
    added_by: user
    reason: Explicit target repository supplied by the user.
    evidence: []

docs:
  - source: /home/user/docs/emr-migration.md
    path: docs/emr-migration.md
    mode: snapshot
    added_by: user
    sha256: SNAPSHOT_CONTENT_HASH
    fetched_at: ISO_8601_TIMESTAMP
    reason: Supplied migration proposal.
  - source: https://internal-wiki.example/emr
    mode: reference
    added_by: user
    reason: Authentication required; content not fetched.

scripts: []
commands:
  - name: test-new-platform
    cwd: new-platform
    argv: [npm, run, test]
    evidence: package.json scripts.test
    wrapper: scripts/test-new-platform.sh

discovery:
  excluded:
    - source: /home/user/code/billing-service
      reason: EMR mention is incidental; no matching implementation found.
  gaps:
    - No verified cross-repository migration test was found.
```

Required top-level fields: `version`, `name`, `request`, `repos`, and `docs`. Other collections default to empty. Reject unsupported schema versions and unknown fields with an actionable message, rather than silently discarding edits.

Validate paths, unique repo identities, branch names, full commit identifiers, and command working directories before mutation. Materialized paths are relative and confined to the workspace; source paths are canonical absolute paths. Relocating the workspace preserves context usability, but Git worktree administration may need repair and original source repos must remain available.

Explicit user attachments remain selected through refresh. `added_by` records origin only; it does not introduce pinned states or lifecycle management. Repository `intent` uses the enum `source | target | reference | shared | unspecified` (intent enum with unspecified). Explicitly supplied repositories default to `unspecified` because explicit inputs carry no inferred role; users or scouts may update intent later. `intent` guides coding agents and does not enforce filesystem read-only access.

## 6. Scout behavior

The pipeline is `understand → retrieve evidence → select → materialize → configure`.

1. Extract task concepts, identifiers, likely symbols, explicit paths/URLs, and source/target hints.
2. Enumerate Git repo roots under configured code roots. Recognize `.git` directories and worktree `.git` files; deduplicate canonical paths. Ignore build/vendor directories, avoid symlink loops, and do not traverse outside configured roots automatically.
3. Read README files, manifests, existing agent instructions, and bounded `rg` matches. Expand searches to concrete symbols and package relationships only when supported by evidence. Track the revision and any dirty-file basis of evidence.
4. Resolve supplied documents. Follow relevant local document mentions within code roots or explicitly supplied document roots, and URLs at most one hop from an input. Use finite file, byte, link, and model/tool-turn budgets; report when a limit reduces coverage.
5. Ask one scout conversation to produce a structured selection with reasons and evidence. Validate every cited repo, file, and line range against retrieved data. A numeric confidence alone is insufficient evidence.
6. Select the smallest useful repo set. Default to at most five automatically discovered repos; explicit repo inputs are included separately and deduplicated. Explain the cap when it leaves likely dependencies out.

Auto-selection proceeds when evidence is sufficient. If the source/target system is ambiguous, ask a focused question or return candidates without creating worktrees. Do not arbitrarily pick the target. If no useful repo is found, return an actionable discovery result and create no completed workspace.

A user-supplied repo path is an explicit inclusion. Repo names embedded in prose are strong hints, not proof that a matching repo is the correct one. Distinguish facts, inferred purpose, and unresolved questions in output.

The scout has bounded read/search/document-fetch tools. It has no general write, Git mutation, installation, or arbitrary shell tool. Source documents and repo instructions are context, not authority to expand tool permissions.

## 7. Repository materialization

- Use `git worktree add` with a new branch per workspace/repo, from the resolved source `HEAD` commit.
- Branch convention: `wsg/<workspace-name>/<repo-entry-name>`; validate with Git and report collisions rather than reusing an unrelated branch.
- Record the source path, exact base commit, branch, and destination before invoking Git.
- Preserve the source checkout's branch and working files. Dirty changes are not silently copied into the new worktree: warn if relevant evidence came from uncommitted files and require committed evidence or an explicit user decision before relying on it.
- No source checkout reset, automatic stash, fetch, pull, branch deletion, or force operation.
- Treat submodules and Git LFS requirements as setup gaps; no automatic downloads in the MVP.
- Multiple independent WSGs can use the same source repo on different branches.

Filesystem operations use a per-workspace writer lock and a persisted operation journal. Before retrying a worktree step, inspect Git's worktree metadata, branch, destination, and recorded base commit. Reuse only an exact match owned by that operation; otherwise stop with a conflict report.

Write temporary generated files and rename them into place. Publish the manifest last after successful materialization. For `add` and `refresh`, preserve the previous manifest until success. The journal supports recovery when generated files and the manifest were interrupted between renames; this is not a claim of an atomic transaction spanning Git and files.

On failure, keep resumable partial state and print the recovery command. Never delete modified worktrees during recovery. Do not report a workspace complete until every selected repo is materialized and context is reconciled.

## 8. Documents, scripts, and validation

For local documents, copy a snapshot and record source, hash, and fetch time. Preserve supplied files rather than rewriting their content. Read plain text/Markdown for scout reasoning; other formats may be attached as opaque files and explicitly marked unread by the scout in v1.

For URLs, snapshot supported accessible text when possible. For authenticated, unsupported, or unavailable sources, keep the URL as a reference and report the gap. Do not pretend that reference content was read. No site login or credential capture is required in v1.

Explicit `add` failure to read a local file is an error. An inaccessible discovered document is a reported gap. URL attachments can succeed as references.

Detect validation commands from manifests and documented scripts. Store command `cwd`, argument vector, and provenance. Existing repository scripts remain in the worktree; explicit external script attachments are copied into `scripts/` with source/hash metadata. Generated wrappers use fixed validated commands and correctly quoted paths, work from any current directory, and propagate exit status.

Do not invent a migration verification script from the feature name. If no useful test exists, state the gap. Do not run tests, copied scripts, dependency installs, or project bootstrap during workspace creation. A summary labels commands as discovered, not verified by execution.

## 9. Generated agent context

Generate `docs/context.md` from the manifest and saved evidence. Include the goal, repo roles and paths, relevant documents, known validation commands, and unresolved questions. Keep source files linked and the summary concise; copying all repo instructions into one prompt is unnecessary.

`AGENTS.md` and `CLAUDE.md` are small adapters directing the coding harness to the same context document. Generate only selected adapters. State that repository-local instructions also apply when working within each repo.

One generator owns the canonical context; adapters never maintain independent task descriptions. `README.md` explains how to use the assembled directory with the user's coding harness.

Track hashes of generated files. On later generation, overwrite only unchanged WSG-owned output. If the user edited an adapter or context file, leave it intact, write a `.wsg-new` proposal, and report that context regeneration needs reconciliation. Do not silently mark that refresh fully complete. User-maintained notes should be attached as separate documents.

## 10. Incremental updates

`add` uses the same resolver, materializer, and generator as `create`. A repo attachment creates only its new worktree. A document or script attachment creates only its snapshot. Duplicate canonical sources are no-ops; a reference can be upgraded to a snapshot when it becomes readable.

`refresh` updates readable snapshots and regenerated context. It preserves user edits to snapshots by detecting hash differences, leaves failed sources at their last successful version, and reports per-source results. It does not rescout all code, prune repositories, change Git revisions, or replace working files. Another repo is added explicitly using `add` in v1.

§10 M4 open item: user-edited snapshot + changed source → `<snapshot>.wsg-new`, partial result (to confirm in M4 design). When a user-edited snapshot has also changed at its source, write `<snapshot>.wsg-new` and report a partial result (exit code 3).

The CLI reports completion, conflicts, partial refreshes, and unresolved references clearly. Invalid input and conflicts have nonzero exit status. An ordinary reference attachment is successful with a reported limitation; a failed requested refresh is nonzero while retaining prior usable context.

## 11. Runtime and implementation shape

Proposed implementation: one TypeScript/Node CLI package with modules for config, discovery, scout, manifest, materialization, documents, and generation. Avoid a multi-package framework until usage justifies it.

Use Pi Durable for one resumable scout conversation and its bounded tools. Save the conversation and planning state locally. Keep filesystem/Git mutation in deterministic application code, reconciled with the operation journal before replay. Read-only scout calls may be replayed; external mutations require explicit idempotency checks.

Pi's storage transaction does not make filesystem operations atomic. A generated workspace must remain understandable and usable when runtime storage is absent.

## 12. MVP acceptance

The MVP is complete when an EMR-like fixture containing a source repo, modular target repo, shared model repo, unrelated repo, and a migration document can produce a useful WSG from a task plus hints:

1. Selected repos have checked evidence; the unrelated repo is excluded with a reason.
2. Worktrees use distinct branches and leave source checkout changes untouched.
3. The workspace includes a valid manifest, document snapshots, context, and selected adapters.
4. Discovered commands retain provenance; no validation result is fabricated.
5. `add` attaches one more repo/doc/script/reference without recreating existing worktrees.
6. `refresh` updates context while preserving dirty repos, user attachments, and edited generated files.
7. Interrupted assembly can resume without duplicate worktrees or silent conflicts.
8. `explain` works with the model offline, and a coding harness can use the directory without Pi runtime storage.

## References

- [Pi Durable introduction](https://earendil.com/posts/pi-durable/): framework inspiration for conversations, tools, and resumable tasks.
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md): implementation reference; the API is experimental, so pin and verify the chosen version during the runtime spike.
