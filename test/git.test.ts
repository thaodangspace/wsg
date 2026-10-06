import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('checkBranchName matches git check-ref-format --branch on a broad corpus', () => {
  const gitCheck = (name: string): boolean => {
    const result = spawnSync('git', ['check-ref-format', '--branch', name], {
      encoding: 'utf8',
    });
    return result.status === 0;
  };

  const names = [
    'main',
    'master',
    'wsg/port-emr/legacy-platform',
    'feature/my-branch_123',
    'a',
    'b/c',
    'refs/heads/foo',
    'refs/heads/-bad',
    'refs/heads/',
    '@',
    '@@',
    'x@',
    '@/x',
    '@x',
    'a@b',
    '-bad',
    '-',
    '--',
    'bad..name',
    'f..oo',
    'a..',
    'bad/',
    '/bad',
    'bad.',
    '.bad',
    'a/.b',
    'a/b.',
    'a.',
    '.',
    '..',
    'a./b',
    'a/b./c',
    'a.lock',
    'a.lock/x',
    'foo/bar.lock',
    'a.lockb',
    'a.lock.b',
    'x.LOCK',
    'a b',
    'a\tb',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a]b',
    'a\\b',
    'a@{b',
    'a@{',
    '@{a',
    '@/b',
    'a/b//c',
    'a//b',
    'foo/',
    'a/b/c',
    'a-b',
    'a_b',
    'a%b',
    'a$b',
    'a+b',
    'a=b',
    'a,b',
    'a!b',
    'a#b',
    'a&b',
    'a(b',
    'a)b',
    'a;b',
    'a{b',
    'a}b',
    'a<b',
    'a>b',
    'a|b',
    'ä',
    '日本語',
    'wsg/fixture-ws/repo-alpha',
  ];

  for (const name of names) {
    assert.equal(
      checkBranchName(name),
      gitCheck(name),
      `checkBranchName(${JSON.stringify(name)}) must match git`
    );
  }

  // Generated repository names must remain valid.
  assert.equal(checkBranchName('wsg/port-emr/legacy-platform'), true);
  assert.equal(checkBranchName('bad..name'), false);
  assert.equal(checkBranchName('bad/'), false);
  assert.equal(checkBranchName(''), false);
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

test('worktreeAddNewBranch disables post-checkout hooks, LFS smudge, and custom filters; sanitizes GIT_CONFIG injection', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-hook-filter-test-'));
  const repoDir = path.join(tmpRoot, 'source-repo');
  const wsRoot = path.join(tmpRoot, 'ws');
  fs.mkdirSync(wsRoot);
  // Isolate git from a host git-lfs install (whose global filter.lfs.process
  // takes precedence over a repo-local smudge and would shadow this test).
  const isolatedHome = path.join(tmpRoot, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  const git = (args: string[]): string => {
    const result = spawnSync('git', args, {
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };

  const hookMarker = path.join(tmpRoot, 'hook-ran.txt');
  const filterMarker = path.join(tmpRoot, 'filter-ran.txt');
  const lfsMarker = path.join(tmpRoot, 'lfs-ran.txt');

  try {
    git(['init', '-b', 'main', repoDir]);
    git(['-C', repoDir, 'config', 'user.name', 'WSG Test']);
    git(['-C', repoDir, 'config', 'user.email', 'test@example.com']);

    // 1. Install executable post-checkout hook in repo
    const hooksDir = path.join(repoDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const postCheckoutHook = path.join(hooksDir, 'post-checkout');
    fs.writeFileSync(
      postCheckoutHook,
      `#!/bin/sh\necho "HOOK_RAN" > "${hookMarker}"\n`,
      { mode: 0o755 }
    );

    // 2. Install executable custom filter smudge script
    const customFilterScript = path.join(tmpRoot, 'custom-filter.sh');
    fs.writeFileSync(
      customFilterScript,
      `#!/bin/sh\necho "CUSTOM_FILTER_RAN" > "${filterMarker}"\ncat\n`,
      { mode: 0o755 }
    );
    git(['-C', repoDir, 'config', 'filter.custom.smudge', customFilterScript]);
    git(['-C', repoDir, 'config', 'filter.custom.required', 'false']);

    // 3. Install executable mock LFS smudge script
    const lfsScript = path.join(tmpRoot, 'mock-lfs.sh');
    fs.writeFileSync(
      lfsScript,
      `#!/bin/sh\necho "LFS_RAN" > "${lfsMarker}"\ncat\n`,
      { mode: 0o755 }
    );
    git(['-C', repoDir, 'config', 'filter.lfs.smudge', lfsScript]);
    git(['-C', repoDir, 'config', 'filter.lfs.clean', 'cat']);
    git(['-C', repoDir, 'config', 'filter.lfs.required', 'true']);

    // Write tracked files and attributes
    fs.writeFileSync(
      path.join(repoDir, '.gitattributes'),
      '*.custom filter=custom\n*.bin filter=lfs diff=lfs merge=lfs -text\n',
      'utf8'
    );
    fs.writeFileSync(path.join(repoDir, 'test.custom'), 'custom content\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'data.bin'), 'version https://git-lfs.github.com/spec/v1\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Hook & Filter Test\n', 'utf8');

    git(['-C', repoDir, 'add', '.']);
    git(['-C', repoDir, 'commit', '-m', 'Add files with hook and filters']);
    const headSha = git(['-C', repoDir, 'rev-parse', 'HEAD']).trim();

    // Verify hooks and filters would run without wsg overrides
    const testUnprotected = path.join(tmpRoot, 'unprotected-wt');
    git(['-C', repoDir, 'worktree', 'add', '-b', 'unprotected', testUnprotected, headSha]);
    assert.ok(fs.existsSync(hookMarker), 'Unprotected worktree add should run post-checkout hook');
    assert.ok(fs.existsSync(filterMarker), 'Unprotected worktree add should run custom filter');
    assert.ok(fs.existsSync(lfsMarker), 'Unprotected worktree add should run LFS filter');
    // Remove markers
    fs.unlinkSync(hookMarker);
    fs.unlinkSync(filterMarker);
    fs.unlinkSync(lfsMarker);

    // 4. Test worktreeAddNewBranch with attempted GIT_CONFIG injection env
    const dest = path.join(wsRoot, 'app');
    const dangerousEnv: NodeJS.ProcessEnv = {
      GIT_CONFIG_PARAMETERS: `'core.hooksPath=${hooksDir}'`,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooksDir,
      GIT_HOOKS_PATH: hooksDir,
      HOME: isolatedHome,
    };

    worktreeAddNewBranch(repoDir, 'wsg/ws/app', dest, headSha, { env: dangerousEnv });

    // Assert destination worktree created
    assert.ok(fs.existsSync(dest));
    assert.ok(fs.existsSync(path.join(dest, 'test.custom')));
    assert.ok(fs.existsSync(path.join(dest, 'data.bin')));

    // Assert that NO hook or filter executed
    assert.equal(fs.existsSync(hookMarker), false, 'post-checkout hook must NOT execute');
    assert.equal(fs.existsSync(filterMarker), false, 'custom filter smudge must NOT execute');
    assert.equal(fs.existsSync(lfsMarker), false, 'LFS filter smudge must NOT execute');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('worktreeAddNewBranch and worktreeAddExisting disable dotted filter drivers and fail closed on config errors', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-dotted-filter-test-'));
  const repoDir = path.join(tmpRoot, 'dotted-repo');
  const wsRoot = path.join(tmpRoot, 'ws');
  fs.mkdirSync(wsRoot);

  const dottedMarker = path.join(tmpRoot, 'dotted-ran.txt');

  try {
    runGit(['init', '-b', 'main', repoDir]);
    runGit(['-C', repoDir, 'config', 'user.name', 'WSG Test']);
    runGit(['-C', repoDir, 'config', 'user.email', 'test@example.com']);

    // Install recording smudge script for dotted filter driver: filter.custom.driver.smudge
    const dottedScript = path.join(tmpRoot, 'dotted-smudge.sh');
    fs.writeFileSync(
      dottedScript,
      `#!/bin/sh\necho "DOTTED_FILTER_RAN" > "${dottedMarker}"\ncat\n`,
      { mode: 0o755 }
    );

    runGit(['-C', repoDir, 'config', 'filter.custom.driver.smudge', dottedScript]);
    runGit(['-C', repoDir, 'config', 'filter.custom.driver.clean', 'cat']);
    runGit(['-C', repoDir, 'config', 'filter.custom.driver.required', 'true']);

    fs.writeFileSync(path.join(repoDir, '.gitattributes'), '*.dotted filter=custom.driver\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'example.dotted'), 'dotted content\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Dotted Filter Test\n', 'utf8');

    runGit(['-C', repoDir, 'add', '.']);
    runGit(['-C', repoDir, 'commit', '-m', 'Add dotted filter file']);
    const headSha = runGit(['-C', repoDir, 'rev-parse', 'HEAD']).trim();

    // Verify unprotected worktree add would trigger dotted filter
    const testUnprotected = path.join(tmpRoot, 'unprotected-dotted-wt');
    runGit(['-C', repoDir, 'worktree', 'add', '-b', 'unprotected-dotted', testUnprotected, headSha]);
    assert.ok(fs.existsSync(dottedMarker), 'Unprotected worktree add should run dotted filter');
    fs.unlinkSync(dottedMarker);

    // Form 1: worktreeAddNewBranch must disable dotted filter
    const dest1 = path.join(wsRoot, 'app-branch');
    worktreeAddNewBranch(repoDir, 'wsg/ws/dotted-branch', dest1, headSha);
    assert.ok(fs.existsSync(dest1));
    assert.ok(fs.existsSync(path.join(dest1, 'example.dotted')));
    assert.equal(fs.existsSync(dottedMarker), false, 'worktreeAddNewBranch must NOT run dotted filter script');

    // Form 2: worktreeAddExisting must disable dotted filter
    const dest2 = path.join(wsRoot, 'app-existing');
    const existingBranch = 'wsg/ws/dotted-existing';
    runGit(['-C', repoDir, 'branch', existingBranch, headSha]);
    worktreeAddExisting(repoDir, existingBranch, dest2);
    assert.ok(fs.existsSync(dest2));
    assert.ok(fs.existsSync(path.join(dest2, 'example.dotted')));
    assert.equal(fs.existsSync(dottedMarker), false, 'worktreeAddExisting must NOT run dotted filter script');

    // Fail closed: if config inspection fails for non-existent repo or corrupt config
    const nonRepoDir = path.join(tmpRoot, 'non-existent-dir');
    assert.throws(
      () => worktreeAddNewBranch(nonRepoDir, 'wsg/ws/fail', path.join(wsRoot, 'fail'), headSha),
      {
        name: 'UsageError',
      }
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});


