import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UsageError } from './errors.ts';

/**
 * Ensures that directory exists, creating parents as necessary.
 */
export function ensureDir(dirPath: string, mode?: number): string {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  return dirPath;
}

/**
 * Computes sha256 hex digest of a string or buffer.
 */
export function sha256(content: string | NodeJS.ArrayBufferView): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Computes sha256 hex digest of a file.
 */
export function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return sha256(data);
}

export interface WriteFileAtomicOptions {
  mode?: number;
  tmpDir?: string;
}

/**
 * Writes content atomically to filePath using tmp + fsync + rename.
 * Refuses to write through symbolic links.
 * Cleans up temp file on failure.
 */
export function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: WriteFileAtomicOptions = {}
): void {
  const resolved = path.resolve(filePath);

  // Refuse if target exists and is a symlink
  try {
    const lstat = fs.lstatSync(resolved);
    if (lstat.isSymbolicLink()) {
      throw new UsageError(`Refusing to write atomic file through symbolic link: '${filePath}'`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const targetDir = path.dirname(resolved);
  ensureDir(targetDir);

  const dirForTmp = options.tmpDir ? path.resolve(options.tmpDir) : targetDir;
  ensureDir(dirForTmp);

  const rand = crypto.randomBytes(8).toString('hex');
  const tmpPath = path.join(
    dirForTmp,
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.${rand}.tmp`
  );

  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;

  const mode = options.mode ?? 0o666;
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, flags, mode);
    if (options.mode !== undefined) {
      try {
        fs.fchmodSync(fd, options.mode);
      } catch {
        // ignore if fchmod not supported
      }
    }
    if (buffer.length > 0) {
      fs.writeSync(fd, buffer, 0, buffer.length, 0);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tmpPath, resolved);

    // Optional dir fsync on POSIX platforms
    try {
      const dirFd = fs.openSync(targetDir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Ignore if dir fsync not permitted or not supported
    }
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore
    }
    throw err;
  }
}
