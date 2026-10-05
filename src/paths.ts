import path from 'node:path';
import os from 'node:os';
import { realpathSync, statSync, lstatSync, existsSync } from 'node:fs';
import { UsageError } from './errors.ts';

export function expandHome(filepath: string, homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  if (filepath === '~') {
    return home;
  }
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    return path.join(home, filepath.slice(2));
  }
  return filepath;
}

export function canonicalize(filepath: string, homeDir?: string): string {
  const expanded = expandHome(filepath, homeDir);
  const absolute = path.resolve(expanded);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function assertConfinedRelative(
  relPath: string,
  context: string = 'Path'
): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new UsageError(`${context} must not be empty`);
  }

  if (relPath.includes('\\')) {
    throw new UsageError(
      `${context} '${relPath}' contains backslashes; use forward slashes`
    );
  }

  if (relPath.includes('\0')) {
    throw new UsageError(`${context} '${relPath}' contains NUL byte`);
  }

  if (
    path.isAbsolute(relPath) ||
    relPath.startsWith('/') ||
    /^[a-zA-Z]:[/\\]/.test(relPath)
  ) {
    throw new UsageError(
      `${context} '${relPath}' must be relative, not absolute`
    );
  }

  const segments = relPath.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new UsageError(
      `${context} '${relPath}' must not contain '..' path traversal`
    );
  }

  const normalized = path.posix.normalize(relPath);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    throw new UsageError(
      `${context} '${relPath}' is not a valid relative path`
    );
  }

  return relPath;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '' || rel === '.') return false;
  const relSegments = rel.split(/[/\\]/);
  return !relSegments.includes('..') && !path.isAbsolute(rel);
}

export function resolveInside(rootDir: string, relPath: string): string {
  assertConfinedRelative(relPath);
  const rootCanonical = canonicalize(rootDir);

  const segments = path.posix.normalize(relPath).split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new UsageError(
      `Path '${relPath}' must refer to an entry inside '${rootDir}'`
    );
  }

  let current = rootCanonical;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const candidate = path.join(current, seg);

    let exists = false;
    let isSymlink = false;
    try {
      const lstat = lstatSync(candidate);
      exists = true;
      isSymlink = lstat.isSymbolicLink();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new UsageError(
          `Cannot access path '${candidate}': ${(err as Error).message}`
        );
      }
    }

    if (exists) {
      if (isSymlink) {
        let real: string;
        try {
          real = realpathSync(candidate);
        } catch {
          throw new UsageError(
            `Path '${relPath}' contains broken symlink '${candidate}'`
          );
        }

        if (!isInside(rootCanonical, real)) {
          throw new UsageError(
            `Path '${relPath}' escapes workspace root via symlink '${candidate}' -> '${real}'`
          );
        }
        current = real;
      } else {
        current = candidate;
      }

      if (i < segments.length - 1) {
        let stat;
        try {
          stat = statSync(current);
        } catch {
          throw new UsageError(`Cannot access path '${current}'`);
        }
        if (!stat.isDirectory()) {
          throw new UsageError(
            `Path component '${candidate}' is not a directory`
          );
        }
      }
    } else {
      const remaining = segments.slice(i);
      current = path.join(current, ...remaining);
      break;
    }
  }

  if (!isInside(rootCanonical, current)) {
    throw new UsageError(
      `Path '${relPath}' escapes workspace root '${rootDir}'`
    );
  }

  return current;
}


export interface FindWorkspaceOptions {
  startDir?: string;
  workspace?: string;
  explicitWorkspace?: string;
}

export function findWorkspaceRoot(
  startDirOrOptions?: string | FindWorkspaceOptions,
  explicitWorkspace?: string
): string | null {
  let startDir: string | undefined;
  let explicit: string | undefined = explicitWorkspace;

  if (typeof startDirOrOptions === 'object' && startDirOrOptions !== null) {
    startDir = startDirOrOptions.startDir;
    explicit =
      startDirOrOptions.workspace ??
      startDirOrOptions.explicitWorkspace ??
      explicitWorkspace;
  } else {
    startDir = startDirOrOptions;
  }

  if (explicit) {
    const expanded = canonicalize(explicit);
    try {
      const stat = statSync(expanded);
      if (stat.isFile() && path.basename(expanded) === 'workspace.yaml') {
        return path.dirname(expanded);
      }
    } catch {
      // Return as-is if stat fails
    }
    return expanded;
  }

  let current = canonicalize(startDir ?? process.cwd());
  while (true) {
    const candidate = path.join(current, 'workspace.yaml');
    if (existsSync(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}
