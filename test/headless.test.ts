import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestRepo } from './helpers/git-fixture.ts';
import { runGit } from '../src/git.ts';

/**
 * Phase 3: non-interactive `-p` / `--json` contract.
 *
 * These are true CLI integration tests: the child is spawned with stdin
 * explicitly closed (`stdio: ['ignore', 'pipe', 'pipe']`), so a passing run
 * proves headless execution never reads stdin and needs no TTY.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
const NO_CONFIG_PATH = path.join(
  os.tmpdir(),
  `wsg-headless-noconfig-${process.pid}.yaml`
);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: { env?: Record<string, string | undefined>; cwd?: string } = {}
): CliResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      WSG_CONFIG: NO_CONFIG_PATH,
      ...options.env,
    },
    encoding: 'utf8',
    // stdin: ignore => closed. stdout/stderr piped so we can assert exact bytes.
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface JsonDoc {
  version: number;
  status: string;
  [key: string]: unknown;
}

/**
 * Asserts stdout is exactly one newline-terminated JSON document with no ANSI
 * escapes or stray progress lines, then parses and returns it.
 */
function parseSingleJson(stdout: string): JsonDoc {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, '', 'stdout must contain a JSON document');
  assert.equal(
    trimmed.split('\n').length,
    1,
    `stdout must be exactly one line of JSON: ${JSON.stringify(stdout)}`
  );
  assert.doesNotMatch(stdout, /\u001b\[/, 'stdout must not contain ANSI escapes');
  const doc = JSON.parse(trimmed) as JsonDoc;
  assert.equal(doc.version, 1, 'JSON result must be versioned');
  return doc;
}

test('headless -p --json creates a workspace with closed stdin and one JSON document', () => {
  const repo = createTestRepo({ prefix: 'wsg-hl-created-' });
  const root = mkTmp('wsg-hl-created-root-');
  const name = 'hl-created';
  const wsDir = path.join(root, name);

  try {
    const result = runCli([
      '-p',
      'create a clear workspace',
      '--name',
      name,
      '--root',
      root,
      '--repo',
      repo.dir,
      '--json',
    ]);

    assert.equal(result.status, 0, `expected exit 0: ${result.stderr}`);
    const doc = parseSingleJson(result.stdout);
    assert.equal(doc.status, 'created');
    assert.equal(doc.name, name);
    assert.equal(doc.wsDir, wsDir);
    assert.equal(doc.resumed, false);
    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless -p --dry-run --json reports planned with a plan summary and no workspace', () => {
  const repo = createTestRepo({ prefix: 'wsg-hl-planned-' });
  const root = mkTmp('wsg-hl-planned-root-');
  const name = 'hl-planned';
  const wsDir = path.join(root, name);

  try {
    const result = runCli([
      '-p',
      'plan this workspace',
      '--name',
      name,
      '--root',
      root,
      '--repo',
      repo.dir,
      '--dry-run',
      '--json',
    ]);

    assert.equal(result.status, 0, `expected exit 0: ${result.stderr}`);
    const doc = parseSingleJson(result.stdout);
    assert.equal(doc.status, 'planned');
    assert.equal(doc.name, name);
    assert.equal(doc.resumed, false);
    const plan = doc.plan as { name: string; repos: unknown[] } | undefined;
    assert.ok(plan, 'planned result must include a plan summary');
    assert.equal(plan?.name, name);
    assert.equal(plan?.repos.length, 1);
    assert.equal(fs.existsSync(wsDir), false, 'dry-run must not create a workspace');
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless -p --json returns needs_input with exit 4 and no workspace', () => {
  const root = mkTmp('wsg-hl-needs-root-');
  const empty = mkTmp('wsg-hl-needs-empty-');
  const name = 'hl-needs';
  const wsDir = path.join(root, name);

  try {
    const result = runCli([
      '-p',
      'an under-specified request',
      '--name',
      name,
      '--root',
      root,
      '--code-root',
      empty,
      '--json',
    ]);

    assert.equal(result.status, 4, `expected exit 4: ${result.stderr}`);
    const doc = parseSingleJson(result.stdout);
    assert.equal(doc.status, 'needs_input');
    assert.match(String(doc.reason), /No git repositories found/);
    const questions = doc.questions as Array<{ id: string; question: string }>;
    assert.ok(Array.isArray(questions) && questions.length > 0, 'must carry questions');
    assert.equal(fs.existsSync(wsDir), false, 'needs_input must not create a workspace');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless --json returns a safe failed record for usage errors', () => {
  // Blank prompt.
  const blank = runCli(['-p', '', '--json']);
  assert.equal(blank.status, 1);
  const blankDoc = parseSingleJson(blank.stdout);
  assert.equal(blankDoc.status, 'failed');
  const blankError = blankDoc.error as { code: string; exitCode: number };
  assert.equal(blankError.code, 'usage');
  assert.equal(blankError.exitCode, 1);

  // --json with no prompt at all.
  const missing = runCli(['--json']);
  assert.equal(missing.status, 1);
  const missingDoc = parseSingleJson(missing.stdout);
  assert.equal(missingDoc.status, 'failed');
  assert.equal((missingDoc.error as { code: string }).code, 'usage');

  // Unknown option while --json was requested.
  const unknown = runCli(['-p', 'x', '--json', '--bogus-option']);
  assert.equal(unknown.status, 1);
  const unknownDoc = parseSingleJson(unknown.stdout);
  assert.equal(unknownDoc.status, 'failed');
  assert.equal((unknownDoc.error as { code: string }).code, 'usage');

  // Missing value for -p while --json was requested.
  const missingValue = runCli(['--json', '-p']);
  assert.equal(missingValue.status, 1);
  const missingValueDoc = parseSingleJson(missingValue.stdout);
  assert.equal(missingValueDoc.status, 'failed');
  assert.equal((missingValueDoc.error as { code: string }).code, 'usage');
});

test('headless --json returns a safe conflict record with exit 2 and no overwrite', () => {
  const repo = createTestRepo({ prefix: 'wsg-hl-conflict-' });
  const root = mkTmp('wsg-hl-conflict-root-');
  const name = 'hl-conflict';
  const branch = `wsg/${name}/${path.basename(repo.dir)}`;
  runGit(['-C', repo.dir, 'branch', branch, repo.headCommit]);

  try {
    const result = runCli([
      '-p',
      'conflicting workspace',
      '--name',
      name,
      '--root',
      root,
      '--repo',
      repo.dir,
      '--json',
    ]);

    assert.equal(result.status, 2, `expected exit 2: ${result.stderr}`);
    const doc = parseSingleJson(result.stdout);
    assert.equal(doc.status, 'failed');
    const error = doc.error as { code: string; exitCode: number; message: string };
    assert.equal(error.code, 'conflict');
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /already exists/);
    assert.equal(fs.existsSync(path.join(root, name)), false);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless --json returns a safe failed record for infrastructure errors', () => {
  const root = mkTmp('wsg-hl-bad-root-');
  const notARepo = mkTmp('wsg-hl-notrepo-');

  try {
    const result = runCli([
      '-p',
      'invalid repository',
      '--name',
      'hl-bad',
      '--root',
      root,
      '--repo',
      notARepo,
      '--json',
    ]);

    assert.equal(result.status, 1, `expected exit 1: ${result.stderr}`);
    const doc = parseSingleJson(result.stdout);
    assert.equal(doc.status, 'failed');
    const error = doc.error as { code: string; exitCode: number; message: string };
    assert.equal(error.code, 'usage');
    assert.match(error.message, /not a git repository/);
    assert.equal(fs.existsSync(path.join(root, 'hl-bad')), false);
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless --resume --json completes an interrupted workspace', () => {
  const repo = createTestRepo({ prefix: 'wsg-hl-resume-' });
  const root = mkTmp('wsg-hl-resume-root-');
  const name = 'hl-resume';
  const wsDir = path.join(root, name);

  try {
    const interrupted = runCli(
      [
        '-p',
        'resume this workspace',
        '--name',
        name,
        '--root',
        root,
        '--repo',
        repo.dir,
        '--json',
      ],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(interrupted.status, 70, `expected injected fault 70: ${interrupted.stderr}`);
    assert.equal(fs.existsSync(path.join(wsDir, 'workspace.yaml')), false);

    const resumed = runCli([
      '-p',
      'resume this workspace',
      '--name',
      name,
      '--root',
      root,
      '--repo',
      repo.dir,
      '--resume',
      '--json',
    ]);

    assert.equal(resumed.status, 0, `expected resume exit 0: ${resumed.stderr}`);
    const doc = parseSingleJson(resumed.stdout);
    assert.equal(doc.status, 'created');
    assert.equal(doc.resumed, true);
    assert.equal(doc.name, name);
    assert.ok(fs.existsSync(path.join(wsDir, 'workspace.yaml')));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless --resume --dry-run --json reports planned without completing the workspace', () => {
  const repo = createTestRepo({ prefix: 'wsg-hl-rd-' });
  const root = mkTmp('wsg-hl-rd-root-');
  const name = 'hl-rd';
  const wsDir = path.join(root, name);

  try {
    const interrupted = runCli(
      ['-p', 'resume dry run', '--name', name, '--root', root, '--repo', repo.dir, '--json'],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(interrupted.status, 70, `expected injected fault 70: ${interrupted.stderr}`);

    const planned = runCli([
      '-p',
      'resume dry run',
      '--name',
      name,
      '--root',
      root,
      '--repo',
      repo.dir,
      '--resume',
      '--dry-run',
      '--json',
    ]);

    assert.equal(planned.status, 0, `expected exit 0: ${planned.stderr}`);
    const doc = parseSingleJson(planned.stdout);
    assert.equal(doc.status, 'planned');
    assert.equal(doc.resumed, true);
    assert.equal(fs.existsSync(path.join(wsDir, 'workspace.yaml')), false);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless human mode prints progress on stderr and the result on stdout', () => {
  const repo = createTestRepo({ prefix: 'wsg-hl-human-' });
  const root = mkTmp('wsg-hl-human-root-');
  const name = 'hl-human';

  try {
    const result = runCli([
      '-p',
      'create a clear workspace',
      '--name',
      name,
      '--root',
      root,
      '--repo',
      repo.dir,
    ]);

    assert.equal(result.status, 0, `expected exit 0: ${result.stderr}`);
    assert.match(result.stdout, /Workspace created at/);
    assert.doesNotMatch(result.stdout, /\u001b\[/, 'stdout must not contain ANSI escapes');
    assert.match(result.stderr, /wsg: \[assembly\]/, 'progress must be on stderr');
    assert.match(result.stderr, /wsg: \[completion\]/);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless human needs_input exits 4 with questions on stderr and empty stdout', () => {
  const root = mkTmp('wsg-hl-human-needs-root-');
  const empty = mkTmp('wsg-hl-human-needs-empty-');

  try {
    const result = runCli([
      '-p',
      'under-specified',
      '--name',
      'hl-human-needs',
      '--root',
      root,
      '--code-root',
      empty,
    ]);

    assert.equal(result.status, 4, `expected exit 4: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /more information needed/);
    assert.match(result.stderr, /No git repositories found/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless option parsing is strict and reports missing values without a prompt', () => {
  const missingValue = runCli(['-p']);
  assert.equal(missingValue.status, 1);
  assert.equal(missingValue.stdout, '');
  assert.match(missingValue.stderr, /argument missing/);
  assert.match(missingValue.stderr, /Usage: wsg/);

  const unknown = runCli(['-p', 'x', '--definitely-unknown']);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /Unknown option '--definitely-unknown'/);

  const extra = runCli(['-p', 'x', 'extra-positional']);
  assert.equal(extra.status, 1);
  assert.equal(extra.stdout, '');
  assert.match(extra.stderr, /Unexpected argument 'extra-positional'/);
});

test('headless no-argument invocation points at -p and never hangs or reads stdin', () => {
  const result = runCli([]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage: wsg/);
  assert.match(result.stderr, /wsg -p/);
});
