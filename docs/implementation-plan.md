# WSG implementation plan

Status: planned work. This plan implements [the MVP specification](spec.md); no implementation milestone is complete yet.

## Delivery approach

Build one CLI package and ship a vertical slice early. First assemble a workspace from explicit repos and docs, then add autonomous scouting. Keep Git/filesystem operations deterministic and separate from model judgment.

Proposed baseline: TypeScript, Node 24, npm, Git, and `rg`. Confirm Pi Durable and SQLite compatibility in the first milestone before fixing the runtime requirement. Use one model provider for initial integration behind a small scout interface; do not build a provider/plugin framework.

Suggested source layout:

```text
src/
  cli.ts
  config.ts
  manifest.ts
  discovery.ts
  scout.ts
  materialize.ts
  documents.ts
  generate.ts
  operation.ts
test/
  fixtures/
docs/
```

Keep selection, evidence validation, and manifest logic callable without an LLM. A scripted scout is a test seam, not a second product interface.

## Milestone 1 — Contracts and runtime spike

Deliver:

- CLI skeleton, configuration loading, safe slug/path handling, and workspace resolution.
- Version 1 manifest schema with parsing, validation, and serialization.
- A short Pi Durable spike: one bounded read/search tool, structured scout result, persisted conversation, and restart/resume.
- Pin verified dependency versions and document model configuration. Keep credentials outside generated files.

Acceptance:

- Config precedence and `--workspace` resolution match the spec.
- The example manifest parses; unsupported versions, traversal, duplicate destinations, and invalid branches fail before writes.
- The Pi conversation survives restart on the selected runtime. Document any API assumptions confirmed by the spike.

## Milestone 2 — Explicit-input vertical slice

Deliver:

- `wsg create` using `--repo`, `--doc`, and `--context` without autonomous discovery yet.
- Worktree creation from recorded source commits and collision handling.
- Local document snapshots, reference-only URLs, manifest, README, context, and optional agent adapters.
- A writer lock, operation journal, generated-file hashes, and `--dry-run` / `--resume`.

Acceptance:

- Two explicit repos plus one migration document produce a usable directory under a configurable root.
- Source branches and dirty files are unchanged; existing destination/branch conflicts are actionable.
- Interrupt after a successful worktree but before journal completion; resume reconciles that worktree without duplicating it.
- No script, dependency installation, or coding harness is launched.
- Removing runtime storage from a completed fixture does not prevent reading context or using the worktrees.

This is the first usable release: a reliable workspace assembler with explicit inputs.

## Milestone 3 — Local scout harness

Deliver:

- Bounded repo enumeration under configured roots, including `.git` files for existing worktrees.
- `rg` retrieval, README/manifest/instruction reads, and local document mention resolution.
- One Pi Durable scout conversation with read-only tools and structured output.
- Selection evidence validation, explicit repo inclusion, default discovered-repo cap, and saved exclusions/gaps.
- Evidence-based source/target inference; focused ambiguity handling.
- `wsg explain` from saved manifest data, without a model dependency.

Acceptance:

- The EMR fixture chooses source, target, and shared types based on symbols/dependencies/docs, while excluding the unrelated repo.
- Missing/fictional evidence is rejected. Ambiguous target repos do not trigger arbitrary materialization.
- Symlink loops, vendor trees, byte/turn limits, and absent code roots produce bounded, understandable results.
- Interrupted scouting resumes, while the materializer still runs outside the model's writable toolset.

## Milestone 4 — Incremental context

Deliver:

- `wsg add` for local Git repos, docs, explicitly typed scripts, and URL references.
- Canonical-source deduplication and deterministic filename collisions.
- `wsg refresh` for all or selected documents and generated context.
- Public accessible text snapshots, fetch limits, and honest fallback to references.
- Conflict handling for user-edited snapshots/adapters/context, including `.wsg-new` proposals.

Acceptance:

- Add a fourth repo without touching existing worktrees or their branches.
- Re-adding the same source is a no-op; caller-relative paths are resolved correctly.
- Refresh a changed source document; preserve manually edited snapshots and adapters.
- A failed fetch retains the last snapshot and returns a partial-failure result.
- Explicit attachments remain in the manifest; refresh neither prunes nor rescouts repos.

## Milestone 5 — Validation hints and handoff quality

Deliver:

- Discover commands from package manifests and documented repository scripts.
- Save argument vectors, working directories, and evidence; generate wrappers only for concrete supported commands.
- Copy explicitly supplied scripts with provenance, without executing them.
- Clear create/add/refresh summaries showing repo roles, unresolved documents, and missing tests.
- Concise agent adapters pointing to the same generated context and repository-local policies.

Acceptance:

- A fixture with a known npm test command gets a wrapper that works from any directory and propagates exit status.
- A fixture without a migration test reports the gap and generates no invented verification script.
- A recording fixture confirms creation performs no test/install execution.
- Both selected adapters expose the same goal/context after an add or refresh.

## Milestone 6 — Reliability and MVP release

Deliver:

- Git integration and crash/recovery coverage for create and add, including source paths containing spaces.
- End-to-end fixture scenarios for task-only discovery and explicit-hint assembly.
- User documentation covering configuration, authentication limitations, dirty sources, conflicts, resume, and ownership of generated files.
- Installation/package smoke check and CI on the supported environment.
- A manual live-model trial in addition to deterministic scout tests; record model/runtime versions and observed discovery limits.

Acceptance:

- All specification acceptance items pass on temporary local Git repositories.
- Concurrent writes are rejected; different WSG directories can use one source repo on different branches.
- Resume handles branch/destination mismatch without force/reset/deletion.
- A user can run the four planned commands and then start Codex, Claude, or Pi in the assembled directory.

## Verification strategy

Use unit checks where rules matter: path containment, manifest validation, config precedence, evidence validation, and selection constraints.

Use real temporary Git repos for behavior mocks cannot establish: worktree branches, preservation of dirty sources, branch collisions, interrupted operations, and recovery reconciliation.

Use deterministic scout responses for CI. Add one manual live-model evaluation over the EMR fixture to validate discovery quality; do not put a billed/network-dependent model call in the default test suite. Use recording scripts to verify that assembly never executes project commands.

For this specification commit, check Markdown links and fenced code blocks and parse YAML examples. Runtime tests apply to implementation milestones, not to the documentation-only change.

## Decisions to resolve during implementation

| Decision | Proposed starting point | Resolve by |
| --- | --- | --- |
| Pi package/runtime versions | Pin the versions that pass SQLite/resume spike. | Milestone 1 |
| Initial provider/model | User-configured provider/model; one tested integration first. | Milestone 1 |
| Search and model budgets | Finite defaults; measure against EMR fixture, report truncation. | Milestone 3 |
| URL text extraction | Plain text/Markdown and conservative HTML-to-text; other URLs are references. | Milestone 4 |
| Command support | Start with npm manifests and directly documented scripts; add others only with fixtures. | Milestone 5 |

None of these decisions should expand the MVP into a catalog service, graph engine, multi-workspace hierarchy, or coding-agent replacement.
