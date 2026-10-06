import test from 'node:test';
import assert from 'node:assert/strict';
import { runMain } from './helpers/cli.ts';
import { ConflictError, PartialError, UsageError, WsgError } from '../src/errors.ts';
import { main, VERSION } from '../src/cli.ts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function ensureBuild(): void {
  if (!existsSync('dist/cli.js')) {
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
  }
}

test('cli --help exits 0 and lists three commands', async () => {
  const result = await runMain(['--help']);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /^\s*create\b/m);
  assert.match(result.stdout, /explain/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /refresh/);
  assert.equal(result.stderr, '');
});

test('cli -h exits 0 and lists three commands', async () => {
  const result = await runMain(['-h']);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /^\s*create\b/m);
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

test('cli --help documents the non-interactive prompt mode', async () => {
  const result = await runMain(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /-p <request>/);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /needs_input/);
});

test('cli --json without a prompt emits one safe failed JSON document and exits 1', async () => {
  const result = await runMain(['--json']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const doc = JSON.parse(result.stdout) as {
    version: number;
    status: string;
    error: { code: string; exitCode: number };
  };
  assert.equal(doc.version, 1);
  assert.equal(doc.status, 'failed');
  assert.equal(doc.error.code, 'usage');
  assert.equal(doc.error.exitCode, 1);
  assert.match(result.stderr, /requires a request/);
});

test('cli --json keeps usage errors parseable for unknown options', async () => {
  const result = await runMain(['-p', 'x', '--json', '--nope']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const doc = JSON.parse(result.stdout) as { status: string; error: { code: string } };
  assert.equal(doc.status, 'failed');
  assert.equal(doc.error.code, 'usage');
});

test('cli prompt mode missing value exits 1 with usage guidance', async () => {
  const result = await runMain(['-p']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /argument missing/);
  assert.match(result.stderr, /Usage: wsg/);
});

test('cli prompt mode rejects unexpected positionals', async () => {
  const result = await runMain(['-p', 'x', 'extra']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unexpected argument 'extra'/);
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

test('cli with no args in interactive TTY invokes tui handler', async () => {
  let tuiInvoked = false;
  let receivedOptions: unknown = null;

  const io = {
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => true },
    stderr: { isTTY: true, write: () => true },
    env: process.env,
    cwd: process.cwd(),
  };

  const handlers = {
    tui: (opts: unknown) => {
      tuiInvoked = true;
      receivedOptions = opts;
      return 0;
    },
  };

  const exitCode = await main([], io, handlers as any);
  assert.equal(exitCode, 0);
  assert.equal(tuiInvoked, true);
  assert.deepEqual(receivedOptions, { request: '' });
});

test('cli with flags but no command in interactive TTY passes parsed options to tui handler', async () => {
  let receivedOptions: any = null;

  const io = {
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => true },
    stderr: { isTTY: true, write: () => true },
    env: process.env,
    cwd: process.cwd(),
  };

  const handlers = {
    tui: (opts: any) => {
      receivedOptions = opts;
      return 0;
    },
  };

  const exitCode = await main(['--name', 'my-workspace', '--root', '/custom/root', '--dry-run'], io, handlers as any);
  assert.equal(exitCode, 0);
  assert.equal(receivedOptions?.name, 'my-workspace');
  assert.equal(receivedOptions?.root, '/custom/root');
  assert.equal(receivedOptions?.dryRun, true);
});

test('cli with flags but no command in non-TTY prints usage and exits 1', async () => {
  const result = await runMain(['--name', 'my-workspace']);
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

test('cli create exits 1 and provides actionable migration guidance', async () => {
  const result = await runMain(['create']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /'wsg create' has been removed/);
  assert.match(result.stderr, /Run 'wsg' without arguments to launch the interactive chat TUI/);
  assert.match(result.stderr, /Run 'wsg -p "<request>"'/);
  assert.equal(result.stdout, '');
});

test('cli create with request arguments exits 1 with migration guidance', async () => {
  const result = await runMain(['create', 'my task', '--name', 'test-ws']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /'wsg create' has been removed/);
  assert.match(result.stderr, /Run 'wsg' without arguments/);
  assert.equal(result.stdout, '');
});

test('cli create with unknown flag exits 1 with migration guidance', async () => {
  const result = await runMain(['create', '--definitely-invalid']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /'wsg create' has been removed/);
  assert.match(result.stderr, /Run 'wsg' without arguments/);
  assert.equal(result.stdout, '');
});

test('cli create with --json outputs failed JSON result', async () => {
  const result = await runMain(['create', 'my task', '--json']);
  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stdout) as { status: string; error?: { message: string } };
  assert.equal(parsed.status, 'failed');
  assert.match(parsed.error?.message ?? '', /'wsg create' has been removed/);
  assert.match(result.stderr, /'wsg create' has been removed/);
});

test('cli explain with unknown flag exits 1 and prints usage on stderr', async () => {
  const result = await runMain(['explain', '--definitely-invalid']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown option '--definitely-invalid'/);
  assert.match(result.stderr, /Usage: wsg/);
  assert.equal(result.stdout, '');
});

test('cli add with no input exits 1 with usage', async () => {
  const result = await runMain(['add']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /add requires at least one path or URL/);
  assert.equal(result.stdout, '');
});

test('cli refresh outside a workspace exits 1 with a hint', async () => {
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'wsg-cli-refresh-'));
  try {
    const result = await runMain(['refresh'], { cwd: emptyDir });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /No workspace\.yaml/);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('stubbed ConflictError exits 2', async () => {
  const result = await runMain(['explain'], {
    handlers: {
      explain: async () => {
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
  const result = await runMain(['explain'], {
    handlers: {
      explain: async () => {
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
  const result = await runMain(['explain'], {
    env: { WSG_DEBUG: '0' },
    handlers: {
      explain: async () => {
        throw new Error('disk read failed unexpectedly');
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /disk read failed unexpectedly/);
  assert.doesNotMatch(result.stderr, /Error: disk read failed unexpectedly\s+at /);
});

test('non-WsgError with WSG_DEBUG=1 prints stack trace', async () => {
  const result = await runMain(['explain'], {
    env: { WSG_DEBUG: '1' },
    handlers: {
      explain: async () => {
        throw new Error('crash with debug trace');
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Error: crash with debug trace/);
  assert.match(result.stderr, /at /);
});

test('cli explain with no workspace exits 1 with a hint', async () => {
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'wsg-cli-explain-'));
  try {
    const result = await runMain(['explain'], { cwd: emptyDir });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /No workspace\.yaml/);
    assert.match(result.stderr, /wsg explain --workspace/);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
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
  assert.doesNotMatch(stdout, /^\s*create\b/m);
  assert.match(stdout, /explain/);
  assert.match(stdout, /add/);
  assert.match(stdout, /refresh/);
});

