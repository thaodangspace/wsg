# WSG

WSG takes a task and builds the smallest local filesystem workspace that gives a coding agent enough context to work on it.

For example, a request to “port EMR mono to modular for the new system” becomes `~/wsg/port-emr/`, containing relevant Git worktrees, supplied and discovered documents, a `workspace.yaml`, optional agent instructions, and useful validation scripts.

WSG scouts and assembles the workspace. The coding harness of your choice does the implementation.

## Design and delivery

- [MVP specification](docs/spec.md): behavior, CLI, manifest, discovery, worktrees, and context updates.
- [Implementation plan](docs/implementation-plan.md): milestones, acceptance checks, and the first usable vertical slice.

Status: specification only; the commands below describe the planned interface.

```bash
wsg create "port EMR mono to modular for new system" --name port-emr
cd ~/wsg/port-emr
wsg add ~/code/emr-importer
wsg add ~/docs/emr-migration.md
wsg explain
codex # or claude / pi
```

Each feature gets an independent directory. There are no nested workspace groups or workspace orchestration in the MVP.

## Inspiration

[Pi Durable](https://earendil.com/posts/pi-durable/) provides the starting point for a resumable scout harness. The portable workspace remains usable without that runtime.
