import fs from 'node:fs';
import path from 'node:path';
import { suffixForSource } from './slug.ts';
import { showFileAtCommit } from './git.ts';
import { resolveInside } from './paths.ts';
import { sha256 } from './fsx.ts';
import type { CommandEntry } from './manifest.ts';
import type { OwnedFileEntry } from './operation.ts';

/**
 * Npm scripts WSG treats as concrete, supported validation commands. The
 * milestone decision is deliberately narrow: start with npm manifests and only
 * add other command sources alongside fixtures. We never synthesize a command
 * from the feature name (e.g. no invented migration test) and we never execute
 * a discovered command during create/add/refresh.
 */
export const SUPPORTED_NPM_SCRIPT_NAMES: readonly string[] = [
  'test',
  'lint',
  'typecheck',
  'build',
  'check',
];

/**
 * A conservative predicate over a package.json script name. Names containing
 * whitespace, path separators, option prefixes, or NUL are rejected outright,
 * so a malicious script key can never influence the generated wrapper path or
 * argv. Only exact supported names and `test:*`/`test-*` variants qualify.
 */
export function isSupportedNpmScript(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('-')) return false;
  if (/[\s/\\\0]/.test(name)) return false;
  if (SUPPORTED_NPM_SCRIPT_NAMES.includes(name)) return true;
  return name.startsWith('test:') || name.startsWith('test-');
}

/**
 * Parses the `scripts` object from a package.json string. Returns null when the
 * JSON is malformed or not an object; returns an empty object when there are no
 * usable scripts. Non-string script values are ignored rather than coerced.
 */
export function parsePackageJsonScripts(text: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (scripts === undefined || scripts === null) return {};
  if (typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

export interface CommandRepoInput {
  /** Workspace entry name (also the manifest repo `path`). */
  name: string;
  /** Canonical absolute source repository path. */
  source: string;
  /** Recorded base commit whose tree defines the worktree contents. */
  base_commit: string;
  /** Assembled worktree destination, when it already exists. */
  dest?: string;
}

export interface DiscoverCommandsOptions {
  /**
   * Lowercased basenames already used under `scripts/` (existing wrappers,
   * attached scripts, and untracked files). New wrappers never collide with
   * these; a stable suffix is appended instead.
   */
  reservedBasenames?: Iterable<string>;
  /** Test seam: overrides how package.json is read for a repository. */
  readPackageJson?: (repo: CommandRepoInput) => string | null;
}

export interface CommandsDiscoveryResult {
  commands: CommandEntry[];
  gaps: string[];
  missingTestRepos: string[];
  usedWrapperBasenames: Set<string>;
}

function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'command';
}

function noTestGap(repo: CommandRepoInput): string {
  return (
    `No test command discovered for repository '${repo.name}' ` +
    `(no supported npm 'test' script in package.json at the recorded commit); ` +
    `no verification wrapper was generated.`
  );
}

/**
 * Reads `package.json` for a repository from the *assembled worktree* when it
 * exists, and otherwise from the recorded base commit via `git show`. Either
 * path reflects the recorded revision; the dirty source checkout is never used.
 */
export function readRepoPackageJson(
  repo: CommandRepoInput,
  override?: (repo: CommandRepoInput) => string | null
): string | null {
  if (override) return override(repo);
  if (repo.dest) {
    const worktreeManifest = path.join(repo.dest, 'package.json');
    try {
      if (fs.existsSync(worktreeManifest)) {
        return fs.readFileSync(worktreeManifest, 'utf8');
      }
    } catch {
      // fall through to the recorded commit
    }
  }
  return showFileAtCommit(repo.source, repo.base_commit, 'package.json');
}

/**
 * Allocates a deterministic `scripts/<name>.sh` basename for a discovered
 * command, avoiding every reserved/used basename. Collisions append a stable
 * `-<6hex>` suffix derived from the source and script name, then a counter.
 */
export function allocateWrapperBasename(
  scriptName: string,
  repo: CommandRepoInput,
  usedLowerBasenames: Set<string>
): string {
  const raw = `${sanitizeSegment(scriptName)}-${sanitizeSegment(repo.name)}`;
  const candidate = `${raw}.sh`;
  if (!usedLowerBasenames.has(candidate.toLowerCase())) {
    usedLowerBasenames.add(candidate.toLowerCase());
    return candidate;
  }

  const suffix = suffixForSource(`${repo.source}\0${scriptName}`);
  let next = `${raw}-${suffix}.sh`;
  let counter = 1;
  while (usedLowerBasenames.has(next.toLowerCase())) {
    next = `${raw}-${suffix}-${counter}.sh`;
    counter++;
  }
  usedLowerBasenames.add(next.toLowerCase());
  return next;
}

/**
 * Quotes an arbitrary argv token for POSIX `sh`. Single quotes protect every
 * shell metacharacter; embedded single quotes are escaped as `'\''`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Renders the generated wrapper for a discovered command. The wrapper resolves
 * the repository relative to its own location, so it works from any current
 * directory; it execs the fixed argv (never an interpolated manifest string),
 * forwards any caller arguments after `--`, and propagates the child exit
 * status via `exec`.
 */
export function renderWrapper(command: CommandEntry): string {
  const cwd = command.cwd;
  const argv = command.argv.map(shellQuote).join(' ');
  // Evidence is informational only and must never break out of the comment.
  const evidence = String(command.evidence ?? 'discovered command')
    .replace(/[\r\n\0]+/g, ' ')
    .slice(0, 200);
  return [
    '#!/bin/sh',
    `# Generated by WSG from ${evidence}. Discovery only; WSG never verified or executed it.`,
    'set -eu',
    'wsg_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `cd -- "$wsg_script_dir/.."/${shellQuote(cwd)}`,
    `exec ${argv} -- "$@"`,
    '',
  ].join('\n');
}

/**
 * Discovers concrete, supported commands for the supplied repositories from
 * their package.json manifests. Produces manifest-ready CommandEntry values,
 * reports a missing-test gap for each repository without a test command, and
 * never executes anything.
 */
export function discoverCommands(
  repos: readonly CommandRepoInput[],
  options: DiscoverCommandsOptions = {}
): CommandsDiscoveryResult {
  const usedWrapperBasenames = new Set<string>();
  for (const name of options.reservedBasenames ?? []) {
    usedWrapperBasenames.add(name.toLowerCase());
  }

  const commands: CommandEntry[] = [];
  const gaps: string[] = [];
  const missingTestRepos: string[] = [];

  for (const repo of repos) {
    const text = readRepoPackageJson(repo, options.readPackageJson);
    if (text === null) {
      missingTestRepos.push(repo.name);
      gaps.push(noTestGap(repo));
      continue;
    }

    const scripts = parsePackageJsonScripts(text);
    if (scripts === null) {
      gaps.push(
        `package.json for repository '${repo.name}' could not be parsed as JSON; no commands discovered.`
      );
      missingTestRepos.push(repo.name);
      gaps.push(noTestGap(repo));
      continue;
    }

    const supported = Object.keys(scripts).filter(isSupportedNpmScript).sort();
    const hasTest = supported.some(
      (name) => name === 'test' || name.startsWith('test:') || name.startsWith('test-')
    );
    if (!hasTest) {
      missingTestRepos.push(repo.name);
      gaps.push(noTestGap(repo));
    }

    for (const scriptName of supported) {
      const wrapperBasename = allocateWrapperBasename(
        scriptName,
        repo,
        usedWrapperBasenames
      );
      commands.push({
        name: wrapperBasename.replace(/\.sh$/, ''),
        cwd: repo.name,
        argv: ['npm', 'run', scriptName],
        evidence: `package.json scripts.${scriptName}`,
        wrapper: `scripts/${wrapperBasename}`,
      });
    }
  }

  return { commands, gaps, missingTestRepos, usedWrapperBasenames };
}

/**
 * Marks freshly reconciled wrapper files executable (0755) when — and only
 * when — they still match WSG's recorded ownership hash. User-edited wrappers
 * are left untouched. Best effort: mode failures never fail the operation.
 */
export function applyWrapperModes(
  wsDir: string,
  files: ReadonlyMap<string, string>,
  owned: Record<string, OwnedFileEntry>
): void {
  for (const relPath of files.keys()) {
    if (!relPath.startsWith('scripts/') || !relPath.endsWith('.sh')) continue;
    const entry = owned[relPath];
    if (!entry) continue;
    let fullPath: string;
    try {
      fullPath = resolveInside(wsDir, relPath);
    } catch {
      continue;
    }
    try {
      if (sha256(fs.readFileSync(fullPath)) !== entry.sha256) continue;
      const mode = fs.statSync(fullPath).mode & 0o777;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(fullPath, 0o755);
      }
    } catch {
      // ignore mode/ownership races
    }
  }
}
