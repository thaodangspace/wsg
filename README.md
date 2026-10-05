# WSG

WSG takes a task and builds the smallest local filesystem workspace that gives a coding agent enough context to work on it.

For example, a request to “port EMR mono to modular for the new system” becomes `~/wsg/port-emr/`, containing relevant Git worktrees, supplied and discovered documents, a `workspace.yaml`, optional agent instructions, and useful validation scripts.

WSG scouts and assembles the workspace. The coding harness of your choice does the implementation.

## Design and delivery

- [MVP specification](docs/spec.md): behavior, CLI, manifest, discovery, worktrees, and context updates.
- [Implementation plan](docs/implementation-plan.md): milestones, acceptance checks, and the first usable vertical slice.
- [M1–M2 delivery spec](docs/specs/01_spec_wsg_workspace_assembler.md) and [phase plan](docs/specs/01_impl_wsg_workspace_assembler.md): scoped decisions and phase-by-phase execution for the first usable release.

Status: **Milestones 1–3 implemented.** Config, slugs/paths, manifest, documents, ownership reconciliation, `wsg create` (including `--dry-run`), `--resume`, fault-injection recovery, `wsg explain`, and the Milestone 3 local scout harness are implemented. `add` and `refresh` are planned for Milestone 4. See [phase plan](docs/specs/01_impl_wsg_workspace_assembler.md).

```bash
# Explicit inputs (no model or credentials required):
wsg create "port EMR mono to modular for new system" --name port-emr \
  --repo ~/code/legacy-platform --repo ~/code/new-platform
cd ~/wsg/port-emr
wsg explain      # read-only: saved repos, docs, exclusions, gaps, commands
codex # or claude / pi

# Autonomous discovery (no --repo): one read-only Pi Durable scout conversation
# enumerates code roots, gathers evidence, and selects the smallest useful set.
wsg create "port EMR mono to modular for new system" --name port-emr --code-root ~/code

# Combined: explicit --repo inputs are always included (outside the roots and
# without evidence), while --code-root also scouted for dependencies.
wsg create "port EMR mono to modular for new system" --name port-emr \
  --repo ~/code/new-platform --code-root ~/code

# Planned (Milestone 4):
# wsg add ~/code/emr-importer
# wsg add ~/docs/emr-migration.md
# wsg refresh
```

## Local Scouting (Milestone 3)

`create` runs one bounded, read-only scout conversation when it is called
without `--repo`, or whenever `--code-root` is supplied. It enumerates Git
repositories under the code roots (default `~/code`), reads
READMEs/manifests/agent instructions, runs bounded `rg` searches, and resolves
local document mentions. The scout has no write, Git mutation, install, or
arbitrary shell tool, and repository instructions are treated as data rather
than authority.

Selection is evidence-based: every automatically discovered repository must
cite a repository-relative file that retrieval or a read/search tool actually
observed, with a quoted snippet verified against the file. Unseen or fictional
evidence stops the run with an actionable error. The scout selects at most
`max_discovered_repos` (default 5) automatically discovered repositories;
explicit `--repo` inputs are always included, are not counted against the cap,
and need no evidence. Selections that name more than one target are reported as
ambiguous (exit 2) and never materialize an arbitrary target.

Scout tool/read/search budgets are finite and durably accounted
(`scout-budget.json`), so an uncooperative model is stopped deterministically
and a resumed run continues the same accounting. Scout state is checkpointed
under `<workspace-root>/.wsg-scout/<name>/` using real SQLite persistence, and
copied into `.wsg/` after a successful assembly. Resume refuses to replay a
selection when the request, context, documents, code roots, or repositories
changed.

`--dry-run` shows the plan without creating the target workspace. Discovery
caches runtime state outside the target. If the pinned Pi Durable packages are
not installed, autonomous scouting reports the blocker and explicit `--repo`
creation (without `--code-root`) still works offline.


Each feature gets an independent directory. There are no nested workspace groups or workspace orchestration in the MVP.

## Inspecting a Workspace

`wsg explain` is a read-only manifest printer. It resolves the nearest ancestor `workspace.yaml` (or accepts `--workspace <dir>`), then prints the request, repositories (intent, reason, and evidence), documents and their modes, exclusions, gaps, and discovered commands.

```bash
wsg explain                 # from anywhere inside a workspace or worktree
wsg explain repo-name       # limit the report to one repository
wsg explain --workspace ~/wsg/port-emr
```

It makes no model or network call, never invokes Git, and never reads `.wsg/`, so a completed workspace stays inspectable after its runtime storage is removed.

## Development

Prerequisites:
- Node `>=24`
- npm
- Git

Install dependencies:

```bash
npm install
```

Typecheck:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Run CLI:

```bash
node dist/cli.js --help
node dist/cli.js --version
```

## Workspace Safety & Locking

WSG enforces strict filesystem safety and concurrency boundaries during workspace creation and modification:

- **Writer Lock (`.wsg/lock`)**: Created with `O_EXCL` and mode `0600` containing process ID, hostname, timestamp, and an acquisition token.
- **Stale Lock Takeover**: Stale locks from demonstrably dead processes (`ESRCH`) on the same local host are automatically taken over with a warning. Live processes and foreign-host locks fail closed with conflict exit code 2.
- **Reclamation Guard (`.wsg/reclaim.lock`)**: Stale lock reclamation is serialized using an exclusive guard to prevent multiple concurrent reclaimers from racing and unlinking newly acquired locks.
- **Exceptional Recovery Limitation**: If a process crashes or is forcefully terminated while holding `.wsg/reclaim.lock`, WSG fails closed with exit code 2 and actionable manual recovery guidance rather than automatically overwriting the guard (which would reintroduce reclaimer races). Once the user verifies no other process is active and manually removes `.wsg/reclaim.lock`, subsequent runs automatically resume normal stale takeover of the main lock.

## Resuming an Interrupted Create

If `wsg create` is interrupted (Ctrl-C, crash, or any exit before `workspace.yaml` is published), rerun the same command with `--resume`:

```bash
wsg create "port EMR mono to modular" --name port-emr --repo ~/code/a --repo ~/code/b --resume
```

`--resume`:

- Requires an existing workspace directory for the same `--name` with an incomplete `create` operation and no `workspace.yaml`. An absent directory exits 1; a completed workspace exits 2 and is never overwritten.
- Compares the supplied `--name`, request, `--repo` set, `--doc` set, `--context`, and `--for` against the recorded plan. Any mismatch exits 2 with a diff (added/missing repositories or documents).
- Uses the recorded base commits, document hashes, unread metadata, and context, so it never rebuilds the plan from source state that changed after the crash. A missing snapshot is restored only from its recorded hash; if the source changed it is reported as a conflict rather than silently rebuilt.
- Never overwrites a user-edited snapshot: the edit is left intact, the recorded bytes are written to a nonclobbering `<path>.wsg-new` proposal (a preexisting proposal is preserved and a numbered sibling is used), and the run exits 3. If the snapshot was edited *and* its source changed, the recorded bytes cannot be reproduced and the resume fails closed with exit 2 before further mutation.
- Recovers each worktree with a fixed matrix and **no destructive Git** (no `reset`, `stash`, `fetch`, `pull`, `prune`, `remove`, `force`, or branch deletion):
  - branch and destination absent → create the worktree and branch;
  - registered at the recorded destination with matching branch and base commit → adopt it;
  - branch (verifiably created by this operation) at the base commit, unchecked-out, destination absent → `git worktree add` on the existing branch;
  - anything else (branch moved, destination registered on a different branch, destination is a plain directory, pre-existing branch) → conflict exit 2 that reports the observed and expected state *before* any Git mutation.
- Regenerates `docs/context.md`, adapters, and `README.md` under the ownership rules: unchanged WSG-owned files are overwritten, a user-edited file is left intact, and `<file>.wsg-new` is written; the run exits 3 when generated files need reconciliation.
- Publishes `workspace.yaml` last.
- Resolves the staging directory (`.wsg/tmp/<operation-id>/`) from the workspace root before any mutation, so a symlinked staging directory that escapes the workspace is rejected and staging writes/cleanup can never occur outside it.

## Manual Teardown

There is no `wsg remove` in the MVP. To reuse a workspace name, tear the workspace down manually:

1. Remove each worktree: `git worktree remove <path>`
2. Delete each workspace branch: `git branch -D wsg/<workspace-name>/<repo-entry-name>`
3. Delete the workspace directory.

## Fault Injection (test hook)

`WSG_FAULT=<name>[:<n>]` makes WSG exit with code 70 on the `n`th hit of a fault point (default 1). It exists only to test crash recovery with real processes and is not needed for normal use.

- `after-lock` — after the write lock and operation journal are persisted.
- `after-worktree` — after a worktree is created, before its step is marked done.
- `after-generate` — after generated files are reconciled, before `workspace.yaml` is published.

## Inspiration

[Pi Durable](https://earendil.com/posts/pi-durable/) provides the starting point for a resumable scout harness. The portable workspace remains usable without that runtime.
