# WSG

WSG takes a task and builds the smallest local filesystem workspace that gives a coding agent enough context to work on it.

For example, a request to “port EMR mono to modular for the new system” becomes `~/wsg/port-emr/`, containing relevant Git worktrees, supplied and discovered documents, a `workspace.yaml`, optional agent instructions, and useful validation scripts.

WSG scouts and assembles the workspace. The coding harness of your choice does the implementation.

## Design and delivery

- [MVP specification](docs/spec.md): behavior, CLI, manifest, discovery, worktrees, and context updates.
- [Implementation plan](docs/implementation-plan.md): milestones, acceptance checks, and the first usable vertical slice.
- [M1–M2 delivery spec](docs/specs/01_spec_wsg_workspace_assembler.md) and [phase plan](docs/specs/01_impl_wsg_workspace_assembler.md): scoped decisions and phase-by-phase execution for the first usable release.

Status: M1–M2 in progress. Package scaffold, CLI skeleton, and specification patches implemented; see [phase plan](docs/specs/01_impl_wsg_workspace_assembler.md).

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

## Inspiration

[Pi Durable](https://earendil.com/posts/pi-durable/) provides the starting point for a resumable scout harness. The portable workspace remains usable without that runtime.
