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

export interface ReclaimGuardData {
  pid: number;
  hostname: string;
  startedAt: string;
  targetPid: number;
  token: string;
}

export interface AcquireLockOptions {
  opId?: string;
  onWarning?: (msg: string) => void;
  _killFn?: (pid: number, signal: number | string) => boolean | void;
}

// Module-level retained acquisition tokens for backward-compatible releaseLock(dir)
const activeLocks = new Map<string, LockData>();

/**
 * Checks whether a process PID is alive.
 * Only ESRCH proves dead; EPERM or any unknown error is treated as alive/unknown.
 */
export function isPidAlive(
  pid: number,
  killFn: (pid: number, signal: number | string) => boolean | void = process.kill
): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    killFn(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    // EPERM or any unknown error must be treated as alive / not demonstrably dead
    return true;
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

export function parseValidLockData(content: string): LockData | null {
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

function parseValidReclaimGuard(content: string): ReclaimGuardData | null {
  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') return null;

    const raw = data as Record<string, unknown>;
    const pid = raw.pid;
    const hostname = raw.hostname;
    const startedAt = raw.startedAt;
    const targetPid = raw.targetPid;
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
    if (typeof targetPid !== 'number' || !Number.isInteger(targetPid) || targetPid <= 0) {
      return null;
    }
    if (typeof token !== 'string' || token.trim().length === 0) {
      return null;
    }

    return {
      pid,
      hostname,
      startedAt,
      targetPid,
      token,
    };
  } catch {
    return null;
  }
}

/**
 * Acquires exclusive workspace lock using O_EXCL.
 * Only reclaims a well-formed lock with matching local hostname and demonstrably dead positive integer PID.
 * Malformed, partial, hostname-missing, or unknown process state conflicts without unlinking.
 * Serializes stale reclamation via recoverable reclaim.lock guard and verifies ownership before atomic replacement.
 */
export function acquireLock(
  dir: string,
  optionsOrOpId?: AcquireLockOptions | string,
  legacyOnWarning?: (msg: string) => void
): LockData {
  let opId: string | undefined;
  let onWarning: ((msg: string) => void) | undefined;
  let killFn: ((pid: number, signal: number | string) => boolean | void) | undefined;

  if (typeof optionsOrOpId === 'string') {
    opId = optionsOrOpId;
    onWarning = legacyOnWarning;
  } else if (optionsOrOpId && typeof optionsOrOpId === 'object') {
    opId = optionsOrOpId.opId;
    onWarning = optionsOrOpId.onWarning ?? legacyOnWarning;
    killFn = optionsOrOpId._killFn;
  }

  const wsgDir = initWsgDir(dir);
  const lockPath = path.join(wsgDir, 'lock');
  const reclaimLockPath = path.join(wsgDir, 'reclaim.lock');

  const maxAttempts = 15;
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
      activeLocks.set(wsgDir, myLock);
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
          break;
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }

    if (!parsed) {
      // Malformed, partial, or missing fields: must conflict without unlinking
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

    // On same host: check if PID is alive (only ESRCH proves dead)
    const alive = isPidAlive(parsed.pid, killFn);
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
    // Serialize stale reclaimers via recoverable reclaim.lock guard
    let reclaimFd: number | null = null;
    let guardAcquired = false;

    const guardToken = crypto.randomBytes(16).toString('hex');
    const guardPayload =
      JSON.stringify(
        {
          pid: process.pid,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
          targetPid: parsed.pid,
          token: guardToken,
        },
        null,
        2
      ) + '\n';

    try {
      reclaimFd = fs.openSync(reclaimLockPath, flags, 0o600);
      writeAllSync(reclaimFd, Buffer.from(guardPayload, 'utf8'));
      fs.fsyncSync(reclaimFd);
      fs.closeSync(reclaimFd);
      reclaimFd = null;
      guardAcquired = true;
    } catch (reclaimErr: unknown) {
      if (reclaimFd !== null) {
        try {
          fs.closeSync(reclaimFd);
        } catch {}
        reclaimFd = null;
      }

      const recCode = (reclaimErr as NodeJS.ErrnoException).code;
      if (recCode !== 'EEXIST') {
        throw reclaimErr;
      }

      // reclaim.lock exists: read holder info for diagnostic/guidance purposes
      let existingGuardContent = '';
      try {
        existingGuardContent = fs.readFileSync(reclaimLockPath, 'utf8');
      } catch {
        existingGuardContent = '';
      }
      const existingGuard = parseValidReclaimGuard(existingGuardContent);

      // If an active process holds the guard, back off briefly to allow it to finish
      if (existingGuard && isPidAlive(existingGuard.pid, killFn)) {
        if (attempt < maxAttempts - 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          continue;
        }
        throw new ConflictError(
          `Workspace reclamation guard '${reclaimLockPath}' is held by active process (pid ${existingGuard.pid} on ${existingGuard.hostname})`,
          [
            `A lock reclamation is currently underway by process ${existingGuard.pid} on host '${existingGuard.hostname}'.`,
            `Wait for it to finish, or manually remove '${reclaimLockPath}' if that process is no longer running.`,
          ]
        );
      }

      // If held by a dead process, unknown process, or unverified guard:
      // Fail closed immediately without unlinking or overwriting to prevent reclaimer races!
      if (existingGuard) {
        throw new ConflictError(
          `Workspace reclamation guard '${reclaimLockPath}' is held by process ${existingGuard.pid} on ${existingGuard.hostname}`,
          [
            `A previous lock reclamation was attempted by process ${existingGuard.pid} on host '${existingGuard.hostname}'.`,
            `To prevent concurrent reclaimer races, WSG does not automatically overwrite an abandoned reclamation guard.`,
            `Verify no other wsg processes are running, then manually remove '${reclaimLockPath}' to proceed.`,
          ]
        );
      }

      throw new ConflictError(
        `Workspace reclamation guard '${reclaimLockPath}' exists and is unverified`,
        [
          `An unverified reclamation guard file exists at '${reclaimLockPath}'.`,
          `To prevent concurrent reclaimer races, WSG does not automatically overwrite an abandoned reclamation guard.`,
          `Verify no other wsg processes are running, then manually remove '${reclaimLockPath}' to proceed.`,
        ]
      );
    }

    if (!guardAcquired) {
      continue;
    }

    // Protected by reclaim.lock: re-read lockPath and verify ownership before mutation
    const tempRand = crypto.randomBytes(8).toString('hex');
    const tempLockPath = path.join(
      wsgDir,
      `.lock.${process.pid}.${Date.now()}.${tempRand}.tmp`
    );
    let tfd: number | null = null;

    try {
      let verifyContent = '';
      try {
        verifyContent = fs.readFileSync(lockPath, 'utf8');
      } catch {
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
        // Lock changed while we were acquiring guard! Back off and re-evaluate
        continue;
      }

      // Still the exact dead PID: take over
      const warning = `wsg: taking over stale lock from dead process (pid ${parsed.pid} on ${parsed.hostname})`;
      if (onWarning) {
        onWarning(warning);
      }
      process.stderr.write(`${warning}\n`);

      // Atomically replace lockPath using tmp file in same directory + rename
      tfd = fs.openSync(tempLockPath, flags, 0o600);
      writeAllSync(tfd, Buffer.from(payload, 'utf8'));
      fs.fsyncSync(tfd);
      fs.closeSync(tfd);
      tfd = null;

      fs.renameSync(tempLockPath, lockPath);
      activeLocks.set(wsgDir, myLock);
      return myLock;
    } finally {
      if (tfd !== null) {
        try {
          fs.closeSync(tfd);
        } catch {}
      }
      try {
        if (fs.existsSync(tempLockPath)) {
          fs.unlinkSync(tempLockPath);
        }
      } catch {}

      try {
        // Check if reclaim.lock still belongs to our guard before unlinking
        const rc = fs.readFileSync(reclaimLockPath, 'utf8');
        const rParsed = parseValidReclaimGuard(rc);
        if (rParsed?.token === guardToken) {
          fs.unlinkSync(reclaimLockPath);
        }
      } catch {}
    }
  }

  throw new ConflictError(`Unable to acquire workspace lock after ${maxAttempts} attempts`);
}

/**
 * Releases the workspace lock only if it matches our exact acquisition token.
 * Retains acquired tokens locally if releaseLock(dir) is called without arguments.
 * Never unlinks an unverified replacement or mismatched lock.
 */
export function releaseLock(
  dir: string,
  expectedLock?: LockData | { pid?: number; hostname?: string; token?: string }
): void {
  const wsgDir = resolveWsgDir(dir);
  const lockPath = path.join(wsgDir, 'lock');

  try {
    if (!fs.existsSync(lockPath)) {
      activeLocks.delete(wsgDir);
      return;
    }

    const content = fs.readFileSync(lockPath, 'utf8');
    const current = parseValidLockData(content);
    if (!current || !current.token) {
      // Malformed lock or missing token: never unlink an unverified lock
      return;
    }

    // Determine expected token
    const expected = expectedLock ?? activeLocks.get(wsgDir);
    if (!expected || !expected.token) {
      // No retained acquisition token and no valid expected token: refuse to unlink
      return;
    }

    const expectedPid = expected.pid ?? process.pid;
    const expectedHost = expected.hostname ?? os.hostname();

    // Require EXACT token match, exact PID match, and exact hostname match
    if (
      current.token !== expected.token ||
      current.pid !== expectedPid ||
      current.hostname !== expectedHost
    ) {
      // Token or ownership mismatch (e.g. same-PID replacement, foreign lock)
      return;
    }

    fs.unlinkSync(lockPath);
    activeLocks.delete(wsgDir);
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
