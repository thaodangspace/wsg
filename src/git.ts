import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.ts';
import { canonicalize } from './paths.ts';
import { checkBranchName } from './branch.ts';

export { checkBranchName };

export interface RunGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
}

/**
 * Asserts that an argument is safe to pass to git subprocesses:
 * - not empty
 * - does not start with a dash ('-') to prevent option injection
 * - contains no NUL bytes
 */
export function assertSafeArg(arg: string, paramName: string = 'Argument'): string {
  if (typeof arg !== 'string' || arg.length === 0) {
    throw new UsageError(`${paramName} must not be empty`);
  }
  if (arg.startsWith('-')) {
    throw new UsageError(`${paramName} '${arg}' must not start with a dash ('-')`);
  }
  if (arg.includes('\0')) {
    throw new UsageError(`${paramName} must not contain NUL bytes`);
  }
  return arg;
}

/**
 * Runs git with sanitized environment and arguments.
 * Unsets parent GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, etc.
 * Purges GIT_CONFIG_* injection variables and GIT_HOOKS_PATH.
 * Enforces GIT_TERMINAL_PROMPT=0 to avoid hangs.
 * Logs argv when WSG_DEBUG is set.
 */
export function runGit(args: string[], options: RunGitOptions = {}): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_HOOKS_PATH;
  delete env.GIT_EXEC_PATH;
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_CONFIG_COUNT;

  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_')) {
      delete env[key];
    }
  }

  if (process.env.WSG_DEBUG) {
    console.error(`[wsg git] git ${args.join(' ')}`);
  }

  const result = spawnSync('git', args, {
    cwd: options.cwd,
    env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const err = new Error(
      `git command failed (exit ${result.status}): git ${args.join(' ')}\n${result.stderr || result.stdout}`
    );
    Object.assign(err, {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    });
    throw err;
  }

  return result.stdout;
}

/**
 * Queries git version.
 */
export function gitVersion(options: RunGitOptions = {}): string {
  const output = runGit(['--version'], options).trim();
  const match = output.match(/git version (\d+\.\d+(?:\.\d+)?)/);
  if (!match) {
    throw new UsageError(`Unable to parse git version from: '${output}'`);
  }
  return match[1];
}

function parseSemverParts(versionStr: string): [number, number, number] {
  const match = versionStr.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    throw new UsageError(`Invalid git version format: '${versionStr}'`);
  }
  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    match[3] ? parseInt(match[3], 10) : 0,
  ];
}

/**
 * Asserts that git meets the minimum version requirement (default >= 2.38.0).
 */
export function assertGitVersion(
  minVersion: string = '2.38.0',
  optionsOrCurrentVersion?: RunGitOptions | string,
  options?: RunGitOptions
): void {
  let current: string;
  let runOpts: RunGitOptions | undefined;

  if (typeof optionsOrCurrentVersion === 'string') {
    current = optionsOrCurrentVersion;
    runOpts = options;
  } else {
    runOpts = optionsOrCurrentVersion;
    current = gitVersion(runOpts);
  }

  const [currMajor, currMinor, currPatch] = parseSemverParts(current);
  const [minMajor, minMinor, minPatch] = parseSemverParts(minVersion);

  if (
    currMajor < minMajor ||
    (currMajor === minMajor && currMinor < minMinor) ||
    (currMajor === minMajor && currMinor === minMinor && currPatch < minPatch)
  ) {
    throw new UsageError(
      `Git version ${minVersion} or newer is required (found ${current})`
    );
  }
}

export interface RepoInfo {
  toplevel: string;
  headCommit: string;
  headBranch: string | null;
  dirty: boolean;
  dirtyFiles: string[];
}

/**
 * Inspects a repository safely:
 * - resolves realpath toplevel
 * - 40-hex commit at HEAD
 * - current branch if on one (null if detached)
 * - dirty status and dirty file list
 * Throws UsageError if path is non-repo, bare repository, or has unborn HEAD.
 */
export function repoInfo(repoPath: string, options: RunGitOptions = {}): RepoInfo {
  assertSafeArg(repoPath, 'Repository path');
  const canonical = canonicalize(repoPath);

  try {
    const st = fs.statSync(canonical);
    if (!st.isDirectory()) {
      throw new UsageError(`Path '${repoPath}' is not a directory`);
    }
  } catch (err: unknown) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`Cannot access path '${repoPath}': ${(err as Error).message}`);
  }

  // Check bare repository
  let isBare = false;
  try {
    const bareOut = runGit(['-C', canonical, 'rev-parse', '--is-bare-repository'], options).trim();
    isBare = bareOut === 'true';
  } catch {
    throw new UsageError(`'${repoPath}' is not a git repository`);
  }

  if (isBare) {
    throw new UsageError(`'${repoPath}' is a bare git repository`);
  }

  let toplevel = '';
  try {
    toplevel = runGit(['-C', canonical, 'rev-parse', '--show-toplevel'], options).trim();
  } catch {
    throw new UsageError(`'${repoPath}' is not a git repository`);
  }

  const toplevelReal = canonicalize(toplevel);

  // Check unborn HEAD
  let headCommit = '';
  try {
    headCommit = runGit(['-C', canonical, 'rev-parse', '--verify', 'HEAD^{commit}'], options).trim();
  } catch {
    throw new UsageError(`'${repoPath}' has an unborn HEAD (no commits yet)`);
  }

  if (!/^[0-9a-f]{40}$/.test(headCommit)) {
    throw new UsageError(`Failed to resolve 40-hex HEAD commit for '${repoPath}'`);
  }

  let headBranch: string | null = null;
  try {
    const branchOut = runGit(['-C', canonical, 'symbolic-ref', '--short', '-q', 'HEAD'], options).trim();
    if (branchOut) {
      headBranch = branchOut;
    }
  } catch {
    headBranch = null;
  }

  let dirty = false;
  const dirtyFiles: string[] = [];
  try {
    const statusOut = runGit(['-C', canonical, 'status', '--porcelain', '-u'], options);
    const lines = statusOut.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      dirty = true;
      for (const line of lines) {
        const filePath = line.slice(3).trim();
        if (filePath) {
          dirtyFiles.push(filePath);
        }
      }
    }
  } catch {
    // If status fails, leave dirty = false
  }

  return {
    toplevel: toplevelReal,
    headCommit,
    headBranch,
    dirty,
    dirtyFiles,
  };
}

/**
 * Checks whether a branch exists in the given repository.
 */
export function branchExists(repoPath: string, branchName: string, options: RunGitOptions = {}): boolean {
  assertSafeArg(repoPath, 'Repository path');
  assertSafeArg(branchName, 'Branch name');
  if (!checkBranchName(branchName)) {
    return false;
  }
  const canonical = canonicalize(repoPath);
  try {
    runGit(['-C', canonical, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the 40-hex commit hash of a branch, or null if it does not exist.
 */
export function branchCommit(repoPath: string, branchName: string, options: RunGitOptions = {}): string | null {
  assertSafeArg(repoPath, 'Repository path');
  assertSafeArg(branchName, 'Branch name');
  if (!checkBranchName(branchName)) {
    return null;
  }
  const canonical = canonicalize(repoPath);
  try {
    const sha = runGit(['-C', canonical, 'rev-parse', '--verify', `refs/heads/${branchName}^{commit}`], options).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export interface WorktreeEntry {
  worktree: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked?: string | boolean;
  prunable?: string | boolean;
}

/**
 * Lists worktrees associated with the repository using git worktree list --porcelain.
 */
export function worktreeList(repoPath: string, options: RunGitOptions = {}): WorktreeEntry[] {
  assertSafeArg(repoPath, 'Repository path');
  const canonical = canonicalize(repoPath);
  const output = runGit(['-C', canonical, 'worktree', 'list', '--porcelain'], options);

  const entries: WorktreeEntry[] = [];
  const blocks = output.split(/(?:\r?\n){2,}/).map((b) => b.trim()).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let wtPath = '';
    let head = '';
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    let locked: string | boolean | undefined;
    let prunable: string | boolean | undefined;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      } else if (line === 'bare') {
        bare = true;
      } else if (line === 'detached') {
        detached = true;
      } else if (line.startsWith('locked')) {
        const reason = line.slice('locked'.length).trim();
        locked = reason || true;
      } else if (line.startsWith('prunable')) {
        const reason = line.slice('prunable'.length).trim();
        prunable = reason || true;
      }
    }

    if (wtPath) {
      let resolvedPath = wtPath;
      try {
        resolvedPath = canonicalize(wtPath);
      } catch {
        // use wtPath as is
      }
      entries.push({
        worktree: resolvedPath,
        head,
        branch,
        bare,
        detached,
        ...(locked !== undefined ? { locked } : {}),
        ...(prunable !== undefined ? { prunable } : {}),
      });
    }
  }

  return entries;
}

/**
 * Returns configuration arguments to disable post-checkout hooks, LFS smudge/clean,
 * and custom filters during worktree materialization.
 * Extracts full subsection driver names including dotted names (e.g. filter.custom.driver.smudge).
 * Fails closed if configuration inspection fails for reasons other than no matching settings.
 */
export function getMaterializationConfigArgs(repoPath: string, options: RunGitOptions = {}): string[] {
  const args: string[] = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.clean=',
    '-c', 'filter.lfs.process=',
    '-c', 'filter.lfs.required=false',
  ];

  const canonical = canonicalize(repoPath);
  let configOut = '';
  try {
    configOut = runGit(['-C', canonical, 'config', '--get-regexp', '^filter\\.'], options);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 1) {
      // Exit code 1 in git config --get-regexp indicates no matching settings found
      configOut = '';
    } else {
      // Any other exit code is a real failure: fail closed
      throw new UsageError(
        `Failed to inspect repository filter configuration in '${repoPath}': ${(err as Error).message}`
      );
    }
  }

  const filterNames = new Set<string>();
  for (const rawLine of configOut.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const firstSpace = line.indexOf(' ');
    const key = firstSpace === -1 ? line : line.slice(0, firstSpace);
    const match = key.match(/^filter\.(.+)\.(smudge|clean|process|required)$/);
    if (match && match[1]) {
      filterNames.add(match[1]);
    }
  }

  for (const name of filterNames) {
    if (name !== 'lfs') {
      args.push(
        '-c', `filter.${name}.smudge=`,
        '-c', `filter.${name}.clean=`,
        '-c', `filter.${name}.process=`,
        '-c', `filter.${name}.required=false`
      );
    }
  }

  return args;
}

/**
 * Creates a new git worktree with a newly created branch.
 * git -C <repo> -c core.hooksPath=/dev/null ... worktree add -b <branch> -- <dest> <commit>
 */
export function worktreeAddNewBranch(
  repoPath: string,
  branch: string,
  dest: string,
  commit: string = 'HEAD',
  options: RunGitOptions = {}
): void {
  assertSafeArg(repoPath, 'Repository path');
  assertSafeArg(branch, 'Branch name');
  assertSafeArg(dest, 'Destination path');
  assertSafeArg(commit, 'Commit');

  if (!checkBranchName(branch)) {
    throw new UsageError(`Invalid branch name '${branch}'`);
  }

  const canonicalRepo = canonicalize(repoPath);
  const resolvedDest = path.resolve(dest);
  const configArgs = getMaterializationConfigArgs(canonicalRepo, options);

  runGit(
    [
      '-C', canonicalRepo,
      ...configArgs,
      'worktree', 'add', '-b', branch, '--', resolvedDest, commit,
    ],
    options
  );
}

/**
 * Creates a new git worktree using an already existing branch.
 * git -C <repo> -c core.hooksPath=/dev/null ... worktree add -- <dest> <branch>
 */
export function worktreeAddExisting(
  repoPath: string,
  branch: string,
  dest: string,
  options: RunGitOptions = {}
): void {
  assertSafeArg(repoPath, 'Repository path');
  assertSafeArg(branch, 'Branch name');
  assertSafeArg(dest, 'Destination path');

  if (!checkBranchName(branch)) {
    throw new UsageError(`Invalid branch name '${branch}'`);
  }

  const canonicalRepo = canonicalize(repoPath);
  const resolvedDest = path.resolve(dest);
  const configArgs = getMaterializationConfigArgs(canonicalRepo, options);

  runGit(
    [
      '-C', canonicalRepo,
      ...configArgs,
      'worktree', 'add', '--', resolvedDest, branch,
    ],
    options
  );
}

/**
 * Detects setup gaps in a repository (e.g. submodules in .gitmodules or Git LFS in .gitattributes).
 */
export function detectGaps(repoPath: string, options: RunGitOptions = {}): string[] {
  assertSafeArg(repoPath, 'Repository path');
  const canonical = canonicalize(repoPath);
  const gaps: string[] = [];
  const repoName = path.basename(canonical);

  // Check .gitmodules
  let hasGitModules = false;
  const gitmodulesFile = path.join(canonical, '.gitmodules');
  if (fs.existsSync(gitmodulesFile)) {
    hasGitModules = true;
  } else {
    try {
      runGit(['-C', canonical, 'rev-parse', '--verify', 'HEAD:.gitmodules'], options);
      hasGitModules = true;
    } catch {
      // not in HEAD
    }
  }

  if (hasGitModules) {
    gaps.push(
      `Submodules detected in .gitmodules for repository '${repoName}' (submodules are not initialized automatically)`
    );
  }

  // Check Git LFS (filter=lfs)
  let hasLfs = false;
  const gitattributesFile = path.join(canonical, '.gitattributes');
  if (fs.existsSync(gitattributesFile)) {
    try {
      const content = fs.readFileSync(gitattributesFile, 'utf8');
      if (content.includes('filter=lfs')) {
        hasLfs = true;
      }
    } catch {
      // ignore
    }
  }

  if (!hasLfs) {
    try {
      const content = runGit(['-C', canonical, 'show', 'HEAD:.gitattributes'], options);
      if (content.includes('filter=lfs')) {
        hasLfs = true;
      }
    } catch {
      // not in HEAD
    }
  }

  if (!hasLfs) {
    const infoAttributes = path.join(canonical, '.git', 'info', 'attributes');
    if (fs.existsSync(infoAttributes)) {
      try {
        const content = fs.readFileSync(infoAttributes, 'utf8');
        if (content.includes('filter=lfs')) {
          hasLfs = true;
        }
      } catch {
        // ignore
      }
    }
  }

  if (hasLfs) {
    gaps.push(
      `Git LFS filter configured (filter=lfs) for repository '${repoName}' (LFS assets are not automatically downloaded)`
    );
  }

  return gaps;
}
