import fs from 'node:fs';
import path from 'node:path';
import { suffixForSource } from './slug.ts';
import { showFileAtCommit, commitPathType } from './git.ts';
import { resolveInside, assertConfinedRelative } from './paths.ts';
import { sha256 } from './fsx.ts';
import type { CommandEntry } from './manifest.ts';
import type { OwnedFileEntry } from './operation.ts';

/**
 * Npm scripts WSG treats as concrete, supported validation commands. The
 * milestone decision is deliberately narrow: start with npm manifests and
 * directly documented repository scripts, and only add other command sources
 * alongside fixtures. We never synthesize a command from the feature name
 * (e.g. no invented migration test) and we never execute a discovered command
 * during create/add/refresh.
 */
export const SUPPORTED_NPM_SCRIPT_NAMES: readonly string[] = [
  'test',
  'lint',
  'typecheck',
  'build',
  'check',
];

/**
 * A documented `npm run <name>` is only recognized when `<name>` is a
 * validation-shaped script name and the package.json script exists with a
 * non-empty value. This keeps README prose from turning arbitrary scripts
 * (deploy, release, ...) into validation wrappers.
 */
const DOCUMENTED_NPM_NAME_RE = /^(test|lint|check|typecheck|build|verify|validate|ci)([-:_][A-Za-z0-9_-]+)?$/i;

/** Directories a documented repository validation script may live under. */
const DOCUMENTED_SCRIPT_ROOTS: readonly string[] = ['scripts/', 'bin/', 'tools/'];

/** Largest README prefix considered for documented-command extraction. */
export const MAX_README_BYTES = 64 * 1024;

const DOCUMENTED_NPM_TEST_RE = /^npm\s+test$/;
const DOCUMENTED_NPM_RUN_RE = /^npm\s+(?:run|run-script)\s+([A-Za-z0-9:_-]+)$/;
const DOCUMENTED_SHELL_RE = /^(sh|bash)\s+((?:\.\/)?[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:sh|bash))$/;

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

function isTestScriptName(name: string): boolean {
  return name === 'test' || name.startsWith('test:') || name.startsWith('test-');
}

/**
 * Parses the `scripts` object from a package.json string. Returns null when the
 * JSON is malformed or not an object; returns an empty object when there are no
 * usable scripts. Non-string and empty/whitespace-only values are ignored, since
 * they name no concrete runnable command.
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
    if (typeof value === 'string' && value.trim().length > 0) {
      result[name] = value;
    }
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
  /** Test seam: overrides how README.md is read for a repository. */
  readReadme?: (repo: CommandRepoInput) => string | null;
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

function readWorktreeFile(repo: CommandRepoInput, relPath: string): string | null {
  if (!repo.dest) return null;
  const candidate = path.join(repo.dest, relPath);
  try {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  } catch {
    // fall through to the recorded commit
  }
  return null;
}

/**
 * Reads a repository-relative file from the *assembled worktree* when it
 * exists, and otherwise from the recorded base commit via `git show`. Either
 * path reflects the recorded revision; the dirty source checkout is never used.
 */
export function readRepoFile(
  repo: CommandRepoInput,
  relPath: string,
  override?: (repo: CommandRepoInput) => string | null
): string | null {
  if (override) return override(repo);
  return readWorktreeFile(repo, relPath) ?? showFileAtCommit(repo.source, repo.base_commit, relPath);
}

/** Reads `package.json` for a repository (worktree first, then recorded commit). */
export function readRepoPackageJson(
  repo: CommandRepoInput,
  override?: (repo: CommandRepoInput) => string | null
): string | null {
  return readRepoFile(repo, 'package.json', override);
}

/** Reads `README.md` for a repository (worktree first, then recorded commit). */
export function readRepoReadme(
  repo: CommandRepoInput,
  override?: (repo: CommandRepoInput) => string | null
): string | null {
  return readRepoFile(repo, 'README.md', override);
}

export interface DocumentedCommandCandidate {
  kind: 'npm' | 'script';
  scriptName?: string;
  scriptPath?: string;
  argv: string[];
  display: string;
}

/**
 * Extracts candidate documented command lines from fenced code blocks and
 * inline code spans only. Prose is never scanned, so an incidental mention
 * cannot become a wrapper.
 */
export function extractDocumentedCommandLines(readme: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const raw of readme.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const leading = line.trimStart();
    const fenceMatch = leading.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }

    if (inFence) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
      continue;
    }

    const inline = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = inline.exec(line)) !== null) {
      const span = match[1].trim();
      if (span) lines.push(span);
    }
  }

  return lines;
}

function isSafeDocumentedScriptPath(scriptPath: string): boolean {
  if (!scriptPath || scriptPath.startsWith('/') || scriptPath.includes('\\')) return false;
  try {
    assertConfinedRelative(scriptPath, 'documented script');
  } catch {
    return false;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:sh|bash)$/.test(scriptPath)) return false;
  return DOCUMENTED_SCRIPT_ROOTS.some((root) => scriptPath.startsWith(root));
}

/**
 * Parses one candidate line into a concrete documented command. Only a single
 * fixed command form is accepted (`npm test`, `npm run <name>`, `sh <path>`,
 * `bash <path>`); arbitrary shell strings, pipes, redirects, substitutions, and
 * multiple commands are rejected rather than interpolated.
 */
export function parseDocumentedCommand(rawLine: string): DocumentedCommandCandidate | null {
  const line = rawLine.trim().replace(/\s+/g, ' ');
  if (!line) return null;

  if (DOCUMENTED_NPM_TEST_RE.test(line)) {
    return { kind: 'npm', scriptName: 'test', argv: ['npm', 'run', 'test'], display: 'npm test' };
  }

  const npmRun = line.match(DOCUMENTED_NPM_RUN_RE);
  if (npmRun) {
    const name = npmRun[1];
    if (!DOCUMENTED_NPM_NAME_RE.test(name)) return null;
    return { kind: 'npm', scriptName: name, argv: ['npm', 'run', name], display: `npm run ${name}` };
  }

  const shell = line.match(DOCUMENTED_SHELL_RE);
  if (shell) {
    const interpreter = shell[1];
    const scriptPath = shell[2].replace(/^\.\//, '');
    if (!isSafeDocumentedScriptPath(scriptPath)) return null;
    return {
      kind: 'script',
      scriptPath,
      argv: [interpreter, scriptPath],
      display: `${interpreter} ${scriptPath}`,
    };
  }

  return null;
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
 * their package.json manifests and directly documented README validation
 * instructions. Produces manifest-ready CommandEntry values, reports a
 * missing-test gap for each repository without a test command, and never
 * executes anything. Discovery is a pure function of the recorded revision, so
 * a resumed operation replays the same commands from the recorded plan.
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
    // --- package.json manifest scripts -------------------------------------
    let scripts: Record<string, string> = {};
    const packageText = readRepoPackageJson(repo, options.readPackageJson);
    if (packageText !== null) {
      const parsed = parsePackageJsonScripts(packageText);
      if (parsed === null) {
        gaps.push(
          `package.json for repository '${repo.name}' could not be parsed as JSON; no manifest commands discovered.`
        );
      } else {
        scripts = parsed;
      }
    }

    const supported = Object.keys(scripts).filter(isSupportedNpmScript).sort();
    const commandScriptNames = new Set<string>(supported);
    const hasTest = supported.some(isTestScriptName);
    if (!hasTest) {
      missingTestRepos.push(repo.name);
      gaps.push(noTestGap(repo));
    }

    for (const scriptName of supported) {
      const wrapperBasename = allocateWrapperBasename(scriptName, repo, usedWrapperBasenames);
      commands.push({
        name: wrapperBasename.replace(/\.sh$/, ''),
        cwd: repo.name,
        argv: ['npm', 'run', scriptName],
        evidence: `package.json scripts.${scriptName}`,
        wrapper: `scripts/${wrapperBasename}`,
      });
    }

    // --- documented README validation commands ------------------------------
    const readmeText = readRepoReadme(repo, options.readReadme);
    if (readmeText === null) continue;

    const documentedLines = extractDocumentedCommandLines(readmeText.slice(0, MAX_README_BYTES));
    const seenCandidates = new Set<string>();
    for (const line of documentedLines) {
      const candidate = parseDocumentedCommand(line);
      if (!candidate) continue;
      const key =
        candidate.kind === 'npm' ? `npm:${candidate.scriptName}` : `script:${candidate.scriptPath}`;
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);

      if (candidate.kind === 'npm') {
        const scriptName = candidate.scriptName as string;
        const value = scripts[scriptName];
        if (value === undefined || value.trim().length === 0) {
          gaps.push(
            `Documented command '${candidate.display}' for repository '${repo.name}' has no matching non-empty package.json script; no wrapper generated.`
          );
          continue;
        }
        if (commandScriptNames.has(scriptName)) continue;
        commandScriptNames.add(scriptName);
        const wrapperBasename = allocateWrapperBasename(scriptName, repo, usedWrapperBasenames);
        commands.push({
          name: wrapperBasename.replace(/\.sh$/, ''),
          cwd: repo.name,
          argv: ['npm', 'run', scriptName],
          evidence: `README.md: documented \`${candidate.display}\``,
          wrapper: `scripts/${wrapperBasename}`,
        });
        continue;
      }

      const scriptPath = candidate.scriptPath as string;
      if (commitPathType(repo.source, repo.base_commit, scriptPath) !== 'blob') {
        gaps.push(
          `Documented validation script '${scriptPath}' for repository '${repo.name}' does not exist at the recorded commit; no wrapper generated.`
        );
        continue;
      }
      const baseRaw = path.basename(scriptPath).replace(/\.(?:sh|bash)$/i, '');
      const wrapperBasename = allocateWrapperBasename(baseRaw, repo, usedWrapperBasenames);
      commands.push({
        name: wrapperBasename.replace(/\.sh$/, ''),
        cwd: repo.name,
        argv: [...candidate.argv],
        evidence: `README.md: documented \`${candidate.display}\``,
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
