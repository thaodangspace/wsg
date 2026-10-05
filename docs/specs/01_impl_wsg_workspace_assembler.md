---
title: WSG workspace assembler — M1–M2 implementation plan
tags: [wsg, typescript, node, cli, git, git-worktree, yaml, typebox, sqlite, pi-durable, crash-recovery, node-test]
weight: 01
---

Spec: `01_spec_wsg_workspace_assembler.md` (FR1–FR15, D1–D7). Canonical: `/Users/dt/code/wsg/docs/spec.md`, `/Users/dt/code/wsg/docs/implementation-plan.md`. Repo is docs-only; every path is new unless marked "modify".

## Shared conventions (fixed for all phases)

- ESM TypeScript; `tsc` build to `dist/`; tests run `.ts` directly with `node --test` (type stripping). Source imports use explicit `./x.ts`; `rewriteRelativeImportExtensions` emits `.js`.
- Error model `src/errors.ts`: `WsgError {exitCode: 1|2|3; message; hints: string[]}` with `UsageError`(1), `ConflictError`(2), `PartialError`(3). `src/cli.ts` exports `main(argv, io: {stdout, stderr, env, cwd}): Promise<number>`; bin sets `process.exitCode`. Tests call `main()` in-process; crash tests spawn `node src/cli.ts`.
- All subprocesses via `execFile` (no shell). `--` precedes all git paths; refs/paths starting with `-` rejected before exec.
- Test helpers: `test/helpers/git-fixture.ts` (`makeRepo(dir, {files, commits, dirty})`, temp dirs via `fs.mkdtemp`), `test/helpers/cli.ts` (`runMain(argv, env)`).
- Phase 4 is independent of Phases 2–3.

## Plan-level design decisions (beyond spec; confirm in review)

- PD1 `--repo` must be a repo toplevel; otherwise exit 1 suggesting the toplevel (keeps FR5 naming unambiguous).
- PD2 `--resume` with inputs that differ from the journal → conflict (exit 2), not a merge.
- PD3 Config path override via `WSG_CONFIG` env (then `XDG_CONFIG_HOME`, then `~/.config`) for testability; not a CLI flag.
- PD4 `WSG_FAULT` fault hook honoured whenever set (no separate test build); only ever calls `process.exit(70)`; documented as a test hook.
- PD5 Spike runs Node with `--disable-warning=ExperimentalWarning`.
- PD6 `--code-root` accepted in M2 with a stderr note that discovery is not in this version.

## Phase 1: Package scaffold, CLI skeleton, repo spec patches

- **Objective**: A buildable, testable npm package with a `wsg` entry point dispatching `create|explain|add|refresh|--help|--version`, mapping `WsgError` to FR14 exit codes, and the repo spec patched per approved decisions.
- **Goal**: G1 skeleton, FR14, repo spec patches.
- **Depends on**: Phase 0 research (approved spec).
- **Verification**:
  - `test/cli.test.ts`: `--help` exits 0 and lists four commands; unknown command → exit 1, usage on stderr; `add`/`refresh` → exit 1 "not implemented in this version"; stubbed `ConflictError` → 2, `PartialError` → 3, non-WsgError → 1.
  - `npm run typecheck` and `npm run build` succeed; `node dist/cli.js --version` prints package version.
  - `rg` confirms in `docs/spec.md`: exit-code table, no-prompt statement, `--allow-dirty-evidence` (reserved M3), no-`remove` + manual teardown note, `intent` enum with `unspecified`, §10 M4 open item; `docs/implementation-plan.md` states Node `>=24` and `explain` in M2.
- **Steps**:
  1. `package.json`: `"type":"module"`, `engines.node >=24`, `bin {wsg: dist/cli.js}`, deps `typebox@1.3.27`, `yaml@^2`; devDeps `typescript`, `@types/node`; scripts `build`, `typecheck`, `test` (`node --test "test/**/*.test.ts"`). Rationale: approved stack, no vitest/tsx.
  2. `tsconfig.json` (noEmit, src+test) and `tsconfig.build.json` (rootDir src, outDir dist): nodenext, es2024, strict, erasableSyntaxOnly, verbatimModuleSyntax, allowImportingTsExtensions, rewriteRelativeImportExtensions.
  3. `src/errors.ts`; `src/cli.ts` with `parseArgs` (strict, allowPositionals), hand-written help, `create`/`explain` stubs. Non-WsgError → exit 1 (stack when `WSG_DEBUG=1`).
  4. `.gitignore`: `node_modules/`, `dist/`, `spikes/*/node_modules/`, `*.sqlite`.
  5. Apply "Repo spec patches" from the spec; update README status + "Development" section.
- **Files to create/modify**: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `src/cli.ts`, `src/errors.ts`, `test/cli.test.ts`, `test/helpers/cli.ts`; modify `docs/spec.md`, `docs/implementation-plan.md`, `README.md`.
- **Estimated effort**: S
- **Locked at**:

## Phase 2: Config, slug/path safety, workspace resolution

- **Objective**: Strict config loading with CLI > config > defaults, slug validation/derivation with reserved names, path containment helpers, and `workspace.yaml` ancestor resolution.
- **Goal**: FR1, FR2, FR3; Security path containment.
- **Depends on**: Phase 1.
- **Verification**:
  - `test/config.test.ts`: missing file → defaults; unknown key → `UsageError` with key name and `line:col`; duplicate key rejected; `~` expanded; CLI `--root` overrides `workspace_root`; `api_key` rejected as unknown.
  - `test/slug.test.ts`: accept/reject table (`.`, `..`, 65 chars, leading `-`, reserved names); `deriveSlug` deterministic, lowercase, ≤64; `assignEntryNames` → `a`, `a-<6hex>`, stable across runs.
  - `test/paths.test.ts`: `assertConfinedRelative` rejects absolute, `..`, backslash, NUL; accepts `docs/x.md`; `findWorkspaceRoot` from nested dir and from inside a dir with a `.git` file; `null` when none; explicit `--workspace` wins.
- **Steps**:
  1. `src/yamlio.ts` `parseYamlStrict(text, schema, {filename})`: `parseDocument` + `LineCounter`, `uniqueKeys`; TypeBox error paths → `file:line:col: message`. Shared by config and manifest.
  2. `src/config.ts`: strict TypeBox `ConfigSchema`; `loadConfig(env)` (PD3); `resolveSettings(cli, config)`.
  3. `src/slug.ts`: `SLUG_RE`, `RESERVED_ROOT_NAMES`, `validateSlug`, `deriveSlug`, `suffixForSource` (sha256 → 6 hex), `assignEntryNames`.
  4. `src/paths.ts`: `expandHome`, `canonicalize`, `assertConfinedRelative`, `resolveInside`, `findWorkspaceRoot`.
- **Files to create/modify**: `src/yamlio.ts`, `src/config.ts`, `src/slug.ts`, `src/paths.ts`, `test/config.test.ts`, `test/slug.test.ts`, `test/paths.test.ts`, `test/fixtures/config/*.yaml`.
- **Estimated effort**: M
- **Locked at**:

## Phase 3: Manifest schema, parse, validate, serialize

- **Objective**: Version-1 `workspace.yaml` schema with version-first rejection, positioned unknown-field errors, cross-field validation, and byte-stable serialization.
- **Goal**: FR4; D6.
- **Depends on**: Phase 2 (`yamlio`, `paths`, `slug`).
- **Verification**:
  - `test/manifest.test.ts`: repo spec §5 example (placeholders filled) parses; `version: 2` → "Unsupported workspace.yaml version 2" only; unknown `repos[0].foo` → `line:col`; missing `request` rejected; `intent: unspecified` ok, `bogus` rejected; duplicate repo `name`/`path`/`source` rejected; `path: ../x`, 39-hex `base_commit`, `branch: bad..name`, `commands[0].cwd: nope`, reference doc with `path`, snapshot doc without `sha256` each rejected.
  - Round-trip `serialize(parse(x))` byte-stable on second pass; spec key order; `request` as `|` block.
- **Steps**:
  1. `src/manifest.ts`: schemas `RepoEntry`, `Evidence`, `DocEntry`, `ScriptEntry`, `CommandEntry`, `Discovery`, `Manifest`; `MANIFEST_VERSION = 1`; `IntentSchema`.
  2. `parseManifest`: version first → schema via `yamlio` → `validateManifest` (cross-field; branch via `checkBranchName` in seed `src/git.ts`).
  3. `serializeManifest`: ordered object → `yaml.Document`, `request` as `BLOCK_LITERAL`.
- **Files to create/modify**: `src/manifest.ts`, `src/git.ts` (seed: `runGit`, `checkBranchName`), `test/manifest.test.ts`, `test/fixtures/manifests/*.yaml`.
- **Estimated effort**: M
- **Locked at**:

## Phase 4: Pi Durable spike

- **Objective**: Standalone proof under `spikes/pi-durable/` that a Pi Durable conversation on SQLite, with one bounded read tool and a terminal structured-result tool, survives a mid-run process kill and resumes to completion with the faux provider; OpenAI provider wired but not exercised in tests.
- **Goal**: FR15; D3, D5; A1, A2.
- **Depends on**: Phase 1 (gitignore). Independent otherwise.
- **Verification**:
  - `spikes/pi-durable/test/resume.test.ts`: run with `SPIKE_KILL_AFTER=read_file` → exit ≠ 0, sqlite exists; rerun → exit 0, stdout JSON equals scripted `submit_selection` payload; `read_file` refuses path outside fixture; over-cap read truncated with marker.
  - `FINDINGS.md`: exact pins, storage API, terminal-tool mechanism, how resume locates the conversation, whether `read_file` re-executed on resume, warning handling, install weight, go/no-go for D5.
- **Steps**:
  1. `spikes/pi-durable/package.json` (private, exact pins pi-durable/pi-ai/chord 1.0.2, typebox 1.3.27) + tsconfig. FR15 keeps these out of the main package.
  2. `src/agent.ts`: tools `read_file` (`{path}`, strict, `replay:"safe"`, realpath-confined, 16 KiB cap) and `submit_selection` (`{repos: string[], reason: string}`, terminal). Provider flag: `openai` (env `OPENAI_API_KEY`) or `faux`. Verify signatures against installed README/`.d.ts`.
  3. `src/run.ts`: CLI wrapper; `SPIKE_KILL_AFTER=<tool>` → `process.exit(70)` after that tool result is persisted.
  4. Write FINDINGS; on no-go record the D5 fallback.
- **Files to create/modify**: `spikes/pi-durable/{package.json,package-lock.json,tsconfig.json,README.md,FINDINGS.md,src/agent.ts,src/run.ts,test/resume.test.ts,test/fixtures/repo/*}`.
- **Estimated effort**: M
- **Locked at**:

## Phase 5: Git facade, lock, operation journal, atomic file I/O

- **Objective**: A safe git facade exposing only inspection and the two worktree-add forms, `.wsg/` with O_EXCL lock and stale takeover, and the `operation.json` journal with owned hashes written tmp+fsync+rename.
- **Goal**: FR6 git safety, FR10; Security Git; R1.
- **Depends on**: Phases 2, 3.
- **Verification**:
  - `test/git.test.ts` (real repos): `repoInfo` toplevel realpath, 40-hex HEAD, `dirty`; bare / unborn / non-repo → `UsageError`; `worktreeAddNewBranch` creates `wsg/x/y` at HEAD and `worktreeList` matches; source branch + dirty file unchanged; `-x` ref / `-d` dest rejected pre-exec; parent `GIT_DIR` not passed through; `assertGitVersion` rejects `<2.38`; `detectGaps` flags `.gitmodules` and `filter=lfs`.
  - `test/operation.test.ts`: `.wsg` mode 0700 + `.gitignore` `*`; second `acquireLock` → `ConflictError` naming pid/host; dead pid same host → takeover + warning; other host → conflict; journal round-trip; no `*.tmp` left.
- **Steps**:
  1. `src/git.ts`: `runGit` (sanitized env, `GIT_TERMINAL_PROMPT=0`, `WSG_DEBUG` argv log), `gitVersion`, `assertGitVersion`, `repoInfo`, `branchExists`, `branchCommit`, `worktreeList`, `worktreeAddNewBranch`, `worktreeAddExisting`, `detectGaps`, `assertSafeArg`. Nothing destructive exported.
  2. `src/fsx.ts`: `writeFileAtomic`, `sha256File`, `sha256`, `ensureDir`.
  3. `src/operation.ts`: `OperationFile`, `Operation`, `Step` types; `initWsgDir`, `acquireLock/releaseLock`, `readOperation/writeOperation`, `markStep` (persists immediately — the only way to advance a step).
- **Files to create/modify**: `src/git.ts` (expand), `src/fsx.ts`, `src/operation.ts`, `test/git.test.ts`, `test/operation.test.ts`, `test/helpers/git-fixture.ts`.
- **Estimated effort**: L
- **Locked at**:

## Phase 6: Documents, generated context, ownership reconciliation

- **Objective**: Classify and snapshot explicit docs (secret refusal, text detection), pure renderers for context/README/adapters, and owned-hash reconciliation writing `.wsg-new` instead of clobbering edits.
- **Goal**: FR7, FR8, FR9; D7.
- **Depends on**: Phases 3, 5.
- **Verification**:
  - `test/documents.test.ts`: URL vs file classification; dir / symlink-to-dir / missing / unreadable → `UsageError`; `.env`, `id_rsa`, `.md` with `BEGIN PRIVATE KEY` → exit-1 secret error; PNG → `text:false`; two `notes.md` → `docs/notes.md`, `docs/notes-<6hex>.md`; snapshot entry sha/ISO time/mode/realpath source; URL → reference with "Not fetched in this version".
  - `test/generate.test.ts`: context contains request, context lines, repo name/path/branch/base/intent, docs with mode and "(unread)", gaps, empty "Commands (discovered, not verified)"; adapter points to `docs/context.md` and mentions repo-local instructions; planned file lists for `agents`, `agents,claude`, `none`.
  - `test/ownership.test.ts`: fresh → written + recorded; unchanged owned → overwritten; edited → untouched + `.wsg-new` + `partial: true`.
- **Steps**:
  1. `src/documents.ts`: `classifyDocInput`, `inspectDoc`, secret lists, `planDocs`, `snapshotDoc`, `referenceDoc`.
  2. `src/generate.ts`: pure `renderContext`, `renderReadme`, `renderAdapter`, `plannedGeneratedFiles`, `renderAll` — single owner of canonical context (repo spec §9).
  3. `src/ownership.ts`: `reconcileGenerated(wsDir, files, owned)`.
- **Files to create/modify**: `src/documents.ts`, `src/generate.ts`, `src/ownership.ts`, `test/documents.test.ts`, `test/generate.test.ts`, `test/ownership.test.ts`, `test/fixtures/docs/*`.
- **Estimated effort**: M
- **Locked at**:

## Phase 7: `wsg create` (explicit inputs) with `--dry-run`

- **Objective**: End-to-end explicit create: validate all inputs and the draft manifest, detect conflicts, print the plan, then (unless dry-run) lock, journal, add worktrees, snapshot docs, generate, publish manifest last.
- **Goal**: FR2, FR4, FR5–FR8, FR12, FR14; D4, D6; PD1, PD6.
- **Depends on**: Phases 2, 3, 5, 6.
- **Verification** — `test/create.test.ts` (real repos, `--root <tmp>`, `WSG_CONFIG` temp):
  - Happy path (2 repos, 1 doc, `--context`, `--for agents,claude`): worktrees on `wsg/<name>/<entry>` at source HEAD; doc sha matches; manifest parses with `added_by: user`, `intent: unspecified`, `evidence: []`, FR5 reason; both adapters; journal `complete`, `owned` has 4 files; exit 0.
  - Dirty source: stderr warning; source branch/content unchanged.
  - Duplicate spelling of same source → one entry; two `app` repos → `app`, `app-<6hex>`, mapping printed before mutation.
  - `--dry-run`: prints plan; `<root>/<name>` absent; no `wsg/` branches.
  - Preflight exit 1, nothing created: non-repo, subdir of repo (PD1), bare, unborn, missing doc, secret doc, invalid `--name`, `--for bogus`, `--for none,agents`.
  - Conflict exit 2, no mutation: existing branch (guidance printed, not run); complete workspace exists; incomplete without `--resume` (suggests it); live lock.
  - Submodule/LFS fixture → `discovery.gaps` in manifest and context.
  - `--code-root` → stderr note (PD6).
- **Steps**:
  1. `src/scout.ts`: `Scout` interface, `ScoutResult` union (`selection | ambiguous | none`), `ExplicitScout`. Fixes the M3 seam now.
  2. `src/create.ts` `runCreate`: (a) git version, slug, adapters, `repoInfo`, `inspectDoc`; (b) `CreatePlan` + draft manifest + `validateManifest`; (c) preflight target/branch/dest; (d) print plan + warnings, dry-run exits here; (e) mkdir, `initWsgDir`, lock, journal `running` with all steps `planned`; (f) worktree steps `started` (detail `{source,dest,branch,base_commit,branchExistedBefore,destExistedBefore}`) → add → `done`; (g) snapshots via `.wsg/tmp/<opId>/` then rename; (h) `renderAll` → `reconcileGenerated`; (i) publish `workspace.yaml` atomically, `complete`, release lock, clean tmp; (j) summary; exit 3 if proposals.
  3. Wire flags in `src/cli.ts`; `--resume` → `UsageError` placeholder until Phase 8.
- **Files to create/modify**: `src/scout.ts`, `src/create.ts`, `src/cli.ts` (modify), `test/create.test.ts`, `test/helpers/git-fixture.ts` (submodule/LFS helpers).
- **Estimated effort**: L
- **Locked at**:

## Phase 8: `--resume` and fault-injection recovery

- **Objective**: Resume an interrupted create from the journal's recorded plan, applying the FR11 worktree recovery matrix with no destructive git, regenerating under ownership rules, publishing the manifest last — proven with real process crashes.
- **Goal**: FR9, FR10, FR11, FR14; R2; PD2, PD4.
- **Depends on**: Phase 7.
- **Verification** — `test/resume.test.ts` (spawns `node src/cli.ts`):
  - `WSG_FAULT=after-worktree:1`, two repos → exit 70, step 1 `started`, worktree exists; `--resume` → exit 0, step 1 `detail.recovered: 'adopt'`, repo 2 created, one worktree per repo, manifest valid.
  - Branch-only state (journal hand-crafted: step `started`, `branchExistedBefore:false`; branch pre-created at base; no dest) → resume uses `worktreeAddExisting`, exit 0.
  - Mismatch → exit 2 with observed state and zero git mutation (branch sha / worktree list unchanged): branch at other commit; dest registered on a different branch; dest is a plain dir; branch at base with `branchExistedBefore:true`.
  - `WSG_FAULT=after-generate` → no `workspace.yaml`; user edits `docs/context.md`; `--resume` → edit intact, `.wsg-new` written, manifest published, exit 3.
  - `--resume`: absent dir → 1; complete → 2; different `--repo` set → 2 listing diff; different `--name` → 2.
  - Stale lock from killed process taken over with warning.
- **Steps**:
  1. `src/faults.ts` `faultPoint(name)`: `WSG_FAULT=<name>[:<n>]` → `process.exit(70)` on nth hit. Points: `after-lock`, `after-worktree`, `after-generate`.
  2. Resume path in `src/create.ts`: require `command==='create'`, status not complete, same name, no `workspace.yaml`; compare inputs (PD2); recorded `base_commit` authoritative; `recoverWorktreeStep` implements the matrix; snapshots idempotent by recorded sha; generated via `reconcileGenerated`; publish.
  3. README: document `--resume`, conflicts, manual teardown, `WSG_FAULT` test hook.
- **Files to create/modify**: `src/faults.ts`, `src/create.ts` (modify), `src/operation.ts` (helpers), `test/resume.test.ts`, `README.md` (modify).
- **Estimated effort**: L
- **Locked at**:

## Phase 9: `wsg explain` and M2 acceptance

- **Objective**: Read-only manifest printer resolvable from any subdirectory, plus an end-to-end test mirroring the repo plan's M2 acceptance list.
- **Goal**: G6; FR3, FR13; repo plan M2 acceptance.
- **Depends on**: Phases 7, 8.
- **Verification**:
  - `test/explain.test.ts`: from WSG root, `docs/`, and inside a worktree subdir → prints request, repos (intent/reason/evidence count), docs+mode, exclusions, gaps, commands; `--workspace` from unrelated cwd; no manifest → exit 1 with hint; `explain <repo>` filters, unknown → 1; works with `.wsg/` removed and without `OPENAI_API_KEY`; invalid manifest → exit 1 with `line:col`.
  - `test/e2e-m2.test.ts`: two repos (one dirty; one path with space + unicode) + doc under custom `--root`; create exit 0; sources unchanged; remove `.wsg/` → explain and `docs/context.md` still usable; second create with another name from same sources → distinct branches; recording `PATH` shim for `npm`/`node`/`sh` scripts shows no project command executed.
- **Steps**:
  1. `src/explain.ts` `runExplain`: `findWorkspaceRoot` → `parseManifest` → sections; no git, network, or `.wsg` access.
  2. Wire `explain [repo-name] --workspace` in `src/cli.ts`.
  3. e2e test; README status "Milestones 1–2 implemented" and usage block marks `add`/`refresh` planned.
- **Files to create/modify**: `src/explain.ts`, `src/cli.ts` (modify), `test/explain.test.ts`, `test/e2e-m2.test.ts`, `README.md` (modify).
- **Estimated effort**: M
- **Locked at**:

## Security review hot spots

`src/paths.ts`, `src/documents.ts` (containment, secret refusal), `src/git.ts` (argv/env), `src/operation.ts` (lock takeover), spike `read_file` confinement. Run `/security-review` at Phases 5, 6, 7.
