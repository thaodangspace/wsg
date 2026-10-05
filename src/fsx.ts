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
 * Lists the lowercased entry basenames directly under `dir` (files, directories,
 * and symlinks). Missing directories yield an empty set. Used to avoid
 * overwriting untracked user files when allocating new workspace paths.
 */
export function listBasenames(dir: string): Set<string> {
  const names = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return names;
    }
    throw err;
  }
  for (const entry of entries) {
    names.add(entry.name.toLowerCase());
  }
  return names;
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

export interface WriteAllSyncOptions {
  maxChunkSize?: number;
}

/**
 * Writes the entire buffer to fd in a loop to handle short writes safely.
 */
export function writeAllSync(
  fd: number,
  buffer: Uint8Array,
  options: WriteAllSyncOptions = {}
): void {
  let offset = 0;
  while (offset < buffer.length) {
    const chunkSize = options.maxChunkSize
      ? Math.min(buffer.length - offset, options.maxChunkSize)
      : buffer.length - offset;

    const written = fs.writeSync(fd, buffer, offset, chunkSize);
    if (written <= 0) {
      throw new Error(
        `writeSync returned ${written} bytes (offset ${offset} of ${buffer.length})`
      );
    }
    offset += written;
  }
}

export interface WriteFileAtomicOptions {
  mode?: number;
  tmpDir?: string;
  _maxChunkSize?: number;
}

/**
 * Writes content atomically to filePath using tmp + fsync + rename.
 * Refuses to write through symbolic links.
 * Handles short writes with a write loop.
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
      writeAllSync(fd, buffer, { maxChunkSize: options._maxChunkSize });
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
