import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.ts';
import { assertConfinedRelative, canonicalize, resolveInside } from './paths.ts';
import { VENDOR_DIR_NAMES, type DiscoveredRepo } from './discovery.ts';
import { isSecretFilename } from './documents.ts';
import { ObservedEvidenceStore } from './observed.ts';
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
export type EvidenceObservation = ObservedEvidenceStore;

export interface EvidenceValidationOptions {
  /** Maximum bytes read from a single file while validating explicit evidence. */
  maxFileBytes?: number;
  /** Files actually retrieved/observed, keyed by canonical repository source. */
  observed?: ObservedEvidenceStore;
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
 * Validates one piece of scout evidence.
 *
 * Discovered selections are validated against the exact lines actually observed
 * by retrieval or a read-only tool: the cited file must have been observed,
 * every cited line must be present in the observation record, and the quote
 * must occur within a single contiguous observed run (and within the cited
 * lines when lines are given). This rejects quotes taken from parts of a file
 * the model never saw. Explicit `--repo` evidence is validated against the
 * confined live file because explicit inputs need no observation.
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
  if (!item.quote || normalize(item.quote ?? '').length < 3) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' in '${file}' must include a quoted snippet that can be verified`
    );
  }

  let lines: [number, number] | undefined;
  if (item.lines) {
    const [start, end] = item.lines;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new UsageError(
        `Evidence for repo '${repo.name}' in '${file}' has an invalid line range [${start}, ${end}]`
      );
    }
    lines = [start, end];
  }

  const store = options.observed;
  if (!repo.explicit && store) {
    const observed = store.getFile(repo.source, normalized);
    if (!observed || observed.size === 0) {
      throw new UsageError(
        `Evidence for repo '${repo.name}' cites '${file}', which was never retrieved or observed; refusing unseen evidence`
      );
    }
    if (lines) {
      for (let n = lines[0]; n <= lines[1]; n++) {
        if (!observed.has(n)) {
          throw new UsageError(
            `Evidence for repo '${repo.name}' in '${file}' cites lines ${lines[0]}-${lines[1]}, which were not observed by any read or search`
          );
        }
      }
      const haystack = normalize(
        Array.from(
          { length: lines[1] - lines[0] + 1 },
          (_value, index) => observed.get(lines[0] + index) ?? ''
        ).join('\n')
      );
      if (!haystack.includes(normalize(item.quote ?? ''))) {
        throw new UsageError(
          `Evidence for repo '${repo.name}' in '${file}' lines ${lines[0]}-${lines[1]} does not contain the quoted snippet; refusing unverifiable evidence`
        );
      }
    } else if (
      !store
        .runs(repo.source, normalized)
        .some((run) => normalize(run).includes(normalize(item.quote ?? '')))
    ) {
      throw new UsageError(
        `Evidence for repo '${repo.name}' in '${file}' does not contain the quoted snippet in any observed slice; refusing unverifiable evidence`
      );
    }
    return { file: normalized, ...(lines ? { lines } : {}), summary: item.summary };
  }

  // Explicit repositories (or callers without an observation store): validate
  // against the confined live file.
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
  if (lines && lines[1] > fileLines.length) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' in '${file}' cites lines [${lines[0]}, ${lines[1]}] but the file has only ${fileLines.length} lines`
    );
  }
  const haystack = lines
    ? normalize(fileLines.slice(lines[0] - 1, lines[1]).join('\n'))
    : normalize(content);
  if (!haystack.includes(normalize(item.quote ?? ''))) {
    throw new UsageError(
      `Evidence for repo '${repo.name}' in '${file}'${lines ? ` lines ${lines[0]}-${lines[1]}` : ''} does not contain the quoted snippet; refusing unverifiable (fictional) evidence`
    );
  }
  return { file: normalized, ...(lines ? { lines } : {}), summary: item.summary };
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
  const observed = options.observed ?? new ObservedEvidenceStore();

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
