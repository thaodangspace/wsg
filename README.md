# WSG

WSG takes a task and builds the smallest local filesystem workspace that gives a coding agent enough context to work on it.

For example, a request to “port EMR mono to modular for the new system” becomes `~/wsg/port-emr/`, containing relevant Git worktrees, supplied and discovered documents, a `workspace.yaml`, optional agent instructions, and useful validation scripts.

WSG scouts and assembles the workspace. The coding harness of your choice does the implementation.

## Design and delivery

- [MVP specification](docs/spec.md): behavior, CLI, manifest, discovery, worktrees, and context updates.
- [Implementation plan](docs/implementation-plan.md): milestones, acceptance checks, and the first usable vertical slice.
- [M1–M2 delivery spec](docs/specs/01_spec_wsg_workspace_assembler.md) and [phase plan](docs/specs/01_impl_wsg_workspace_assembler.md): scoped decisions and phase-by-phase execution for the first usable release.

Status: M1–M2 in progress. Config, slugs/paths, manifest, documents, ownership reconciliation, `wsg create` (including `--dry-run`), `--resume`, and fault-injection recovery are implemented; `explain` is pending. See [phase plan](docs/specs/01_impl_wsg_workspace_assembler.md).

```bash
wsg create "port EMR mono to modular for new system" --name port-emr
cd ~/wsg/port-emr
wsg add ~/code/emr-importer
wsg add ~/docs/emr-migration.md
wsg explain
codex # or claude / pi
```

Each feature gets an independent directory. There are no nested workspace groups or workspace orchestration in the MVP.

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
