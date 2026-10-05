import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestRepo } from './helpers/git-fixture.ts';
import { makeEmrFixture } from './helpers/emr-fixture.ts';
import { runMain } from './helpers/cli.ts';
import { runCreate } from '../src/create.ts';
import { ScriptedScout } from '../src/scout.ts';
import { parseManifest } from '../src/manifest.ts';
import { runGit, branchExists, worktreeList } from '../src/git.ts';
import { acquireLock, releaseLock, readOperation } from '../src/operation.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');
const NO_CONFIG = path.join(os.tmpdir(), `wsg-m6-noconfig-${process.pid}.yaml`);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
): CliResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      WSG_CONFIG: NO_CONFIG,
      ...options.env,
    },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
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

function readManifest(wsDir: string) {
  return parseManifest(fs.readFileSync(path.join(wsDir, 'workspace.yaml'), 'utf8'));
}

function ioEnv(extra: Record<string, string | undefined> = {}) {
  return { env: { ...process.env, WSG_CONFIG: NO_CONFIG, ...extra }, cwd: process.cwd() };
}

// ---------------------------------------------------------------------------
// End-to-end: task-only discovery leads to a full four-command lifecycle.
// ---------------------------------------------------------------------------
test('M6: task-only discovery assembles the EMR workspace and all four commands work', async () => {
  const fixture = makeEmrFixture();
  const wsDir = path.join(fixture.workspaceRoot, 'm6-scout');
  const stateDir = path.join(fixture.workspaceRoot, '.scout-state');
  const docPath = path.join(mkTmp('wsg-m6-doc-'), 'followup.md');
  fs.writeFileSync(docPath, '# Follow-up\nmap billing fields later\n', 'utf8');

  try {
    // create: no --repo; the scout selects source/target/shared and excludes billing.
    const code = await runCreate(
      {
        request: 'Port EMR from the monolith to the modular architecture',
        name: 'm6-scout',
        root: fixture.workspaceRoot,
        codeRoots: [fixture.codeRoot],
        scout: new ScriptedScout(fixture.selection),
        scoutStateDir: stateDir,
      },
      ioEnv({ OPENAI_API_KEY: undefined })
    );
    assert.equal(code, 0);

    let manifest = readManifest(wsDir);
    assert.equal(manifest.repos.length, 3);
    assert.equal(manifest.repos.filter((r) => r.intent === 'target').length, 1);
    assert.ok(!manifest.repos.some((r) => r.source === fixture.unrelated.dir));

    // explain (offline, no model call).
    const explain = await runMain(['explain', '--workspace', wsDir], ioEnv({ OPENAI_API_KEY: undefined }));
    assert.equal(explain.exitCode, 0, explain.stderr);
    assert.match(explain.stdout, /Workspace: m6-scout/);
    assert.match(explain.stdout, /intent: target/);

    // add a document; existing worktrees must be untouched.
    const reposBefore = manifest.repos.map((r) => `${r.name}@${r.base_commit}`);
    const add = await runMain(['add', docPath, '--workspace', wsDir], ioEnv());
    assert.equal(add.exitCode, 0, add.stderr);
    manifest = readManifest(wsDir);
    assert.equal(manifest.docs.length, 1);
    assert.deepEqual(
      manifest.repos.map((r) => `${r.name}@${r.base_commit}`),
      reposBefore,
      'add must not change existing repositories'
    );

    // refresh regenerates context/adapters.
    const refresh = await runMain(['refresh', '--workspace', wsDir], ioEnv());
    assert.equal(refresh.exitCode, 0, refresh.stderr);

    // A coding harness can consume the directory.
    const agents = fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /docs\/context\.md/);
    const context = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    assert.match(context, /followup\.md/);
    for (const repo of manifest.repos) {
      assert.ok(fs.existsSync(path.join(wsDir, repo.path)), `worktree ${repo.path} exists`);
    }
  } finally {
    fixture.cleanup();
    fs.rmSync(path.dirname(docPath), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end: explicit-hint assembly + four commands, all via the real CLI.
// ---------------------------------------------------------------------------
test('M6: explicit-hint assembly drives create/explain/add/refresh through the CLI', () => {
  const repoA = createTestRepo({
    prefix: 'wsg-m6-a-',
    files: { 'package.json': JSON.stringify({ name: 'a', scripts: { test: 'true' } }) },
  });
  const repoB = createTestRepo({ prefix: 'wsg-m6-b-' });
  const root = mkTmp('wsg-m6-explicit-root-');
  const wsDir = path.join(root, 'explicit');
  const docDir = mkTmp('wsg-m6-explicit-doc-');
  const doc1 = path.join(docDir, 'guide.md');
  const doc2 = path.join(docDir, 'notes.md');
  fs.writeFileSync(doc1, '# Guide\n', 'utf8');
  fs.writeFileSync(doc2, '# Notes\n', 'utf8');

  try {
    const created = runCli([
      'create',
      'explicit hint task',
      '--name',
      'explicit',
      '--root',
      root,
      '--repo',
      repoA.dir,
      '--repo',
      repoB.dir,
      '--doc',
      doc1,
      '--for',
      'agents,claude',
    ]);
    assert.equal(created.status, 0, created.stderr);

    const explained = runCli(['explain', '--workspace', wsDir]);
    assert.equal(explained.status, 0, explained.stderr);
    assert.match(explained.stdout, /Workspace: explicit/);

    const added = runCli(['add', doc2, '--workspace', wsDir]);
    assert.equal(added.status, 0, added.stderr);

    const refreshed = runCli(['refresh', '--workspace', wsDir]);
    assert.equal(refreshed.status, 0, refreshed.stderr);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.repos.length, 2);
    assert.equal(manifest.docs.length, 2);
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/context.md']) {
      assert.ok(fs.existsSync(path.join(wsDir, f)), `${f} exists`);
    }
    assert.match(fs.readFileSync(path.join(wsDir, 'CLAUDE.md'), 'utf8'), /docs\/context\.md/);
  } finally {
    repoA.cleanup();
    repoB.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source paths containing spaces / unicode, with a real crash and resume.
// ---------------------------------------------------------------------------
test('M6: create crash+resume with a spaced source path preserves the source', () => {
  const repo = createTestRepo({ prefix: 'wsg-m6-space-create-' });
  const spacedParent = mkTmp('wsg m6 空间 create-');
  const spacedSource = path.join(spacedParent, 'repo with space');
  fs.renameSync(repo.dir, spacedSource);
  const root = mkTmp('wsg-m6-space-create-root-');

  const snapshot = () => ({
    status: runGit(['-C', spacedSource, 'status', '--porcelain']),
    head: runGit(['-C', spacedSource, 'rev-parse', 'HEAD']).trim(),
    branch: runGit(['-C', spacedSource, 'symbolic-ref', '--short', 'HEAD']).trim(),
  });
  const before = snapshot();

  try {
    const interrupted = runCli(
      ['create', 'spaced create task', '--name', 'm6create', '--root', root, '--repo', spacedSource],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(interrupted.status, 70, interrupted.stderr);

    const resumed = runCli(
      ['create', 'spaced create task', '--name', 'm6create', '--root', root, '--repo', spacedSource, '--resume']
    );
    assert.equal(resumed.status, 0, resumed.stderr);

    const wsDir = path.join(root, 'm6create');
    const manifest = readManifest(wsDir);
    assert.equal(manifest.repos.length, 1);
    const repoEntry = manifest.repos[0];
    assert.ok(fs.existsSync(path.join(wsDir, repoEntry.path)), 'worktree exists');
    assert.ok(branchExists(repoEntry.source, repoEntry.branch), 'branch exists');
    assert.equal(
      worktreeList(spacedSource).filter((w) => w.branch === repoEntry.branch).length,
      1,
      'resume must not duplicate the worktree'
    );
    assert.deepEqual(snapshot(), before, 'source checkout must be unchanged');
  } finally {
    repo.cleanup();
    fs.rmSync(spacedParent, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M6: add crash+resume with a spaced source path does not duplicate worktrees', () => {
  const baseRepo = createTestRepo({ prefix: 'wsg-m6-space-add-base-' });
  const newRepo = createTestRepo({ prefix: 'wsg-m6-space-add-new-' });
  const spacedParent = mkTmp('wsg m6 空间 add-');
  const spacedSource = path.join(spacedParent, 'added repo');
  fs.renameSync(newRepo.dir, spacedSource);
  const root = mkTmp('wsg-m6-space-add-root-');
  const wsDir = path.join(root, 'base');

  try {
    const created = runCli(['create', 'base', '--name', 'base', '--root', root, '--repo', baseRepo.dir]);
    assert.equal(created.status, 0, created.stderr);

    const interrupted = runCli(
      ['add', spacedSource, '--workspace', wsDir],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(interrupted.status, 70, interrupted.stderr);

    const resumed = runCli(['add', spacedSource, '--workspace', wsDir, '--resume']);
    assert.equal(resumed.status, 0, resumed.stderr);

    const manifest = readManifest(wsDir);
    assert.equal(manifest.repos.length, 2);
    const entry = manifest.repos.find((r) => r.source === fs.realpathSync(spacedSource));
    assert.ok(entry, 'spaced source is recorded canonically');
    assert.equal(
      worktreeList(spacedSource).filter((w) => w.branch === entry!.branch).length,
      1,
      'resume must not duplicate the added worktree'
    );
  } finally {
    baseRepo.cleanup();
    newRepo.cleanup();
    fs.rmSync(spacedParent, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Concurrency and multi-workspace branch isolation.
// ---------------------------------------------------------------------------
test('M6: concurrent same-workspace writes are rejected without mutation', () => {
  const repo = createTestRepo({ prefix: 'wsg-m6-lock-base-' });
  const extra = createTestRepo({ prefix: 'wsg-m6-lock-extra-' });
  const root = mkTmp('wsg-m6-lock-root-');
  const wsDir = path.join(root, 'base');

  try {
    const created = runCli(['create', 'lock task', '--name', 'base', '--root', root, '--repo', repo.dir]);
    assert.equal(created.status, 0, created.stderr);

    const lock = acquireLock(wsDir, { opId: 'm6-holder' });
    try {
      const refresh = runCli(['refresh', '--workspace', wsDir]);
      assert.equal(refresh.status, 2, `refresh must conflict: ${refresh.stderr}`);
      assert.match(refresh.stderr, /lock/i);

      const add = runCli(['add', extra.dir, '--workspace', wsDir]);
      assert.equal(add.status, 2, `add must conflict: ${add.stderr}`);
      assert.ok(
        !fs.existsSync(path.join(wsDir, path.basename(extra.dir))),
        'no worktree may be created while the lock is held'
      );
    } finally {
      releaseLock(wsDir, lock);
    }

    const manifest = readManifest(wsDir);
    assert.equal(manifest.repos.length, 1);
  } finally {
    repo.cleanup();
    extra.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M6: different workspaces use one source repo on distinct branches', () => {
  const repo = createTestRepo({ prefix: 'wsg-m6-multi-' });
  const root = mkTmp('wsg-m6-multi-root-');

  try {
    for (const name of ['one', 'two']) {
      const result = runCli(['create', 'multi task', '--name', name, '--root', root, '--repo', repo.dir]);
      assert.equal(result.status, 0, result.stderr);
    }
    const m1 = readManifest(path.join(root, 'one'));
    const m2 = readManifest(path.join(root, 'two'));
    assert.notEqual(m1.repos[0].branch, m2.repos[0].branch);
    assert.ok(branchExists(repo.dir, m1.repos[0].branch));
    assert.ok(branchExists(repo.dir, m2.repos[0].branch));
    // Two worktrees on the same source, one per workspace branch.
    const branches = new Set(worktreeList(repo.dir).map((w) => w.branch));
    assert.ok(branches.has(m1.repos[0].branch));
    assert.ok(branches.has(m2.repos[0].branch));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M6: a branch moved off its recorded commit stops resume without destructive git', () => {
  const repo = createTestRepo({ prefix: 'wsg-m6-mismatch-' });
  const root = mkTmp('wsg-m6-mismatch-root-');
  const wsDir = path.join(root, 'base');

  try {
    const interrupted = runCli(
      ['create', 'mismatch task', '--name', 'base', '--root', root, '--repo', repo.dir],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(interrupted.status, 70, interrupted.stderr);

    const op = readOperation(wsDir);
    const plan = op?.operation?.plan as
      | { repos: Array<{ name: string; source: string; dest: string; branch: string; base_commit: string }> }
      | undefined;
    assert.ok(plan && plan.repos.length === 1, 'recorded plan has the repository');
    const repoEntry = plan.repos[0];
    const recordBranch = repoEntry.branch;
    const worktree = repoEntry.dest;
    assert.ok(fs.existsSync(worktree));

    // Move the recorded branch off its base commit through the worktree (the
    // only way to advance a checked-out branch).
    runGit(['-C', worktree, 'commit', '--allow-empty', '-m', 'moved']);
    const movedCommit = runGit(['-C', repo.dir, 'rev-parse', recordBranch]).trim();
    assert.notEqual(movedCommit, repoEntry.base_commit);
    const worktreesBefore = worktreeList(repo.dir).length;

    const resumed = runCli([
      'create',
      'mismatch task',
      '--name',
      'base',
      '--root',
      root,
      '--repo',
      repo.dir,
      '--resume',
    ]);
    assert.equal(resumed.status, 2, `expected conflict, got ${resumed.status}: ${resumed.stderr}`);
    assert.match(resumed.stderr, /branch|commit|mismatch/i);

    // No force/reset/deletion: the branch still points where the test moved it
    // and no worktree was added or removed.
    assert.equal(runGit(['-C', repo.dir, 'rev-parse', recordBranch]).trim(), movedCommit);
    assert.equal(worktreeList(repo.dir).length, worktreesBefore);
    assert.ok(fs.existsSync(worktree));
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regressions for confirmed M6 defects.
// ---------------------------------------------------------------------------
test('M6: --for none is honored by create and by resume (no implicit adapters)', () => {
  const repo = createTestRepo({ prefix: 'wsg-m6-none-' });
  const root = mkTmp('wsg-m6-none-root-');

  try {
    // Fresh create with no adapters.
    const fresh = runCli(['create', 'none task', '--name', 'nonefresh', '--root', root, '--repo', repo.dir, '--for', 'none']);
    assert.equal(fresh.status, 0, fresh.stderr);
    const freshManifest = readManifest(path.join(root, 'nonefresh'));
    assert.deepEqual(freshManifest.adapters, []);
    assert.ok(!fs.existsSync(path.join(root, 'nonefresh', 'AGENTS.md')));
    assert.ok(!fs.existsSync(path.join(root, 'nonefresh', 'CLAUDE.md')));

    // Interrupt with --for none, then resume WITHOUT --for: the recorded empty
    // adapter set is authoritative and must not become [agents].
    const interrupted = runCli(
      ['create', 'none resume', '--name', 'noneresume', '--root', root, '--repo', repo.dir, '--for', 'none'],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(interrupted.status, 70, interrupted.stderr);

    const resumed = runCli(
      ['create', 'none resume', '--name', 'noneresume', '--root', root, '--repo', repo.dir, '--resume']
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedManifest = readManifest(path.join(root, 'noneresume'));
    assert.deepEqual(resumedManifest.adapters, []);
    assert.ok(!fs.existsSync(path.join(root, 'noneresume', 'AGENTS.md')));
    assert.ok(!fs.existsSync(path.join(root, 'noneresume', 'CLAUDE.md')));

    // Resume WITH --for none must also accept the recorded empty set.
    const interrupted2 = runCli(
      ['create', 'none resume2', '--name', 'noneresume2', '--root', root, '--repo', repo.dir, '--for', 'none'],
      { env: { WSG_FAULT: 'after-worktree:1' } }
    );
    assert.equal(interrupted2.status, 70, interrupted2.stderr);
    const resumed2 = runCli(
      ['create', 'none resume2', '--name', 'noneresume2', '--root', root, '--repo', repo.dir, '--for', 'none', '--resume']
    );
    assert.equal(resumed2.status, 0, resumed2.stderr);
    assert.deepEqual(readManifest(path.join(root, 'noneresume2')).adapters, []);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M6: add --resume --dry-run performs no mutation', () => {
  const baseRepo = createTestRepo({ prefix: 'wsg-m6-dryrun-base-' });
  const root = mkTmp('wsg-m6-dryrun-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-m6-dryrun-doc-');
  const doc = path.join(docDir, 'dryrun-notes.md');
  fs.writeFileSync(doc, '# Dry run notes\n', 'utf8');

  try {
    const created = runCli(['create', 'dryrun task', '--name', 'base', '--root', root, '--repo', baseRepo.dir]);
    assert.equal(created.status, 0, created.stderr);

    const interrupted = runCli(
      ['add', doc, '--workspace', wsDir],
      { env: { WSG_FAULT: 'after-stage:1' } }
    );
    assert.equal(interrupted.status, 70, interrupted.stderr);
    assert.ok(!fs.existsSync(path.join(wsDir, 'docs', 'dryrun-notes.md')), 'doc must not be committed after crash');

    const dry = runCli(['add', doc, '--workspace', wsDir, '--resume', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(!fs.existsSync(path.join(wsDir, 'docs', 'dryrun-notes.md')), 'dry-run must not commit the doc');
    assert.equal(readManifest(wsDir).docs.length, 0, 'dry-run must not publish a manifest change');

    const resumed = runCli(['add', doc, '--workspace', wsDir, '--resume']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.ok(fs.existsSync(path.join(wsDir, 'docs', 'dryrun-notes.md')), 'real resume commits the doc');
    assert.equal(readManifest(wsDir).docs.length, 1);
  } finally {
    baseRepo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});

test('M6: refresh preserves the (unread) marker for a binary snapshot with a text extension', () => {
  const repo = createTestRepo({ prefix: 'wsg-m6-unread-' });
  const root = mkTmp('wsg-m6-unread-root-');
  const wsDir = path.join(root, 'base');
  const docDir = mkTmp('wsg-m6-unread-doc-');
  const doc = path.join(docDir, 'binary.md');
  fs.writeFileSync(doc, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x03]));

  try {
    const created = runCli(['create', 'unread task', '--name', 'base', '--root', root, '--repo', repo.dir, '--doc', doc]);
    assert.equal(created.status, 0, created.stderr);

    const contextBefore = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    assert.match(contextBefore, /binary\.md.*\(unread\)/);
    assert.match(contextBefore, /Unresolved Documents/);

    const refreshed = runCli(['refresh', '--workspace', wsDir]);
    assert.equal(refreshed.status, 0, refreshed.stderr);

    const contextAfter = fs.readFileSync(path.join(wsDir, 'docs', 'context.md'), 'utf8');
    assert.match(contextAfter, /binary\.md.*\(unread\)/, 'refresh must keep the unread marker');
    assert.match(contextAfter, /Unresolved Documents/);
  } finally {
    repo.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(docDir, { recursive: true, force: true });
  }
});
