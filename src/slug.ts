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

const LOWER_RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set(
  Array.from(RESERVED_ROOT_NAMES).map((s) => s.toLowerCase())
);

export function isReservedRootName(name: string): boolean {
  return (
    RESERVED_ROOT_NAMES.has(name) ||
    LOWER_RESERVED_ROOT_NAMES.has(name.toLowerCase())
  );
}

export function validateSlug(slug: string): boolean {
  if (typeof slug !== 'string') return false;
  if (!SLUG_RE.test(slug)) return false;
  if (slug === '.' || slug === '..') return false;
  if (isReservedRootName(slug)) return false;
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

  if (isReservedRootName(slug)) {
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

function normalizeBase(rawBase: string): string {
  let normalized = rawBase
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');

  if (normalized.length > 64) {
    normalized = normalized.slice(0, 64).replace(/[._-]+$/, '');
  }

  if (!normalized) {
    normalized = 'repo';
  }

  return normalized;
}

export function assignEntryNames(
  sources: readonly string[]
): Map<string, string> {
  const result = new Map<string, string>();
  const canonicalToEntry = new Map<string, string>();
  const usedLowerNames = new Set<string>();

  for (const source of sources) {
    const canonical = canonicalize(source);
    if (canonicalToEntry.has(canonical)) {
      result.set(source, canonicalToEntry.get(canonical)!);
      continue;
    }

    const cleanCanonical = canonical.replace(/[/\\]+$/, '');
    const rawBase = path.basename(cleanCanonical);
    const base = normalizeBase(rawBase);

    let entryName: string;
    if (
      !usedLowerNames.has(base.toLowerCase()) &&
      !isReservedRootName(base) &&
      validateSlug(base)
    ) {
      entryName = base;
    } else {
      const suffix = suffixForSource(canonical);
      const maxBaseLen = 64 - suffix.length - 1;
      const truncatedBase =
        base.slice(0, maxBaseLen).replace(/[._-]+$/, '') || 'repo';
      let candidate = `${truncatedBase}-${suffix}`;

      let counter = 1;
      while (
        usedLowerNames.has(candidate.toLowerCase()) ||
        isReservedRootName(candidate) ||
        !validateSlug(candidate)
      ) {
        const counterSuffix = `-${counter}`;
        const maxLen = 64 - suffix.length - 1 - counterSuffix.length;
        const tBase =
          base.slice(0, Math.max(1, maxLen)).replace(/[._-]+$/, '') || 'repo';
        candidate = `${tBase}-${suffix}${counterSuffix}`;
        counter++;
      }
      entryName = candidate;
    }

    usedLowerNames.add(entryName.toLowerCase());
    canonicalToEntry.set(canonical, entryName);
    result.set(source, entryName);
  }

  return result;
}
