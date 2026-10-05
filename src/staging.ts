import fs from 'node:fs';
import path from 'node:path';
import { ConflictError } from './errors.ts';
import { resolveInside } from './paths.ts';
import { writeFileAtomic, ensureDir, sha256 } from './fsx.ts';

export interface CommitOptions {
  /**
   * When overwriting an existing destination is intentional, the sha256 of the
   * bytes expected on disk immediately before the rename. If the destination
   * exists with a different hash, the write is rejected rather than clobbering
   * a user edit.
   */
  expectedPriorSha?: string;
}

/**
 * Writes bytes atomically to `.wsg/tmp/.../<relPath>` under `tmpDir`.
 */
export function stageFile(tmpDir: string, relPath: string, content: Buffer | string): void {
  const stagingPath = resolveInside(tmpDir, relPath);
  ensureDir(path.dirname(stagingPath));
  writeFileAtomic(stagingPath, content, { tmpDir });
}

/**
 * Renames a previously staged file into the workspace.
 *
 * - Destination absent: rename into place.
 * - Destination already holds the same bytes: drop the staged copy (idempotent).
 * - Destination holds `expectedPriorSha`: overwrite (intentional refresh).
 * - Anything else: refuse, so unowned user files are never overwritten.
 */
export function commitStagedFile(
  wsDir: string,
  tmpDir: string,
  relPath: string,
  content: Buffer | string,
  options: CommitOptions = {}
): void {
  const stagingPath = resolveInside(tmpDir, relPath);
  const finalPath = resolveInside(wsDir, relPath);
  const contentSha = sha256(content);

  if (fs.existsSync(finalPath)) {
    const disk = fs.readFileSync(finalPath);
    const diskSha = sha256(disk);
    if (diskSha === contentSha) {
      try {
        fs.rmSync(stagingPath, { force: true });
      } catch {
        // ignore
      }
      return;
    }
    if (options.expectedPriorSha && diskSha === options.expectedPriorSha) {
      ensureDir(path.dirname(finalPath));
      fs.renameSync(stagingPath, finalPath);
      return;
    }
    throw new ConflictError(
      `Refusing to overwrite existing file '${relPath}': destination contains different content.`,
      [`Move or rename the existing file, then retry.`]
    );
  }

  ensureDir(path.dirname(finalPath));
  fs.renameSync(stagingPath, finalPath);
}

/** Stages and immediately commits a file under the caller's writer lock. */
export function writeWorkspaceFile(
  wsDir: string,
  tmpDir: string,
  relPath: string,
  content: Buffer | string,
  options: CommitOptions = {}
): void {
  stageFile(tmpDir, relPath, content);
  commitStagedFile(wsDir, tmpDir, relPath, content, options);
}
