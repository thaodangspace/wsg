# Pi Durable Spike (`spikes/pi-durable`)

This spike validates **Pi Durable** as the durable conversation and task harness for agent execution (Milestone 1–2 Phase 4; FR15; D3, D5; A1, A2).

It is isolated from the main `wsg` package to keep experimental dependencies and install weight decoupled from core tooling.

## Objectives & Scope

1. **Durable Conversation on SQLite**:
   - Persist conversation turns, tool calls, and tool results using `@earendil-works/pi-durable` backed by `node:sqlite` storage (`openNodeSqliteStorage`).
   - Survive mid-run process crashes (fault injection via `SPIKE_KILL_AFTER=read_file` which terminates the process immediately after the tool result is committed).
   - Resume the conversation on restart without re-executing already-committed tool tasks.

2. **Bounded Read Tool (`read_file`)**:
   - Strict TypeBox parameter schema `{ path: string }` with `additionalProperties: false`.
   - `replay: "safe"` policy to allow safe resumption if interrupted before completion.
   - Realpath confinement within the allowed fixture directory (preventing `..` traversals, absolute escapes, and escaping symlinks).
   - 16 KiB output cap with truncation marker (`\n[TRUNCATED: 16 KiB limit reached]`) and diagnostic warning.

3. **Terminal Structured-Result Tool (`submit_selection`)**:
   - Strict TypeBox schema `{ repos: string[], reason: string }` with `additionalProperties: false`.
   - Returns `control: { terminate: true }` to end conversation rounds cleanly without further model turns.

4. **Provider Support**:
   - Tested in CI/local runs deterministically using `fauxProvider` from `@earendil-works/pi-ai/providers/faux`.
   - Wired with OpenAI provider via `@earendil-works/pi-ai/providers/openai` (reading `OPENAI_API_KEY`) without running live paid calls.

## Structure

```
spikes/pi-durable/
├── package.json          # Private package with exact pinned dependencies
├── package-lock.json     # Pinned lockfile
├── tsconfig.json         # NodeNext TypeScript configuration
├── README.md             # This file
├── FINDINGS.md           # Evaluation findings and D5 go/no-go recommendation
├── src/
│   ├── agent.ts          # Tools, provider setup, and Harness factory
│   └── run.ts            # CLI runner with crash simulation hook
└── test/
    ├── fixtures/repo/    # Test fixtures (README.md, large.txt, etc.)
    └── resume.test.ts    # Node test suite verifying crash/resume, tools, limits
```

## Running the Spike

### Installation
Dependencies are isolated in this directory:
```bash
cd spikes/pi-durable
npm install
```

### Typecheck & Tests
```bash
npm run typecheck
npm test
```

### Manual CLI Run
Simulate crash after `read_file`:
```bash
node --disable-warning=ExperimentalWarning src/run.ts --db /tmp/spike.sqlite --kill-after read_file
# Exits with status 70
```

Resume and complete:
```bash
node --disable-warning=ExperimentalWarning src/run.ts --db /tmp/spike.sqlite
# Outputs JSON selection payload to stdout and exits with status 0
```
