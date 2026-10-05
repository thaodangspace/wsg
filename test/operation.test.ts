import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  initWsgDir,
  acquireLock,
  releaseLock,
  readOperation,
  writeOperation,
  markStep,
  isPidAlive,
  type OperationFile,
} from '../src/operation.ts';
import { writeFileAtomic, sha256, sha256File, ensureDir } from '../src/fsx.ts';
import { ConflictError, UsageError } from '../src/errors.ts';

import { canonicalize } from '../src/paths.ts';

test('initWsgDir creates .wsg with mode 0700 and .gitignore containing *', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-ws-'));
  try {
    const wsgDir = initWsgDir(wsDir);
    assert.equal(wsgDir, path.join(canonicalize(wsDir), '.wsg'));
    assert.ok(fs.existsSync(wsgDir));

    const stat = fs.statSync(wsgDir);
    assert.equal(stat.mode & 0o777, 0o700);

    const gitignorePath = path.join(wsgDir, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath));
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    assert.equal(gitignoreContent, '*\n');
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('initWsgDir refuses symlinked .wsg directory', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-sym-'));
  try {
    const wsDir = path.join(tmpRoot, 'workspace');
    const externalDir = path.join(tmpRoot, 'external-wsg');
    fs.mkdirSync(wsDir);
    fs.mkdirSync(externalDir);

    const symlinkPath = path.join(wsDir, '.wsg');
    fs.symlinkSync(externalDir, symlinkPath);

    assert.throws(() => initWsgDir(wsDir), {
      name: 'UsageError',
      message: /Refusing to initialize \.wsg directory through symbolic link/,
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('acquireLock acquires lock, second acquireLock throws ConflictError naming pid and host, releaseLock frees it', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-lock-'));
  try {
    const lock = acquireLock(wsDir, { opId: 'op-1' });
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.hostname, os.hostname());
    assert.equal(lock.opId, 'op-1');

    const lockPath = path.join(wsDir, '.wsg', 'lock');
    assert.ok(fs.existsSync(lockPath));

    // Second acquireLock while held by same live PID must throw ConflictError naming pid/host
    assert.throws(
      () => acquireLock(wsDir, { opId: 'op-2' }),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.exitCode, 2);
        assert.ok(err.message.includes(String(process.pid)));
        assert.ok(err.message.includes(os.hostname()));
        return true;
      }
    );

    // Release lock
    releaseLock(wsDir);
    assert.equal(fs.existsSync(lockPath), false);

    // Re-acquire should now succeed
    const lock2 = acquireLock(wsDir, { opId: 'op-3' });
    assert.equal(lock2.pid, process.pid);
  } finally {
    releaseLock(wsDir);
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('acquireLock on other host throws ConflictError naming other host and pid', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-otherhost-'));
  try {
    initWsgDir(wsDir);
    const lockPath = path.join(wsDir, '.wsg', 'lock');
    const foreignLock = {
      pid: 43210,
      hostname: 'remote-worker-node.corp',
      startedAt: new Date().toISOString(),
      opId: 'foreign-op',
    };
    fs.writeFileSync(lockPath, JSON.stringify(foreignLock, null, 2) + '\n', 'utf8');

    assert.throws(
      () => acquireLock(wsDir, { opId: 'local-op' }),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.exitCode, 2);
        assert.ok(err.message.includes('remote-worker-node.corp'));
        assert.ok(err.message.includes('43210'));
        return true;
      }
    );
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('acquireLock on dead pid same host takes over stale lock with warning', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-deadpid-'));
  try {
    // Spawn and immediately finish a child process to obtain a dead PID
    const child = spawnSync('node', ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    assert.ok(typeof deadPid === 'number' && deadPid > 0);
    assert.equal(isPidAlive(deadPid), false);

    initWsgDir(wsDir);
    const lockPath = path.join(wsDir, '.wsg', 'lock');
    const staleLock = {
      pid: deadPid,
      hostname: os.hostname(),
      startedAt: '2026-10-01T00:00:00.000Z',
      opId: 'dead-op',
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock, null, 2) + '\n', 'utf8');

    const warnings: string[] = [];
    const acquired = acquireLock(wsDir, {
      opId: 'new-op',
      onWarning: (msg) => warnings.push(msg),
    });

    assert.equal(acquired.pid, process.pid);
    assert.equal(acquired.opId, 'new-op');

    // Warning emitted
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('taking over stale lock'));
    assert.ok(warnings[0].includes(String(deadPid)));
    assert.ok(warnings[0].includes(os.hostname()));

    // Lock file on disk now reflects current process
    const currentOnDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(currentOnDisk.pid, process.pid);
    assert.equal(currentOnDisk.opId, 'new-op');
  } finally {
    releaseLock(wsDir);
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('journal round-trip and markStep advances step and persists immediately', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-journal-'));
  try {
    // Absent journal returns null
    assert.equal(readOperation(wsDir), null);

    const initialOpFile: OperationFile = {
      version: 1,
      owned: {
        'docs/context.md': {
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          generatedAt: '2026-10-05T12:00:00.000Z',
        },
      },
      operation: {
        id: 'op-42',
        command: 'create',
        status: 'running',
        startedAt: '2026-10-05T12:00:00.000Z',
        args: { name: 'my-ws' },
        steps: [
          {
            id: 'worktree:app',
            type: 'worktree',
            status: 'planned',
          },
          {
            id: 'generate:context',
            type: 'generate',
            status: 'planned',
          },
        ],
      },
    };

    // Write and read round-trip
    writeOperation(wsDir, initialOpFile);
    const roundTrip = readOperation(wsDir);
    assert.deepEqual(roundTrip, initialOpFile);

    // markStep: advance step to started
    markStep(wsDir, 'worktree:app', 'started', {
      detail: { source: '/path/to/src', branch: 'wsg/my-ws/app' },
    });

    const afterStart = readOperation(wsDir);
    assert.ok(afterStart && afterStart.operation);
    const step1 = afterStart.operation.steps.find((s) => s.id === 'worktree:app');
    assert.ok(step1);
    assert.equal(step1.status, 'started');
    assert.ok(step1.startedAt);
    assert.equal(step1.detail?.branch, 'wsg/my-ws/app');

    // markStep: advance step to done
    markStep(wsDir, 'worktree:app', 'done');
    const afterDone = readOperation(wsDir);
    const step1Done = afterDone?.operation?.steps.find((s) => s.id === 'worktree:app');
    assert.ok(step1Done);
    assert.equal(step1Done.status, 'done');
    assert.ok(step1Done.completedAt);

    // markStep on unknown step throws UsageError
    assert.throws(() => markStep(wsDir, 'nonexistent-step', 'started'), {
      name: 'UsageError',
      message: /Step 'nonexistent-step' not found in operation journal/,
    });
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('writeFileAtomic writes atomically, fsyncs, renames, and leaves no *.tmp files', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-atomic-'));
  try {
    const targetFile = path.join(wsDir, 'sub', 'file.txt');
    const content = 'atomic hello world\n';
    writeFileAtomic(targetFile, content);

    assert.equal(fs.readFileSync(targetFile, 'utf8'), content);
    assert.equal(sha256(content), sha256File(targetFile));

    // Refuses symlinks
    const symlinkTarget = path.join(wsDir, 'symlink-target.txt');
    fs.writeFileSync(symlinkTarget, 'target content');
    const symlinkPath = path.join(wsDir, 'symlink.txt');
    fs.symlinkSync(symlinkTarget, symlinkPath);

    assert.throws(() => writeFileAtomic(symlinkPath, 'overwrite'), {
      name: 'UsageError',
      message: /Refusing to write atomic file through symbolic link/,
    });

    // Check no *.tmp files exist in wsDir or its subdirectories
    function findTmpFiles(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findTmpFiles(full));
        } else if (entry.name.endsWith('.tmp')) {
          results.push(full);
        }
      }
      return results;
    }

    const tmpFiles = findTmpFiles(wsDir);
    assert.deepEqual(tmpFiles, []);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('no *.tmp left after operation journal writes and lock operations', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-tmpclean-'));
  try {
    initWsgDir(wsDir);
    acquireLock(wsDir, { opId: 'clean-test' });

    const opFile: OperationFile = {
      version: 1,
      owned: {},
      operation: {
        id: 'clean-test',
        command: 'create',
        status: 'running',
        startedAt: new Date().toISOString(),
        steps: [{ id: 'step-1', type: 'generate', status: 'planned' }],
      },
    };

    writeOperation(wsDir, opFile);
    markStep(wsDir, 'step-1', 'started');
    markStep(wsDir, 'step-1', 'done');

    releaseLock(wsDir);

    function findTmpFiles(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findTmpFiles(full));
        } else if (entry.name.endsWith('.tmp')) {
          results.push(full);
        }
      }
      return results;
    }

    const wsgDir = path.join(wsDir, '.wsg');
    const remainingTmps = findTmpFiles(wsgDir);
    assert.deepEqual(remainingTmps, []);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});
