import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runGit,
  gitVersion,
  assertGitVersion,
  repoInfo,
  branchExists,
  branchCommit,
  worktreeList,
  worktreeAddNewBranch,
  worktreeAddExisting,
  detectGaps,
  assertSafeArg,
  checkBranchName,
} from '../src/git.ts';
import { UsageError } from '../src/errors.ts';
import { canonicalize } from '../src/paths.ts';
import { createTestRepo } from './helpers/git-fixture.ts';

test('assertSafeArg rejects invalid arguments and passes safe arguments', () => {
  assert.equal(assertSafeArg('main'), 'main');
  assert.equal(assertSafeArg('wsg/foo/bar'), 'wsg/foo/bar');
  assert.equal(assertSafeArg('/tmp/destination'), '/tmp/destination');

  assert.throws(() => assertSafeArg('', 'param'), {
    name: 'UsageError',
    message: /param must not be empty/,
  });
  assert.throws(() => assertSafeArg('-x', 'ref'), {
    name: 'UsageError',
    message: /ref '-x' must not start with a dash/,
  });
  assert.throws(() => assertSafeArg('--force', 'arg'), {
    name: 'UsageError',
    message: /arg '--force' must not start with a dash/,
  });
  assert.throws(() => assertSafeArg('foo\0bar', 'arg'), {
    name: 'UsageError',
    message: /arg must not contain NUL bytes/,
  });
});

test('gitVersion returns a version string', () => {
  const version = gitVersion();
  assert.match(version, /^\d+\.\d+(?:\.\d+)?$/);
});

test('assertGitVersion validates version and rejects <2.38', () => {
  // Current git version should pass
  assertGitVersion();
  assertGitVersion('2.38.0');

  // Explicit version checks
  assertGitVersion('2.38.0', '2.38.0');
  assertGitVersion('2.38.0', '2.38.1');
  assertGitVersion('2.38.0', '2.40.0');
  assertGitVersion('2.38.0', '3.0.0');

  // Should reject < 2.38
  assert.throws(() => assertGitVersion('2.38.0', '2.37.5'), {
    name: 'UsageError',
    message: /Git version 2.38.0 or newer is required \(found 2.37.5\)/,
  });
  assert.throws(() => assertGitVersion('2.38.0', '2.30.0'), {
    name: 'UsageError',
    message: /Git version 2.38.0 or newer is required \(found 2.30.0\)/,
  });
  assert.throws(() => assertGitVersion('2.38.0', '1.9.5'), {
    name: 'UsageError',
    message: /Git version 2.38.0 or newer is required \(found 1.9.5\)/,
  });
});

test('repoInfo returns toplevel realpath, 40-hex HEAD, and clean dirty flag', () => {
  const repo = createTestRepo({ branch: 'main' });
  try {
    const info = repoInfo(repo.dir);
    assert.equal(info.toplevel, canonicalize(repo.dir));
    assert.match(info.headCommit, /^[0-9a-f]{40}$/);
    assert.equal(info.headCommit, repo.headCommit);
    assert.equal(info.headBranch, 'main');
    assert.equal(info.dirty, false);
    assert.deepEqual(info.dirtyFiles, []);
  } finally {
    repo.cleanup();
  }
});

test('repoInfo detects dirty working tree', () => {
  const repo = createTestRepo({ dirty: true });
  try {
    const info = repoInfo(repo.dir);
    assert.equal(info.dirty, true);
    assert.ok(info.dirtyFiles.includes('dirty.txt'));
    assert.equal(info.headBranch, 'main');
  } finally {
    repo.cleanup();
  }
});

test('repoInfo throws UsageError for non-repo, bare repo, unborn repo, and nonexistent dir', () => {
  // Non-repo
  const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-nonrepo-'));
  try {
    assert.throws(() => repoInfo(nonRepoDir), {
      name: 'UsageError',
      message: /is not a git repository/,
    });
  } finally {
    fs.rmSync(nonRepoDir, { recursive: true, force: true });
  }

  // Bare repo
  const bareRepo = createTestRepo({ bare: true });
  try {
    assert.throws(() => repoInfo(bareRepo.dir), {
      name: 'UsageError',
      message: /is a bare git repository/,
    });
  } finally {
    bareRepo.cleanup();
  }

  // Unborn repo
  const unbornRepo = createTestRepo({ unborn: true });
  try {
    assert.throws(() => repoInfo(unbornRepo.dir), {
      name: 'UsageError',
      message: /has an unborn HEAD/,
    });
  } finally {
    unbornRepo.cleanup();
  }

  // Nonexistent directory
  const missingPath = path.join(os.tmpdir(), 'wsg-missing-' + Date.now());
  assert.throws(() => repoInfo(missingPath), {
    name: 'UsageError',
  });
});

test('branchExists and branchCommit inspect branches safely', () => {
  const repo = createTestRepo({ branch: 'main' });
  try {
    assert.equal(branchExists(repo.dir, 'main'), true);
    assert.equal(branchExists(repo.dir, 'nonexistent'), false);
    assert.equal(branchCommit(repo.dir, 'main'), repo.headCommit);
    assert.equal(branchCommit(repo.dir, 'nonexistent'), null);

    // Option injection rejected pre-exec
    assert.throws(() => branchExists(repo.dir, '-x'), {
      name: 'UsageError',
      message: /Branch name '-x' must not start with a dash/,
    });
    assert.throws(() => branchCommit(repo.dir, '-d'), {
      name: 'UsageError',
      message: /Branch name '-d' must not start with a dash/,
    });
  } finally {
    repo.cleanup();
  }
});

test('worktreeAddNewBranch creates wsg/x/y at HEAD and worktreeList matches; source branch + dirty file unchanged; rejects -x ref / -d dest pre-exec', () => {
  const repo = createTestRepo({ dirty: true });
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-ws-'));
  const dest = path.join(wsRoot, 'app');

  try {
    // Rejection of invalid args pre-exec
    assert.throws(() => worktreeAddNewBranch(repo.dir, '-x', dest, repo.headCommit), {
      name: 'UsageError',
      message: /Branch name '-x' must not start with a dash/,
    });
    assert.throws(() => worktreeAddNewBranch(repo.dir, 'wsg/x/y', '-d', repo.headCommit), {
      name: 'UsageError',
      message: /Destination path '-d' must not start with a dash/,
    });
    assert.throws(() => worktreeAddNewBranch(repo.dir, 'bad..branch', dest, repo.headCommit), {
      name: 'UsageError',
      message: /Invalid branch name 'bad\.\.branch'/,
    });

    // Create worktree on branch wsg/test-ws/app
    const branchName = 'wsg/test-ws/app';
    worktreeAddNewBranch(repo.dir, branchName, dest, repo.headCommit);

    // Check dest created and has committed files
    assert.ok(fs.existsSync(dest));
    assert.ok(fs.existsSync(path.join(dest, 'README.md')));
    // Dirty file from source repo must NOT be carried over
    assert.equal(fs.existsSync(path.join(dest, 'dirty.txt')), false);

    // Source repo must still be on main and dirty file must remain untouched
    const srcInfo = repoInfo(repo.dir);
    assert.equal(srcInfo.headBranch, 'main');
    assert.equal(srcInfo.dirty, true);
    assert.ok(fs.existsSync(path.join(repo.dir, 'dirty.txt')));

    // worktreeList matches
    const list = worktreeList(repo.dir);
    assert.equal(list.length, 2);

    const mainWt = list.find((wt) => wt.worktree === canonicalize(repo.dir));
    assert.ok(mainWt);
    assert.equal(mainWt.branch, 'main');
    assert.equal(mainWt.head, repo.headCommit);

    const appWt = list.find((wt) => wt.worktree === canonicalize(dest));
    assert.ok(appWt);
    assert.equal(appWt.branch, branchName);
    assert.equal(appWt.head, repo.headCommit);
  } finally {
    repo.cleanup();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
});

test('worktreeAddExisting creates worktree with existing branch; rejects -x ref / -d dest pre-exec', () => {
  const repo = createTestRepo({ branch: 'main' });
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-ws-'));
  const dest = path.join(wsRoot, 'app-existing');

  try {
    const existingBranch = 'wsg/test-ws/feature';
    // Create branch in source repo without checking it out
    runGit(['-C', repo.dir, 'branch', existingBranch, repo.headCommit]);
    assert.equal(branchExists(repo.dir, existingBranch), true);

    // Rejection pre-exec
    assert.throws(() => worktreeAddExisting(repo.dir, '-x', dest), {
      name: 'UsageError',
      message: /Branch name '-x' must not start with a dash/,
    });
    assert.throws(() => worktreeAddExisting(repo.dir, existingBranch, '-d'), {
      name: 'UsageError',
      message: /Destination path '-d' must not start with a dash/,
    });

    worktreeAddExisting(repo.dir, existingBranch, dest);

    assert.ok(fs.existsSync(dest));
    const list = worktreeList(repo.dir);
    const addedWt = list.find((wt) => wt.worktree === canonicalize(dest));
    assert.ok(addedWt);
    assert.equal(addedWt.branch, existingBranch);
    assert.equal(addedWt.head, repo.headCommit);
  } finally {
    repo.cleanup();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
});

test('parent GIT_DIR not passed through to git commands', () => {
  const repo = createTestRepo({ branch: 'main' });
  const originalGitDir = process.env.GIT_DIR;
  try {
    // Point GIT_DIR to a bogus nonexistent directory
    process.env.GIT_DIR = '/nonexistent/bogus/path/that/does/not/exist';

    // repoInfo should succeed because runGit strips GIT_DIR
    const info = repoInfo(repo.dir);
    assert.equal(info.headBranch, 'main');
    assert.equal(info.headCommit, repo.headCommit);

    const list = worktreeList(repo.dir);
    assert.ok(list.length >= 1);
  } finally {
    if (originalGitDir !== undefined) {
      process.env.GIT_DIR = originalGitDir;
    } else {
      delete process.env.GIT_DIR;
    }
    repo.cleanup();
  }
});

test('detectGaps flags .gitmodules and filter=lfs', () => {
  // Clean repo: no gaps
  const cleanRepo = createTestRepo();
  try {
    const gaps = detectGaps(cleanRepo.dir);
    assert.deepEqual(gaps, []);
  } finally {
    cleanRepo.cleanup();
  }

  // Repo with .gitmodules
  const submoduleRepo = createTestRepo({ submodules: true });
  try {
    const gaps = detectGaps(submoduleRepo.dir);
    assert.equal(gaps.length, 1);
    assert.ok(gaps[0].includes('.gitmodules'));
    assert.ok(gaps[0].includes('submodule'));
  } finally {
    submoduleRepo.cleanup();
  }

  // Repo with filter=lfs
  const lfsRepo = createTestRepo({ lfs: true });
  try {
    const gaps = detectGaps(lfsRepo.dir);
    assert.equal(gaps.length, 1);
    assert.ok(gaps[0].includes('filter=lfs'));
    assert.ok(gaps[0].includes('LFS'));
  } finally {
    lfsRepo.cleanup();
  }

  // Repo with both
  const bothRepo = createTestRepo({ submodules: true, lfs: true });
  try {
    const gaps = detectGaps(bothRepo.dir);
    assert.equal(gaps.length, 2);
    assert.ok(gaps.some((g) => g.includes('.gitmodules')));
    assert.ok(gaps.some((g) => g.includes('filter=lfs')));
  } finally {
    bothRepo.cleanup();
  }
});
