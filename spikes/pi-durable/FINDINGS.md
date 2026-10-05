# Pi Durable Spike Findings (Phase 4 / D5 Evaluation)

This document records empirical findings and verification evidence from the standalone spike in `spikes/pi-durable/` evaluating **Pi Durable** for workspace scouting and agent orchestration (M1–M2 Phase 4; FR15; D3, D5; A1, A2).

---

## 1. Environment & Runtime Baseline

- **Node.js Version**: `v25.9.0` (darwin-arm64, macOS).
- **Engine Requirement**: Node `>=24` (matches root package and implementation plan).
- **SQLite Engine**: Node.js native `node:sqlite` (`DatabaseSync` / `StatementSync`).
- **Node Warning Handling**: Passing `--disable-warning=ExperimentalWarning` cleanly suppresses the `node:sqlite` experimental notice without suppressing other runtime warnings or errors (PD5 / A1).

---

## 2. Exact Dependency Pins

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

- **Main Package Isolation**: `spikes/*/node_modules/` is gitignored. The root package remains lean with only `typebox: 1.3.27` and `yaml: ^2.7.0`.

---

## 3. Storage API & Persistence Model

- **Storage Adapter**: `openNodeSqliteStorage(path, options)` from `@earendil-works/pi-durable/storage/sqlite/node`.
- **Engine**: Backed by Node.js built-in `node:sqlite`.
- **Configuration**:
  - WAL mode enabled by default with auto-checkpointing at 1,000 pages (`walAutoCheckpointPages: 1000`).
  - Busy timeout configured to 5,000 ms (`busyTimeoutMs: 5000`).
- **Commit Semantics**:
  - `SessionImpl` holds a sequential mutation line. Every commit batch (entries, task state, document tracker deltas) executes inside an atomic SQLite transaction before publication.
  - Listeners registered via `harness.subscribeCommits()` fire synchronously post-adoption once the SQLite transaction has committed to disk.

---

## 4. Terminal-Tool Mechanism & Selection Recovery

- **Tool Definition & Control**:
  - `submit_selection` defines strict TypeBox schema `{ repos: string[], reason: string }` with `additionalProperties: false`.
  - Tool returns `{ control: { terminate: true }, details: args, content: [...] }`.
  - When all tool results in a round request `control: { terminate: true }`, `GenerationTask` ends the run immediately without requesting further model completions.
  - The submission transitions to `status: "done"`.
- **Result Recovery vs Call Request**:
  - Rather than inspecting model assistant call arguments (which merely reflect an intent to call a tool), `src/run.ts` recovers the terminal selection directly from the **persisted `pi.tool-result` entry** where `toolName === "submit_selection"` and `!isError`.
  - This guarantees that the tool execution actually completed successfully and its output was committed to SQLite.
- **Restart After Completion**:
  - Re-running `run.ts` against an already completed SQLite database re-acquires the settled submission (`status: "done"`), extracts the selection payload from the persisted `submit_selection` tool result, prints the JSON payload, and exits 0 without re-running any agent turns.

---

## 5. Tool Bounded I/O, UTF-8 Safety & Truncation Budgeting

- **Bounded Filesystem I/O**:
  - `read_file` acquires a file handle via `fs.open(targetPath, "r")` and reads at most `maxBytes + 1` (16,385 bytes) into a preallocated buffer, closing the handle in a `finally` block.
  - Regression testing on files > 1 MB confirmed that filesystem read length is bounded to 16,385 bytes and `fs.readFile` is not used. Memory and disk I/O remain strictly $O(\text{cap})$.
- **UTF-8 Character Boundary Preservation**:
  - Multi-byte UTF-8 sequences at the boundary are preserved using `sliceUtf8Safe`. Slicing scans continuation bytes (`0x80..0xBF`) to ensure characters (e.g. 3-byte or 4-byte code points) are not split across byte boundaries, preventing replacement characters (`\uFFFD`).
- **Cap and Marker Budgeting**:
  - The truncation marker `\n[TRUNCATED: 16 KiB limit reached]` is budgeted against `maxBytes`:
    `maxHeadBytes = maxBytes - markerBytes`.
  - The combined text (`headText + marker`) fits within the 16 KiB cap (`<= 16,384` bytes).
  - Verified through a full Harness turn: the model-visible persisted result in SQLite retains the full truncation marker without the Harness `outputLimits` stripping or dropping the custom suffix.

---

## 6. Proof: `read_file` Is Not Re-Executed on Resume

The spike establishes direct proof through multiple complementary checks:

1. **SQLite Entry Inspection Post-Kill**:
   - Immediately following the process kill (`SPIKE_KILL_AFTER=read_file`, exit code 70), inspecting the SQLite database confirms that the `pi.tool-result` entry for `read_file` exists with `isError: false`.
2. **Filesystem Deletion Proof**:
   - The read source file (`transient-source.txt`) was deleted from disk after the crash and before restarting.
   - When restarted, the conversation successfully resumed and completed with exit code 0 using the persisted tool result from SQLite. If `read_file` had attempted to re-execute, it would have failed with `File not found` (exit code 1).
3. **Execution Counting**:
   - An in-process test tracked invocations of `read_file.execute`: exactly 1 execution occurred across the initial crash and subsequent resumption.
4. **Replay Policy Behavior**:
   - `replay: "safe"` on `read_file` ensures that if a crash occurs *mid-execution* before settlement, recovery re-runs the tool. Because the tool result was already settled, no re-run took place.

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
  2. Bounded tools with realpath confinement, bounded file handle I/O, and 16 KiB caps work cleanly.
  3. Terminal tool signaling (`control: { terminate: true }`) cleanly stops agent rounds without prompt hacking or extra completion cost.
  4. Faux provider allows 100% deterministic, zero-cost, offline testing of full agent loops.

### Fallback Plan (if Pi Durable becomes unavailable or incompatible in future):
- If Pi Durable's experimental API breaks or becomes unmaintainable for M3:
  - Implement a direct `openai` / `node:https` client.
  - Use `node:sqlite` directly with a single `checkpoints` table:
    `CREATE TABLE checkpoints (step TEXT, payload TEXT, created_at INTEGER);`
  - Record each scouted repository inspection atomically before moving to the next.
  - Because D5 specifies isolating scouting behind a clean `Scout` interface (`scout(request, repos): Promise<WorkspaceSelection>`), the rest of `wsg` (worktrees, manifest, journal, CLI) remains completely unaffected by the internal scout engine choice.
