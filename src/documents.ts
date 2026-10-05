import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.ts';
import { expandHome, canonicalize, assertConfinedRelative } from './paths.ts';
import { sha256, writeFileAtomic } from './fsx.ts';
import { suffixForSource } from './slug.ts';
import type { AddedBy, DocEntry, DocMode } from './manifest.ts';

export type DocInputKind = 'url' | 'file';

export const SECRET_FILENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\..*)?$/i,
  /.*\.env$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
];

export const SECRET_CONTENT_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY/i,
  /BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY/i,
];

export const RESERVED_DOC_BASENAMES: ReadonlySet<string> = new Set([
  'context.md',
]);

/**
 * Classifies an input string as either a 'url' or 'file'.
 */
export function classifyDocInput(input: string): DocInputKind {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return 'url';
  }
  return 'file';
}

/**
 * Checks if a filename matches any secret-like filename pattern.
 */
export function isSecretFilename(filename: string): boolean {
  const base = path.basename(filename);
  return SECRET_FILENAME_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Checks if a buffer contains any secret content pattern (e.g. private keys).
 */
export function containsSecretContent(content: Buffer | string): boolean {
  const text = typeof content === 'string' ? content : content.toString('utf8', 0, Math.min(content.length, 512 * 1024));
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Detects whether a buffer contains text vs binary data using the NUL byte heuristic.
 */
export function isTextBuffer(buffer: Buffer): boolean {
  const checkLen = Math.min(buffer.length, 8000);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      return false;
    }
  }
  return true;
}

export interface InspectedFileDoc {
  kind: 'file';
  input: string;
  source: string; // canonical realpath
  basename: string;
  sha256: string;
  size: number;
  text: boolean;
  content: Buffer;
  mode: 'snapshot';
}

export interface InspectedUrlDoc {
  kind: 'url';
  input: string;
  source: string;
  mode: 'reference';
  reason: string;
  text: false;
}

export type InspectedDoc = InspectedFileDoc | InspectedUrlDoc;

/**
 * Inspects a document source (file or URL):
 * - Validates existence, regular file, readability
 * - Refuses directories, symlinks to directories, broken symlinks
 * - Refuses secret-like filenames or private key contents
 * - Detects text vs binary
 */
export function inspectDoc(input: string): InspectedDoc {
  const kind = classifyDocInput(input);
  if (kind === 'url') {
    return {
      kind: 'url',
      input,
      source: input.trim(),
      mode: 'reference',
      reason: 'Not fetched in this version',
      text: false,
    };
  }

  const expanded = expandHome(input);
  const resolved = path.resolve(expanded);

  // Check existence and lstat
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new UsageError(`Document file '${input}' does not exist`);
    }
    throw new UsageError(`Cannot access document '${input}': ${(err as Error).message}`);
  }

  // Canonical realpath
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch (err: unknown) {
    throw new UsageError(`Document file '${input}' is a broken symbolic link: ${(err as Error).message}`);
  }

  // Stat the canonical target
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch (err: unknown) {
    throw new UsageError(`Cannot inspect document target '${canonical}': ${(err as Error).message}`);
  }

  if (stat.isDirectory()) {
    throw new UsageError(`Document path '${input}' is a directory, not a regular file`);
  }

  if (!stat.isFile()) {
    throw new UsageError(`Document path '${input}' is not a regular file`);
  }

  // Check readability and read content
  let content: Buffer;
  try {
    content = fs.readFileSync(canonical);
  } catch (err: unknown) {
    throw new UsageError(`Document file '${input}' is unreadable: ${(err as Error).message}`);
  }

  // Refuse secret-like filename
  if (isSecretFilename(input) || isSecretFilename(canonical)) {
    throw new UsageError(
      `Refusing to snapshot secret-like file '${input}': filename matches protected pattern`
    );
  }

  // Refuse secret-like content
  if (containsSecretContent(content)) {
    throw new UsageError(
      `Refusing to snapshot secret-like file '${input}': file content contains private key`
    );
  }

  const text = isTextBuffer(content);
  const hash = sha256(content);

  return {
    kind: 'file',
    input,
    source: canonical,
    basename: path.basename(canonical),
    sha256: hash,
    size: content.length,
    text,
    content,
    mode: 'snapshot',
  };
}

/**
 * Creates a reference DocEntry for a URL or remote source.
 */
export function referenceDoc(
  source: string,
  reason: string = 'Not fetched in this version',
  addedBy: AddedBy = 'user'
): DocEntry {
  return {
    source,
    mode: 'reference',
    added_by: addedBy,
    reason,
  };
}

export interface SnapshotDocOptions {
  fetchedAt?: string;
  addedBy?: AddedBy;
  wsDir?: string;
}

/**
 * Creates a snapshot DocEntry for an inspected local file and optionally writes it to the workspace.
 */
export function snapshotDoc(
  doc: string | InspectedFileDoc,
  destPath: string,
  options: SnapshotDocOptions = {}
): DocEntry {
  const inspected: InspectedFileDoc =
    typeof doc === 'string'
      ? (() => {
          const res = inspectDoc(doc);
          if (res.kind !== 'file') {
            throw new UsageError(`Expected local file for snapshotDoc, got URL '${doc}'`);
          }
          return res;
        })()
      : doc;

  assertConfinedRelative(destPath, 'Snapshot doc destination path');

  if (options.wsDir) {
    const fullPath = path.resolve(options.wsDir, destPath);
    writeFileAtomic(fullPath, inspected.content);
  }

  return {
    source: inspected.source,
    path: destPath,
    mode: 'snapshot',
    added_by: options.addedBy ?? 'user',
    sha256: inspected.sha256,
    fetched_at: options.fetchedAt ?? new Date().toISOString(),
  };
}

export interface PlannedDoc extends DocEntry {
  inspected: InspectedDoc;
  text?: boolean;
}

export interface PlanDocsOptions {
  addedBy?: AddedBy;
  fetchedAt?: string;
}

/**
 * Plans destination paths and DocEntry entries for a list of document inputs.
 * - Deduplicates identical canonical sources
 * - Maps local files to docs/<basename>
 * - Deterministically handles collisions with other docs and reserved files (e.g. context.md)
 *   by appending -<6hex> from sha256 of canonical path
 * - Maps URLs to reference entries with mode: reference
 */
export function planDocs(
  inputs: readonly (string | InspectedDoc)[],
  options: PlanDocsOptions = {}
): PlannedDoc[] {
  const addedBy = options.addedBy ?? 'user';
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();

  // Step 1: Inspect all inputs
  const inspectedList: InspectedDoc[] = inputs.map((item) =>
    typeof item === 'string' ? inspectDoc(item) : item
  );

  // Step 2: Deduplicate identical sources
  const deduplicated: InspectedDoc[] = [];
  const seenCanonicalSources = new Set<string>();

  for (const inspected of inspectedList) {
    if (seenCanonicalSources.has(inspected.source)) {
      continue;
    }
    seenCanonicalSources.add(inspected.source);
    deduplicated.push(inspected);
  }

  // Step 3: Plan doc entries
  const planned: PlannedDoc[] = [];
  const usedLowerDocBasenames = new Set<string>();

  for (const inspected of deduplicated) {
    if (inspected.kind === 'url') {
      const refEntry = referenceDoc(inspected.source, inspected.reason, addedBy);
      planned.push({
        ...refEntry,
        inspected,
        text: false,
      });
      continue;
    }

    // Snapshot file
    const rawBasename = inspected.basename;
    const ext = path.extname(rawBasename);
    const baseName = ext.length > 0 ? rawBasename.slice(0, -ext.length) : rawBasename;

    let targetBasename: string;
    const lowerRaw = rawBasename.toLowerCase();

    if (!RESERVED_DOC_BASENAMES.has(lowerRaw) && !usedLowerDocBasenames.has(lowerRaw)) {
      targetBasename = rawBasename;
    } else {
      const suffix = suffixForSource(inspected.source);
      let candidate = `${baseName}-${suffix}${ext}`;
      let counter = 1;
      while (
        RESERVED_DOC_BASENAMES.has(candidate.toLowerCase()) ||
        usedLowerDocBasenames.has(candidate.toLowerCase())
      ) {
        candidate = `${baseName}-${suffix}-${counter}${ext}`;
        counter++;
      }
      targetBasename = candidate;
    }

    usedLowerDocBasenames.add(targetBasename.toLowerCase());

    const destRelPath = `docs/${targetBasename}`;
    const snapEntry = snapshotDoc(inspected, destRelPath, { addedBy, fetchedAt });

    planned.push({
      ...snapEntry,
      inspected,
      text: inspected.text,
    });
  }

  return planned;
}
