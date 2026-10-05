import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enumerateRepos } from '../src/discovery.ts';
import { createTestRepo } from './helpers/git-fixture.ts';
import { runGit } from '../src/git.ts';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('discovers repositories under a code root and deduplicates symlink aliases', () => {
  const codeRoot = tmp('wsg-disc-');
  const repoA = createTestRepo({ prefix: 'wsg-disc-a-' });
  const repoB = createTestRepo({ prefix: 'wsg-disc-b-' });
  fs.symlinkSync(repoA.dir, path.join(codeRoot, 'alias-one'));
  fs.symlinkSync(repoA.dir, path.join(codeRoot, 'alias-two'));
  fs.symlinkSync(repoB.dir, path.join(codeRoot, 'plain-b'));

  try {
    const result = enumerateRepos([codeRoot]);
    assert.equal(result.repos.length, 2, 'duplicate symlink aliases collapse to one repo');
    const sources = result.repos.map((r) => r.source).sort();
    assert.deepEqual(sources, [fs.realpathSync(repoA.dir), fs.realpathSync(repoB.dir)].sort());
  } finally {
    repoA.cleanup();
    repoB.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('recognizes a .git file for an existing worktree', () => {
  const codeRoot = tmp('wsg-disc-wt-');
  const repo = createTestRepo({ prefix: 'wsg-disc-wt-src-' });
  const wtPath = path.join(codeRoot, 'feature-worktree');
  runGit(['-C', repo.dir, 'worktree', 'add', '-b', 'feature', '--', wtPath, 'HEAD']);

  try {
    const result = enumerateRepos([codeRoot]);
    const found = result.repos.find((r) => r.source === fs.realpathSync(wtPath));
    assert.ok(found, 'worktree with a .git file must be discovered');
    assert.equal(found.gitKind, 'file');
  } finally {
    try {
      runGit(['-C', repo.dir, 'worktree', 'remove', '--force', wtPath]);
    } catch {
      // ignore
    }
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('skips vendor directories and does not descend into repositories', () => {
  const codeRoot = tmp('wsg-disc-vendor-');
  const repo = createTestRepo({ prefix: 'wsg-disc-v-' });
  fs.symlinkSync(repo.dir, path.join(codeRoot, 'app'));

  // A git repository that must be ignored because it lives under node_modules.
  const vendored = createTestRepo({ prefix: 'wsg-disc-nm-' });
  const nmRepoPath = path.join(codeRoot, 'node_modules', 'vendored');
  fs.mkdirSync(path.dirname(nmRepoPath), { recursive: true });
  fs.cpSync(vendored.dir, nmRepoPath, { recursive: true });

  // A nested repository inside a real repository must not be enumerated.
  const nested = createTestRepo({ prefix: 'wsg-disc-nested-' });
  const nestedInside = path.join(repo.dir, 'nested-repo');
  fs.cpSync(nested.dir, nestedInside, { recursive: true });

  try {
    const result = enumerateRepos([codeRoot]);
    assert.equal(result.repos.length, 1, 'only the top-level repository is discovered');
    assert.equal(result.repos[0].source, fs.realpathSync(repo.dir));
  } finally {
    repo.cleanup();
    vendored.cleanup();
    nested.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('symlink loops terminate and absent code roots are reported as gaps', () => {
  const codeRoot = tmp('wsg-disc-loop-');
  fs.symlinkSync(codeRoot, path.join(codeRoot, 'loop'));
  const missing = path.join(codeRoot, 'does-not-exist');

  const result = enumerateRepos([codeRoot, missing], { maxEntries: 500 });
  assert.deepEqual(result.repos, []);
  assert.ok(
    result.gaps.some((g) => g.includes('does not exist') && g.includes(missing)),
    `expected an absent-root gap, got: ${JSON.stringify(result.gaps)}`
  );
});

test('exhausted repo/entry budgets produce bounded results and gaps', () => {
  const codeRoot = tmp('wsg-disc-cap-');
  const repos = [
    createTestRepo({ prefix: 'wsg-disc-c1-' }),
    createTestRepo({ prefix: 'wsg-disc-c2-' }),
    createTestRepo({ prefix: 'wsg-disc-c3-' }),
  ];
  repos.forEach((r, i) => fs.symlinkSync(r.dir, path.join(codeRoot, `r${i}`)));

  try {
    const capped = enumerateRepos([codeRoot], { maxRepos: 2 });
    assert.equal(capped.repos.length, 2);
    assert.ok(capped.gaps.some((g) => g.includes('repository limit')));

    const entryCapped = enumerateRepos([codeRoot], { maxEntries: 1 });
    assert.ok(entryCapped.repos.length <= 1);
    assert.ok(entryCapped.gaps.some((g) => g.includes('directory entries')));
  } finally {
    repos.forEach((r) => r.cleanup());
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('depth budget bounds deep non-repository trees', () => {
  const codeRoot = tmp('wsg-disc-depth-');
  const repo = createTestRepo({ prefix: 'wsg-disc-d-' });
  let deep = codeRoot;
  for (let i = 0; i < 10; i++) {
    deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep);
  }
  fs.symlinkSync(repo.dir, path.join(codeRoot, 'shallow-repo'));

  try {
    const result = enumerateRepos([codeRoot], { maxDepth: 3 });
    assert.equal(result.repos.length, 1);
    assert.ok(result.gaps.some((g) => g.includes('depth 3')));
  } finally {
    repo.cleanup();
    fs.rmSync(codeRoot, { recursive: true, force: true });
  }
});
