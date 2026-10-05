import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestRepo } from './helpers/git-fixture.ts';
import {
  runGit,
  branchExists,
  branchCommit,
  worktreeList,
} from '../src/git.ts';
import { parseManifest } from '../src/manifest.ts';
import { readOperation, writeOperation } from '../src/operation.ts';
import { sha256 } from '../src/fsx.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
const NO_CONFIG_PATH = path.join(
  os.tmpdir(),
  `wsg-test-noconfig-${process.pid}.yaml`
);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: { env?: Record<string, string | undefined> } = {}
): CliResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      WSG_CONFIG: NO_CONFIG_PATH,
      ...options.env,
    },
    encoding: 'utf8',
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

interface CraftRepoSpec {
  name: string;
  source: string;
  dest: string;
  branch: string;
  base_commit: string;
}

function writeCraftedJournal(
  wsDir: string,
  planRepos: CraftRepoSpec[],
  options: { name?: string; request?: string; branchExistedBefore?: boolean } = {}
): void {
  const name = options.name ?? 'ws';
  const request = options.request ?? 'task';
  const branchExistedBefore = options.branchExistedBefore ?? false;

  const steps: Record<string, unknown>[] = planRepos.map((r) => ({
    id: `worktree:${r.name}`,
    type: 'worktree',
    status: 'started',
    detail: {
      source: r.source,
      dest: r.dest,
      branch: r.branch,
      base_commit: r.base_commit,
      branchExistedBefore,
      destExistedBefore: false,
    },
  }));
  steps.push({ id: 'generate', type: 'generate', status: 'planned' });
  steps.push({ id: 'publish-manifest', type: 'publish-manifest', status: 'planned' });

  const operation = {
    id: 'op-crafted',
    command: 'create',
    status: 'running',
    startedAt: new Date().toISOString(),
    args: {
      request,
      name,
      adapters: ['agents'],
      repos: planRepos.map((r) => ({ name: r.name, source: r.source })),
      docs: [],
    },
    plan: {
      name,
      request,
      context: [],
      adapters: ['agents'],
      repos: planRepos.map((r) => ({
        ...r,
        dirty: false,
        dirtyFiles: [],
        reason: 'Explicit repository supplied by the user.',
      })),
      docs: [],
      gaps: [],
    },
    steps,
  };

  writeOperation(wsDir, {
    version: 1,
    owned: {},
    operation: operation as never,
  });
}

test('WSG_FAULT=after-worktree:1: resume adopts started worktree and completes', () => {
  const repo1 = createTestRepo({ prefix: 'wsg-rsm-r1-' });
  const repo2 = createTestRepo({ prefix: 'wsg-rsm-r2-' });
  const tmpRoot = mkTmp('wsg-rsm-root-');
  const wsDir = path.join(tmpRoot, 'ws');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo1.dir,
        '--repo',
        repo2.dir,
      ],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(first.status, 70, `expected fault exit 70: ${first.stderr}`);

    const opFile = readOperation(wsDir);
    assert.ok(opFile?.operation, 'journal must exist after fault');
    const planRepos = (opFile.operation.plan as { repos: CraftRepoSpec[] }).repos;
    assert.equal(planRepos.length, 2);
    const [r1, r2] = planRepos;

    const step1 = opFile.operation.steps.find((s) => s.id === `worktree:${r1.name}`);
    assert.equal(step1?.status, 'started', 'first worktree step must be started');
    assert.ok(branchExists(repo1.dir, r1.branch), 'repo1 branch must exist');
    assert.ok(
      worktreeList(repo1.dir).some((w) => w.branch === r1.branch),
      'repo1 worktree must be registered'
    );

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo1.dir,
      '--repo',
      repo2.dir,
      '--resume',
    ]);
    assert.equal(resumed.status, 0, `expected resume exit 0: ${resumed.stderr}`);
    assert.match(resumed.stderr, /taking over stale lock/);

    const opAfter = readOperation(wsDir);
    const step1After = opAfter?.operation?.steps.find((s) => s.id === `worktree:${r1.name}`);
    assert.equal(step1After?.status, 'done');
    assert.equal((step1After?.detail as { recovered?: string })?.recovered, 'adopt');

    assert.ok(branchExists(repo2.dir, r2.branch), 'repo2 branch must be created');
    const onePerRepo =
      worktreeList(repo1.dir).filter((w) => w.branch?.startsWith('wsg/ws/')).length === 1 &&
      worktreeList(repo2.dir).filter((w) => w.branch?.startsWith('wsg/ws/')).length === 1;
    assert.ok(onePerRepo, 'exactly one workspace worktree per repo');

    const manifest = parseManifest(
      fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8')
    );
    assert.equal(manifest.repos.length, 2);
    assert.equal(manifest.name, 'ws');
  } finally {
    repo1.cleanup();
    repo2.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume uses worktreeAddExisting for genuinely owned branch-only state', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-bo-' });
  const tmpRoot = mkTmp('wsg-rsm-bo-root-');
  const wsDir = path.join(tmpRoot, 'ws');
  const source = fs.realpathSync(repo.dir);
  const entry = 'repo';
  const branch = `wsg/ws/${entry}`;
  const dest = path.join(wsDir, entry);

  try {
    fs.mkdirSync(wsDir, { recursive: true });
    // Branch pre-created at the recorded base with no destination on disk.
    runGit(['-C', repo.dir, 'branch', branch, repo.headCommit]);
    writeCraftedJournal(wsDir, [
      { name: entry, source, dest, branch, base_commit: repo.headCommit },
    ]);

    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 0, `expected exit 0: ${result.stderr}`);

    const step = readOperation(wsDir)?.operation?.steps.find(
      (s) => s.id === `worktree:${entry}`
    );
    assert.equal(step?.status, 'done');
    assert.equal(
      (step?.detail as { recovered?: string })?.recovered,
      'worktreeAddExisting'
    );
    assert.ok(
      worktreeList(repo.dir).some(
        (w) => w.branch === branch && w.worktree === fs.realpathSync(dest)
      ),
      'worktree must be registered at destination'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume conflict: branch at a different commit leaves git untouched', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-c1-' });
  const tmpRoot = mkTmp('wsg-rsm-c1-root-');
  const wsDir = path.join(tmpRoot, 'ws');
  const source = fs.realpathSync(repo.dir);
  const entry = 'repo';
  const branch = `wsg/ws/${entry}`;
  const dest = path.join(wsDir, entry);
  const base = repo.headCommit;

  try {
    fs.mkdirSync(wsDir, { recursive: true });
    runGit(['-C', repo.dir, 'commit', '--allow-empty', '-m', 'second']);
    const otherCommit = runGit(['-C', repo.dir, 'rev-parse', 'HEAD']).trim();
    runGit(['-C', repo.dir, 'branch', branch, otherCommit]);
    writeCraftedJournal(wsDir, [
      { name: entry, source, dest, branch, base_commit: base },
    ]);

    const before = worktreeList(repo.dir).length;
    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /base commit/);

    assert.equal(branchCommit(repo.dir, branch), otherCommit, 'branch sha unchanged');
    assert.equal(worktreeList(repo.dir).length, before, 'worktree list unchanged');
    assert.ok(!fs.existsSync(dest), 'destination must not be created');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume conflict: destination registered on a different branch', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-c2-' });
  const tmpRoot = mkTmp('wsg-rsm-c2-root-');
  const wsDir = path.join(tmpRoot, 'ws');
  const source = fs.realpathSync(repo.dir);
  const entry = 'repo';
  const branch = `wsg/ws/${entry}`;
  const dest = path.join(wsDir, entry);

  try {
    fs.mkdirSync(wsDir, { recursive: true });
    runGit([
      '-C',
      repo.dir,
      'worktree',
      'add',
      '-b',
      'other-branch',
      '--',
      dest,
      repo.headCommit,
    ]);
    writeCraftedJournal(wsDir, [
      { name: entry, source, dest, branch, base_commit: repo.headCommit },
    ]);

    const before = worktreeList(repo.dir).length;
    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /registered for branch/);

    assert.ok(!branchExists(repo.dir, branch), 'expected branch must not be created');
    assert.equal(worktreeList(repo.dir).length, before, 'worktree list unchanged');
    assert.ok(
      worktreeList(repo.dir).some((w) => w.branch === 'other-branch'),
      'other branch worktree must remain'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume conflict: destination is a plain directory', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-c3-' });
  const tmpRoot = mkTmp('wsg-rsm-c3-root-');
  const wsDir = path.join(tmpRoot, 'ws');
  const source = fs.realpathSync(repo.dir);
  const entry = 'repo';
  const branch = `wsg/ws/${entry}`;
  const dest = path.join(wsDir, entry);

  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'user-file.txt'), 'mine\n');
    writeCraftedJournal(wsDir, [
      { name: entry, source, dest, branch, base_commit: repo.headCommit },
    ]);

    const before = worktreeList(repo.dir).length;
    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /exists on disk/);

    assert.ok(!branchExists(repo.dir, branch), 'expected branch must not be created');
    assert.equal(worktreeList(repo.dir).length, before, 'worktree list unchanged');
    assert.ok(fs.existsSync(path.join(dest, 'user-file.txt')), 'plain dir preserved');
    assert.ok(!fs.existsSync(path.join(dest, '.git')), 'plain dir not converted to worktree');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume conflict: branch at base but branchExistedBefore is true', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-c4-' });
  const tmpRoot = mkTmp('wsg-rsm-c4-root-');
  const wsDir = path.join(tmpRoot, 'ws');
  const source = fs.realpathSync(repo.dir);
  const entry = 'repo';
  const branch = `wsg/ws/${entry}`;
  const dest = path.join(wsDir, entry);

  try {
    fs.mkdirSync(wsDir, { recursive: true });
    runGit(['-C', repo.dir, 'branch', branch, repo.headCommit]);
    writeCraftedJournal(
      wsDir,
      [{ name: entry, source, dest, branch, base_commit: repo.headCommit }],
      { branchExistedBefore: true }
    );

    const before = worktreeList(repo.dir).length;
    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /already existed prior/);

    assert.equal(branchCommit(repo.dir, branch), repo.headCommit, 'branch sha unchanged');
    assert.equal(worktreeList(repo.dir).length, before, 'worktree list unchanged');
    assert.ok(!fs.existsSync(dest), 'destination must not be created');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('WSG_FAULT=after-generate: resume preserves edits, writes .wsg-new, publishes manifest', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-gen-' });
  const tmpRoot = mkTmp('wsg-rsm-gen-root-');
  const wsDir = path.join(tmpRoot, 'ws');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo.dir,
      ],
      { env: { WSG_FAULT: 'after-generate' } }
    );
    assert.equal(first.status, 70, `expected fault exit 70: ${first.stderr}`);

    const manifestPath = path.join(wsDir, 'workspace.yaml');
    const contextPath = path.join(wsDir, 'docs', 'context.md');
    assert.ok(!fs.existsSync(manifestPath), 'manifest must not be published yet');
    assert.ok(fs.existsSync(contextPath), 'generated context must exist');

    const edited = fs.readFileSync(contextPath, 'utf8') + '\nUSER EDIT\n';
    fs.writeFileSync(contextPath, edited, 'utf8');

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(resumed.status, 3, `expected partial exit 3: ${resumed.stderr}`);

    assert.equal(fs.readFileSync(contextPath, 'utf8'), edited, 'user edit intact');
    assert.ok(
      fs.existsSync(`${contextPath}.wsg-new`),
      '.wsg-new proposal must be written'
    );
    assert.ok(fs.existsSync(manifestPath), 'manifest must be published last');
    const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'ws');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('--resume rejects a complete workspace', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-done-' });
  const tmpRoot = mkTmp('wsg-rsm-done-root-');

  try {
    const created = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
    ]);
    assert.equal(created.status, 0, created.stderr);

    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /already complete/);
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('--resume rejects a different --repo set with a diff', () => {
  const repo1 = createTestRepo({ prefix: 'wsg-rsm-diff1-' });
  const repo2 = createTestRepo({ prefix: 'wsg-rsm-diff2-' });
  const tmpRoot = mkTmp('wsg-rsm-diff-root-');

  try {
    const first = runCli(
      ['create', 'task', '--name', 'ws', '--root', tmpRoot, '--repo', repo1.dir],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo1.dir,
      '--repo',
      repo2.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /Added repositories/);
  } finally {
    repo1.cleanup();
    repo2.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('--resume rejects a different --name against a single interrupted workspace', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-name-' });
  const tmpRoot = mkTmp('wsg-rsm-name-root-');

  try {
    // No --name: directory derives from the request ("task").
    const first = runCli(
      ['create', 'task', '--root', tmpRoot, '--repo', repo.dir],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const result = runCli([
      'create',
      'task',
      '--name',
      'other',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /does not match recorded operation name/);

    // No manifest should have been published by the rejected resume.
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'task', 'workspace.yaml')));
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume recovers a pending snapshot from its recorded hash', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-snap-' });
  const docDir = mkTmp('wsg-rsm-snap-doc-');
  const docPath = path.join(docDir, 'guide.md');
  const docContent = '# Guide\nDeterministic snapshot.\n';
  fs.writeFileSync(docPath, docContent, 'utf8');
  const tmpRoot = mkTmp('wsg-rsm-snap-root-');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo.dir,
        '--doc',
        docPath,
      ],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const wsDir = path.join(tmpRoot, 'ws');
    const snapshotPath = path.join(wsDir, 'docs', 'guide.md');
    assert.ok(!fs.existsSync(snapshotPath), 'snapshot must be pending after fault');

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      docPath,
      '--resume',
    ]);
    assert.equal(resumed.status, 0, `expected exit 0: ${resumed.stderr}`);
    assert.ok(fs.existsSync(snapshotPath), 'snapshot must be recovered');
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), docContent);

    const manifest = parseManifest(
      fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8')
    );
    assert.equal(manifest.docs.length, 1);
    assert.equal(manifest.docs[0].sha256, sha256(docContent));
  } finally {
    repo.cleanup();
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume refuses to rebuild a snapshot from changed source state', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-snapchg-' });
  const docDir = mkTmp('wsg-rsm-snapchg-doc-');
  const docPath = path.join(docDir, 'guide.md');
  fs.writeFileSync(docPath, '# Guide\nOriginal.\n', 'utf8');
  const tmpRoot = mkTmp('wsg-rsm-snapchg-root-');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo.dir,
        '--doc',
        docPath,
      ],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(first.status, 70, first.stderr);

    // User changes the source document after the crash.
    fs.writeFileSync(docPath, '# Guide\nChanged after crash.\n', 'utf8');

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      docPath,
      '--resume',
    ]);
    assert.equal(resumed.status, 2, `expected conflict exit 2: ${resumed.stderr}`);
    assert.match(resumed.stderr, /changed since the interrupted operation/);

    const wsDir = path.join(tmpRoot, 'ws');
    assert.ok(
      !fs.existsSync(path.join(wsDir, 'docs', 'guide.md')),
      'changed snapshot must not be rebuilt'
    );
    assert.ok(
      !fs.existsSync(path.join(wsDir, 'workspace.yaml')),
      'manifest must not be published'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume rejects a recorded destination outside the workspace with zero git mutation', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-dest-' });
  const tmpRoot = mkTmp('wsg-rsm-dest-root-');
  const wsDir = path.join(tmpRoot, 'ws');
  const sibling = path.join(tmpRoot, 'sibling');

  try {
    const first = runCli(
      ['create', 'task', '--name', 'ws', '--root', tmpRoot, '--repo', repo.dir],
      { env: { WSG_FAULT: 'after-lock' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const opFile = readOperation(wsDir);
    assert.ok(opFile?.operation?.plan, 'journal plan must exist');
    const planRepos = (opFile.operation.plan as { repos: Array<{ name: string; dest: string }> })
      .repos;
    const entry = planRepos[0].name;
    const branch = `wsg/ws/${entry}`;
    planRepos[0].dest = sibling;
    writeOperation(wsDir, opFile);

    const before = worktreeList(repo.dir).length;
    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /not the expected workspace path|outside the workspace/);

    assert.ok(!fs.existsSync(sibling), 'no worktree written outside the workspace');
    assert.ok(!branchExists(repo.dir, branch), 'no branch created');
    assert.equal(worktreeList(repo.dir).length, before, 'worktree list unchanged');
    assert.ok(
      !fs.existsSync(path.join(wsDir, 'workspace.yaml')),
      'manifest must not be published'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume rejects a symlinked recorded destination with zero git mutation', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-destlink-' });
  const tmpRoot = mkTmp('wsg-rsm-destlink-root-');
  const wsDir = path.join(tmpRoot, 'ws');

  try {
    const first = runCli(
      ['create', 'task', '--name', 'ws', '--root', tmpRoot, '--repo', repo.dir],
      { env: { WSG_FAULT: 'after-lock' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const opFile = readOperation(wsDir);
    const planRepos = (opFile?.operation?.plan as { repos: Array<{ name: string; dest: string }> })
      .repos;
    const entry = planRepos[0].name;
    const branch = `wsg/ws/${entry}`;
    const dest = path.join(wsDir, entry);
    const realTarget = path.join(wsDir, 'real-target');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.symlinkSync(realTarget, dest, 'dir');

    const before = worktreeList(repo.dir).length;
    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /symbolic link/);

    assert.ok(!branchExists(repo.dir, branch), 'no branch created');
    assert.equal(worktreeList(repo.dir).length, before, 'worktree list unchanged');
    assert.ok(fs.lstatSync(realTarget).isDirectory(), 'symlink target preserved');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume rejects a traversal operation id without writing outside .wsg/tmp', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-opid-' });
  const tmpRoot = mkTmp('wsg-rsm-opid-root-');
  const wsDir = path.join(tmpRoot, 'ws');

  try {
    const first = runCli(
      ['create', 'task', '--name', 'ws', '--root', tmpRoot, '--repo', repo.dir],
      { env: { WSG_FAULT: 'after-lock' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const opFile = readOperation(wsDir);
    assert.ok(opFile?.operation);
    opFile.operation.id = '../../escape';
    writeOperation(wsDir, opFile);

    const before = worktreeList(repo.dir).length;
    const result = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(result.status, 2, `expected conflict exit 2: ${result.stderr}`);
    assert.match(result.stderr, /not a safe path segment/);

    assert.ok(!fs.existsSync(path.join(wsDir, 'escape')), 'no escaped directory in workspace');
    assert.ok(
      !fs.existsSync(path.join(wsDir, '.wsg', 'escape')),
      'no escaped directory under .wsg'
    );
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'escape')), 'no escaped directory in root');
    assert.equal(worktreeList(repo.dir).length, before, 'worktree list unchanged');
    assert.ok(
      !fs.existsSync(path.join(wsDir, 'workspace.yaml')),
      'manifest must not be published'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume rejects an outside .wsg/tmp staging symlink with zero git mutation', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-stage-' });
  const docDir = mkTmp('wsg-rsm-stage-doc-');
  const docPath = path.join(docDir, 'guide.md');
  fs.writeFileSync(docPath, '# Guide\nPending snapshot.\n', 'utf8');
  const tmpRoot = mkTmp('wsg-rsm-stage-root-');
  const outside = mkTmp('wsg-rsm-stage-out-');
  const marker = path.join(outside, 'marker.txt');
  fs.writeFileSync(marker, 'MARKER\n', 'utf8');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo.dir,
        '--doc',
        docPath,
      ],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const wsDir = path.join(tmpRoot, 'ws');
    const tmpLink = path.join(wsDir, '.wsg', 'tmp');
    assert.ok(!fs.existsSync(tmpLink), 'staging dir must be absent before symlink setup');
    fs.symlinkSync(outside, tmpLink, 'dir');

    const beforeList = worktreeList(repo.dir).length;
    const beforeSha = sha256(fs.readFileSync(marker));

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      docPath,
      '--resume',
    ]);
    assert.equal(resumed.status, 2, `expected conflict exit 2: ${resumed.stderr}`);
    assert.match(resumed.stderr, /unsafe staging directory/);

    assert.deepEqual(fs.readdirSync(outside), ['marker.txt'], 'no outside writes/deletes');
    assert.equal(sha256(fs.readFileSync(marker)), beforeSha, 'outside marker unchanged');
    assert.equal(worktreeList(repo.dir).length, beforeList, 'worktree list unchanged');
    assert.ok(fs.lstatSync(tmpLink).isSymbolicLink(), 'staging symlink untouched');
    assert.ok(
      !fs.existsSync(path.join(wsDir, 'workspace.yaml')),
      'manifest must not be published'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resume rejects an outside .wsg/tmp/<id> staging symlink with zero git mutation', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-stageid-' });
  const docDir = mkTmp('wsg-rsm-stageid-doc-');
  const docPath = path.join(docDir, 'guide.md');
  fs.writeFileSync(docPath, '# Guide\nPending snapshot.\n', 'utf8');
  const tmpRoot = mkTmp('wsg-rsm-stageid-root-');
  const outside = mkTmp('wsg-rsm-stageid-out-');
  const marker = path.join(outside, 'marker.txt');
  fs.writeFileSync(marker, 'MARKER\n', 'utf8');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo.dir,
        '--doc',
        docPath,
      ],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const wsDir = path.join(tmpRoot, 'ws');
    const opFile = readOperation(wsDir);
    assert.ok(opFile?.operation?.id, 'operation id must be recorded');
    const opId = opFile.operation.id;
    const tmpParent = path.join(wsDir, '.wsg', 'tmp');
    fs.mkdirSync(tmpParent, { recursive: true });
    const idLink = path.join(tmpParent, opId);
    fs.symlinkSync(outside, idLink, 'dir');

    const beforeList = worktreeList(repo.dir).length;
    const beforeSha = sha256(fs.readFileSync(marker));

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      docPath,
      '--resume',
    ]);
    assert.equal(resumed.status, 2, `expected conflict exit 2: ${resumed.stderr}`);
    assert.match(resumed.stderr, /unsafe staging directory/);

    assert.deepEqual(fs.readdirSync(outside), ['marker.txt'], 'no outside writes/deletes');
    assert.equal(sha256(fs.readFileSync(marker)), beforeSha, 'outside marker unchanged');
    assert.equal(worktreeList(repo.dir).length, beforeList, 'worktree list unchanged');
    assert.ok(fs.lstatSync(idLink).isSymbolicLink(), 'staging symlink untouched');
    assert.ok(
      !fs.existsSync(path.join(wsDir, 'workspace.yaml')),
      'manifest must not be published'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resume preserves an edited snapshot and writes a .wsg-new proposal', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-snapedit-' });
  const docDir = mkTmp('wsg-rsm-snapedit-doc-');
  const docPath = path.join(docDir, 'guide.md');
  const recorded = '# Guide\nRecorded snapshot.\n';
  fs.writeFileSync(docPath, recorded, 'utf8');
  const tmpRoot = mkTmp('wsg-rsm-snapedit-root-');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo.dir,
        '--doc',
        docPath,
      ],
      { env: { WSG_FAULT: 'after-generate' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const wsDir = path.join(tmpRoot, 'ws');
    const snapshotPath = path.join(wsDir, 'docs', 'guide.md');
    assert.ok(fs.existsSync(snapshotPath), 'snapshot must exist before resume');
    const edited = recorded + 'USER SNAPSHOT EDIT\n';
    fs.writeFileSync(snapshotPath, edited, 'utf8');

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      docPath,
      '--resume',
    ]);
    assert.equal(resumed.status, 3, `expected partial exit 3: ${resumed.stderr}`);

    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), edited, 'snapshot edit intact');
    const proposalPath = `${snapshotPath}.wsg-new`;
    assert.ok(fs.existsSync(proposalPath), '.wsg-new proposal must be written');
    assert.equal(fs.readFileSync(proposalPath, 'utf8'), recorded, 'proposal holds recorded bytes');

    const manifest = parseManifest(
      fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8')
    );
    assert.equal(manifest.docs[0].sha256, sha256(recorded));
  } finally {
    repo.cleanup();
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume preserves a preexisting snapshot proposal and numbers the new one', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-snappro-' });
  const docDir = mkTmp('wsg-rsm-snappro-doc-');
  const docPath = path.join(docDir, 'guide.md');
  const recorded = '# Guide\nRecorded snapshot.\n';
  fs.writeFileSync(docPath, recorded, 'utf8');
  const tmpRoot = mkTmp('wsg-rsm-snappro-root-');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo.dir,
        '--doc',
        docPath,
      ],
      { env: { WSG_FAULT: 'after-generate' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const wsDir = path.join(tmpRoot, 'ws');
    const snapshotPath = path.join(wsDir, 'docs', 'guide.md');
    fs.writeFileSync(snapshotPath, recorded + 'USER SNAPSHOT EDIT\n', 'utf8');
    const preexistingProposal = `${snapshotPath}.wsg-new`;
    fs.writeFileSync(preexistingProposal, 'PREEXISTING PROPOSAL\n', 'utf8');

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      docPath,
      '--resume',
    ]);
    assert.equal(resumed.status, 3, `expected partial exit 3: ${resumed.stderr}`);

    assert.equal(
      fs.readFileSync(preexistingProposal, 'utf8'),
      'PREEXISTING PROPOSAL\n',
      'preexisting proposal preserved'
    );
    const numberedProposal = `${snapshotPath}.wsg-new-1`;
    assert.ok(fs.existsSync(numberedProposal), 'numbered proposal must be written');
    assert.equal(fs.readFileSync(numberedProposal, 'utf8'), recorded);
  } finally {
    repo.cleanup();
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resume fails closed when an edited snapshot source also changed', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-snapboth-' });
  const docDir = mkTmp('wsg-rsm-snapboth-doc-');
  const docPath = path.join(docDir, 'guide.md');
  const recorded = '# Guide\nRecorded snapshot.\n';
  fs.writeFileSync(docPath, recorded, 'utf8');
  const tmpRoot = mkTmp('wsg-rsm-snapboth-root-');

  try {
    const first = runCli(
      [
        'create',
        'task',
        '--name',
        'ws',
        '--root',
        tmpRoot,
        '--repo',
        repo.dir,
        '--doc',
        docPath,
      ],
      { env: { WSG_FAULT: 'after-generate' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const wsDir = path.join(tmpRoot, 'ws');
    const snapshotPath = path.join(wsDir, 'docs', 'guide.md');
    const edited = recorded + 'USER SNAPSHOT EDIT\n';
    fs.writeFileSync(snapshotPath, edited, 'utf8');
    fs.writeFileSync(docPath, '# Guide\nChanged source.\n', 'utf8');

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--doc',
      docPath,
      '--resume',
    ]);
    assert.equal(resumed.status, 2, `expected conflict exit 2: ${resumed.stderr}`);
    assert.match(resumed.stderr, /also changed/);

    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), edited, 'snapshot edit intact');
    assert.ok(!fs.existsSync(`${snapshotPath}.wsg-new`), 'no proposal for unverifiable bytes');
    assert.ok(
      !fs.existsSync(path.join(wsDir, 'workspace.yaml')),
      'manifest must not be published'
    );
  } finally {
    repo.cleanup();
    fs.rmSync(docDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('WSG_FAULT=after-lock leaves a stale lock that resume takes over with a warning', () => {
  const repo = createTestRepo({ prefix: 'wsg-rsm-lock-' });
  const tmpRoot = mkTmp('wsg-rsm-lock-root-');
  const wsDir = path.join(tmpRoot, 'ws');

  try {
    const first = runCli(
      ['create', 'task', '--name', 'ws', '--root', tmpRoot, '--repo', repo.dir],
      { env: { WSG_FAULT: 'after-lock' } }
    );
    assert.equal(first.status, 70, first.stderr);

    const lockPath = path.join(wsDir, '.wsg', 'lock');
    assert.ok(fs.existsSync(lockPath), 'stale lock must remain after crash');

    const resumed = runCli([
      'create',
      'task',
      '--name',
      'ws',
      '--root',
      tmpRoot,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(resumed.status, 0, `expected exit 0: ${resumed.stderr}`);
    assert.match(resumed.stderr, /taking over stale lock from dead process/);
    assert.ok(!fs.existsSync(lockPath), 'lock must be released after resume');
  } finally {
    repo.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
