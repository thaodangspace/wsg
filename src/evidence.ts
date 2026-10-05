import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.ts';
import { assertConfinedRelative, canonicalize } from './paths.ts';
import { VENDOR_DIR_NAMES, type DiscoveredRepo } from './discovery.ts';
import { isSecretFilename } from './documents.ts';
import type { Evidence, Intent } from './manifest.ts';
import type {
  ScoutEvidence,
  ScoutExclusion,
  ScoutRepoSelection,
  ScoutSelection,
} from './scout.ts';

export interface AllowedRepo {
  name: string;
  source: string;
}

export interface EvidenceValidationOptions {
  /** Maximum bytes read from a single file while validating evidence. */
  maxFileBytes?: number;
}

export interface ValidatedRepoSelection {
  name: string;
  source: string;
  intent: Intent;
  addedBy: 'scout' | 'user';
  reason: string;
  evidence: Evidence[];
}

export interface ValidatedSelection {
  repos: ValidatedRepoSelection[];
  excluded: ScoutExclusion[];
  gaps: string[];
  context: string[];
  docs: { input: string; reason?: string }[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function resolveAllowed(
  raw: string,
  allowed: readonly AllowedRepo[]
): AllowedRepo | undefined {
  const byName = allowed.find((r) => r.name === raw);
  if (byName) return byName;
  let canonicalRaw: string;
  try {
    canonicalRaw = canonicalize(raw);
  } catch {
    canonicalRaw = path.resolve(raw);
  }
  return allowed.find((r) => r.source === canonicalRaw);
}

/**
 * Validates one piece of scout evidence against the real repository contents.
 *
 * A citation must name a confined repository-relative file, an in-range line
 * selection (when lines are given), and a non-empty quote that actually occurs
 * within that file (and within the cited lines). Anything else is rejected as
 * fictional evidence (repo spec §6.5).
 */
export function validateEvidenceItem(
  repo: AllowedRepo,
  item: ScoutEvidence,
  options: EvidenceValidationOptions = {}
): Evidence {
  const file = item.file;
  assertConfinedRelative(file, `evidence file for repo '${repo.name}'`);
  const normalized = path.posix.normalize(file);
  const firstSegment = normalized.split('/')[0];
  if (VENDOR_DIR_NAMES.has(firstSegment)) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' cites vendor path '${file}', which is not part of the repository source`
    );
  }
  if (isSecretFilename(normalized)) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' cites secret-like file '${file}'`
    );
  }
  if (!item.summary || item.summary.trim().length === 0) {
    throw new UsageError(`Evidence for repo '${repo.name}' in '${file}' is missing a summary`);
  }

  const abs = path.resolve(repo.source, normalized);
  const rel = path.relative(repo.source, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UsageError(`Evidence path '${file}' escapes repository '${repo.name}'`);
  }

  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw new UsageError(
      `Evidence for repo '${repo.name}' cites missing file '${file}'`
    );
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' cites non-regular file '${file}'`
    );
  }

  const maxBytes = options.maxFileBytes ?? 1024 * 1024;
  let content: string;
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(maxBytes + 1);
      const read = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
      content = buf.subarray(0, Math.min(read, maxBytes)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err: unknown) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' could not read '${file}': ${(err as Error).message}`
    );
  }

  const fileLines = content.split('\n');

  let lines: [number, number] | undefined;
  if (item.lines) {
    const [start, end] = item.lines;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start
    ) {
      throw new UsageError(
        `Evidence for repo '${repo.name}' in '${file}' has an invalid line range [${start}, ${end}]`
      );
    }
    if (end > fileLines.length) {
      throw new UsageError(
        `Evidence for repo '${repo.name}' in '${file}' cites lines [${start}, ${end}] but the file has only ${fileLines.length} lines`
      );
    }
    lines = [start, end];
  }

  if (!item.quote || normalize(item.quote).length < 3) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' in '${file}' must include a quoted snippet that can be verified`
    );
  }

  const haystack = lines
    ? normalize(fileLines.slice(lines[0] - 1, lines[1]).join('\n'))
    : normalize(content);
  if (!haystack.includes(normalize(item.quote))) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' in '${file}'${lines ? ` lines ${lines[0]}-${lines[1]}` : ''} does not contain the quoted snippet; refusing unverifiable (fictional) evidence`
    );
  }

  const evidence: Evidence = {
    file: normalized,
    ...(lines ? { lines } : {}),
    summary: item.summary,
  };
  return evidence;
}

/**
 * Validates a scout selection against the enumerated repository universe:
 * every selected repository must exist, every citation must verify, and
 * explicit repositories are preserved. Returns the validated selection.
 */
export function validateScoutSelection(
  selection: ScoutSelection,
  allowed: readonly AllowedRepo[],
  options: EvidenceValidationOptions = {}
): ValidatedSelection {
  const repos: ValidatedRepoSelection[] = [];
  const seen = new Set<string>();

  for (const input of selection.repos) {
    const resolved = resolveAllowed(input.source, allowed);
    if (!resolved) {
      throw new UsageError(
        `Scout selected repository '${input.source}', which was not enumerated under the configured code roots`
      );
    }
    if (seen.has(resolved.source)) continue;
    seen.add(resolved.source);

    const intent: Intent = input.intent ?? 'unspecified';
    const addedBy = input.addedBy ?? 'scout';
    const evidence: Evidence[] = [];
    for (const item of input.evidence ?? []) {
      evidence.push(validateEvidenceItem(resolved, item, options));
    }

    if (addedBy === 'scout' && evidence.length === 0) {
      throw new UsageError(
        `Scout selected repository '${resolved.name}' without evidence; every discovered selection requires verified evidence`
      );
    }

    repos.push({
      name: resolved.name,
      source: resolved.source,
      intent,
      addedBy,
      reason: input.reason?.trim() || 'Selected by the local scout from repository evidence.',
      evidence,
    });
  }

  return {
    repos,
    excluded: (selection.excluded ?? []).map((e) => ({ source: e.source, reason: e.reason })),
    gaps: selection.gaps ?? [],
    context: selection.context ?? [],
    docs: selection.docs ?? [],
  };
}

/**
 * Focused ambiguity handling: a selection that names more than one repository as
 * the target system is ambiguous, so WSG returns candidates instead of
 * materializing an arbitrary target (repo spec §6.6).
 */
export function findTargetAmbiguity(
  selection: ValidatedSelection
): { reason: string; candidates: string[]; guidance: string } | null {
  const targets = selection.repos.filter((r) => r.intent === 'target');
  if (targets.length <= 1) return null;
  return {
    reason: `Scout identified ${targets.length} candidate target repositories; refusing to choose arbitrarily.`,
    candidates: targets.map((r) => `${r.name} (${r.source})`),
    guidance:
      'Re-run with --repo <path> to name the target explicitly, or tighten the request.',
  };
}

/**
 * Resolves `--repo` sources to canonical paths and rejects duplicates. Used to
 * make explicit repositories mandatory in a discovered selection.
 */
export function canonicalRepoSet(sources: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of sources) {
    const canonical = canonicalize(source);
    if (!map.has(canonical)) {
      map.set(canonical, source);
    }
  }
  return map;
}

export function discoveredToAllowed(repos: readonly DiscoveredRepo[]): AllowedRepo[] {
  return repos.map((r) => ({ name: r.name, source: r.source }));
}
