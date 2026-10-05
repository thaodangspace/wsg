import fs from 'node:fs';
import path from 'node:path';
import { canonicalize } from './paths.ts';

/**
 * Directory names that are skipped during bounded repository enumeration.
 * These are build outputs, dependency caches, or tool metadata that should
 * never contribute a discoverable repository (repo spec §6.2).
 */
export const VENDOR_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'bower_components',
  'Pods',
  'DerivedData',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.terraform',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  '.nyc_output',
]);

export type GitMarkerKind = 'dir' | 'file';

export interface DiscoveredRepo {
  /** Human-friendly basename of the repository root (not guaranteed unique). */
  name: string;
  /** Canonical absolute repository toplevel. */
  source: string;
  /** Whether `.git` is a directory (normal clone) or a file (worktree/submodule). */
  gitKind: GitMarkerKind;
}

export interface DiscoveryResult {
  repos: DiscoveredRepo[];
  gaps: string[];
}

export interface DiscoveryOptions {
  /** Maximum directory depth below each code root. Default 6. */
  maxDepth?: number;
  /** Maximum number of repositories to enumerate. Default 200. */
  maxRepos?: number;
  /** Maximum number of directory entries visited. Default 20000. */
  maxEntries?: number;
}

interface Limits {
  maxDepth: number;
  maxRepos: number;
  maxEntries: number;
}

/**
 * Returns the `.git` marker kind at `dir`, or null when the directory is not a
 * repository root. `.git` may be a directory (clone) or a file (worktree or
 * submodule, repo spec §6.2).
 */
export function detectGitMarker(dir: string): GitMarkerKind | null {
  const marker = path.join(dir, '.git');
  try {
    const st = fs.lstatSync(marker);
    if (st.isSymbolicLink()) {
      return null;
    }
    if (st.isDirectory()) {
      return 'dir';
    }
    if (st.isFile()) {
      return 'file';
    }
  } catch {
    // not present
  }
  return null;
}

/**
 * Bounded repository enumeration under the configured code roots.
 *
 * Behavior:
 * - A directory containing a `.git` directory or `.git` file is a repository
 *   root; enumeration does not descend into it (nested repos inside a repo are
 *   not enumerated).
 * - Vendor/build/dependency directories are skipped entirely.
 * - Symlinked directories are never followed, so symlink loops cannot occur.
 * - Absent roots, unreadable directories, and exhausted depth/repo/entry
 *   budgets are reported as gaps rather than throwing.
 * - Duplicate canonical roots are deduplicated.
 */
export function enumerateRepos(
  codeRoots: readonly string[],
  options: DiscoveryOptions = {}
): DiscoveryResult {
  const limits: Limits = {
    maxDepth: options.maxDepth ?? 6,
    maxRepos: options.maxRepos ?? 200,
    maxEntries: options.maxEntries ?? 20000,
  };

  const repos: DiscoveredRepo[] = [];
  const gaps: string[] = [];
  const seenSources = new Set<string>();
  const seenDirs = new Set<string>();
  let entriesVisited = 0;
  let depthExceededReported = false;
  let repoLimitReported = false;
  let entryLimitReported = false;

  for (const rawRoot of codeRoots) {
    if (repos.length >= limits.maxRepos) break;

    let root: string;
    try {
      root = canonicalize(rawRoot);
    } catch {
      root = path.resolve(rawRoot);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      gaps.push(`Code root '${rawRoot}' does not exist or is not accessible`);
      continue;
    }
    if (!stat.isDirectory()) {
      gaps.push(`Code root '${rawRoot}' is not a directory`);
      continue;
    }

    // A code root may itself be a repository.
    const rootMarker = detectGitMarker(root);
    if (rootMarker) {
      addRepo(root, rootMarker);
      continue;
    }

    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
      if (repos.length >= limits.maxRepos) {
        if (!repoLimitReported) {
          gaps.push(
            `Repository enumeration stopped after reaching the ${limits.maxRepos} repository limit`
          );
          repoLimitReported = true;
        }
        break;
      }
      if (entriesVisited >= limits.maxEntries) {
        if (!entryLimitReported) {
          gaps.push(
            `Repository enumeration stopped after visiting ${limits.maxEntries} directory entries`
          );
          entryLimitReported = true;
        }
        break;
      }

      const { dir, depth } = stack.pop()!;

      let realDir: string;
      try {
        realDir = fs.realpathSync(dir);
      } catch {
        realDir = dir;
      }
      if (seenDirs.has(realDir)) continue;
      seenDirs.add(realDir);

      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err: unknown) {
        gaps.push(`Cannot read directory '${dir}': ${(err as Error).message}`);
        continue;
      }

      for (const entry of dirents) {
        entriesVisited++;
        if (entriesVisited > limits.maxEntries) {
          if (!entryLimitReported) {
            gaps.push(
              `Repository enumeration stopped after visiting ${limits.maxEntries} directory entries`
            );
            entryLimitReported = true;
          }
          break;
        }

        if (repos.length >= limits.maxRepos) {
          if (!repoLimitReported) {
            gaps.push(
              `Repository enumeration stopped after reaching the ${limits.maxRepos} repository limit`
            );
            repoLimitReported = true;
          }
          break;
        }

        if (VENDOR_DIR_NAMES.has(entry.name)) continue;

        const child = path.join(dir, entry.name);

        // Follow a symlink only far enough to recognize a repository root.
        // Non-repository symlinked directories are not traversed, which keeps
        // enumeration inside the configured roots and makes symlink loops
        // impossible.
        if (entry.isSymbolicLink()) {
          let real: string;
          try {
            real = fs.realpathSync(child);
          } catch {
            continue;
          }
          const marker = detectGitMarker(real);
          if (marker) {
            addRepo(real, marker, entry.name);
          }
          continue;
        }

        if (entry.isDirectory()) {
          const marker = detectGitMarker(child);
          if (marker) {
            addRepo(child, marker);
            continue;
          }
          if (depth + 1 > limits.maxDepth) {
            if (!depthExceededReported) {
              gaps.push(
                `Repository enumeration stopped at depth ${limits.maxDepth} below code root '${rawRoot}'`
              );
              depthExceededReported = true;
            }
            continue;
          }
          stack.push({ dir: child, depth: depth + 1 });
        }
      }
    }
  }

  function addRepo(source: string, gitKind: GitMarkerKind, displayName?: string): void {
    let canonical: string;
    try {
      canonical = canonicalize(source);
    } catch {
      canonical = path.resolve(source);
    }
    if (seenSources.has(canonical)) return;
    seenSources.add(canonical);
    repos.push({ name: displayName ?? path.basename(canonical), source: canonical, gitKind });
  }

  return { repos, gaps };
}
