# Pi Durable Spike Findings (Phase 4 / D5 Evaluation)

This document records findings from the standalone spike in `spikes/pi-durable/` evaluating **Pi Durable** for workspace scouting and agent orchestration (M1–M2 Phase 4; FR15; D3, D5; A1, A2).

---

## 1. Exact Dependency Pins

All dependencies in `spikes/pi-durable/package.json` are pinned exactly with no caret (`^`) or tilde (`~`):

```json
{
  "dependencies": {
    "@earendil-works/chord": "1.0.2",
    "@earendil-works/pi-ai": "1.0.2",
    "@earendil-works/pi-durable": "1.0.2",
    "chord": "npm:@earendil-works/chord@1.0.2",
    "pi-ai": "npm:@earendil-works/pi-ai@1.0.2",
    "typebox": "1.3.27"
  },
  "devDependencies": {
    "@types/node": "^22.13.9",
    "typescript": "^5.8.2"
  }
}
```

- Main package isolation: `spikes/*/node_modules/` is gitignored; main `package.json` retains only `typebox: 1.3.27` and `yaml: ^2.7.0`.

---

## 2. Storage API & Persistence Model

- **Storage Adapter**: `openNodeSqliteStorage(path, options)` from `@earendil-works/pi-durable/storage/sqlite/node`.
- **Engine**: Backed by Node.js built-in `node:sqlite` (`DatabaseSync` / `StatementSync`).
- **Configuration**:
  - WAL mode enabled by default with auto-checkpointing at 1,000 pages (`walAutoCheckpointPages: 1000`).
  - Busy timeout configured to 5,000 ms (`busyTimeoutMs: 5000`).
- **Commit Semantics**:
  - `SessionImpl` holds a sequential mutation line. Every commit batch (entries, task state, document tracker deltas) executes inside an atomic SQLite transaction before publication.
  - Listeners registered via `harness.subscribeCommits()` fire synchronously post-adoption once the SQLite transaction has committed to disk.

---

## 3. Terminal-Tool Mechanism

- **Schema & Execution**:
  - `submit_selection` defines strict TypeBox schema `{ repos: string[], reason: string }` with `additionalProperties: false`.
  - Tool returns `{ control: { terminate: true }, details: args, content: [...] }`.
- **Harness Control**:
  - When all tool results in a round request `control: { terminate: true }`, `GenerationTask` ends the run immediately without requesting further model completions.
  - The submission transitions to `status: "done"`.
  - The structured payload is preserved in entry `model` tool arguments and `details`.

---

## 4. How Resume Locates the Conversation & State

1. **Root Conversation Resolution**:
   - `harness.root(context)` resolves the reserved root conversation ID. If it already exists in the SQLite storage, it is reloaded without modifying existing state.
2. **Scheduler Activation**:
   - `harness.resume()` starts the background task scheduler to re-evaluate pending/unsettled tasks.
3. **Idempotent Submission Re-acquisition**:
   - Submissions submitted with a persistent `requestId` (e.g. `root.submit({ ..., requestId: "spike-selection-request" })`) locate and return the existing submission record if one already exists in storage.
4. **State Reconciliation**:
   - Checkpoints recorded in `pi.live` documents identify unfinished task phases. Generation resumes from the last settled tool round.

---

## 5. Tool Re-Execution on Resume (`read_file`)

- **Observation**:
  - When the process is terminated after persisting `read_file` (`SPIKE_KILL_AFTER=read_file`), **`read_file` is NOT re-executed upon resumption**.
- **Explanation**:
  - The tool result entry (`kind: "pi.tool-result"`) and task completion were committed to SQLite before the process exit.
  - Upon restart, the Harness reads the existing active transcript containing the tool result. The model context for the subsequent turn already includes the output of `read_file`.
  - The scheduler proceeds directly to the next turn (calling `submit_selection`).
- **Replay Policy**:
  - `replay: "safe"` on `read_file` ensures that if a crash were to occur *mid-execution* before settlement, recovery would re-run the tool. Since the tool result was already settled, no re-run was needed.

---

## 6. Warning Handling

- `node:sqlite` is marked experimental in Node 24/25 and triggers:
  `ExperimentalWarning: SQLite is an experimental feature and could change at any time`.
- **Handling**:
  - Passing `--disable-warning=ExperimentalWarning` to `node` suppresses this warning without silencing other runtime errors (PD5 / A1).
  - CLI runs and `npm test` execute cleanly with zero warning noise.

---

## 7. Install Weight & Footprint

- **Disk Footprint**:
  - `@earendil-works/pi-durable`: ~2.2 MB unpacked.
  - `@earendil-works/pi-ai`: ~4.0 MB unpacked.
  - Total `node_modules` in `spikes/pi-durable`: 94 packages, ~45 MB on disk.
- **Transitive Scope**:
  - `pi-ai` includes providers for OpenAI, Anthropic, Bedrock, Mistral, Google, etc., along with provider model catalogs and JSON schemas.
- **Evaluation**:
  - Too heavy for the root `wsg` CLI in M1–M2 (where instant startup and minimal footprint are critical).
  - Isolation under `spikes/pi-durable/` successfully validates the architecture while keeping the main package fast and dependency-light.

---

## 8. Go / No-Go Decision for D5

### Decision: **GO (Scoped for M3)**
- **Justification**:
  1. Crash recovery on SQLite works out-of-the-box with zero data corruption.
  2. Bounded tools with realpath confinement and 16 KiB caps work cleanly.
  3. Terminal tool signaling (`control: { terminate: true }`) cleanly stops agent rounds without prompt hacking or extra completion cost.
  4. Faux provider allows 100% deterministic, zero-cost, offline testing of full agent loops.

### Fallback Plan (if Pi Durable becomes unavailable or incompatible in future):
- If Pi Durable's experimental API breaks or becomes unmaintainable for M3:
  - Implement a direct `openai` / `node:https` client.
  - Use `node:sqlite` directly with a single `checkpoints` table:
    `CREATE TABLE checkpoints (step TEXT, payload TEXT, created_at INTEGER);`
  - Record each scouted repository inspection atomically before moving to the next.
  - Because D5 specifies isolating scouting behind a clean `Scout` interface (`scout(request, repos): Promise<WorkspaceSelection>`), the rest of `wsg` (worktrees, manifest, journal, CLI) remains completely unaffected by the internal scout engine choice.
