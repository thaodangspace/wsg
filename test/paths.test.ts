import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  assertConfinedRelative,
  canonicalize,
  expandHome,
  findWorkspaceRoot,
  resolveInside,
} from '../src/paths.ts';
import { UsageError } from '../src/errors.ts';

test('assertConfinedRelative rejects absolute, .., backslash, NUL; accepts docs/x.md', () => {
  // Rejects absolute paths
  const absolutePaths = [
    '/docs/x.md',
    '/etc/passwd',
    '/root',
    '/',
    'C:/foo/bar',
  ];
  for (const p of absolutePaths) {
    assert.throws(
      () => assertConfinedRelative(p),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /absolute/i);
        return true;
      },
      `Expected '${p}' to be rejected as absolute`
    );
  }

  // Rejects .. traversal
  const traversalPaths = [
    '..',
    '../x.md',
    'docs/../x.md',
    'a/b/../../c',
    'nested/..',
  ];
  for (const p of traversalPaths) {
    assert.throws(
      () => assertConfinedRelative(p),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /\.\./);
        return true;
      },
      `Expected '${p}' to be rejected as traversal`
    );
  }

  // Rejects backslash
  const backslashPaths = ['docs\\x.md', 'scripts\\build.sh', 'a\\b'];
  for (const p of backslashPaths) {
    assert.throws(
      () => assertConfinedRelative(p),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /backslash/i);
        return true;
      },
      `Expected '${p}' to be rejected for backslashes`
    );
  }

  // Rejects NUL
  const nulPaths = ['docs/\0x.md', '\0evil', 'test\0'];
  for (const p of nulPaths) {
    assert.throws(
      () => assertConfinedRelative(p),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /NUL/i);
        return true;
      },
      `Expected '${p}' to be rejected for NUL byte`
    );
  }

  // Accepts valid relative paths
  const validPaths = [
    'docs/x.md',
    'README.md',
    'workspace.yaml',
    'scripts/test.sh',
    'repos/platform/src/index.ts',
  ];
  for (const p of validPaths) {
    assert.equal(assertConfinedRelative(p), p);
  }
});

test('resolveInside safely confines paths within root directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-test-resolve-'));
  try {
    const rootCanonical = canonicalize(tmpDir);
    const resolved = resolveInside(tmpDir, 'docs/x.md');
    assert.equal(resolved, path.join(rootCanonical, 'docs', 'x.md'));

    assert.throws(() => resolveInside(tmpDir, '../outside'), UsageError);
    assert.throws(() => resolveInside(tmpDir, '/etc/passwd'), UsageError);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveInside accepts ..cache/x and does not treat filename prefix as traversal', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-test-cache-'));
  try {
    const rootCanonical = canonicalize(tmpDir);
    const resolved = resolveInside(tmpDir, '..cache/x');
    assert.equal(resolved, path.join(rootCanonical, '..cache', 'x'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveInside rejects escaping symlinks, broken symlinks, and non-directory components', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-test-symlink-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-test-outside-'));

  try {
    const root = path.join(tmpDir, 'workspace');
    fs.mkdirSync(root, { recursive: true });

    // 1. Escaping symlink pointing outside workspace
    fs.symlinkSync(outsideDir, path.join(root, 'docs'));

    // Non-existent leaf under escaping symlink must be rejected
    assert.throws(
      () => resolveInside(root, 'docs/new.md'),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /escapes workspace root/i);
        return true;
      }
    );

    // Escaping symlink itself
    assert.throws(
      () => resolveInside(root, 'docs'),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /escapes workspace root/i);
        return true;
      }
    );

    // 2. Broken symlink
    fs.symlinkSync(path.join(tmpDir, 'does-not-exist'), path.join(root, 'broken-link'));
    assert.throws(
      () => resolveInside(root, 'broken-link/sub/leaf.md'),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /broken symlink/i);
        return true;
      }
    );
    assert.throws(
      () => resolveInside(root, 'broken-link'),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /broken symlink/i);
        return true;
      }
    );

    // 3. Non-directory path component
    fs.writeFileSync(path.join(root, 'regular-file.txt'), 'hello');
    assert.throws(
      () => resolveInside(root, 'regular-file.txt/child.md'),
      (err: unknown) => {
        assert(err instanceof UsageError);
        assert.match(err.message, /not a directory/i);
        return true;
      }
    );

    // 4. Confined symlink pointing inside workspace is allowed
    const internalDir = path.join(root, 'real-sub');
    fs.mkdirSync(internalDir);
    fs.symlinkSync(internalDir, path.join(root, 'internal-link'));

    const internalRes = resolveInside(root, 'internal-link/new.md');
    assert.equal(internalRes, path.join(canonicalize(internalDir), 'new.md'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('expandHome and canonicalize expand ~ and resolve paths', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/docs'), path.join(os.homedir(), 'docs'));
  assert.equal(expandHome('/absolute/path'), '/absolute/path');

  const customHome = '/custom/home';
  assert.equal(expandHome('~/test', customHome), '/custom/home/test');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-test-canon-'));
  try {
    const canon = canonicalize(tmpDir);
    assert(path.isAbsolute(canon));
    assert.equal(canon, fs.realpathSync(tmpDir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findWorkspaceRoot resolution: nested dir, dir with .git file, null when none, explicit wins', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-test-ws-'));

  try {
    const wsDir = path.join(tmpRoot, 'my-workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'workspace.yaml'), 'version: 1\nname: test\n');

    // 1. Nested dir inside workspace
    const nestedDir = path.join(wsDir, 'nested', 'deep', 'dir');
    fs.mkdirSync(nestedDir, { recursive: true });

    const foundFromNested = findWorkspaceRoot(nestedDir);
    assert.equal(foundFromNested, canonicalize(wsDir));

    // 2. From inside a dir with a .git file (simulating git worktree)
    const worktreeDir = path.join(wsDir, 'my-worktree');
    const worktreeSrc = path.join(worktreeDir, 'src', 'deep');
    fs.mkdirSync(worktreeSrc, { recursive: true });
    // Write a .git FILE (not directory) as git worktrees do
    fs.writeFileSync(
      path.join(worktreeDir, '.git'),
      'gitdir: /some/path/.git/worktrees/my-worktree\n'
    );

    const foundFromWorktree = findWorkspaceRoot(worktreeSrc);
    assert.equal(foundFromWorktree, canonicalize(wsDir));

    const foundFromWorktreeRoot = findWorkspaceRoot(worktreeDir);
    assert.equal(foundFromWorktreeRoot, canonicalize(wsDir));

    // 3. Null when none found
    const unrelatedDir = path.join(tmpRoot, 'unrelated', 'dir');
    fs.mkdirSync(unrelatedDir, { recursive: true });

    const foundNone = findWorkspaceRoot(unrelatedDir);
    assert.equal(foundNone, null);

    // 4. Explicit --workspace wins
    const explicitDir = path.join(tmpRoot, 'explicit-workspace');
    fs.mkdirSync(explicitDir, { recursive: true });
    fs.writeFileSync(path.join(explicitDir, 'workspace.yaml'), 'version: 1\nname: explicit\n');

    // Even when starting from inside wsDir, explicit workspace wins
    const explicitWins = findWorkspaceRoot(nestedDir, explicitDir);
    assert.equal(explicitWins, canonicalize(explicitDir));

    // Also via options object
    const explicitViaOptions = findWorkspaceRoot({
      startDir: nestedDir,
      workspace: explicitDir,
    });
    assert.equal(explicitViaOptions, canonicalize(explicitDir));

    // Explicit pointing directly to workspace.yaml resolves to its parent dir
    const explicitFileWins = findWorkspaceRoot(
      nestedDir,
      path.join(explicitDir, 'workspace.yaml')
    );
    assert.equal(explicitFileWins, canonicalize(explicitDir));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
