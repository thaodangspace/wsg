import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConflictError, UsageError } from './errors.ts';
import { ensureDir, writeFileAtomic } from './fsx.ts';
import { canonicalize } from './paths.ts';

export type StepStatus = 'planned' | 'started' | 'done' | 'failed';

export interface Step {
  id: string;
  type: string;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

export type OperationStatus = 'running' | 'complete' | 'failed';

export interface Operation {
  id: string;
  command: string;
  status: OperationStatus;
  startedAt: string;
  completedAt?: string;
  args?: Record<string, unknown>;
  steps: Step[];
}

export interface OwnedFileEntry {
  sha256: string;
  generatedAt: string;
}

export interface OperationFile {
  version: 1;
  owned: Record<string, OwnedFileEntry>;
  operation: Operation | null;
}

export interface LockData {
  pid: number;
  hostname: string;
  startedAt: string;
  opId?: string;
}

export interface AcquireLockOptions {
  opId?: string;
  onWarning?: (msg: string) => void;
}

export function isPidAlive(pid: number): boolean {
  if (typeof pid !== 'number' || isNaN(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export function resolveWsgDir(dir: string): string {
  const canonical = canonicalize(dir);
  if (path.basename(canonical) === '.wsg') {
    return canonical;
  }
  return path.join(canonical, '.wsg');
}

/**
 * Initializes the .wsg directory:
 * - mode 0700
 * - creates .gitignore containing *
 * - refuses symlinks
 */
export function initWsgDir(dir: string): string {
  const wsgDir = resolveWsgDir(dir);

  try {
    const lstat = fs.lstatSync(wsgDir);
    if (lstat.isSymbolicLink()) {
      throw new UsageError(`Refusing to initialize .wsg directory through symbolic link: '${wsgDir}'`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  ensureDir(wsgDir, 0o700);
  try {
    fs.chmodSync(wsgDir, 0o700);
  } catch {
    // ignore
  }

  const gitignorePath = path.join(wsgDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    writeFileAtomic(gitignorePath, '*\n', { mode: 0o644 });
  }

  return wsgDir;
}

/**
 * Acquires exclusive workspace lock using O_EXCL.
 * If held by another host, throws ConflictError.
 * If held by live PID on same host, throws ConflictError.
 * If held by dead PID on same host, takes over stale lock and logs warning.
 */
export function acquireLock(
  dir: string,
  optionsOrOpId?: AcquireLockOptions | string,
  legacyOnWarning?: (msg: string) => void
): LockData {
  let opId: string | undefined;
  let onWarning: ((msg: string) => void) | undefined;

  if (typeof optionsOrOpId === 'string') {
    opId = optionsOrOpId;
    onWarning = legacyOnWarning;
  } else if (optionsOrOpId && typeof optionsOrOpId === 'object') {
    opId = optionsOrOpId.opId;
    onWarning = optionsOrOpId.onWarning ?? legacyOnWarning;
  }

  const wsgDir = initWsgDir(dir);
  const lockPath = path.join(wsgDir, 'lock');

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check if lock file is a symlink
    try {
      const lstat = fs.lstatSync(lockPath);
      if (lstat.isSymbolicLink()) {
        throw new ConflictError(`Lock file '${lockPath}' is a symbolic link`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    const myLock: LockData = {
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      ...(opId ? { opId } : {}),
    };
    const payload = JSON.stringify(myLock, null, 2) + '\n';

    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW;

    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, flags, 0o600);
      fs.writeSync(fd, Buffer.from(payload, 'utf8'));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      return myLock;
    } catch (err: unknown) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }

      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw err;
      }
    }

    // Lock exists: read it
    let existing: LockData | null = null;
    try {
      const content = fs.readFileSync(lockPath, 'utf8');
      existing = JSON.parse(content) as LockData;
    } catch {
      existing = null;
    }

    const currentHost = os.hostname();

    if (existing && existing.hostname && existing.hostname !== currentHost) {
      throw new ConflictError(
        `Workspace lock held on another host: ${existing.hostname} (pid ${existing.pid})`,
        [
          `The workspace is locked by process ${existing.pid} running on host '${existing.hostname}'.`,
          `WSG cannot safely take over locks across hosts. If that process is no longer running, manually remove '${lockPath}'.`,
        ]
      );
    }

    if (existing && typeof existing.pid === 'number') {
      const alive = isPidAlive(existing.pid);
      if (alive) {
        throw new ConflictError(
          `Workspace lock held by active process (pid ${existing.pid} on ${existing.hostname})`,
          [
            `Another wsg process (pid ${existing.pid}) is currently running in this workspace.`,
            `If you believe this is in error, wait for it to finish or terminate pid ${existing.pid}.`,
          ]
        );
      }

      // Dead PID on same host -> stale takeover
      const warning = `wsg: taking over stale lock from dead process (pid ${existing.pid} on ${existing.hostname})`;
      if (onWarning) {
        onWarning(warning);
      }
      process.stderr.write(`${warning}\n`);

      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr: unknown) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw unlinkErr;
        }
      }
      continue;
    }

    // Corrupted or empty lock on same host
    const warning = `wsg: taking over unreadable or empty lock file in '${wsgDir}'`;
    if (onWarning) {
      onWarning(warning);
    }
    process.stderr.write(`${warning}\n`);
    try {
      fs.unlinkSync(lockPath);
    } catch (unlinkErr: unknown) {
      if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw unlinkErr;
      }
    }
  }

  throw new ConflictError(`Unable to acquire workspace lock after ${maxAttempts} attempts`);
}

/**
 * Releases the workspace lock.
 */
export function releaseLock(dir: string): void {
  const wsgDir = resolveWsgDir(dir);
  const lockPath = path.join(wsgDir, 'lock');
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Reads the operation journal from .wsg/operation.json.
 * Returns null if file does not exist.
 */
export function readOperation(dir: string): OperationFile | null {
  const wsgDir = resolveWsgDir(dir);
  const opPath = path.join(wsgDir, 'operation.json');
  if (!fs.existsSync(opPath)) {
    return null;
  }

  let content: string;
  try {
    content = fs.readFileSync(opPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err: unknown) {
    throw new UsageError(`Failed to parse operation journal '${opPath}': ${(err as Error).message}`);
  }

  if (!data || typeof data !== 'object') {
    throw new UsageError(`Invalid operation journal in '${opPath}': expected JSON object`);
  }

  const raw = data as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new UsageError(`Unsupported operation.json version ${raw.version}`);
  }

  return {
    version: 1,
    owned:
      typeof raw.owned === 'object' && raw.owned !== null
        ? (raw.owned as Record<string, OwnedFileEntry>)
        : {},
    operation:
      typeof raw.operation === 'object' && raw.operation !== null
        ? (raw.operation as Operation)
        : null,
  };
}

/**
 * Writes the operation journal atomically to .wsg/operation.json via tmp+fsync+rename.
 */
export function writeOperation(dir: string, opFile: OperationFile): void {
  const wsgDir = initWsgDir(dir);
  const opPath = path.join(wsgDir, 'operation.json');
  const payload = JSON.stringify(opFile, null, 2) + '\n';
  writeFileAtomic(opPath, payload, { mode: 0o600 });
}

export interface MarkStepOptions {
  detail?: Record<string, unknown>;
  error?: string;
  inMemory?: OperationFile;
}

/**
 * Advances or marks a step status in the operation journal.
 * Persists to disk immediately.
 */
export function markStep(
  dir: string,
  stepId: string,
  status: StepStatus,
  options: MarkStepOptions = {}
): OperationFile {
  const opFile = options.inMemory ?? readOperation(dir);
  if (!opFile || !opFile.operation) {
    throw new UsageError(`Cannot mark step '${stepId}': no active operation found in '${dir}'`);
  }

  const step = opFile.operation.steps.find((s) => s.id === stepId);
  if (!step) {
    throw new UsageError(`Step '${stepId}' not found in operation journal`);
  }

  step.status = status;
  const now = new Date().toISOString();
  if (status === 'started' && !step.startedAt) {
    step.startedAt = now;
  }
  if (status === 'done' || status === 'failed') {
    step.completedAt = now;
  }
  if (options.detail) {
    step.detail = { ...step.detail, ...options.detail };
  }
  if (options.error) {
    step.error = options.error;
  }

  writeOperation(dir, opFile);
  return opFile;
}
