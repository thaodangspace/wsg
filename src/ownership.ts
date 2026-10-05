import fs from 'node:fs';
import path from 'node:path';
import { assertConfinedRelative, resolveInside } from './paths.ts';
import { sha256, writeFileAtomic } from './fsx.ts';
import { readOperation, writeOperation, type OwnedFileEntry } from './operation.ts';

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

/**
 * Reconciles generated workspace files against existing files on disk and ownership hashes.
 * - Fresh files (not on disk) are written atomically and recorded in owned.
 * - Unchanged owned files (disk sha matches recorded owned sha) are overwritten and updated in owned.
 * - Edited files (disk sha differs from owned sha, or unowned files) are left untouched on disk;
 *   a <file>.wsg-new proposal file is written, and partial is set to true.
 * - Unmodified files (disk content already matches new content) are left as-is.
 * - Updates .wsg/operation.json on disk if present.
 */
export function reconcileGenerated(
  wsDir: string,
  files: GeneratedFilesInput,
  owned?: Record<string, OwnedFileEntry>
): ReconcileResult {
  const ownedMap: Record<string, OwnedFileEntry> = owned ?? {};

  // If owned was not passed, try reading from operation.json
  if (!owned) {
    try {
      const op = readOperation(wsDir);
      if (op && op.owned) {
        Object.assign(ownedMap, op.owned);
      }
    } catch {
      // Ignore if operation journal doesn't exist
    }
  }

  // Normalize files input
  const fileEntries: [string, string][] = [];
  if (files instanceof Map) {
    for (const [k, v] of files.entries()) {
      fileEntries.push([k, v]);
    }
  } else if (Array.isArray(files)) {
    for (const item of files) {
      fileEntries.push([item.path, item.content]);
    }
  } else if (typeof files === 'object' && files !== null) {
    for (const [k, v] of Object.entries(files)) {
      fileEntries.push([k, v]);
    }
  }

  const written: string[] = [];
  const proposals: string[] = [];
  const unmodified: string[] = [];
  let partial = false;

  for (const [relPath, content] of fileEntries) {
    assertConfinedRelative(relPath, 'Generated file path');
    const targetPath = resolveInside(wsDir, relPath);

    const newSha = sha256(content);
    const now = new Date().toISOString();

    if (!fs.existsSync(targetPath)) {
      // Fresh file
      writeFileAtomic(targetPath, content);
      ownedMap[relPath] = { sha256: newSha, generatedAt: now };
      written.push(relPath);
    } else {
      const diskData = fs.readFileSync(targetPath);
      const diskSha = sha256(diskData);
      const ownedEntry = ownedMap[relPath];

      const isUntouchedOwned = ownedEntry !== undefined && ownedEntry.sha256 === diskSha;

      if (isUntouchedOwned) {
        if (diskSha !== newSha) {
          // File was owned and unmodified by user -> overwrite
          writeFileAtomic(targetPath, content);
          ownedMap[relPath] = { sha256: newSha, generatedAt: now };
          written.push(relPath);
        } else {
          unmodified.push(relPath);
        }
      } else {
        // File was modified by user or unowned
        if (diskSha === newSha) {
          unmodified.push(relPath);
        } else {
          // User edited -> preserve user file, write proposal
          const proposalRelPath = `${relPath}.wsg-new`;
          const proposalFullPath = `${targetPath}.wsg-new`;
          writeFileAtomic(proposalFullPath, content);
          proposals.push(proposalRelPath);
          partial = true;
        }
      }
    }
  }

  // If .wsg/operation.json exists, update it atomically
  try {
    const op = readOperation(wsDir);
    if (op) {
      op.owned = { ...op.owned, ...ownedMap };
      writeOperation(wsDir, op);
    }
  } catch {
    // Ignore if not present or cannot update
  }

  return {
    partial,
    written,
    proposals,
    unmodified,
    owned: ownedMap,
  };
}
