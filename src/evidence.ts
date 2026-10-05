import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.ts';
import { assertConfinedRelative, canonicalize, resolveInside } from './paths.ts';
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
  /** Explicit `--repo` inputs may live outside the code roots and need no evidence. */
  explicit?: boolean;
}

/** Repository-relative paths actually retrieved or observed by the scout. */
export type EvidenceObservation = ReadonlyMap<string, ReadonlySet<string>>;

export interface EvidenceValidationOptions {
  /** Maximum bytes read from a single file while validating evidence. */
  maxFileBytes?: number;
  /** Files actually retrieved/observed, keyed by canonical repository source. */
  observed?: EvidenceObservation;
}

export interface ValidatedRepoSelection {
  name: string;
  source: string;
  intent: Intent;
  addedBy: 'scout' | 'user';
  explicit: boolean;
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

function assertNoVendorSegments(repoName: string, normalized: string): void {
  const segments = normalized.split('/').slice(0, -1);
  const vendorSegment = segments.find((segment) => VENDOR_DIR_NAMES.has(segment));
  if (vendorSegment) {
    throw new UsageError(
      `Evidence for repo '${repoName}' cites path '${normalized}' under vendor/build directory '${vendorSegment}'`
    );
  }
}

/**
 * Validates one piece of scout evidence against the real repository contents.
 *
 * A citation must name a confined repository-relative file, an in-range line
 * selection (when lines are given), and a non-empty quote that actually occurs
 * within that file (and within the cited lines). Confinement is enforced with
 * canonical realpath resolution for every path component, so an intermediate
 * directory symlink cannot redirect a read outside the repository. Anything
 * else is rejected as fictional evidence (repo spec §6.5).
 */
export function validateEvidenceItem(
  repo: AllowedRepo,
  item: ScoutEvidence,
  options: EvidenceValidationOptions = {}
): Evidence {
  const file = item.file;
  assertConfinedRelative(file, `evidence file for repo '${repo.name}'`);
  const normalized = path.posix.normalize(file);
  assertNoVendorSegments(repo.name, normalized);
  if (isSecretFilename(normalized)) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' cites secret-like file '${file}'`
    );
  }
  if (!item.summary || item.summary.trim().length === 0) {
    throw new UsageError(`Evidence for repo '${repo.name}' in '${file}' is missing a summary`);
  }

  // Observed-evidence rule: a discovered selection may only cite files that
  // retrieval or a read-only tool actually observed, never content the model
  // claims to have seen.
  if (!repo.explicit && options.observed) {
    const observedForRepo = options.observed.get(repo.source);
    if (!observedForRepo || !observedForRepo.has(normalized)) {
      throw new UsageError(
        `Evidence for repo '${repo.name}' cites '${file}', which was never retrieved or observed; refusing unseen evidence`
      );
    }
  }

  // Canonical, component-by-component confinement. This rejects an
  // intermediate directory symlink that escapes the repository.
  let abs: string;
  try {
    abs = resolveInside(repo.source, normalized);
  } catch (err: unknown) {
    throw new UsageError(
      `Evidence path '${file}' for repo '${repo.name}' is not confined to the repository: ${(err as Error).message}`
    );
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
 * Validates a scout selection against the enumerated repository universe plus
 * any explicit `--repo` inputs:
 * - explicit repositories are mandatory, may live outside the code roots, and
 *   do not require evidence;
 * - every other selected repository must exist under the code roots with
 *   verified, actually-observed evidence.
 * Returns the validated selection.
 */
export function validateScoutSelection(
  selection: ScoutSelection,
  allowed: readonly AllowedRepo[],
  options: EvidenceValidationOptions = {}
): ValidatedSelection {
  const repos: ValidatedRepoSelection[] = [];
  const seen = new Set<string>();
  const observed = options.observed ?? new Map<string, ReadonlySet<string>>();

  for (const input of selection.repos) {
    const resolved = resolveAllowed(input.source, allowed);
    if (!resolved) {
      throw new UsageError(
        `Scout selected repository '${input.source}', which is neither an explicit --repo input nor enumerated under the configured code roots`
      );
    }
    if (seen.has(resolved.source)) continue;
    seen.add(resolved.source);

    const explicit = resolved.explicit === true;
    const addedBy: 'scout' | 'user' = explicit ? 'user' : input.addedBy ?? 'scout';
    const intent: Intent = input.intent ?? 'unspecified';

    const evidence: Evidence[] = [];
    for (const item of input.evidence ?? []) {
      evidence.push(validateEvidenceItem({ ...resolved, explicit }, item, { ...options, observed }));
    }

    if (!explicit && evidence.length === 0) {
      throw new UsageError(
        `Scout selected repository '${resolved.name}' without evidence; every discovered selection requires verified evidence`
      );
    }

    repos.push({
      name: resolved.name,
      source: resolved.source,
      intent,
      addedBy,
      explicit,
      reason:
        input.reason?.trim() ||
        (explicit
          ? 'Explicit repository supplied by the user.'
          : 'Selected by the local scout from repository evidence.'),
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

export function explicitToAllowed(
  sources: Iterable<string>
): AllowedRepo[] {
  const result: AllowedRepo[] = [];
  for (const source of sources) {
    result.push({ name: path.basename(source), source, explicit: true });
  }
  return result;
}
