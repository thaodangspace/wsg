import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
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

    // Refuses workspace directory when .wsg is a symlink
    assert.throws(() => initWsgDir(wsDir), {
      name: 'UsageError',
      message: /Refusing to initialize \.wsg directory through symbolic link/,
    });

    // Refuses explicit .wsg argument when it is a symlink
    assert.throws(() => initWsgDir(symlinkPath), {
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

test('acquireLock refuses to unlink malformed, empty, or missing-hostname lock files', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-malformed-lock-'));
  try {
    initWsgDir(wsDir);
    const lockPath = path.join(wsDir, '.wsg', 'lock');

    // Test 1: empty lock file
    fs.writeFileSync(lockPath, '', 'utf8');
    assert.throws(() => acquireLock(wsDir), {
      name: 'ConflictError',
      message: /is held or unreadable/,
    });
    // Lock file must NOT be unlinked
    assert.ok(fs.existsSync(lockPath), 'Lock file must not be deleted on empty lock');

    // Test 2: partial/invalid JSON
    fs.writeFileSync(lockPath, '{"pid": 1234, "hostname":', 'utf8');
    assert.throws(() => acquireLock(wsDir), {
      name: 'ConflictError',
      message: /is held or unreadable/,
    });
    assert.ok(fs.existsSync(lockPath), 'Lock file must not be deleted on malformed lock');

    // Test 3: missing hostname
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1234, startedAt: new Date().toISOString() }), 'utf8');
    assert.throws(() => acquireLock(wsDir), {
      name: 'ConflictError',
      message: /is held or unreadable/,
    });
    assert.ok(fs.existsSync(lockPath), 'Lock file must not be deleted on missing hostname');

    // Test 4: non-positive / invalid pid
    fs.writeFileSync(lockPath, JSON.stringify({ pid: -5, hostname: os.hostname(), startedAt: new Date().toISOString() }), 'utf8');
    assert.throws(() => acquireLock(wsDir), {
      name: 'ConflictError',
      message: /is held or unreadable/,
    });
    assert.ok(fs.existsSync(lockPath), 'Lock file must not be deleted on invalid PID');
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('isPidAlive treats only ESRCH as dead and unknown errors as alive/conflict', () => {
  // Test with injected killFn
  const fakePid = 12345;

  // ESRCH proves dead
  assert.equal(
    isPidAlive(fakePid, () => {
      const err = new Error('No such process');
      (err as NodeJS.ErrnoException).code = 'ESRCH';
      throw err;
    }),
    false
  );

  // EPERM proves alive (exists but cannot signal)
  assert.equal(
    isPidAlive(fakePid, () => {
      const err = new Error('Operation not permitted');
      (err as NodeJS.ErrnoException).code = 'EPERM';
      throw err;
    }),
    true
  );

  // Unknown error must be treated as alive
  assert.equal(
    isPidAlive(fakePid, () => {
      const err = new Error('Unknown internal error');
      (err as NodeJS.ErrnoException).code = 'EINVAL';
      throw err;
    }),
    true
  );

  // acquireLock with unknown kill error must conflict and not reclaim/unlink
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-injected-kill-'));
  try {
    initWsgDir(wsDir);
    const lockPath = path.join(wsDir, '.wsg', 'lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: fakePid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        token: 'test-token',
      }) + '\n',
      'utf8'
    );

    assert.throws(
      () =>
        acquireLock(wsDir, {
          _killFn: () => {
            const err = new Error('Random kernel error');
            (err as NodeJS.ErrnoException).code = 'EIO';
            throw err;
          },
        }),
      {
        name: 'ConflictError',
        message: /Workspace lock held by active process/,
      }
    );
    assert.ok(fs.existsSync(lockPath), 'Lock must not be unlinked on unknown process.kill error');
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('releaseLock requires exact token match and handles same-PID replacement and missing tokens', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-releaselock-'));
  try {
    initWsgDir(wsDir);
    const lockPath = path.join(wsDir, '.wsg', 'lock');

    // 1. Acquire lock normally (stores retained token in activeLocks)
    const acquired = acquireLock(wsDir, { opId: 'test-op' });
    assert.ok(acquired.token);
    assert.ok(fs.existsSync(lockPath));

    // 2. Simulate same-PID replacement on disk with a DIFFERENT token
    const replacementLock = {
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: 'different-token-' + Date.now(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(replacementLock, null, 2) + '\n', 'utf8');

    // Calling releaseLock(wsDir) must NOT unlink because token differs
    releaseLock(wsDir);
    assert.ok(fs.existsSync(lockPath), 'releaseLock must refuse to unlink same-PID replacement with different token');

    // 3. Simulate missing / stripped token on disk
    const strippedLock = {
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(strippedLock, null, 2) + '\n', 'utf8');

    // Calling releaseLock(wsDir) must NOT unlink when token is missing on disk
    releaseLock(wsDir);
    assert.ok(fs.existsSync(lockPath), 'releaseLock must refuse to unlink when token is missing on disk');

    // 4. Restore original token: releaseLock(wsDir) should now unlink matching lock
    fs.writeFileSync(lockPath, JSON.stringify(acquired, null, 2) + '\n', 'utf8');
    releaseLock(wsDir);
    assert.equal(fs.existsSync(lockPath), false, 'releaseLock with matching retained token should unlink');
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('reclaim.lock guard fails closed with actionable recovery guidance on abandoned guard, and normal takeover succeeds after manual removal', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-reclaim-guard-'));
  try {
    initWsgDir(wsDir);
    const lockPath = path.join(wsDir, '.wsg', 'lock');
    const reclaimLockPath = path.join(wsDir, '.wsg', 'reclaim.lock');

    // Create dead primary lock
    const deadChild = spawnSync('node', ['-e', 'process.exit(0)']);
    const deadPid = deadChild.pid;

    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: os.hostname(),
        startedAt: '2026-10-01T00:00:00.000Z',
        token: 'dead-token',
      }) + '\n',
      'utf8'
    );

    // Scenario A: previous reclaimer died while holding reclaim.lock (abandoned guard)
    const deadReclaimerChild = spawnSync('node', ['-e', 'process.exit(0)']);
    const deadReclaimerPid = deadReclaimerChild.pid;

    fs.writeFileSync(
      reclaimLockPath,
      JSON.stringify({
        pid: deadReclaimerPid,
        hostname: os.hostname(),
        startedAt: '2026-10-01T00:00:00.000Z',
        targetPid: deadPid,
        token: 'dead-reclaim-token',
      }) + '\n',
      'utf8'
    );

    // Must fail closed with ConflictError and actionable guidance
    assert.throws(
      () => acquireLock(wsDir, { opId: 'recovery-op' }),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.exitCode, 2);
        assert.ok(err.message.includes('reclamation guard'));
        assert.ok(err.message.includes(String(deadReclaimerPid)));
        assert.ok(err.hints.some((h) => h.includes('manually remove')));
        return true;
      }
    );

    // Guard and primary lock remain intact
    assert.ok(fs.existsSync(reclaimLockPath));
    assert.ok(fs.existsSync(lockPath));

    // Manually remove abandoned reclamation guard
    fs.unlinkSync(reclaimLockPath);

    // Subsequent acquireLock performs normal stale main-lock takeover
    const warnings: string[] = [];
    const acquired = acquireLock(wsDir, {
      opId: 'recovery-op',
      onWarning: (w) => warnings.push(w),
    });

    assert.equal(acquired.pid, process.pid);
    assert.ok(warnings.some((w) => w.includes('stale lock')));
    assert.equal(fs.existsSync(reclaimLockPath), false, 'reclaim.lock must be cleaned up');

    releaseLock(wsDir);

    // Scenario B: reclaim.lock held by a LIVE process produces actionable ConflictError
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: os.hostname(),
        startedAt: '2026-10-01T00:00:00.000Z',
        token: 'dead-token',
      }) + '\n',
      'utf8'
    );

    fs.writeFileSync(
      reclaimLockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        targetPid: deadPid,
        token: 'live-guard-token',
      }) + '\n',
      'utf8'
    );

    assert.throws(
      () => acquireLock(wsDir, { opId: 'contender' }),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.exitCode, 2);
        assert.ok(err.message.includes('reclamation guard'));
        assert.ok(err.message.includes(String(process.pid)));
        assert.ok(err.hints.some((h) => h.includes('manually remove')));
        return true;
      }
    );

    fs.unlinkSync(reclaimLockPath);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('writeFileAtomic handles short writes via writeAllSync loop with regression injection', () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-shortwrite-'));
  try {
    const target = path.join(wsDir, 'test.txt');
    // 500-byte test string
    const content = 'a'.repeat(250) + 'b'.repeat(250);

    // Inject chunk size of 7 bytes to force multiple short writes in the loop
    writeFileAtomic(target, content, { _maxChunkSize: 7 });

    const readBack = fs.readFileSync(target, 'utf8');
    assert.equal(readBack.length, 500);
    assert.equal(readBack, content);
    assert.equal(sha256(content), sha256File(target));
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('multi-process lock contention: only one contender wins and losers receive ConflictError', async () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-contention-'));
  try {
    initWsgDir(wsDir);

    const childScript = `
      import fs from 'node:fs';
      import { acquireLock, releaseLock } from './src/operation.ts';
      import { ConflictError } from './src/errors.ts';

      const wsDir = process.argv[process.argv.length - 2];
      const goFile = process.argv[process.argv.length - 1];
      // Wait for the parent's start barrier so all contenders attempt the
      // acquire at the same moment regardless of process startup jitter.
      while (!fs.existsSync(goFile)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      try {
        const lock = acquireLock(wsDir, { opId: 'child-' + process.pid });
        // Hold lock for 300ms
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        releaseLock(wsDir, lock);
        process.exit(0);
      } catch (err) {
        if (err instanceof ConflictError) {
          process.exit(2);
        }
        process.exit(1);
      }
    `;

    const goFile = path.join(os.tmpdir(), `wsg-contention-go-${process.pid}-${Date.now()}`);
    // Spawn 4 parallel child processes attempting acquireLock at the same moment
    const procs = Array.from({ length: 4 }, () =>
      spawn('node', ['--input-type=module', '-e', childScript, '--', wsDir, goFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );

    // Wait for children to be alive, then release the barrier.
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.writeFileSync(goFile, 'go');
    try {
      const exitCodes = await Promise.all(
        procs.map((p) => new Promise<number>((resolve) => p.on('exit', (code) => resolve(code ?? 1))))
      );

      const winCount = exitCodes.filter((code) => code === 0).length;
      const conflictCount = exitCodes.filter((code) => code === 2).length;

      assert.equal(winCount, 1, 'Exactly one contender must acquire the lock and exit 0');
      assert.equal(conflictCount, 3, 'All other contenders must conflict with exit code 2');
    } finally {
      fs.rmSync(goFile, { force: true });
    }
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('multi-process stale lock takeover: contenders serialize and newly acquired lock is protected', async () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-stale-contention-'));
  try {
    initWsgDir(wsDir);
    const lockPath = path.join(wsDir, '.wsg', 'lock');

    // Create dead PID lock
    const deadChild = spawnSync('node', ['-e', 'process.exit(0)']);
    const deadPid = deadChild.pid;

    const staleLock = {
      pid: deadPid,
      hostname: os.hostname(),
      startedAt: '2026-10-01T00:00:00.000Z',
      opId: 'dead-op',
      token: 'dead-token',
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock, null, 2) + '\n', 'utf8');

    const childScript = `
      import { acquireLock, releaseLock } from './src/operation.ts';
      import { ConflictError } from './src/errors.ts';

      const wsDir = process.argv[process.argv.length - 1];
      try {
        const lock = acquireLock(wsDir, { opId: 'reclaimer-' + process.pid });
        // Hold lock for 100ms
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        releaseLock(wsDir, lock);
        process.exit(0);
      } catch (err) {
        if (err instanceof ConflictError) {
          process.exit(2);
        }
        process.exit(1);
      }
    `;

    // Spawn 3 parallel processes competing to reclaim the stale lock
    const procs = Array.from({ length: 3 }, () =>
      spawn('node', ['--input-type=module', '-e', childScript, '--', wsDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );

    const exitCodes = await Promise.all(
      procs.map((p) => new Promise<number>((resolve) => p.on('exit', (code) => resolve(code ?? 1))))
    );

    const winCount = exitCodes.filter((code) => code === 0).length;
    const conflictCount = exitCodes.filter((code) => code === 2).length;

    assert.equal(winCount, 1, 'Exactly one reclaimer must successfully take over and exit 0');
    assert.equal(conflictCount, 2, 'Other contenders must observe the new live lock and conflict with code 2');
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

