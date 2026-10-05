import type { Manifest, ManifestAdapter } from './manifest.ts';

export interface RenderContextOptions {
  unreadDocs?: Set<string> | readonly string[];
}

const NON_TEXT_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.pdf',
  '.bin',
  '.exe',
  '.zip',
  '.tar',
  '.gz',
]);

/**
 * Pure renderer for docs/context.md.
 * Canonical single owner of workspace task context and repository roles.
 */
export function renderContext(
  manifest: Manifest,
  options: RenderContextOptions = {}
): string {
  const unreadSet = new Set(options.unreadDocs ?? []);

  const sections: string[] = [];

  // Title & Request
  sections.push(`# Workspace Context: ${manifest.name}\n\n## Request\n${manifest.request.trim()}`);

  // Additional context
  if (manifest.context && manifest.context.length > 0) {
    const contextLines = manifest.context.map((line) => `- ${line}`).join('\n');
    sections.push(`## Additional Context\n${contextLines}`);
  }

  // Repositories
  const repoBlocks = manifest.repos.map((repo) => {
    const lines = [
      `### ${repo.name}`,
      `- Path: \`${repo.path}\``,
      `- Source: \`${repo.source}\``,
      `- Branch: \`${repo.branch}\``,
      `- Base commit: \`${repo.base_commit}\``,
      `- Intent: ${repo.intent}`,
    ];

    if (repo.reason) {
      lines.push(`- Reason: ${repo.reason}`);
    }

    if (repo.evidence && repo.evidence.length > 0) {
      lines.push('- Evidence:');
      for (const ev of repo.evidence) {
        const lineSuffix = ev.lines ? `:${ev.lines[0]}-${ev.lines[1]}` : '';
        lines.push(`  - \`${ev.file}${lineSuffix}\`: ${ev.summary}`);
      }
    }

    return lines.join('\n');
  });

  sections.push(`## Repositories\n\n${repoBlocks.length > 0 ? repoBlocks.join('\n\n') : 'None.'}`);

  // Documents
  if (manifest.docs && manifest.docs.length > 0) {
    const docLines = manifest.docs.map((doc) => {
      const ext = doc.path ? doc.path.slice(doc.path.lastIndexOf('.')).toLowerCase() : '';
      const isUnread =
        doc.mode === 'reference' ||
        (doc.path && unreadSet.has(doc.path)) ||
        (doc.path && NON_TEXT_EXTENSIONS.has(ext));

      const unreadTag = isUnread ? ' (unread)' : '';

      if (doc.mode === 'snapshot' && doc.path) {
        return `- \`${doc.path}\` (mode: snapshot)${unreadTag} — source: \`${doc.source}\``;
      } else {
        const reasonStr = doc.reason ? ` — ${doc.reason}` : '';
        return `- [${doc.source}](${doc.source}) (mode: reference)${unreadTag}${reasonStr}`;
      }
    });
    sections.push(`## Documents\n\n${docLines.join('\n')}`);
  } else {
    sections.push('## Documents\n\nNone attached.');
  }

  // Gaps and Unresolved Questions
  const gaps = manifest.discovery?.gaps ?? [];
  if (gaps.length > 0) {
    const gapLines = gaps.map((gap) => `- ${gap}`).join('\n');
    sections.push(`## Gaps and Unresolved Questions\n\n${gapLines}`);
  } else {
    sections.push('## Gaps and Unresolved Questions\n\nNone reported.');
  }

  // Commands (discovered, not verified)
  sections.push('## Commands (discovered, not verified)\n\nNone discovered.');

  return sections.join('\n\n') + '\n';
}

/**
 * Pure renderer for workspace README.md explaining harness usage.
 */
export function renderReadme(manifest: Manifest): string {
  const repoList = manifest.repos
    .map((r) => `- \`${r.path}/\`: ${r.intent} repository on branch \`${r.branch}\``)
    .join('\n');

  return `# ${manifest.name}

${manifest.request.trim()}

## Workspace Overview

This workspace was assembled by WSG for multi-repository tasks with coding agent harnesses.

- **Canonical Context**: Read [docs/context.md](docs/context.md) for full task context, repository roles, documentation, and discovered commands.
- **Repositories**:
${repoList || '  None.'}

## Using with Coding Harnesses

When working with an agent harness (e.g. Pi, Claude Code, Cursor, Codex):

1. Point your agent harness to this workspace root directory.
2. The agent should read [docs/context.md](docs/context.md) as the canonical workspace context.
3. Repository-local instructions, configuration, and build commands within each repository directory also apply when working inside that repository.
`;
}

/**
 * Pure renderer for adapter files (AGENTS.md, CLAUDE.md).
 * Points harness to canonical docs/context.md and notes repo-local instructions.
 */
export function renderAdapter(
  adapter: ManifestAdapter,
  _manifest: Manifest
): string {
  const adapterTitle = adapter === 'claude' ? 'Claude Instructions' : 'Agent Instructions';

  return `# ${adapterTitle}

Please read [docs/context.md](docs/context.md) for canonical workspace context, repository roles, relevant documentation, and guidelines.

Repository-local instructions and workflows also apply when working within each repository directory.
`;
}

/**
 * Returns planned generated file paths given adapters configuration.
 */
export function plannedGeneratedFiles(
  input: Manifest | readonly ManifestAdapter[] | string | readonly string[]
): string[] {
  let adapters: string[] = [];

  if (typeof input === 'string') {
    adapters = input.split(',').map((s) => s.trim().toLowerCase());
  } else if (Array.isArray(input)) {
    adapters = input.flatMap((item) =>
      typeof item === 'string'
        ? item.split(',').map((s) => s.trim().toLowerCase())
        : []
    );
  } else if (input && typeof input === 'object' && 'adapters' in input) {
    adapters = (input.adapters ?? []).map((s) => s.toLowerCase());
  }

  const isNone = adapters.includes('none');

  const files: string[] = ['docs/context.md', 'README.md'];

  if (!isNone) {
    if (adapters.includes('agents')) {
      files.push('AGENTS.md');
    }
    if (adapters.includes('claude')) {
      files.push('CLAUDE.md');
    }
  }

  return files;
}

/**
 * Pure renderer for all generated workspace files.
 * Returns a Map of relative path -> file content.
 */
export function renderAll(
  manifest: Manifest,
  options: RenderContextOptions = {}
): Map<string, string> {
  const result = new Map<string, string>();

  // Canonical context
  result.set('docs/context.md', renderContext(manifest, options));

  // Workspace README
  result.set('README.md', renderReadme(manifest));

  // Adapters
  const planned = plannedGeneratedFiles(manifest);
  if (planned.includes('AGENTS.md')) {
    result.set('AGENTS.md', renderAdapter('agents', manifest));
  }
  if (planned.includes('CLAUDE.md')) {
    result.set('CLAUDE.md', renderAdapter('claude', manifest));
  }

  return result;
}
