import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConflictError, UsageError } from './errors.ts';
import { ensureDir, writeFileAtomic, writeAllSync } from './fsx.ts';
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
  token?: string;
}

export interface AcquireLockOptions {
  opId?: string;
  onWarning?: (msg: string) => void;
}

export function isPidAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
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

/**
 * Resolves the .wsg directory while checking and refusing symlinks
 * BEFORE calling realpath / canonicalize.
 */
export function resolveWsgDir(dir: string): string {
  const resolvedInput = path.resolve(dir);

  let wsDir: string;
  let wsgDir: string;

  if (path.basename(resolvedInput) === '.wsg') {
    wsgDir = resolvedInput;
    wsDir = path.dirname(resolvedInput);
  } else {
    wsDir = resolvedInput;
    wsgDir = path.join(resolvedInput, '.wsg');
  }

  // Refuse if wsgDir itself is a symbolic link before realpath
  try {
    const lstat = fs.lstatSync(wsgDir);
    if (lstat.isSymbolicLink()) {
      throw new UsageError(`Refusing to initialize .wsg directory through symbolic link: '${wsgDir}'`);
    }
  } catch (err: unknown) {
    if (err instanceof UsageError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // Canonicalize workspace directory
  const canonicalWs = canonicalize(wsDir);
  const canonicalWsg = path.join(canonicalWs, '.wsg');

  // Verify canonical .wsg is not a symlink either
  try {
    const lstat = fs.lstatSync(canonicalWsg);
    if (lstat.isSymbolicLink()) {
      throw new UsageError(`Refusing to initialize .wsg directory through symbolic link: '${canonicalWsg}'`);
    }
  } catch (err: unknown) {
    if (err instanceof UsageError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  return canonicalWsg;
}

/**
 * Initializes the .wsg directory:
 * - mode 0700 (verifies and does not silently ignore chmod failure)
 * - creates .gitignore containing *
 * - refuses symlinks before realpath
 */
export function initWsgDir(dir: string): string {
  const wsgDir = resolveWsgDir(dir);

  ensureDir(wsgDir, 0o700);

  try {
    fs.chmodSync(wsgDir, 0o700);
  } catch (err: unknown) {
    throw new UsageError(
      `Failed to set required 0700 permissions on '${wsgDir}': ${(err as Error).message}`
    );
  }

  const stat = fs.statSync(wsgDir);
  if ((stat.mode & 0o777) !== 0o700) {
    throw new UsageError(
      `Directory '${wsgDir}' does not have required 0700 permissions (got ${(stat.mode & 0o777).toString(8)})`
    );
  }

  const gitignorePath = path.join(wsgDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    writeFileAtomic(gitignorePath, '*\n', { mode: 0o644 });
  }

  return wsgDir;
}

function parseValidLockData(content: string): LockData | null {
  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') return null;

    const raw = data as Record<string, unknown>;
    const pid = raw.pid;
    const hostname = raw.hostname;
    const startedAt = raw.startedAt;
    const opId = raw.opId;
    const token = raw.token;

    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    if (typeof hostname !== 'string' || hostname.trim().length === 0) {
      return null;
    }
    if (typeof startedAt !== 'string' || startedAt.trim().length === 0) {
      return null;
    }

    return {
      pid,
      hostname,
      startedAt,
      ...(typeof opId === 'string' ? { opId } : {}),
      ...(typeof token === 'string' ? { token } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Acquires exclusive workspace lock using O_EXCL.
 * Only reclaims a well-formed lock with matching local hostname and demonstrably dead positive integer PID.
 * Malformed, partial, hostname-missing, or unknown process state conflicts without unlinking.
 * Serializes stale reclamation via reclaim.lock and verifies ownership before atomic replacement.
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
  const reclaimLockPath = path.join(wsgDir, 'reclaim.lock');

  const maxAttempts = 10;
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

    const token = crypto.randomBytes(16).toString('hex');
    const myLock: LockData = {
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token,
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
      writeAllSync(fd, Buffer.from(payload, 'utf8'));
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

    // Lock file exists: read it carefully
    // Give a concurrent writer a few microsecond turns in case it just opened the file
    let existingContent = '';
    let parsed: LockData | null = null;
    for (let readAttempt = 0; readAttempt < 5; readAttempt++) {
      try {
        existingContent = fs.readFileSync(lockPath, 'utf8');
        parsed = parseValidLockData(existingContent);
        if (parsed !== null) {
          break;
        }
      } catch (readErr: unknown) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
          // Lock disappeared concurrently, retry acquisition
          break;
        }
      }
      // Small sync sleep: 10ms
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }

    if (!parsed) {
      // Still malformed, partial, or missing fields: must conflict without unlinking
      throw new ConflictError(
        `Workspace lock file '${lockPath}' is held or unreadable (cannot safely verify holder without conflict risk)`,
        [
          `A lock file exists but does not contain a verified process record.`,
          `This may indicate another process is starting or was terminated abnormally.`,
          `WSG will not unlink unverified lock files. Remove '${lockPath}' manually if no process is running.`,
        ]
      );
    }

    const currentHost = os.hostname();
    if (parsed.hostname !== currentHost) {
      throw new ConflictError(
        `Workspace lock held on another host: ${parsed.hostname} (pid ${parsed.pid})`,
        [
          `The workspace is locked by process ${parsed.pid} running on host '${parsed.hostname}'.`,
          `WSG cannot safely take over locks across hosts. If that process is no longer running, manually remove '${lockPath}'.`,
        ]
      );
    }

    // On same host: check if PID is alive
    const alive = isPidAlive(parsed.pid);
    if (alive) {
      throw new ConflictError(
        `Workspace lock held by active process (pid ${parsed.pid} on ${parsed.hostname})`,
        [
          `Another wsg process (pid ${parsed.pid}) is currently running in this workspace.`,
          `If you believe this is in error, wait for it to finish or terminate pid ${parsed.pid}.`,
        ]
      );
    }

    // Demonstrably dead positive integer PID on same local host:
    // Serialize stale reclaimers via reclaim.lock to avoid races
    let reclaimFd: number | null = null;
    try {
      reclaimFd = fs.openSync(reclaimLockPath, flags, 0o600);
    } catch (reclaimErr: unknown) {
      const recCode = (reclaimErr as NodeJS.ErrnoException).code;
      if (recCode === 'EEXIST') {
        // Another process is currently reclaiming, back off and retry
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      throw reclaimErr;
    }

    try {
      // Protected by reclaim.lock: re-read lockPath and verify ownership before mutation
      let verifyContent = '';
      try {
        verifyContent = fs.readFileSync(lockPath, 'utf8');
      } catch {
        // lock vanished
        verifyContent = '';
      }
      const verified = parseValidLockData(verifyContent);

      if (
        !verified ||
        verified.pid !== parsed.pid ||
        verified.hostname !== parsed.hostname ||
        verified.startedAt !== parsed.startedAt ||
        verified.token !== parsed.token
      ) {
        // Lock changed while we were acquiring reclaim.lock! Back off and re-evaluate
        continue;
      }

      // Still the exact dead PID: take over
      const warning = `wsg: taking over stale lock from dead process (pid ${parsed.pid} on ${parsed.hostname})`;
      if (onWarning) {
        onWarning(warning);
      }
      process.stderr.write(`${warning}\n`);

      // Atomically replace lockPath using tmp file in same directory + rename
      const tempRand = crypto.randomBytes(8).toString('hex');
      const tempLockPath = path.join(
        wsgDir,
        `.lock.${process.pid}.${Date.now()}.${tempRand}.tmp`
      );

      const tfd = fs.openSync(tempLockPath, flags, 0o600);
      writeAllSync(tfd, Buffer.from(payload, 'utf8'));
      fs.fsyncSync(tfd);
      fs.closeSync(tfd);

      fs.renameSync(tempLockPath, lockPath);
      return myLock;
    } finally {
      if (reclaimFd !== null) {
        try {
          fs.closeSync(reclaimFd);
        } catch {
          // ignore
        }
      }
      try {
        if (fs.existsSync(reclaimLockPath)) {
          fs.unlinkSync(reclaimLockPath);
        }
      } catch {
        // ignore
      }
    }
  }

  throw new ConflictError(`Unable to acquire workspace lock after ${maxAttempts} attempts`);
}

/**
 * Releases the workspace lock only if it matches our own acquisition.
 */
export function releaseLock(
  dir: string,
  expectedLock?: LockData | { pid?: number; hostname?: string; token?: string }
): void {
  const wsgDir = resolveWsgDir(dir);
  const lockPath = path.join(wsgDir, 'lock');

  try {
    if (!fs.existsSync(lockPath)) {
      return;
    }

    const content = fs.readFileSync(lockPath, 'utf8');
    const current = parseValidLockData(content);

    // Verify ownership before unlinking
    const expectedPid = expectedLock?.pid ?? process.pid;
    const expectedHost = expectedLock?.hostname ?? os.hostname();

    if (current?.pid !== expectedPid || current?.hostname !== expectedHost) {
      // Does not belong to this process, refuse to unlink
      return;
    }

    if (expectedLock?.token && current?.token && current.token !== expectedLock.token) {
      // Token mismatch, refuse to unlink
      return;
    }

    fs.unlinkSync(lockPath);
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
