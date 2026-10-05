import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { UsageError } from './errors.ts';
import { findWorkspaceRoot } from './paths.ts';
import { parseManifest, type Manifest, type RepoEntry } from './manifest.ts';
import type { CliIO } from './cli.ts';

export const EXPLAIN_HELP_TEXT = `Usage: wsg explain [repo-name] [options]

Show the saved selection evidence, repository roles, documents, exclusions,
gaps, and discovered commands from a workspace.yaml. Read-only: no model call,
no network, and no Git.

Options:
  --workspace <dir>  Workspace directory (default: nearest ancestor workspace.yaml)
  -h, --help         Show help
`;

export interface RenderExplainOptions {
  workspaceRoot: string;
  /** Restrict the report to a single repository entry. */
  repoFilter?: string;
}

/**
 * Pure renderer for the `wsg explain` report. Derived only from the parsed
 * manifest; performs no I/O so it can be unit-tested directly.
 */
export function renderExplain(
  manifest: Manifest,
  options: RenderExplainOptions
): string {
  const lines: string[] = [];

  lines.push(`Workspace: ${manifest.name}`);
  lines.push(`Root: ${options.workspaceRoot}`);
  lines.push('');

  lines.push('Request:');
  const request = manifest.request.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  for (const line of request.split('\n')) {
    lines.push(`  ${line}`);
  }
  lines.push('');

  if (manifest.context.length > 0) {
    lines.push('Additional context:');
    for (const line of manifest.context) {
      lines.push(`  - ${line}`);
    }
    lines.push('');
  }

  let repos: RepoEntry[] = manifest.repos;
  let filterMatched: RepoEntry | undefined;

  if (options.repoFilter !== undefined) {
    filterMatched = manifest.repos.find(
      (repo) =>
        repo.name === options.repoFilter || repo.path === options.repoFilter
    );
    if (!filterMatched) {
      const available = manifest.repos.map((repo) => repo.name).join(', ');
      throw new UsageError(
        `Repository '${options.repoFilter}' is not part of workspace '${manifest.name}'.`,
        [`Available repositories: ${available || '(none)'}`]
      );
    }
    repos = [filterMatched];
  }

  lines.push(`Repositories (${repos.length}):`);
  if (repos.length === 0) {
    lines.push('  None.');
  }
  for (const repo of repos) {
    lines.push(`  - ${repo.name} (intent: ${repo.intent}, path: ${repo.path})`);
    lines.push(`      source: ${repo.source}`);
    lines.push(`      branch: ${repo.branch} (base: ${repo.base_commit})`);
    lines.push(`      reason: ${repo.reason}`);
    const evidence = repo.evidence ?? [];
    lines.push(
      `      evidence: ${evidence.length} ${evidence.length === 1 ? 'entry' : 'entries'}`
    );
    for (const ev of evidence) {
      const range = ev.lines ? `:${ev.lines[0]}-${ev.lines[1]}` : '';
      lines.push(`        - ${ev.file}${range}: ${ev.summary}`);
    }
  }
  lines.push('');

  // Documents, exclusions, gaps, and commands are workspace-wide. When a repo
  // filter is supplied the report is intentionally scoped to that repository.
  if (options.repoFilter !== undefined) {
    lines.push(
      `Filtered to repository '${filterMatched?.name}'.`
    );
    lines.push('');
    const repoCommands = manifest.commands.filter(
      (cmd) => cmd.cwd === filterMatched?.path
    );
    lines.push(`Commands (${repoCommands.length}) [discovered, not verified]:`);
    if (repoCommands.length === 0) {
      lines.push('  None discovered.');
    }
    for (const cmd of repoCommands) {
      const suffix = cmd.wrapper ? ` (wrapper: ${cmd.wrapper})` : '';
      lines.push(
        `  - ${cmd.name}: ${cmd.argv.join(' ')} (cwd: ${cmd.cwd})${suffix}`
      );
    }
    return `${lines.join('\n')}\n`;
  }

  lines.push(`Documents (${manifest.docs.length}):`);
  if (manifest.docs.length === 0) {
    lines.push('  None attached.');
  }
  for (const doc of manifest.docs) {
    if (doc.mode === 'snapshot') {
      lines.push(
        `  - ${doc.path} (mode: snapshot) source: ${doc.source}`
      );
    } else {
      const reason = doc.reason ?? 'Not fetched in this version';
      lines.push(`  - ${doc.source} (mode: reference) - ${reason}`);
    }
  }
  lines.push('');

  const excluded = manifest.discovery.excluded ?? [];
  lines.push(`Exclusions (${excluded.length}):`);
  if (excluded.length === 0) {
    lines.push('  None.');
  }
  for (const exclusion of excluded) {
    lines.push(`  - ${exclusion.source}: ${exclusion.reason}`);
  }
  lines.push('');

  const gaps = manifest.discovery.gaps ?? [];
  lines.push(`Gaps (${gaps.length}):`);
  if (gaps.length === 0) {
    lines.push('  None reported.');
  }
  for (const gap of gaps) {
    lines.push(`  - ${gap}`);
  }
  lines.push('');

  lines.push(
    `Commands (${manifest.commands.length}) [discovered, not verified]:`
  );
  if (manifest.commands.length === 0) {
    lines.push('  None discovered.');
  }
  for (const cmd of manifest.commands) {
    const suffix = cmd.wrapper ? ` (wrapper: ${cmd.wrapper})` : '';
    lines.push(
      `  - ${cmd.name}: ${cmd.argv.join(' ')} (cwd: ${cmd.cwd})${suffix}`
    );
  }

  return `${lines.join('\n')}\n`;
}

function getCwd(io: CliIO): string {
  if (io.cwd) {
    return typeof io.cwd === 'function' ? io.cwd() : io.cwd;
  }
  return process.cwd();
}

/**
 * `wsg explain [repo-name] --workspace <dir>`.
 *
 * Resolves the workspace from `--workspace` or the nearest ancestor containing
 * `workspace.yaml`, parses the manifest, and prints a read-only summary. It
 * never reads `.wsg/`, never invokes Git, and never touches the network, so a
 * completed workspace stays inspectable after its runtime storage is removed.
 */
export async function runExplain(
  args: string[],
  io: CliIO = {}
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const cwd = getCwd(io);

  const { values, positionals } = parseArgs({
    args,
    options: {
      workspace: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    stdout.write(EXPLAIN_HELP_TEXT);
    return 0;
  }

  if (positionals.length > 1) {
    throw new UsageError(
      `explain accepts at most one repository name (received ${positionals.length})`
    );
  }
  const repoFilter = positionals[0];

  // Resolve a relative --workspace against the caller's cwd. `~` paths are
  // left for findWorkspaceRoot/canonicalize to expand.
  let explicitWorkspace = values.workspace;
  if (
    explicitWorkspace !== undefined &&
    !path.isAbsolute(explicitWorkspace) &&
    !explicitWorkspace.startsWith('~')
  ) {
    explicitWorkspace = path.resolve(cwd, explicitWorkspace);
  }

  const root = findWorkspaceRoot({
    startDir: cwd,
    workspace: explicitWorkspace,
  });

  if (!root) {
    throw new UsageError(
      `No workspace.yaml found in '${cwd}' or any parent directory.`,
      [
        `Run 'wsg explain --workspace <workspace-dir>' or run from inside a workspace.`,
      ]
    );
  }

  const manifestPath = path.join(root, 'workspace.yaml');

  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(`No workspace.yaml found at '${manifestPath}'.`, [
        `Run 'wsg explain --workspace <workspace-dir>' or run from inside a workspace.`,
      ]);
    }
    throw err;
  }

  const manifest = parseManifest(text, { filename: manifestPath });
  stdout.write(renderExplain(manifest, { workspaceRoot: root, repoFilter }));
  return 0;
}
