import { createHash } from 'node:crypto';
import path from 'node:path';
import { UsageError } from './errors.ts';
import { canonicalize } from './paths.ts';

export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  'workspace.yaml',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs',
  'scripts',
  '.wsg',
]);

export function validateSlug(slug: string): boolean {
  if (typeof slug !== 'string') return false;
  if (!SLUG_RE.test(slug)) return false;
  if (slug === '.' || slug === '..') return false;
  if (RESERVED_ROOT_NAMES.has(slug)) return false;
  return true;
}

export function assertValidSlug(slug: string, context: string = 'Slug'): void {
  if (!validateSlug(slug)) {
    throw new UsageError(
      `${context} '${slug}' is invalid: must be 1-64 characters matching ${SLUG_RE.source} and not a reserved name (${Array.from(RESERVED_ROOT_NAMES).join(', ')})`
    );
  }
}

export function deriveSlug(request: string): string {
  let slug = request
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');

  if (slug.length > 64) {
    slug = slug.slice(0, 64).replace(/[._-]+$/, '');
  }

  if (!slug) {
    slug = 'workspace';
  }

  if (RESERVED_ROOT_NAMES.has(slug)) {
    slug = `${slug}-ws`;
    if (slug.length > 64) {
      slug = slug.slice(0, 64);
    }
  }

  return slug;
}

export function suffixForSource(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 6);
}

export function assignEntryNames(
  sources: readonly string[]
): Map<string, string> {
  const result = new Map<string, string>();
  const canonicalToEntry = new Map<string, string>();
  const usedNames = new Set<string>();

  for (const source of sources) {
    const canonical = canonicalize(source);
    if (canonicalToEntry.has(canonical)) {
      result.set(source, canonicalToEntry.get(canonical)!);
      continue;
    }

    const cleanPath = source.replace(/[/\\]+$/, '');
    let base = path.basename(cleanPath);
    if (!base || base === '.' || base === '..') {
      base = 'repo';
    }

    let entryName: string;
    if (
      !usedNames.has(base) &&
      !RESERVED_ROOT_NAMES.has(base) &&
      validateSlug(base)
    ) {
      entryName = base;
    } else {
      const suffix = suffixForSource(canonical);
      let candidate = `${base}-${suffix}`;
      if (usedNames.has(candidate)) {
        const fullHash = createHash('sha256').update(canonical).digest('hex');
        candidate = `${base}-${fullHash.slice(0, 8)}`;
      }
      entryName = candidate;
    }

    usedNames.add(entryName);
    canonicalToEntry.set(canonical, entryName);
    result.set(source, entryName);
  }

  return result;
}
