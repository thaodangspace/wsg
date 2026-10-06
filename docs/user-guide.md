# WSG user guide

This guide covers day-to-day use of WSG: configuration, credentials and their
limits, dirty sources, conflicts, `--resume`, and who owns which files. For the
behavior contract see [spec.md](spec.md); for milestone status see the
[README](../README.md).

## 1. Install and run

WSG is a Node CLI (Node `>=24`) that shells out to `git`.

From a packed tarball (no checkout required):

```bash
npm pack                       # builds dist/ and writes wsg-<version>.tgz
npm install -g ./wsg-0.1.0.tgz # or npm install --prefix <dir> ./wsg-0.1.0.tgz
wsg --version
wsg --help
```

The published artifact contains the compiled `dist/` modules only; it does not
include `src/` or development dependencies. `npm run test:package` installs the
real tarball into a throwaway prefix and drives all four commands from it.

Use `wsg` for interactive creation or `wsg -p <request>` for unattended creation; `explain`, `add`, and `refresh` are subcommands. `"$WSG" add`
and `"$WSG refresh"` resolve the nearest ancestor `workspace.yaml`, so they work
from inside the workspace, its `docs/` directory, or any worktree.

## 2. Configuration

Configuration is optional and lives in YAML. Resolution order:

1. `--root`, `--code-root`, `--for` (and other flags)
2. the config file
3. built-in defaults

The config file is found at:

- `$WSG_CONFIG` when set (used heavily by tests and scripts), else
- `$XDG_CONFIG_HOME/wsg/config.yaml`, else
- `~/.config/wsg/config.yaml`.

```yaml
code_roots: [~/code]        # where the scout enumerates Git repositories
workspace_root: ~/wsg       # where assembled workspaces are written
adapters: [agents]          # agents | claude (or [] for neither)
max_discovered_repos: 5     # cap on *auto-discovered* repos (explicit --repo is extra)
scout:
  provider: openai          # 'openai' for live scouting, 'faux' in tests
  model: gpt-4o             # provider-specific model id
```

- Unknown keys, unknown nested keys, wrong types, and duplicate keys are
  rejected with a `line:column` error instead of being silently ignored.
- `--root` changes the workspace root only; it never changes `code_roots`.
- `--repo` inputs are always included and do not count against
  `max_discovered_repos`.
- Provider and model are explicit choices. The workspace manifest never stores
  credentials or vendor-specific settings.

## 3. Credentials and authentication limits

- The scout uses the provider's own environment/configuration. For the built-in
  `openai` provider that is `OPENAI_API_KEY` in the environment. WSG reads no
  credential file of its own and writes no credential into the workspace or
  manifest.
- Autonomous discovery (`--code-root`, or no `--repo`) requires the pinned
  optional Pi packages and a working provider. If they are missing, WSG stops
  with an actionable error and **explicit `--repo` creation still works
  offline**.
- **URLs:** WSG attempts a bounded public-text fetch (timeout, redirect limit,
  byte cap, content-type check). Plain text, Markdown, HTML, and JSON can be
  snapshotted; HTML is converted conservatively.
- Authenticated, unsupported, binary, or unavailable URLs become honest
  `reference` entries with a reason. WSG never logs in, captures credentials, or
  pretends a reference's content was read. This is a deliberate v1 limitation:
  there are no Jira/Confluence/wiki connectors.
- Local documents are read only as text/Markdown. Other formats can be attached
  as opaque snapshots and are explicitly marked unread.

## 4. Dirty sources and dirty evidence

- Worktrees are created from the source repo's resolved `HEAD` commit. WSG never
  resets, stashes, fetches, pulls, prunes, or force-checks-out the source, and
  it never copies uncommitted changes into the workspace.
- The source checkout's branch, files, and dirty working tree are left exactly
  as they were. This is asserted by the end-to-end tests.
- If a scout selection cites a file whose evidence only exists in uncommitted
  changes, the run stops (exit 2) and asks you to commit the evidence or to pass
  `--allow-dirty-evidence`. Passing the flag is an explicit, recorded decision
  and proceeds with the dirty evidence.
- Validation commands are always discovered from the **recorded base commit**,
  not from dirty files in the source checkout.

## 5. Exit codes, conflicts, and no prompts

WSG is non-interactive. It never prompts: ambiguity, conflicts, and dirty-only
evidence stop execution with candidates, reasons, and an exact rerun command.

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Invalid input or unexpected error |
| `2` | Conflict or needs-user-decision (prints exact rerun guidance) |
| `3` | Partial completion (e.g. `.wsg-new` reconciliation or a failed fetch) |

Common conflicts:

- A complete workspace already exists for the chosen name — never overwritten.
- A destination directory exists, is non-empty, or is a symlink.
- A workspace branch already exists in the source repo.
- A writer lock is held by a live process (concurrent workspace creation/`add`/`refresh`).
- `--resume` arguments do not match the recorded interrupted operation.

`refresh` with no selector refreshes all documents; with a selector it refreshes
only those, but always regenerates `docs/context.md`, the adapters, and
`README.md` (even when there are no documents). A failed fetch keeps the last
usable snapshot and returns a partial result.

## 6. Resuming an interrupted operation

If workspace creation or `add` is interrupted (Ctrl-C, crash, power loss) before
`workspace.yaml` is published, the on-disk journal under `.wsg/` and (for `add`)
staged bytes under `.wsg/tmp/` let you finish without duplicating work:

```bash
# create
wsg -p "port EMR mono to modular" --name port-emr \
  --repo ~/code/legacy-platform --repo ~/code/new-platform --resume

# add
wsg add ~/docs/mapping-notes.md --workspace ~/wsg/port-emr --resume
```

- An absent workspace exits 1; a completed workspace exits 2 and is never
  overwritten (re-checked again under the writer lock).
- `-p --resume` compares `--name`, request, `--repo`/`--doc` sets,
  `--context`, and `--for` against the recorded plan and reports a diff on
  mismatch. The recorded base commits, document hashes, unread metadata, and
  context are authoritative, so a changed source is never silently rebuilt.
- Worktree recovery uses **no destructive Git**. Each recorded repo is matched
  against Git's worktree metadata, branch, destination, and base commit:
  - branch and destination absent → create the worktree and branch;
  - exactly the recorded destination, branch, and base commit → adopt it;
  - a branch this operation created, unchecked-out, destination absent →
    `git worktree add` on the existing branch;
  - anything else (branch moved, destination on another branch, plain directory,
    pre-existing branch) → conflict (exit 2) reported **before** any mutation.
- `--resume --dry-run` preflights and prints the recovery plan without changing
  files.
- A user-edited snapshot is never overwritten: the recorded bytes are written to
  a nonclobbering `<path>.wsg-new` proposal and the run exits 3. A preexisting
  proposal is preserved.

## 7. Ownership of generated files

WSG tracks a hash for every file it generates under `.wsg/operation.json`:

- `workspace.yaml` — the source of truth; published last, atomically.
- `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/context.md` — generated context
  and adapters.
- `scripts/*.sh` — wrappers for discovered validation commands.
- `docs/<snapshot>` — copies of supplied documents.

Rules:

- If a WSG-owned generated file is unchanged, WSG may overwrite it on
  regeneration.
- If **you edited** a generated file, WSG leaves it intact and writes a
  `<file>.wsg-new` proposal next to it, then reports partial completion (exit 3).
  Reconcile by diffing and merging, then delete the proposal.
- Attached documents are snapshots, not live links. If the source changes and
  you have not edited the snapshot, `refresh` copies the new bytes. If you edited
  the snapshot and the source also changed, WSG keeps your file and writes
  `<snapshot>.wsg-new`.
- User-maintained notes should be attached as separate documents; they are never
  treated as WSG-owned generated output.
- Runtime state (`.wsg/runtime.sqlite`, operation journals) is orchestration
  state. The workspace stays readable and usable if you delete `.wsg/`; `explain`
  and the worktrees never depend on it. A later `refresh` may not be able to
  prove ownership of generated files without `operation.json`, in which case it
  proposes `.wsg-new` files instead of overwriting.

## 8. Teardown

There is no `wsg remove` in the MVP. To reuse a name:

1. `git worktree remove <path>` for each worktree.
2. `git branch -D wsg/<workspace-name>/<repo-entry-name>`.
3. Delete the workspace directory.
