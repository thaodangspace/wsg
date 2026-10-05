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
  worktreeAddNewBranch,
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
import { writeFileAtomic, ensureDir } from './fsx.ts';
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
      steps,
    };

    const opFile: OperationFile = {
      version: 1,
      owned: {},
      operation: op,
    };
    writeOperation(wsDir, opFile);

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

    if (values.resume) {
      throw new UsageError('--resume is not implemented in this version');
    }

    if (values['allow-dirty-evidence']) {
      throw new UsageError('--allow-dirty-evidence is reserved for Milestone 3');
    }

    if (positionals.length === 0) {
      throw new UsageError('create requires a request description: wsg create <request> [options]');
    }

    const request = positionals.join(' ');
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

  if (optionsOrArgs.resume) {
    throw new UsageError('--resume is not implemented in this version');
  }

  if (optionsOrArgs.allowDirtyEvidence) {
    throw new UsageError('--allow-dirty-evidence is reserved for Milestone 3');
  }

  return await executeCreate(optionsOrArgs, io);
}
