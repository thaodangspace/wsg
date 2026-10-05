import test from 'node:test';
import assert from 'node:assert/strict';
import { runMain } from './helpers/cli.ts';
import { ConflictError, PartialError, UsageError, WsgError } from '../src/errors.ts';
import { VERSION } from '../src/cli.ts';
import { existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function ensureBuild(): void {
  if (!existsSync('dist/cli.js')) {
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
  }
}

test('cli --help exits 0 and lists four commands', async () => {
  const result = await runMain(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /create/);
  assert.match(result.stdout, /explain/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /refresh/);
  assert.equal(result.stderr, '');
});

test('cli -h exits 0 and lists four commands', async () => {
  const result = await runMain(['-h']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /create/);
  assert.match(result.stdout, /explain/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /refresh/);
  assert.equal(result.stderr, '');
});

test('cli --version exits 0 and prints package version', async () => {
  const result = await runMain(['--version']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), VERSION);
  assert.equal(result.stderr, '');
});

test('cli -v exits 0 and prints package version', async () => {
  const result = await runMain(['-v']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), VERSION);
  assert.equal(result.stderr, '');
});

test('cli with no args exits 1 and prints usage on stderr', async () => {
  const result = await runMain([]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Usage: wsg/);
  assert.equal(result.stdout, '');
});

test('cli with unknown command exits 1 and prints usage on stderr', async () => {
  const result = await runMain(['unknown-cmd']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown command 'unknown-cmd'/);
  assert.match(result.stderr, /Usage: wsg/);
  assert.equal(result.stdout, '');
});

test('cli with unknown flag exits 1 and prints usage on stderr', async () => {
  const result = await runMain(['--unknown-flag']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown option '--unknown-flag'/);
  assert.match(result.stderr, /Usage: wsg/);
  assert.equal(result.stdout, '');
});

test('cli create with unknown flag exits 1 and prints usage on stderr', async () => {
  const result = await runMain(['create', '--definitely-invalid']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown option '--definitely-invalid'/);
  assert.match(result.stderr, /Usage: wsg/);
  assert.equal(result.stdout, '');
});

test('cli explain with unknown flag exits 1 and prints usage on stderr', async () => {
  const result = await runMain(['explain', '--definitely-invalid']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown option '--definitely-invalid'/);
  assert.match(result.stderr, /Usage: wsg/);
  assert.equal(result.stdout, '');
});

test('cli add exits 1 with not implemented in this version', async () => {
  const result = await runMain(['add']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not implemented in this version/);
  assert.equal(result.stdout, '');
});

test('cli refresh exits 1 with not implemented in this version', async () => {
  const result = await runMain(['refresh']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not implemented in this version/);
  assert.equal(result.stdout, '');
});

test('stubbed ConflictError exits 2', async () => {
  const result = await runMain(['create'], {
    handlers: {
      create: async () => {
        throw new ConflictError('workspace already exists', [
          'rerun with --resume or choose a different --name',
        ]);
      },
    },
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /workspace already exists/);
  assert.match(result.stderr, /rerun with --resume or choose a different --name/);
});

test('stubbed PartialError exits 3', async () => {
  const result = await runMain(['create'], {
    handlers: {
      create: async () => {
        throw new PartialError('snapshot updated with conflict proposal .wsg-new', [
          'review and reconcile generated files',
        ]);
      },
    },
  });
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /snapshot updated with conflict proposal \.wsg-new/);
  assert.match(result.stderr, /review and reconcile generated files/);
});

test('non-WsgError exits 1', async () => {
  const result = await runMain(['create'], {
    env: { WSG_DEBUG: '0' },
    handlers: {
      create: async () => {
        throw new Error('disk read failed unexpectedly');
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /disk read failed unexpectedly/);
  assert.doesNotMatch(result.stderr, /Error: disk read failed unexpectedly\s+at /);
});

test('non-WsgError with WSG_DEBUG=1 prints stack trace', async () => {
  const result = await runMain(['create'], {
    env: { WSG_DEBUG: '1' },
    handlers: {
      create: async () => {
        throw new Error('crash with debug trace');
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Error: crash with debug trace/);
  assert.match(result.stderr, /at /);
});

test('cli create with no request exits 1 and prints usage on stderr', async () => {
  const result = await runMain(['create']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /create requires a request description/);
});

test('default explain stub exits 0', async () => {
  const result = await runMain(['explain']);
  assert.equal(result.exitCode, 0);
});

test('dist/cli.js --version prints package version in subprocess', async () => {
  ensureBuild();
  const { stdout } = await execFileAsync(process.execPath, ['dist/cli.js', '--version']);
  assert.equal(stdout.trim(), VERSION);
});

test('dist/cli.js --help prints help in subprocess', async () => {
  ensureBuild();
  const { stdout } = await execFileAsync(process.execPath, ['dist/cli.js', '--help']);
  assert.match(stdout, /Usage: wsg/);
  assert.match(stdout, /create/);
  assert.match(stdout, /explain/);
  assert.match(stdout, /add/);
  assert.match(stdout, /refresh/);
});

