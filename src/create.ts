import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { UsageError, ConflictError, PartialError, WsgError } from './errors.ts';
import {
  assertGitVersion,
  repoInfo,
  branchExists,
  branchCommit,
  worktreeList,
  worktreeAddNewBranch,
  worktreeAddExisting,
  detectGaps,
  checkBranchName,
  type RepoInfo,
} from './git.ts';
import {
  classifyDocInput,
  inspectDoc,
  planDocs,
  type PlannedDoc,
  type InspectedDoc,
} from './documents.ts';
import { canonicalize, expandHome, resolveInside } from './paths.ts';
import { assertValidSlug, deriveSlug, assignEntryNames } from './slug.ts';
import { loadConfig } from './config.ts';
import {
  validateManifest,
  serializeManifest,
  type Manifest,
  type ManifestAdapter,
  type AddedBy,
  type DocMode,
} from './manifest.ts';
import {
  initWsgDir,
  acquireLock,
  releaseLock,
  readOperation,
  writeOperation,
  markStep,
  parseValidLockData,
  isPidAlive,
  type LockData,
  type Step,
  type Operation,
  type OperationFile,
} from './operation.ts';
import { reconcileGenerated, type ReconcileResult } from './ownership.ts';
import { renderAll } from './generate.ts';
import { writeFileAtomic, ensureDir, sha256 } from './fsx.ts';
import { faultPoint } from './faults.ts';
import { ExplicitScout, type Scout, type ScoutResult } from './scout.ts';
import type { CliIO } from './cli.ts';

export const CREATE_HELP_TEXT = `Usage: wsg create <request> [options]

Options:
  --name <name>                  Workspace directory name
  --root <dir>                   Output root directory (default: ~/wsg)
  --repo <path>                  Add a repository (repeatable)
  --doc <path-or-url>            Add a document or URL (repeatable)
  --context <text>               Add task context line (repeatable)
  --code-root <dir>              Code discovery root (repeatable, reserved)
  --for <adapters>               Adapters: agents, claude, none (default: agents)
  --dry-run                      Print plan without creating files
  --resume                       Resume an interrupted create operation
  --allow-dirty-evidence         Allow dirty source evidence (reserved)
  -h, --help                     Show help
`;

export interface CreateOptions {
  request: string;
  name?: string;
  root?: string;
  repos?: string[];
  docs?: string[];
  context?: string[];
  codeRoots?: string[];
  for?: string;
  dryRun?: boolean;
  resume?: boolean;
  allowDirtyEvidence?: boolean;
  scout?: Scout;
  _afterLockAcquired?: (wsDir: string) => void;
  _beforeWorktreeStep?: (repo: RepoPlan) => void;
  _beforeSnapshotWrite?: (doc: PlannedDoc) => void;
}

export interface RepoPlan {
  name: string;
  source: string;
  dest: string;
  branch: string;
  base_commit: string;
  dirty: boolean;
  dirtyFiles: string[];
  reason: string;
}

export interface CreatePlan {
  name: string;
  wsDir: string;
  request: string;
  context: string[];
  adapters: ManifestAdapter[];
  repos: RepoPlan[];
  docs: PlannedDoc[];
  gaps: string[];
  manifest: Manifest;
  warnings: string[];
}

function getCwd(io?: CliIO): string {
  if (io?.cwd) {
    return typeof io.cwd === 'function' ? io.cwd() : io.cwd;
  }
  return process.cwd();
}

export type WorktreeRecoveryAction = 'adopt' | 'worktreeAddExisting' | 'retry';

export interface WorktreeRecoveryDecision {
  action: WorktreeRecoveryAction;
  stepId: string;
  source: string;
  branch: string;
  dest: string;
  base_commit: string;
  reason: string;
}

export function inspectWorktreeRecovery(
  step: Step,
  repo: { source: string; branch: string; dest: string; base_commit: string }
): WorktreeRecoveryDecision {
  const source = repo.source;
  const branch = repo.branch;
  const dest = path.resolve(repo.dest);
  const base_commit = repo.base_commit;

  // Inspect git worktrees for source repo
  const worktrees = worktreeList(source);
  const bExists = branchExists(source, branch);
  const bCommit = bExists ? branchCommit(source, branch) : null;

  // Check if destination exists on disk
  let destExistsOnDisk = false;
  try {
    fs.lstatSync(dest);
    destExistsOnDisk = true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // Look for matching worktree registered at dest
  const matchingWt = worktrees.find((wt) => {
    try {
      return canonicalize(wt.worktree) === canonicalize(dest);
    } catch {
      return path.resolve(wt.worktree) === dest;
    }
  });

  if (matchingWt) {
    // Registered at recorded dest: check branch and HEAD
    if (matchingWt.branch !== branch) {
      throw new ConflictError(
        `Worktree destination '${dest}' is registered for branch '${matchingWt.branch}', expected '${branch}'.`,
        [
          `Observed: registered for branch '${matchingWt.branch}' at commit ${matchingWt.head}`,
          `Expected: registered for branch '${branch}' at base commit ${base_commit}`,
        ]
      );
    }

    if (matchingWt.head !== base_commit) {
      throw new ConflictError(
        `Worktree destination '${dest}' HEAD is at commit '${matchingWt.head}', expected base commit '${base_commit}'.`,
        [
          `Observed: HEAD at ${matchingWt.head}`,
          `Expected: base commit ${base_commit}`,
        ]
      );
    }

    if (!destExistsOnDisk) {
      throw new ConflictError(
        `Worktree destination '${dest}' is registered in git worktree list but does not exist on disk.`
      );
    }

    // Registered at recorded dest + HEAD==base + branch matches -> adopt
    return {
      action: 'adopt',
      stepId: step.id,
      source,
      branch,
      dest,
      base_commit,
      reason: 'registered at recorded dest with matching branch and base commit',
    };
  }

  // Dest is NOT registered in git worktree list
  if (destExistsOnDisk) {
    // Plain directory or unlinked path exists on disk
    throw new ConflictError(
      `Worktree destination '${dest}' already exists on disk but is not registered as a git worktree for branch '${branch}'.`,
      [
        `Observed: destination exists on disk without git worktree registration`,
        `Expected: registered git worktree or absent destination`,
      ]
    );
  }

  // Dest is absent
  if (bExists) {
    // Branch exists in repository
    const otherWtHoldingBranch = worktrees.find((wt) => wt.branch === branch);
    if (otherWtHoldingBranch) {
      throw new ConflictError(
        `Branch '${branch}' is already checked out at '${otherWtHoldingBranch.worktree}'.`,
        [
          `Observed: branch checked out at '${otherWtHoldingBranch.worktree}'`,
          `Expected: branch unchecked-out or registered at '${dest}'`,
        ]
      );
    }

    if (bCommit !== base_commit) {
      throw new ConflictError(
        `Branch '${branch}' in repository '${source}' is at commit '${bCommit}', expected base commit '${base_commit}'.`,
        [
          `Observed: branch commit ${bCommit}`,
          `Expected: base commit ${base_commit}`,
        ]
      );
    }

    const branchExistedBefore = step.detail?.branchExistedBefore;
    if (branchExistedBefore === true) {
      throw new ConflictError(
        `Branch '${branch}' in repository '${source}' already existed prior to workspace creation (branchExistedBefore: true).`,
        [
          `Observed: branch existed prior to workspace creation`,
          `Expected: branch created by this workspace step`,
        ]
      );
    }

    if (branchExistedBefore !== false) {
      throw new ConflictError(
        `Branch '${branch}' in repository '${source}' cannot be verified as created by this workspace step (branchExistedBefore is not false).`
      );
    }

    // Branch at base, unchecked-out, created by this step -> worktree add -- <dest> <branch>
    return {
      action: 'worktreeAddExisting',
      stepId: step.id,
      source,
      branch,
      dest,
      base_commit,
      reason: 'branch at base commit, unchecked-out, created by this step',
    };
  }

  // Branch does not exist and dest does not exist -> retry
  return {
    action: 'retry',
    stepId: step.id,
    source,
    branch,
    dest,
    base_commit,
    reason: 'absent branch and destination; retry creation',
  };
}

export function recoverWorktreeStep(
  step: Step,
  repo?: { source: string; branch: string; dest: string; base_commit: string }
): WorktreeRecoveryDecision {
  const detail = (step.detail ?? {}) as Record<string, unknown>;
  const source = repo?.source ?? (detail.source as string);
  const branch = repo?.branch ?? (detail.branch as string);
  const dest = repo?.dest ?? (detail.dest as string);
  const base_commit = repo?.base_commit ?? (detail.base_commit as string);

  return inspectWorktreeRecovery(step, { source, branch, dest, base_commit });
}

export interface RecordedPlanDoc {
  source: string;
  path?: string;
  mode: DocMode;
  added_by: AddedBy;
  sha256?: string;
  fetched_at?: string;
  reason?: string;
  text?: boolean;
}

export interface RecordedPlan {
  name: string;
  request: string;
  context: string[];
  adapters: ManifestAdapter[];
  repos: RepoPlan[];
  docs: RecordedPlanDoc[];
  gaps: string[];
}

function normalizeSource(source: string): string {
  return canonicalize(source);
}

/**
 * Reconstructs the full deterministic plan from the operation journal.
 *
 * The journal's `plan` field is authoritative: it stores base commits, document
 * hashes, unread metadata and context so a restart never re-derives the plan
 * from source state that may have changed after the crash. Older journals that
 * predate plan persistence fall back to worktree/snapshot step details.
 */
export function extractRecordedPlan(op: Operation, fallbackName: string): RecordedPlan {
  const rawPlan = (op.plan ?? undefined) as Record<string, unknown> | undefined;
  const rawRepos = rawPlan && Array.isArray(rawPlan.repos) ? (rawPlan.repos as any[]) : null;
  const rawDocs = rawPlan && Array.isArray(rawPlan.docs) ? (rawPlan.docs as any[]) : null;

  if (rawPlan && (rawRepos || rawDocs)) {
    return {
      name: (rawPlan.name as string) ?? (op.args?.name as string) ?? fallbackName,
      request: (rawPlan.request as string) ?? (op.args?.request as string) ?? '',
      context: Array.isArray(rawPlan.context) ? (rawPlan.context as string[]) : [],
      adapters:
        Array.isArray(rawPlan.adapters) && (rawPlan.adapters as unknown[]).length > 0
          ? (rawPlan.adapters as ManifestAdapter[])
          : (['agents'] as ManifestAdapter[]),
      repos: (rawRepos ?? []).map((r) => ({
        name: r.name,
        source: normalizeSource(r.source),
        dest: r.dest,
        branch: r.branch,
        base_commit: r.base_commit,
        dirty: r.dirty === true,
        dirtyFiles: Array.isArray(r.dirtyFiles) ? (r.dirtyFiles as string[]) : [],
        reason: r.reason ?? 'Explicit repository supplied by the user.',
      })),
      docs: (rawDocs ?? []).map((d) => ({
        source: d.source,
        ...(d.path ? { path: d.path as string } : {}),
        mode: (d.mode as DocMode) ?? 'snapshot',
        added_by: (d.added_by as AddedBy) ?? 'user',
        ...(d.sha256 ? { sha256: d.sha256 as string } : {}),
        ...(d.fetched_at ? { fetched_at: d.fetched_at as string } : {}),
        ...(d.reason ? { reason: d.reason as string } : {}),
        ...(typeof d.text === 'boolean' ? { text: d.text as boolean } : {}),
      })),
      gaps: Array.isArray(rawPlan.gaps) ? (rawPlan.gaps as string[]) : [],
    };
  }

  const args = op.args ?? {};
  const repos: RepoPlan[] = [];
  for (const s of op.steps.filter((x) => x.type === 'worktree')) {
    const detail = (s.detail ?? {}) as Record<string, unknown>;
    repos.push({
      name: s.id.replace(/^worktree:/, ''),
      source: normalizeSource((detail.source as string) ?? ''),
      dest: (detail.dest as string) ?? '',
      branch: (detail.branch as string) ?? '',
      base_commit: (detail.base_commit as string) ?? '',
      dirty: detail.dirty === true,
      dirtyFiles: Array.isArray(detail.dirtyFiles) ? (detail.dirtyFiles as string[]) : [],
      reason: (detail.reason as string) ?? 'Explicit repository supplied by the user.',
    });
  }

  const docs: RecordedPlanDoc[] = [];
  for (const s of op.steps.filter((x) => x.type === 'snapshot')) {
    const detail = (s.detail ?? {}) as Record<string, unknown>;
    docs.push({
      source: (detail.source as string) ?? '',
      path: (detail.dest as string) ?? '',
      mode: 'snapshot',
      added_by: 'user',
      ...(detail.sha256 ? { sha256: detail.sha256 as string } : {}),
      ...(typeof detail.text === 'boolean' ? { text: detail.text as boolean } : {}),
    });
  }

  return {
    name: (args.name as string) ?? fallbackName,
    request: (args.request as string) ?? '',
    context: Array.isArray(args.context) ? (args.context as string[]) : [],
    adapters:
      Array.isArray(args.adapters) && (args.adapters as unknown[]).length > 0
        ? (args.adapters as ManifestAdapter[])
        : (['agents'] as ManifestAdapter[]),
    repos,
    docs,
    gaps: [],
  };
}

/**
 * Scans a workspace root for incomplete `create` operations. Used by `--resume`
 * as a fallback when the requested name directory is absent so that a
 * mismatched `--name` is reported as a conflict (exit 2) rather than mistaken
 * for a missing workspace (exit 1).
 */
export function scanInterruptedWorkspaces(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name);
    const opPath = path.join(candidate, '.wsg', 'operation.json');
    if (!fs.existsSync(opPath)) continue;
    if (fs.existsSync(path.join(candidate, 'workspace.yaml'))) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(opPath, 'utf8')) as {
        operation?: { command?: string; status?: string };
      };
      if (
        raw?.operation &&
        raw.operation.command === 'create' &&
        raw.operation.status !== 'complete'
      ) {
        found.push(candidate);
      }
    } catch {
      // ignore unreadable journals
    }
  }
  return found;
}

/**
 * Resumes an interrupted workspace create operation from the recorded plan.
 */
async function executeResume(
  options: CreateOptions,
  io: CliIO = {}
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const writeStdout = (chunk: string) => stdout.write(chunk);
  const writeStderr = (chunk: string) => stderr.write(chunk);
  const cwd = getCwd(io);

  assertGitVersion('2.38.0');

  const settings = loadConfig(io.env, {
    root: options.root,
    for: options.for,
    code_root: options.codeRoots,
  });
  const expandedRoot = expandHome(settings.workspace_root);
  const resolvedRoot = path.isAbsolute(expandedRoot)
    ? expandedRoot
    : path.resolve(cwd, expandedRoot);

  let wsName: string | undefined = options.name;
  if (wsName !== undefined) {
    assertValidSlug(wsName, 'Workspace name');
  } else if (options.request && options.request.trim().length > 0) {
    wsName = deriveSlug(options.request.trim());
    assertValidSlug(wsName, 'Workspace name');
  } else {
    throw new UsageError('create with --resume requires --name or a request description');
  }

  let wsDir = path.resolve(resolvedRoot, wsName);

  let wsDirExists = false;
  let wsDirIsSymlink = false;
  try {
    const st = fs.lstatSync(wsDir);
    wsDirExists = true;
    wsDirIsSymlink = st.isSymbolicLink();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  if (!wsDirExists) {
    // The requested name directory is absent. If exactly one interrupted
    // create operation exists under the root, adopt it so a mismatched
    // --name/request is reported as a conflict rather than "absent dir".
    const interrupted = scanInterruptedWorkspaces(resolvedRoot);
    if (interrupted.length === 1) {
      wsDir = interrupted[0];
      wsDirExists = true;
      try {
        wsDirIsSymlink = fs.lstatSync(wsDir).isSymbolicLink();
      } catch {
        // ignore
      }
    } else if (interrupted.length > 1) {
      throw new ConflictError(
        `Multiple interrupted create operations found under '${resolvedRoot}'; specify --name to choose one.`,
        interrupted
      );
    }
  }

  if (!wsDirExists) {
    throw new UsageError(
      `Workspace directory '${path.resolve(resolvedRoot, wsName)}' does not exist. Cannot resume.`
    );
  }

  if (wsDirIsSymlink) {
    throw new ConflictError(
      `Workspace destination '${wsDir}' is an existing symbolic link. Refusing to operate on it.`
    );
  }

  const manifestPath = path.join(wsDir, 'workspace.yaml');
  if (fs.existsSync(manifestPath)) {
    throw new ConflictError(
      `Workspace at '${wsDir}' is already complete. Refusing to overwrite.`
    );
  }

  const opFile = readOperation(wsDir);
  if (!opFile || !opFile.operation) {
    throw new ConflictError(
      `Workspace directory '${wsDir}' does not contain an operation journal. Cannot resume.`
    );
  }

  const op = opFile.operation;
  if (op.command !== 'create') {
    throw new ConflictError(
      `Operation journal in '${wsDir}' is for command '${op.command}', not 'create'. Cannot resume.`
    );
  }

  if (op.status === 'complete') {
    throw new ConflictError(
      `Workspace operation in '${wsDir}' is already marked complete.`
    );
  }

  const plan = extractRecordedPlan(op, wsName);

  if (options.name !== undefined && options.name !== plan.name) {
    throw new ConflictError(
      `Workspace name '${options.name}' does not match recorded operation name '${plan.name}'.`
    );
  }
  if (wsName !== plan.name) {
    throw new ConflictError(
      `Workspace name '${wsName}' does not match recorded operation name '${plan.name}'.`
    );
  }

  if (options.request !== undefined && options.request.trim().length > 0) {
    if (plan.request && options.request.trim() !== plan.request.trim()) {
      throw new ConflictError(
        `Supplied request does not match recorded operation request.`,
        [
          `Supplied: ${options.request.trim()}`,
          `Recorded: ${plan.request.trim()}`,
        ]
      );
    }
  }

  if (options.for !== undefined) {
    const suppliedAdapters = settings.adapters as ManifestAdapter[];
    const sameAdapters =
      suppliedAdapters.length === plan.adapters.length &&
      suppliedAdapters.every((a, idx) => a === plan.adapters[idx]);
    if (!sameAdapters) {
      throw new ConflictError(
        `Supplied adapters (${suppliedAdapters.join(',')}) do not match recorded operation adapters (${plan.adapters.join(',')}).`
      );
    }
  }

  if (options.context !== undefined && options.context.length > 0) {
    const sameContext =
      options.context.length === plan.context.length &&
      options.context.every((c, idx) => c === plan.context[idx]);
    if (!sameContext) {
      throw new ConflictError(
        `Supplied context does not match recorded operation context.`
      );
    }
  }

  if (options.repos !== undefined && options.repos.length > 0) {
    const suppliedCanonical = options.repos.map((r) =>
      canonicalize(path.isAbsolute(expandHome(r)) ? expandHome(r) : path.resolve(cwd, expandHome(r)))
    );
    const recordedSources = plan.repos.map((r) => r.source);

    const suppliedSet = new Set(suppliedCanonical);
    const recordedSet = new Set(recordedSources);

    const added = suppliedCanonical.filter((s) => !recordedSet.has(s));
    const removed = recordedSources.filter((s) => !suppliedSet.has(s));

    if (added.length > 0 || removed.length > 0 || suppliedSet.size !== recordedSet.size) {
      const diffLines: string[] = [];
      if (added.length > 0) {
        diffLines.push(`Added repositories: ${added.join(', ')}`);
      }
      if (removed.length > 0) {
        diffLines.push(`Missing repositories: ${removed.join(', ')}`);
      }
      throw new ConflictError(
        `Supplied repositories do not match recorded operation repositories:\n${diffLines.join('\n')}`,
        diffLines
      );
    }
  }

  if (options.docs !== undefined && options.docs.length > 0) {
    const suppliedDocSources = options.docs.map((d) => {
      const kind = classifyDocInput(d);
      return kind === 'url' ? d.trim() : canonicalize(path.resolve(cwd, expandHome(d)));
    });
    const recordedDocSources = plan.docs.map((d) => d.source);

    const suppliedSet = new Set(suppliedDocSources);
    const recordedSet = new Set(recordedDocSources);

    const added = suppliedDocSources.filter((s) => !recordedSet.has(s));
    const removed = recordedDocSources.filter((s) => !suppliedSet.has(s));

    if (added.length > 0 || removed.length > 0 || suppliedSet.size !== recordedSet.size) {
      const diffLines: string[] = [];
      if (added.length > 0) {
        diffLines.push(`Added documents: ${added.join(', ')}`);
      }
      if (removed.length > 0) {
        diffLines.push(`Missing documents: ${removed.join(', ')}`);
      }
      throw new ConflictError(
        `Supplied documents do not match recorded operation documents:\n${diffLines.join('\n')}`,
        diffLines
      );
    }
  }

  const draftManifest: Manifest = {
    version: 1,
    name: plan.name,
    request: plan.request,
    context: plan.context,
    adapters: plan.adapters,
    repos: plan.repos.map((r) => ({
      name: r.name,
      source: r.source,
      path: r.name,
      base_commit: r.base_commit,
      branch: r.branch,
      added_by: 'user',
      intent: 'unspecified',
      evidence: [],
      reason: r.reason ?? 'Explicit repository supplied by the user.',
    })),
    docs: plan.docs.map((d) => ({
      source: d.source,
      ...(d.path ? { path: d.path } : {}),
      mode: d.mode,
      added_by: d.added_by,
      ...(d.sha256 ? { sha256: d.sha256 } : {}),
      ...(d.fetched_at ? { fetched_at: d.fetched_at } : {}),
      ...(d.reason ? { reason: d.reason } : {}),
    })),
    scripts: [],
    commands: [],
    discovery: {
      excluded: [],
      gaps: plan.gaps,
    },
  };

  validateManifest(draftManifest);

  // Acquire lock (takes over stale lock from dead process if present)
  const lock = acquireLock(wsDir, {
    opId: op.id,
    onWarning: (msg) => writeStderr(`${msg}\n`),
  });
  let lockData: LockData | undefined = lock;
  faultPoint('after-lock', io.env);

  try {
    // PREFLIGHT: inspect every worktree and snapshot step before ANY mutation.
    const worktreeDecisions: WorktreeRecoveryDecision[] = [];
    for (const r of plan.repos) {
      const stepId = `worktree:${r.name}`;
      const step = op.steps.find((s) => s.id === stepId) ?? {
        id: stepId,
        type: 'worktree',
        status: 'planned',
        detail: {
          source: r.source,
          dest: r.dest,
          branch: r.branch,
          base_commit: r.base_commit,
        },
      };

      const decision = recoverWorktreeStep(step, r);
      worktreeDecisions.push(decision);
    }

    // Snapshot reproducibility preflight. The recorded sha is authoritative:
    // an intact target needs nothing, otherwise the source must still hash to
    // the recorded value. Never rebuild a snapshot from changed source state.
    const tmpDir = path.join(wsDir, '.wsg', 'tmp', op.id);
    const snapshotRepair: Array<{ doc: RecordedPlanDoc; finalPath: string; content: Buffer }> = [];
    const intactSnapshots: string[] = [];
    for (const d of plan.docs) {
      if (d.mode !== 'snapshot' || !d.path) continue;
      const finalPath = resolveInside(wsDir, d.path);
      if (d.sha256 && fs.existsSync(finalPath)) {
        const currentSha = sha256(fs.readFileSync(finalPath));
        if (currentSha === d.sha256) {
          intactSnapshots.push(d.path);
          continue;
        }
      }
      if (!d.sha256) {
        throw new ConflictError(
          `Recorded snapshot '${d.path}' is missing its sha256; cannot verify recovery.`
        );
      }
      let sourceContent: Buffer;
      try {
        sourceContent = fs.readFileSync(d.source);
      } catch (err: unknown) {
        throw new ConflictError(
          `Snapshot source '${d.source}' for '${d.path}' is unreadable; cannot reproduce recorded snapshot.`,
          [
            `Observed: ${(err as Error).message}`,
            `Expected: readable file with sha256 ${d.sha256}`,
          ]
        );
      }
      const sourceSha = sha256(sourceContent);
      if (sourceSha !== d.sha256) {
        throw new ConflictError(
          `Snapshot source '${d.source}' changed since the interrupted operation; refusing to rebuild '${d.path}' from changed source state.`,
          [
            `Observed: source sha256 ${sourceSha}`,
            `Recorded: source sha256 ${d.sha256}`,
            `Restore the original document or start a new workspace.`,
          ]
        );
      }
      snapshotRepair.push({ doc: d, finalPath, content: sourceContent });
    }

    if (options.dryRun) {
      return 0;
    }

    // Ensure all required steps exist in opFile before marking
    const stepIds = new Set(op.steps.map((s) => s.id));
    for (const r of plan.repos) {
      const stepId = `worktree:${r.name}`;
      if (!stepIds.has(stepId)) {
        op.steps.push({
          id: stepId,
          type: 'worktree',
          status: 'planned',
          detail: {
            source: r.source,
            dest: r.dest,
            branch: r.branch,
            base_commit: r.base_commit,
          },
        });
      }
    }
    for (const d of plan.docs) {
      if (d.mode === 'snapshot' && d.path) {
        const stepId = `snapshot:${d.path}`;
        if (!stepIds.has(stepId)) {
          op.steps.push({
            id: stepId,
            type: 'snapshot',
            status: 'planned',
            detail: {
              source: d.source,
              dest: d.path,
              sha256: d.sha256,
              ...(typeof d.text === 'boolean' ? { text: d.text } : {}),
            },
          });
        }
      }
    }
    if (!stepIds.has('generate')) {
      op.steps.push({ id: 'generate', type: 'generate', status: 'planned' });
    }
    if (!stepIds.has('publish-manifest')) {
      op.steps.push({ id: 'publish-manifest', type: 'publish-manifest', status: 'planned' });
    }
    // Persist the deterministic plan so subsequent resumes never rebuild it.
    opFile.operation.plan = plan as unknown as Record<string, unknown>;
    writeOperation(wsDir, opFile);

    // MUTATION PHASE: Worktree steps
    for (const d of worktreeDecisions) {
      if (d.action === 'adopt') {
        markStep(wsDir, d.stepId, 'done', {
          detail: {
            recovered: 'adopt',
          },
        });
      } else if (d.action === 'worktreeAddExisting') {
        markStep(wsDir, d.stepId, 'started');
        worktreeAddExisting(d.source, d.branch, d.dest);
        faultPoint('after-worktree', io.env);
        markStep(wsDir, d.stepId, 'done', {
          detail: {
            recovered: 'worktreeAddExisting',
          },
        });
      } else if (d.action === 'retry') {
        markStep(wsDir, d.stepId, 'started', {
          detail: {
            branchExistedBefore: false,
            destExistedBefore: false,
          },
        });
        worktreeAddNewBranch(d.source, d.branch, d.dest, d.base_commit);
        faultPoint('after-worktree', io.env);
        markStep(wsDir, d.stepId, 'done', {
          detail: {
            recovered: 'retry',
          },
        });
      }
    }

    // Snapshot steps
    ensureDir(tmpDir);
    for (const d of plan.docs) {
      if (d.mode === 'snapshot' && d.path && intactSnapshots.includes(d.path)) {
        markStep(wsDir, `snapshot:${d.path}`, 'done', {
          detail: { recovered: 'intact' },
        });
      }
    }
    for (const entry of snapshotRepair) {
      const d = entry.doc;
      const relPath = d.path as string;
      const stepId = `snapshot:${relPath}`;
      markStep(wsDir, stepId, 'started');
      const stagingPath = path.join(tmpDir, relPath);
      ensureDir(path.dirname(stagingPath));
      writeFileAtomic(stagingPath, entry.content, { tmpDir });
      ensureDir(path.dirname(entry.finalPath));
      fs.renameSync(stagingPath, entry.finalPath);
      markStep(wsDir, stepId, 'done', {
        detail: { recovered: 'copy' },
      });
    }

    // Generation & ownership reconciliation
    markStep(wsDir, 'generate', 'started');
    const unreadDocs = new Set<string>();
    for (const d of plan.docs) {
      if (d.path && d.text === false) {
        unreadDocs.add(d.path);
      }
    }
    const generatedFiles = renderAll(draftManifest, { unreadDocs });
    const currentJournal = readOperation(wsDir);
    const owned = currentJournal?.owned ?? {};
    const reconcileResult = reconcileGenerated(wsDir, generatedFiles, owned);
    markStep(wsDir, 'generate', 'done');
    faultPoint('after-generate', io.env);

    // Publish manifest
    markStep(wsDir, 'publish-manifest', 'started');
    const manifestYaml = serializeManifest(draftManifest);
    writeFileAtomic(manifestPath, manifestYaml);
    markStep(wsDir, 'publish-manifest', 'done');

    const finishedJournal = readOperation(wsDir);
    if (finishedJournal && finishedJournal.operation) {
      finishedJournal.operation.status = 'complete';
      finishedJournal.operation.completedAt = new Date().toISOString();
      writeOperation(wsDir, finishedJournal);
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup failure
    }

    writeStdout(`\nWorkspace resumed at ${wsDir}\n`);
    if (reconcileResult.partial || reconcileResult.proposals.length > 0) {
      writeStdout(`Note: Some generated files required reconciliation (.wsg-new proposals written).\n`);
      return 3;
    }

    return 0;
  } finally {
    if (lockData) {
      try {
        releaseLock(wsDir, lockData);
      } catch {
        // ignore
      }
      lockData = undefined;
    }
  }
}


/**
 * Executes workspace creation end-to-end.
 */
async function executeCreate(
  options: CreateOptions,
  io: CliIO = {}
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const writeStdout = (chunk: string) => stdout.write(chunk);
  const writeStderr = (chunk: string) => stderr.write(chunk);
  const cwd = getCwd(io);

  // (a) Preflight validations before any mutation

  // 1. Git version
  assertGitVersion('2.38.0');

  // 2. Note on --code-root (PD6)
  if (options.codeRoots && options.codeRoots.length > 0) {
    writeStderr(
      'wsg: note: --code-root is accepted but autonomous discovery is not available in this version; repositories must be specified explicitly with --repo\n'
    );
  }

  // 3. Request validation
  if (!options.request || typeof options.request !== 'string' || options.request.trim().length === 0) {
    throw new UsageError('Workspace request must not be empty');
  }
  const request = options.request.trim();

  // 4. Slug / Name derivation and validation
  let wsName: string;
  if (options.name !== undefined) {
    assertValidSlug(options.name, 'Workspace name');
    wsName = options.name;
  } else {
    wsName = deriveSlug(request);
    assertValidSlug(wsName, 'Workspace name');
  }

  // 5. Settings / Config / Adapters resolution
  // loadConfig enforces adapter validation (e.g. --for bogus or --for none,agents -> UsageError exit 1)
  const settings = loadConfig(io.env, {
    root: options.root,
    for: options.for,
    code_root: options.codeRoots,
  });
  const expandedRoot = expandHome(settings.workspace_root);
  const resolvedRoot = path.isAbsolute(expandedRoot)
    ? expandedRoot
    : path.resolve(cwd, expandedRoot);
  const wsDir = path.resolve(resolvedRoot, wsName);
  const adapters = settings.adapters as ManifestAdapter[];

  // 6. Scout seam invocation (defaults to ExplicitScout)
  const scout = options.scout ?? new ExplicitScout();
  const scoutResult = await scout.scout({
    request,
    repos: options.repos,
    docs: options.docs,
    context: options.context,
  });

  if (scoutResult.kind === 'none') {
    throw new UsageError(scoutResult.reason);
  }
  if (scoutResult.kind === 'ambiguous') {
    throw new ConflictError(
      scoutResult.reason,
      scoutResult.guidance ? [scoutResult.guidance] : []
    );
  }

  // 7. Repositories inspection and preflight
  const uniqueRepoMap = new Map<
    string,
    { rawPath: string; source: string; info: RepoInfo; reason?: string }
  >();

  for (const r of scoutResult.repos) {
    const rawPath = r.source;
    const expanded = expandHome(rawPath);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);

    // repoInfo throws UsageError for non-repo, bare repo, unborn HEAD, or nonexistent dir
    const info = repoInfo(resolved);

    // PD1 check: --repo must be a repo toplevel
    const canonicalInput = canonicalize(resolved);
    if (canonicalInput !== info.toplevel) {
      throw new UsageError(
        `Path '${rawPath}' is a subdirectory of git repository at '${info.toplevel}'. Please specify the repository root: --repo ${info.toplevel}`
      );
    }

    // Deduplicate duplicate spellings of same source canonical toplevel
    if (!uniqueRepoMap.has(info.toplevel)) {
      uniqueRepoMap.set(info.toplevel, {
        rawPath,
        source: info.toplevel,
        info,
        reason: r.reason,
      });
    }
  }

  const uniqueRepos = Array.from(uniqueRepoMap.values());
  const entryNames = assignEntryNames(uniqueRepos.map((r) => r.source));

  const repos: RepoPlan[] = uniqueRepos.map((r) => {
    const entryName = entryNames.get(r.source)!;
    const branch = `wsg/${wsName}/${entryName}`;
    if (!checkBranchName(branch)) {
      throw new UsageError(`Invalid branch name '${branch}'`);
    }
    return {
      name: entryName,
      source: r.source,
      dest: path.join(wsDir, entryName),
      branch,
      base_commit: r.info.headCommit,
      dirty: r.info.dirty,
      dirtyFiles: r.info.dirtyFiles,
      reason: r.reason ?? 'Explicit repository supplied by the user.',
    };
  });

  // Collect gaps (submodules / LFS)
  const allGaps: string[] = [];
  if (scoutResult.gaps) {
    allGaps.push(...scoutResult.gaps);
  }
  for (const r of repos) {
    const gaps = detectGaps(r.source);
    allGaps.push(...gaps);
  }

  // 8. Documents inspection and planning
  const inspectedDocs: InspectedDoc[] = [];
  if (scoutResult.docs) {
    for (const d of scoutResult.docs) {
      const kind = classifyDocInput(d.input);
      if (kind === 'url') {
        inspectedDocs.push(inspectDoc(d.input));
      } else {
        const expanded = expandHome(d.input);
        const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
        inspectedDocs.push(inspectDoc(resolved));
      }
    }
  }
  const plannedDocs = planDocs(inspectedDocs, { addedBy: 'user' });

  // (b) CreatePlan + Draft Manifest + validateManifest
  const draftManifest: Manifest = {
    version: 1,
    name: wsName,
    request,
    context: options.context ?? [],
    adapters,
    repos: repos.map((r) => ({
      name: r.name,
      source: r.source,
      path: r.name,
      base_commit: r.base_commit,
      branch: r.branch,
      added_by: 'user',
      intent: 'unspecified',
      evidence: [],
      reason: r.reason,
    })),
    docs: plannedDocs.map((d) => ({
      source: d.source,
      ...(d.path ? { path: d.path } : {}),
      mode: d.mode,
      added_by: d.added_by,
      ...(d.sha256 ? { sha256: d.sha256 } : {}),
      ...(d.fetched_at ? { fetched_at: d.fetched_at } : {}),
      ...(d.reason ? { reason: d.reason } : {}),
    })),
    scripts: [],
    commands: [],
    discovery: {
      excluded: [],
      gaps: allGaps,
    },
  };

  // Run manifest validation before any mutation
  validateManifest(draftManifest);

  // (c) Preflight target, branches, destination conflicts
  let wsDirExists = false;
  let wsDirIsSymlink = false;
  try {
    const st = fs.lstatSync(wsDir);
    wsDirExists = true;
    wsDirIsSymlink = st.isSymbolicLink();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  if (wsDirExists) {
    if (wsDirIsSymlink) {
      throw new ConflictError(
        `Workspace destination '${wsDir}' is an existing symbolic link. Refusing to overwrite.`
      );
    }

    const manifestFile = path.join(wsDir, 'workspace.yaml');
    if (fs.existsSync(manifestFile)) {
      throw new ConflictError(
        `Workspace directory '${wsDir}' already exists with a completed workspace. Choose a different name or inspect the existing workspace.`
      );
    }

    const lockPath = path.join(wsDir, '.wsg', 'lock');
    if (fs.existsSync(lockPath)) {
      try {
        const lockContent = fs.readFileSync(lockPath, 'utf8');
        const lockData = parseValidLockData(lockContent);
        if (lockData && isPidAlive(lockData.pid)) {
          throw new ConflictError(
            `Lock is held by active process (pid ${lockData.pid} on ${lockData.hostname}). Cannot modify workspace while another operation is running.`
          );
        }
      } catch (err: unknown) {
        if (err instanceof ConflictError) throw err;
      }
    }

    let dirEntries: string[] = [];
    try {
      dirEntries = fs.readdirSync(wsDir);
    } catch {
      // ignore
    }

    if (dirEntries.length > 0) {
      throw new ConflictError(
        `Workspace directory '${wsDir}' already exists with an incomplete workspace. Use --resume to continue the existing operation or remove the directory to start over.`
      );
    }

    throw new ConflictError(
      `Workspace directory '${wsDir}' already exists. Choose a different name or inspect the existing workspace.`
    );
  }

  for (const r of repos) {
    if (branchExists(r.source, r.branch)) {
      throw new ConflictError(
        `Branch '${r.branch}' already exists in repository '${r.source}'.`,
        [
          `To inspect the existing branch: git -C "${r.source}" log -1 "${r.branch}"`,
          `To remove the branch if no longer needed: git -C "${r.source}" branch -D "${r.branch}"`,
          `Or choose a different workspace name using --name <name>.`,
        ]
      );
    }

    if (fs.existsSync(r.dest)) {
      throw new ConflictError(`Worktree destination '${r.dest}' already exists.`);
    }
  }

  // Dirty source warnings
  for (const r of repos) {
    if (r.dirty) {
      writeStderr(
        `wsg: warning: source repository '${r.source}' has uncommitted changes; uncommitted changes are not carried over to the workspace\n`
      );
    }
  }

  // (d) Print plan and mapping before mutation
  writeStdout(`Workspace: ${wsName}\n`);
  writeStdout(`Destination: ${wsDir}\n`);
  writeStdout(`Request: ${request}\n`);
  if (adapters.length > 0) {
    writeStdout(`Adapters: ${adapters.join(', ')}\n`);
  } else {
    writeStdout(`Adapters: none\n`);
  }
  writeStdout(`Repositories (${repos.length}):\n`);
  for (const r of repos) {
    writeStdout(
      `  - ${r.name}: ${r.source} -> ${r.name} (branch: ${r.branch}, base: ${r.base_commit.slice(0, 8)})\n`
    );
  }
  if (plannedDocs.length > 0) {
    writeStdout(`Documents (${plannedDocs.length}):\n`);
    for (const d of plannedDocs) {
      if (d.mode === 'snapshot') {
        writeStdout(
          `  - ${d.path} (mode: snapshot, sha256: ${d.sha256?.slice(0, 8)}) <- ${d.source}\n`
        );
      } else {
        writeStdout(`  - ${d.source} (mode: reference) - ${d.reason}\n`);
      }
    }
  }
  if (allGaps.length > 0) {
    writeStdout(`Gaps:\n`);
    for (const g of allGaps) {
      writeStdout(`  - ${g}\n`);
    }
  }

  // Dry-run exits here: creates no directory, no worktrees, no branches
  if (options.dryRun) {
    return 0;
  }

  // (e) Begin mutation: exclusively reserve directory, initWsgDir, lock, journal running
  const parentDir = path.dirname(wsDir);
  fs.mkdirSync(parentDir, { recursive: true });

  try {
    fs.mkdirSync(wsDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ConflictError(
        `Workspace directory '${wsDir}' already exists or was reserved by another process.`
      );
    }
    throw err;
  }

  initWsgDir(wsDir);
  const opId = crypto.randomUUID();
  const lock = acquireLock(wsDir, { opId });

  let lockData: LockData | undefined = lock;

  try {
    if (options._afterLockAcquired) {
      options._afterLockAcquired(wsDir);
    }

    // Re-verify destination is still pristine before writing operation journal
    if (fs.existsSync(path.join(wsDir, 'workspace.yaml'))) {
      throw new ConflictError(
        `Workspace directory '${wsDir}' already contains a completed workspace.`
      );
    }
    const existingOp = readOperation(wsDir);
    if (existingOp?.operation) {
      throw new ConflictError(
        `Workspace directory '${wsDir}' already contains an active operation journal.`
      );
    }
    const steps: Step[] = [];
    for (const r of repos) {
      steps.push({
        id: `worktree:${r.name}`,
        type: 'worktree',
        status: 'planned',
        detail: {
          source: r.source,
          dest: r.dest,
          branch: r.branch,
          base_commit: r.base_commit,
        },
      });
    }
    for (const d of plannedDocs) {
      if (d.mode === 'snapshot' && d.path) {
        steps.push({
          id: `snapshot:${d.path}`,
          type: 'snapshot',
          status: 'planned',
          detail: {
            source: d.source,
            dest: d.path,
            sha256: d.sha256,
            ...(typeof d.text === 'boolean' ? { text: d.text } : {}),
          },
        });
      }
    }
    steps.push({
      id: 'generate',
      type: 'generate',
      status: 'planned',
    });
    steps.push({
      id: 'publish-manifest',
      type: 'publish-manifest',
      status: 'planned',
    });

    // Persist the full deterministic plan (including base commits, document
    // hashes, unread metadata and context) so --resume never rebuilds the
    // plan from source state that may have changed after a crash.
    const recordedPlan: RecordedPlan = {
      name: wsName,
      request,
      context: options.context ?? [],
      adapters,
      repos: repos.map((r) => ({ ...r })),
      docs: plannedDocs.map((d) => ({
        source: d.source,
        ...(d.path ? { path: d.path } : {}),
        mode: d.mode,
        added_by: d.added_by,
        ...(d.sha256 ? { sha256: d.sha256 } : {}),
        ...(d.fetched_at ? { fetched_at: d.fetched_at } : {}),
        ...(d.reason ? { reason: d.reason } : {}),
        ...(typeof d.text === 'boolean' ? { text: d.text } : {}),
      })),
      gaps: allGaps,
    };

    const op: Operation = {
      id: opId,
      command: 'create',
      status: 'running',
      startedAt: new Date().toISOString(),
      args: {
        request,
        name: wsName,
        adapters,
        repos: repos.map((r) => ({ name: r.name, source: r.source })),
        docs: plannedDocs.map((d) => ({ source: d.source, path: d.path, mode: d.mode })),
      },
      plan: recordedPlan as unknown as Record<string, unknown>,
      steps,
    };

    const opFile: OperationFile = {
      version: 1,
      owned: {},
      operation: op,
    };
    writeOperation(wsDir, opFile);

    faultPoint('after-lock', io.env);

    // (f) Worktree steps
    for (const r of repos) {
      if (options._beforeWorktreeStep) {
        options._beforeWorktreeStep(r);
      }

      // Recheck actual existence immediately before marking step started
      const branchExisted = branchExists(r.source, r.branch);
      const destExisted = fs.existsSync(r.dest);

      if (branchExisted || destExisted) {
        if (branchExisted) {
          throw new ConflictError(
            `Branch '${r.branch}' already exists in repository '${r.source}'.`,
            [
              `To inspect the existing branch: git -C "${r.source}" log -1 "${r.branch}"`,
              `To remove the branch if no longer needed: git -C "${r.source}" branch -D "${r.branch}"`,
              `Or choose a different workspace name using --name <name>.`,
            ]
          );
        }
        throw new ConflictError(`Worktree destination '${r.dest}' already exists.`);
      }

      const stepId = `worktree:${r.name}`;
      markStep(wsDir, stepId, 'started', {
        detail: {
          source: r.source,
          dest: r.dest,
          branch: r.branch,
          base_commit: r.base_commit,
          branchExistedBefore: false,
          destExistedBefore: false,
        },
      });
      worktreeAddNewBranch(r.source, r.branch, r.dest, r.base_commit);
      faultPoint('after-worktree', io.env);
      markStep(wsDir, stepId, 'done');
    }

    // (g) Snapshots via .wsg/tmp/<opId>/ then rename
    const tmpDir = path.join(wsDir, '.wsg', 'tmp', opId);
    ensureDir(tmpDir);

    for (const d of plannedDocs) {
      if (d.mode === 'snapshot' && d.path) {
        const stepId = `snapshot:${d.path}`;
        markStep(wsDir, stepId, 'started');

        if (options._beforeSnapshotWrite) {
          options._beforeSnapshotWrite(d);
        }

        const stagingPath = path.join(tmpDir, d.path);
        const finalPath = resolveInside(wsDir, d.path);
        const stagingDir = path.dirname(stagingPath);
        const finalDir = path.dirname(finalPath);

        ensureDir(stagingDir);
        if (d.inspected.kind === 'file') {
          writeFileAtomic(stagingPath, d.inspected.content, { tmpDir });
        }

        ensureDir(finalDir);
        fs.renameSync(stagingPath, finalPath);

        try {
          const dirFd = fs.openSync(finalDir, fs.constants.O_RDONLY);
          try {
            fs.fsyncSync(dirFd);
          } finally {
            fs.closeSync(dirFd);
          }
        } catch {
          // ignore if dir fsync not supported on OS
        }

        markStep(wsDir, stepId, 'done');
      }
    }

    // (h) renderAll -> reconcileGenerated
    markStep(wsDir, 'generate', 'started');
    const unreadDocs = new Set<string>();
    for (const d of plannedDocs) {
      if (d.path && d.text === false) {
        unreadDocs.add(d.path);
      }
    }
    const generatedFiles = renderAll(draftManifest, { unreadDocs });
    const currentJournal = readOperation(wsDir);
    const owned = currentJournal?.owned ?? {};
    const reconcileResult = reconcileGenerated(wsDir, generatedFiles, owned);
    markStep(wsDir, 'generate', 'done');
    faultPoint('after-generate', io.env);

    // (i) Publish workspace.yaml atomically, complete journal, clean tmp, release lock
    markStep(wsDir, 'publish-manifest', 'started');
    const manifestYaml = serializeManifest(draftManifest);
    const manifestPath = path.join(wsDir, 'workspace.yaml');
    writeFileAtomic(manifestPath, manifestYaml);
    markStep(wsDir, 'publish-manifest', 'done');

    const finishedJournal = readOperation(wsDir);
    if (finishedJournal && finishedJournal.operation) {
      finishedJournal.operation.status = 'complete';
      finishedJournal.operation.completedAt = new Date().toISOString();
      writeOperation(wsDir, finishedJournal);
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup failure
    }

    // (j) Summary; exit 3 if proposals
    writeStdout(`\nWorkspace created at ${wsDir}\n`);
    if (reconcileResult.partial || reconcileResult.proposals.length > 0) {
      writeStdout(`Note: Some generated files required reconciliation (.wsg-new proposals written).\n`);
      return 3;
    }

    return 0;
  } finally {
    if (lockData) {
      try {
        releaseLock(wsDir, lockData);
      } catch {
        // ignore lock release error on error path
      }
      lockData = undefined;
    }
  }
}

/**
 * Public entry point for `wsg create`. Accepts either CreateOptions or string[] args.
 */
export async function runCreate(
  optionsOrArgs: CreateOptions | string[],
  io: CliIO = {}
): Promise<number> {
  if (Array.isArray(optionsOrArgs)) {
    const { values, positionals } = parseArgs({
      args: optionsOrArgs,
      options: {
        name: { type: 'string' },
        root: { type: 'string' },
        repo: { type: 'string', multiple: true },
        doc: { type: 'string', multiple: true },
        context: { type: 'string', multiple: true },
        'code-root': { type: 'string', multiple: true },
        for: { type: 'string' },
        'dry-run': { type: 'boolean' },
        resume: { type: 'boolean' },
        'allow-dirty-evidence': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });

    if (values.help) {
      (io.stdout ?? process.stdout).write(CREATE_HELP_TEXT);
      return 0;
    }

    if (values['allow-dirty-evidence']) {
      throw new UsageError('--allow-dirty-evidence is reserved for Milestone 3');
    }

    const request = positionals.join(' ');

    if (values.resume) {
      return await executeResume(
        {
          request,
          name: values.name,
          root: values.root,
          repos: values.repo,
          docs: values.doc,
          context: values.context,
          codeRoots: values['code-root'],
          for: values.for,
          dryRun: values['dry-run'],
          resume: values.resume,
          allowDirtyEvidence: values['allow-dirty-evidence'],
        },
        io
      );
    }

    if (positionals.length === 0) {
      throw new UsageError('create requires a request description: wsg create <request> [options]');
    }

    return await executeCreate(
      {
        request,
        name: values.name,
        root: values.root,
        repos: values.repo,
        docs: values.doc,
        context: values.context,
        codeRoots: values['code-root'],
        for: values.for,
        dryRun: values['dry-run'],
        resume: values.resume,
        allowDirtyEvidence: values['allow-dirty-evidence'],
      },
      io
    );
  }

  if (optionsOrArgs.allowDirtyEvidence) {
    throw new UsageError('--allow-dirty-evidence is reserved for Milestone 3');
  }

  if (optionsOrArgs.resume) {
    return await executeResume(optionsOrArgs, io);
  }

  return await executeCreate(optionsOrArgs, io);
}
