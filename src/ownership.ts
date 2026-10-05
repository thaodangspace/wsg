import fs from 'node:fs';
import path from 'node:path';
import { assertConfinedRelative, resolveInside, canonicalize } from './paths.ts';
import { sha256, writeFileAtomic } from './fsx.ts';
import { readOperation, writeOperation, type OwnedFileEntry, type OperationFile } from './operation.ts';
import { UsageError } from './errors.ts';

export type GeneratedFilesInput =
  | Map<string, string>
  | Record<string, string>
  | ReadonlyArray<{ path: string; content: string }>;

export interface ReconcileResult {
  partial: boolean;
  written: string[];
  proposals: string[];
  unmodified: string[];
  owned: Record<string, OwnedFileEntry>;
}

interface PreflightEntry {
  rawPath: string;
  normalizedPath: string;
  targetPath: string;
  canonicalTarget: string;
  content: string;
}

/**
 * Reconciles generated workspace files against existing files on disk and ownership hashes.
 * - Preflights all batch paths and collisions before performing any filesystem mutations.
 * - Fresh files (not on disk) are written atomically and recorded in owned.
 * - Unchanged owned files (disk sha matches recorded owned sha) are overwritten and updated in owned.
 * - Edited files (disk sha differs from owned sha, or unowned files) are left untouched on disk;
 *   a <file>.wsg-new proposal file is resolved independently and written without clobbering existing proposals.
 * - Unmodified files (disk content already matches new content) are left as-is.
 * - Propagates journal corruption/access/write errors; persists ownership after each successful file change.
 */
export function reconcileGenerated(
  wsDir: string,
  files: GeneratedFilesInput,
  owned?: Record<string, OwnedFileEntry>
): ReconcileResult {
  // Normalize files input to entries
  const rawEntries: [string, string][] = [];
  if (files instanceof Map) {
    for (const [k, v] of files.entries()) {
      rawEntries.push([k, v]);
    }
  } else if (Array.isArray(files)) {
    for (const item of files) {
      rawEntries.push([item.path, item.content]);
    }
  } else if (typeof files === 'object' && files !== null) {
    for (const [k, v] of Object.entries(files)) {
      rawEntries.push([k, v]);
    }
  }

  // Preflight all batch paths and collisions BEFORE any writes
  const preflighted: PreflightEntry[] = [];
  const seenNormalized = new Set<string>();
  const seenCanonicalTargets = new Set<string>();

  for (const [rawPath, content] of rawEntries) {
    assertConfinedRelative(rawPath, 'Generated file path');
    const normalized = path.posix.normalize(rawPath);

    if (seenNormalized.has(normalized.toLowerCase())) {
      throw new UsageError(`Duplicate generated file destination '${rawPath}' in batch`);
    }
    seenNormalized.add(normalized.toLowerCase());

    const targetPath = resolveInside(wsDir, normalized);
    const canonicalTarget = canonicalize(targetPath);

    if (seenCanonicalTargets.has(canonicalTarget.toLowerCase())) {
      throw new UsageError(`Duplicate resolved destination for '${rawPath}' in batch`);
    }
    seenCanonicalTargets.add(canonicalTarget.toLowerCase());

    // Preflight proposal path confinement as well
    const proposalRelPath = `${normalized}.wsg-new`;
    resolveInside(wsDir, proposalRelPath);

    preflighted.push({
      rawPath,
      normalizedPath: normalized,
      targetPath,
      canonicalTarget,
      content,
    });
  }

  // Load operation journal if present. Do NOT swallow corruption/access errors.
  let opFile: OperationFile | null = null;
  const journalOp = readOperation(wsDir);
  if (journalOp !== null) {
    opFile = journalOp;
  }

  const ownedMap: Record<string, OwnedFileEntry> = owned ?? (opFile ? { ...opFile.owned } : {});

  const written: string[] = [];
  const proposals: string[] = [];
  const unmodified: string[] = [];
  let partial = false;

  for (const entry of preflighted) {
    const { normalizedPath, targetPath, content } = entry;
    const newSha = sha256(content);
    const now = new Date().toISOString();

    if (!fs.existsSync(targetPath)) {
      // Fresh file
      writeFileAtomic(targetPath, content);
      ownedMap[normalizedPath] = { sha256: newSha, generatedAt: now };
      if (opFile) {
        opFile.owned[normalizedPath] = ownedMap[normalizedPath];
        writeOperation(wsDir, opFile);
      }
      written.push(normalizedPath);
    } else {
      const diskData = fs.readFileSync(targetPath);
      const diskSha = sha256(diskData);
      const ownedEntry = ownedMap[normalizedPath];

      const isUntouchedOwned = ownedEntry !== undefined && ownedEntry.sha256 === diskSha;

      if (isUntouchedOwned) {
        if (diskSha !== newSha) {
          // File was owned and unmodified by user -> overwrite
          writeFileAtomic(targetPath, content);
          ownedMap[normalizedPath] = { sha256: newSha, generatedAt: now };
          if (opFile) {
            opFile.owned[normalizedPath] = ownedMap[normalizedPath];
            writeOperation(wsDir, opFile);
          }
          written.push(normalizedPath);
        } else {
          unmodified.push(normalizedPath);
        }
      } else {
        // File was modified by user or unowned
        if (diskSha === newSha) {
          unmodified.push(normalizedPath);
        } else {
          // User edited -> preserve user file, resolve proposal path independently
          const baseProposalRelPath = `${normalizedPath}.wsg-new`;
          let chosenProposalRelPath = baseProposalRelPath;
          let chosenProposalFullPath = resolveInside(wsDir, chosenProposalRelPath);

          // Preserve preexisting proposal files rather than unconditionally overwriting them
          if (fs.existsSync(chosenProposalFullPath)) {
            const existingData = fs.readFileSync(chosenProposalFullPath, 'utf8');
            if (existingData !== content) {
              let counter = 1;
              while (fs.existsSync(chosenProposalFullPath)) {
                const currentData = fs.readFileSync(chosenProposalFullPath, 'utf8');
                if (currentData === content) {
                  break;
                }
                chosenProposalRelPath = `${baseProposalRelPath}-${counter}`;
                chosenProposalFullPath = resolveInside(wsDir, chosenProposalRelPath);
                counter++;
              }
            }
          }

          if (
            !fs.existsSync(chosenProposalFullPath) ||
            fs.readFileSync(chosenProposalFullPath, 'utf8') !== content
          ) {
            writeFileAtomic(chosenProposalFullPath, content);
          }

          proposals.push(chosenProposalRelPath);
          partial = true;
        }
      }
    }
  }

  return {
    partial,
    written,
    proposals,
    unmodified,
    owned: ownedMap,
  };
}
